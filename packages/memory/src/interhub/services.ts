import type { InterhubChatPayload, InterhubRoster, InterhubRosterAgent, InterhubRosterHub } from "@agenthub/shared"
import { INTERHUB_CHANNEL_KIND } from "@agenthub/shared"
import { ACTIVE_TEAM_STATES } from "../chat-access.js"
import { check } from "../contracts.js"
import { sessionStatus } from "../local-chat.js"
import type { MemoryStore } from "../store.js"
import { SharedProjects } from "../sharing/projects.js"
import { InterhubChat, INTERHUB_REMOTE_CLI_KIND } from "./chat.js"
import { InterhubNetwork } from "./network.js"
import type { InterhubCaller, InterhubPendingEscalation, InterhubServices } from "./tools.js"

const activeTeams = ACTIVE_TEAM_STATES.map(state => `'${state}'`).join(",")
const peerName = (value: unknown) => {
  try {
    const identity = typeof value === "string" ? JSON.parse(value) : value
    return typeof identity?.name === "string" && identity.name.trim() ? String(identity.name) : null
  } catch { return null }
}

/**
 * Connects the tools and routes to the P2P replica (InterhubNetwork) and the chat model (InterhubChat).
 * Every authority decision is taken here with Hub data (session rows, channel leader, creator hub identity),
 * never from tool input. `changed` wakes local listeners after inter-hub state changes.
 */
export function createInterhubServices(store: MemoryStore, changed?: () => void): InterhubServices {
  const network = new InterhubNetwork(store), db = store.db
  const localIdentity = () => new SharedProjects(store).identity()
  const localHubId = async () => (await localIdentity()).id
  const chat = new InterhubChat(store, {
    hubs: async channelId => (await network.listHubs(channelId)).map(hub => ({ id: String(hub.id), name: String(hub.name), is_local: Boolean(hub.is_local), connection: hub.connection === "online" ? "online" : "offline" })),
    localHubId,
    // Signs and appends to the local event log that peers catch up from; delivery to peers is the P2P transport's job.
    // origin_agent_id is the signed author receivers match against the payload; escalation events are hub-level.
    publish: async (channelId, payload: InterhubChatPayload) => {
      const agent = payload.type === "thread" ? payload.thread.author.id : payload.type === "message" ? payload.message.author.id : payload.type === "presence" ? payload.presence.session.id : null
      const envelope = await network.signEnvelope({ version: 1, channel_id: channelId, origin_agent_id: agent, kind: payload.type === "thread" ? "thread" : "message", occurred_at: new Date().toISOString(), payload })
      await db.query("INSERT INTO interhub_events(id,channel_id,origin_hub_id,envelope,received_from) VALUES($1,$2,$3,$4,$5)", [envelope.id, channelId, envelope.origin_hub_id, JSON.stringify(envelope), "local"])
    },
    ...(changed ? { changed } : {}),
  })
  const interhubChannel = async (channelId: string) => (await db.query("SELECT * FROM chat_channels WHERE id=$1 AND kind=$2 AND deleted_at IS NULL", [channelId, INTERHUB_CHANNEL_KIND]))[0]
  /** The caller is the current, open leader of the hub it represents in the channel. */
  const isHubLeader = async (channelId: string, caller: InterhubCaller) => Boolean((await db.query(
    `SELECT 1 FROM interhub_members m JOIN chat_sessions s ON s.id=m.leader_session_id
     WHERE m.channel_id=$1 AND m.hub_id=$2 AND m.removed_at IS NULL AND m.leader_session_id=$3 AND s.closed_at IS NULL AND s.removed_at IS NULL`,
    [channelId, await localHubId(), caller.id]))[0])

  return {
    createChannel: (caller, input) => network.createChannel(caller, { name: input.name, projectId: input.projectId ?? null }),
    async joinChannel(caller, code) {
      // Joining represents the whole local hub: only the leader of the caller's own local channel may do it.
      const own = (await db.query("SELECT leader_id,kind FROM chat_channels WHERE id=$1", [caller.channel_id]))[0]
      check(own && own.leader_id === caller.id && own.kind !== INTERHUB_CHANNEL_KIND, "Sólo el líder de tu canal local puede unir tu hub a un canal entre hubs.", 403)
      return network.joinChannel(caller, code)
    },
    rotateCode: (caller, channelId, action) => network.rotateCode(caller, channelId, action),
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
          const rows = await db.query(
            `SELECT s.* FROM chat_sessions s WHERE (s.id=$2 OR s.channel_id=$1 OR s.id IN (SELECT m.session_id FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id
               WHERE p.master_channel_id=$1 AND m.state='joined' AND p.state IN (${activeTeams})))
             AND s.cli_kind NOT IN ($3,'hub') AND s.nickname IS NOT NULL AND s.removed_at IS NULL AND s.closed_at IS NULL ORDER BY s.created_at,s.id`, [channelId, leaderId, INTERHUB_REMOTE_CLI_KIND])
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
