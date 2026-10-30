import type { InterhubChatPayload, InterhubRoster, InterhubRosterAgent, InterhubRosterHub } from "@agenthub/shared"
import { INTERHUB_CHANNEL_KIND } from "@agenthub/shared"
import { check } from "../contracts.js"
import type { MemoryStore } from "../store.js"
import { SharedProjects } from "../sharing/projects.js"
import { InterhubChat } from "./chat.js"
import { InterhubNetwork } from "./network.js"
import type { InterhubCaller, InterhubPendingEscalation, InterhubServices } from "./tools.js"

const asRole = (value: unknown): "leader" | "member" => value === "leader" ? "leader" : "member"

/**
 * Connects the tools and routes to the P2P replica (InterhubNetwork) and the chat model (InterhubChat).
 * Every authority decision is taken here with Hub data (session rows, channel leader, creator hub identity),
 * never from tool input.
 */
export function createInterhubServices(store: MemoryStore): InterhubServices {
  const network = new InterhubNetwork(store), db = store.db
  const localHubId = async () => (await new SharedProjects(store).identity()).id
  const chat = new InterhubChat(store, {
    hubs: async channelId => (await network.listHubs(channelId)).map(hub => ({ id: String(hub.id), name: String(hub.name), is_local: Boolean(hub.is_local), connection: hub.connection === "online" ? "online" : "offline" })),
    localHubId,
    // Signs and appends to the local event log that peers catch up from; delivery to peers is the P2P transport's job.
    publish: async (channelId, payload: InterhubChatPayload) => {
      const envelope = await network.signEnvelope({ version: 1, channel_id: channelId, origin_agent_id: null, kind: payload.type === "thread" ? "thread" : "message", occurred_at: new Date().toISOString(), payload })
      await db.query("INSERT INTO interhub_events(id,channel_id,origin_hub_id,envelope,received_from) VALUES($1,$2,$3,$4,$5)", [envelope.id, channelId, envelope.origin_hub_id, JSON.stringify(envelope), "local"])
    },
  })
  const interhubChannel = async (channelId: string) => (await db.query("SELECT * FROM chat_channels WHERE id=$1 AND kind=$2 AND deleted_at IS NULL", [channelId, INTERHUB_CHANNEL_KIND]))[0]
  /** The caller is the current, open leader of the hub it represents in the channel. */
  const isHubLeader = async (channelId: string, caller: InterhubCaller) => Boolean((await db.query(
    `SELECT 1 FROM interhub_members m JOIN chat_sessions s ON s.id=m.leader_session_id
     WHERE m.channel_id=$1 AND m.hub_id=$2 AND m.removed_at IS NULL AND m.leader_session_id=$3 AND s.closed_at IS NULL AND s.removed_at IS NULL`,
    [channelId, await localHubId(), caller.id]))[0])
  const state = (row: Record<string, any>) => row.removed_at || row.closed_at ? "offline" : String(row.state ?? "unknown")

  return {
    createChannel: (caller, input) => network.createChannel(caller, { name: input.name, projectId: input.projectId ?? null }),
    async joinChannel(caller, code) {
      // Joining represents the whole local hub: only the leader of the caller's own local channel may do it.
      const own = (await db.query("SELECT leader_id,kind FROM chat_channels WHERE id=$1", [caller.channel_id]))[0]
      check(own && own.leader_id === caller.id && own.kind !== INTERHUB_CHANNEL_KIND, "Sólo el líder de tu canal local puede unir tu hub a un canal entre hubs.", 403)
      return network.joinChannel(caller, code)
    },
    rotateCode: (caller, channelId, action) => network.rotateCode(caller, channelId, action),
    async roster(channelId): Promise<InterhubRoster | null> {
      if (!await interhubChannel(channelId)) return null
      const local = await localHubId()
      const members = await db.query("SELECT hub_id,peer_identity,leader_session_id,leader_label FROM interhub_members WHERE channel_id=$1 AND removed_at IS NULL ORDER BY hub_id=$2 DESC,joined_at", [channelId, local])
      const hubs: InterhubRosterHub[] = []
      for (const member of members) {
        const isLocal = member.hub_id === local
        let agents: InterhubRosterAgent[]
        if (isLocal) {
          const rows = await db.query(
            `SELECT id,COALESCE(nickname,label) AS label,cli_kind,state,closed_at,removed_at FROM chat_sessions
             WHERE (id=$2 OR channel_id=$1) AND cli_kind<>'interhub-remote' AND nickname IS NOT NULL AND removed_at IS NULL AND closed_at IS NULL`, [channelId, member.leader_session_id])
          agents = rows.map(row => ({ id: String(row.id), label: String(row.label), cli_kind: String(row.cli_kind), role: row.id === member.leader_session_id ? "leader" : "member", state: state(row) }))
        } else {
          const rows = await db.query("SELECT session_id,label,cli_kind,role,state FROM interhub_remote_sessions WHERE channel_id=$1 AND hub_id=$2", [channelId, member.hub_id])
          agents = rows.map(row => ({ id: String(row.session_id), label: String(row.label), cli_kind: String(row.cli_kind), role: asRole(row.role), state: String(row.state) }))
        }
        agents.sort((a, b) => Number(b.role === "leader") - Number(a.role === "leader"))
        const identity = typeof member.peer_identity === "string" ? JSON.parse(member.peer_identity) : member.peer_identity
        hubs.push({ id: String(member.hub_id), name: String(identity?.name ?? member.leader_label), is_local: isLocal, agent_count: agents.length,
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
      check(await isHubLeader(channelId, caller), "Sólo el líder de tu hub en el canal puede escalar.", 403)
      const result = await chat.escalate(caller, channelId, threadId, messageId)
      if ("no_other_hub" in result) return result
      const row = (await db.query("SELECT id FROM interhub_escalations WHERE channel_id=$1 AND thread_id=$2 AND question_message_id=$3", [channelId, threadId, messageId]))[0]
      return { ...result, ...(row ? { escalation_id: String(row.id) } : {}) }
    },
    async resolveEscalation(caller, channelId, threadId, escalationId) {
      check(await interhubChannel(channelId), "Canal entre hubs inexistente.", 404)
      check(await isHubLeader(channelId, caller), "Sólo el líder de un hub miembro puede resolver una escalada.", 403)
      const resolvedAt = new Date().toISOString()
      const updated = await db.query("UPDATE interhub_escalations SET answered_at=COALESCE(answered_at,$4),updated_at=now() WHERE id=$1 AND channel_id=$2 AND thread_id=$3 RETURNING id", [escalationId, channelId, threadId, resolvedAt])
      check(updated.length, "Escalada inexistente.", 404)
      await chat.transport.publish(channelId, { type: "escalation_resolved", resolution: { escalation_id: escalationId, hub_id: await localHubId(), resolved_at: resolvedAt } })
      return { resolved: true as const }
    },
  }
}
