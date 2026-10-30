import type { EventEmitter } from "node:events"
import type { InterhubChatPayload, InterhubRoster, InterhubRosterAgent, InterhubRosterHub } from "@agenthub/shared"
import { INTERHUB_CHANNEL_KIND } from "@agenthub/shared"
import { check } from "../contracts.js"
import { sessionStatus } from "../local-chat.js"
import type { MemoryStore } from "../store.js"
import type { SharedNetwork } from "../sharing/network.js"
import { SharedProjects } from "../sharing/projects.js"
import { InterhubChat, localChannelAgents } from "./chat.js"
import { InterhubNetwork, chatKind } from "./network.js"
import { InterhubTransport } from "./transport.js"
import type { InterhubCaller, InterhubPendingEscalation, InterhubServices } from "./tools.js"

const peerName = (value: unknown) => {
  try {
    const identity = typeof value === "string" ? JSON.parse(value) : value
    return typeof identity?.name === "string" && identity.name.trim() ? String(identity.name) : null
  } catch { return null }
}

/**
 * Connects the tools and routes to the P2P replica (InterhubNetwork), its transport over the sharing network
 * (InterhubTransport) and the chat model (InterhubChat). Every authority decision is taken here with Hub data
 * (session rows, channel leader, creator hub identity), never from tool input. Without `network` the services
 * still record events locally but cannot join channels of other hubs. `events` is the local chat emitter: its
 * "change" wakes local listeners after inter-hub state changes and drives the transport's outbox.
 */
export function createInterhubServices(store: MemoryStore, options: { network?: SharedNetwork; events?: EventEmitter } = {}): InterhubServices {
  const network = new InterhubNetwork(store), db = store.db, events = options.events
  const localIdentity = () => new SharedProjects(store).identity()
  const localHubId = async () => (await localIdentity()).id
  let transport: InterhubTransport | undefined
  const chat = new InterhubChat(store, {
    hubs: async channelId => (await network.listHubs(channelId)).map(hub => ({ id: String(hub.id), name: String(hub.name), is_local: Boolean(hub.is_local), connection: hub.connection === "online" ? "online" : "offline" })),
    localHubId,
    // Signs and appends to the event log every member pulls from; with a transport it is also announced to connected members.
    // origin_agent_id is the signed author receivers match against the payload; escalation events are hub-level.
    publish: async (channelId, payload: InterhubChatPayload) => {
      const agent = payload.type === "thread" ? payload.thread.author.id : payload.type === "message" ? payload.message.author.id : payload.type === "presence" ? payload.presence.session.id : null
      if (transport) return transport.publish(channelId, payload, agent)
      await network.append(channelId, chatKind(payload), payload, agent)
    },
    ...(events ? { changed: () => { events.emit("change") } } : {}),
  })
  if (options.network) transport = new InterhubTransport(store, network, options.network, chat, events)
  const interhubChannel = async (channelId: string) => (await db.query("SELECT * FROM chat_channels WHERE id=$1 AND kind=$2 AND deleted_at IS NULL", [channelId, INTERHUB_CHANNEL_KIND]))[0]
  /** The caller is the current, open leader of the hub it represents in the channel. */
  const isHubLeader = async (channelId: string, caller: InterhubCaller) => Boolean((await db.query(
    `SELECT 1 FROM interhub_members m JOIN chat_sessions s ON s.id=m.leader_session_id
     WHERE m.channel_id=$1 AND m.hub_id=$2 AND m.removed_at IS NULL AND m.leader_session_id=$3 AND s.closed_at IS NULL AND s.removed_at IS NULL`,
    [channelId, await localHubId(), caller.id]))[0])

  return {
    async createChannel(caller, input) {
      const created = await network.createChannel(caller, { name: input.name, projectId: input.projectId ?? null })
      transport?.topicsChanged()
      return created
    },
    async joinChannel(caller, code) {
      // Joining represents the whole local hub: only the leader of the caller's own local channel may do it.
      const own = (await db.query("SELECT leader_id,kind FROM chat_channels WHERE id=$1", [caller.channel_id]))[0]
      check(own && own.leader_id === caller.id && own.kind !== INTERHUB_CHANNEL_KIND, "Sólo el líder de tu canal local puede unir tu hub a un canal entre hubs.", 403)
      check(transport, "La red P2P entre hubs no está disponible en este servicio.", 503)
      return transport.join({ id: caller.id, label: String(caller.nickname ?? caller.label) }, code)
    },
    async rotateCode(caller, channelId, action) {
      const result = await network.rotateCode(caller, channelId, action)
      const change = action === "revoke" ? "revoked" as const : "regenerated" as const
      if (transport) await transport.codeChanged(channelId, change, result.generation)
      else await network.append(channelId, "code", { action: change, generation: result.generation })
      return "code" in result ? { code: result.code } : { revoked: true }
    },
    /**
     * Local hub: its leader in the channel, sessions of the channel and joined members of active teams mastered there.
     * Remote hubs: sessions announced by signed presence plus the leader of their signed membership. The role is always
     * derived from the hub's leader_session_id, so each hub shows at most one leader.
     */
    async roster(channelId): Promise<InterhubRoster | null> {
      if (!await interhubChannel(channelId)) return null
      const local = await localIdentity()
      const members = await db.query("SELECT hub_id,peer_identity,leader_session_id,leader_label FROM interhub_members WHERE channel_id=$1 AND removed_at IS NULL ORDER BY hub_id=$2 DESC,joined_at,hub_id", [channelId, local.id])
      const hubs: InterhubRosterHub[] = []
      for (const member of members) {
        const isLocal = member.hub_id === local.id, leaderId = member.leader_session_id ? String(member.leader_session_id) : null
        let agents: InterhubRosterAgent[]
        if (isLocal) {
          const rows = await localChannelAgents(db, channelId, leaderId)
          agents = rows.map(row => ({ id: String(row.id), label: String(row.nickname ?? row.label), cli_kind: String(row.cli_kind), role: row.id === leaderId ? "leader" : "member", state: sessionStatus(row).state }))
        } else {
          const rows = await db.query("SELECT session_id,label,cli_kind,state FROM interhub_remote_sessions WHERE channel_id=$1 AND hub_id=$2 ORDER BY occurred_at,session_id", [channelId, member.hub_id])
          agents = rows.map(row => ({ id: String(row.session_id), label: String(row.label), cli_kind: String(row.cli_kind), role: row.session_id === leaderId ? "leader" : "member", state: String(row.state) }))
          if (leaderId && !agents.some(agent => agent.id === leaderId)) agents.push({ id: leaderId, label: String(member.leader_label), cli_kind: "unknown", role: "leader", state: "unknown" })
        }
        agents.sort((a, b) => Number(b.role === "leader") - Number(a.role === "leader"))
        hubs.push({ id: String(member.hub_id), name: isLocal ? local.name : peerName(member.peer_identity) ?? String(member.leader_label), is_local: isLocal, agent_count: agents.length,
          leader_id: agents.find(agent => agent.role === "leader")?.id ?? null, agents })
      }
      return { hub_count: hubs.length, agent_count: hubs.reduce((sum, hub) => sum + hub.agent_count, 0), hubs }
    },
    async pendingEscalations(channelId): Promise<InterhubPendingEscalation[]> {
      const rows = await db.query("SELECT id,thread_id,question_message_id,escalated_at FROM interhub_escalations WHERE channel_id=$1 AND next_hub_id=$2 AND answered_at IS NULL ORDER BY escalated_at", [channelId, await localHubId()])
      return rows.map(row => ({ id: String(row.id), thread_id: String(row.thread_id), question_message_id: String(row.question_message_id), escalated_at: String(row.escalated_at) }))
    },
    async creatorCode(channelId) {
      const row = (await db.query("SELECT creator_hub_id FROM interhub_channels WHERE channel_id=$1 AND code_revoked_at IS NULL", [channelId]))[0]
      // The local hub must be the creator: a joined hub never shows the code, whatever its vault holds.
      if (!row || row.creator_hub_id !== await localHubId()) return null
      return network.creatorCode(channelId)
    },
    async escalate(caller, channelId, threadId, messageId) {
      check(await interhubChannel(channelId), "Canal entre hubs inexistente.", 404)
      check(await isHubLeader(channelId, caller), "Sólo el líder de tu hub en el canal puede escalar.", 403)
      return chat.escalate(caller, channelId, threadId, messageId)
    },
    async resolveEscalation(caller, channelId, threadId, escalationId) {
      check(await interhubChannel(channelId), "Canal entre hubs inexistente.", 404)
      check(await isHubLeader(channelId, caller), "Sólo el líder de un hub miembro puede resolver una escalada.", 403)
      return chat.resolve(channelId, threadId, escalationId)
    },
    sweepEscalations: now => chat.sweepEscalations(now),
    receive: envelope => chat.receive(envelope),
  }
}
