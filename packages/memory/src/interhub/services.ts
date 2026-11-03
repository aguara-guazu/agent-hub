import type { EventEmitter } from "node:events"
import type { InterhubChatPayload, InterhubRoster, InterhubRosterAgent, InterhubRosterHub } from "@agenthub/shared"
import { INTERHUB_CHANNEL_KIND } from "@agenthub/shared"
import { ACTIVE_TEAM_STATES, channelProjectId, sessionProjectId } from "../chat-access.js"
import { check } from "../contracts.js"
import { sessionStatus } from "../local-chat.js"
import type { MemoryStore } from "../store.js"
import type { SharedNetwork } from "../sharing/network.js"
import { SharedProjects } from "../sharing/projects.js"
import { INTERHUB_REMOTE_CLI_KIND, InterhubChat, localChannelAgents } from "./chat.js"
import { InterhubNetwork, chatKind } from "./network.js"
import { InterhubTransport } from "./transport.js"
import { assignProject, backfillProjects, isLocalHubLeader, listOrphans, nextLocalExpiry, projectReconcilers, sharedProjectUsable, unlinkInvalidProjects } from "./project-association.js"
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
  /**
   * Project of the local copy of an inter-hub channel. An explicit id must be a project of this hub. Without one, the
   * caller's local workspace channels decide: their effective projects (own channel and the open local channels it
   * leads) must reduce to exactly one; otherwise the channel stays without project.
   */
  const channelProject = async (caller: InterhubCaller, projectId: string | null | undefined) => {
    if (projectId) {
      check((await db.query("SELECT 1 FROM entities WHERE id=$1 AND kind='project'", [projectId]))[0], "Proyecto inexistente en este hub.", 404)
      return projectId
    }
    const led = await db.query("SELECT id FROM chat_channels WHERE leader_id=$1 AND kind<>$2 AND closed_at IS NULL AND deleted_at IS NULL", [caller.id, INTERHUB_CHANNEL_KIND])
    const projects = new Set<string>()
    const own = await sessionProjectId(db, caller.id)
    if (own) projects.add(own)
    for (const row of led) {
      const project = await channelProjectId(db, String(row.id))
      if (project) projects.add(project)
    }
    return projects.size === 1 ? [...projects][0]! : null
  }
  /** Assigns the channels whose current shared-project policies leave exactly one candidate; notifies listeners on any change. */
  const backfill = async (channelId?: string) => {
    // Existing associations are checked first so a project this hub no longer belongs to is released before the channel is evaluated.
    try {
      const unlinked = await unlinkInvalidProjects(db, localHubId, channelId ? { channelId } : {})
      const result = await backfillProjects(db, localHubId, channelId ? { channelId } : {})
      const announced = await announceProjects(channelId)
      if (unlinked.length || result.resolved.length || announced) events?.emit("change")
      return result
    } finally {
      // Rearmed even when a step failed: the previous timer was cancelled by the last pass and the expiry must stay watched.
      await scheduleExpiry().catch(error => { console.error("interhub: project expiry timer could not be rearmed:", error instanceof Error ? error.message : "unknown error") })
    }
  }
  /**
   * One timer per service for the next expiry of this hub's own membership in a project that has channels assigned.
   * It wakes at most once per hour so a Mac that slept recomputes the deadline, and it is replaced after every pass.
   */
  const MAX_EXPIRY_DELAY_MS = 3_600_000
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleExpiry = async () => {
    clearTimeout(expiryTimer)
    expiryTimer = undefined
    const expires = await nextLocalExpiry(db, localHubId)
    if (expires === null || disposed) return
    expiryTimer = setTimeout(() => { void reconcileProjects() }, Math.min(Math.max(expires - Date.now(), 1_000), MAX_EXPIRY_DELAY_MS))
    expiryTimer.unref()
  }
  let disposed = false
  /** Creator side: declares in the signed log the project of every channel of this hub whose last announced value differs; true when something was announced. */
  const announceProjects = async (channelId?: string) => {
    const pending = await db.query(`SELECT c.id,c.project_id,i.creator_hub_id FROM chat_channels c JOIN interhub_channels i ON i.channel_id=c.id
      WHERE c.kind=$1 AND c.deleted_at IS NULL AND c.project_id IS NOT NULL AND ($2 IS NULL OR c.id=$2)
      AND (i.shared_project_hint IS NULL OR i.shared_project_hint<>c.project_id)`, [INTERHUB_CHANNEL_KIND, channelId ?? null])
    // The hub identity is created on first use; installations without such channels must not trigger that.
    if (!pending.length) return false
    const local = await localHubId()
    const rows = pending.filter(row => row.creator_hub_id === local)
    let announced = false
    for (const row of rows) {
      // A project that is not an enabled shared project of this hub is never declared to the others.
      if (!await sharedProjectUsable(db, String(row.project_id), [local])) continue
      if (transport ? await transport.announceProject(String(row.id)) : await network.announceProject(String(row.id))) announced = true
    }
    return announced
  }
  // Repairs channels saved without project by earlier versions. Reads that must see the result await `backfilled`;
  // a failure is logged without channel data and never blocks the service.
  const backfilled = backfill().then(() => undefined, error => { console.error("interhub: project backfill failed:", error instanceof Error ? error.message : "unknown error") })
  /** The caller is the current, open leader of the hub it represents in the channel. */
  // A hub that becomes a member after the channel exists (creator side) can complete the evidence for its project.
  network.afterMembership = channelId => backfill(channelId).then(() => undefined, error => { console.error("interhub: project backfill after membership failed:", error instanceof Error ? error.message : "unknown error") })
  /** Backfill over every orphan channel for callers that must not fail: awaits the startup pass, logs without channel data. */
  const reconcileProjects = async () => {
    await backfilled
    await backfill().then(() => undefined, error => { console.error("interhub: project reconciliation failed:", error instanceof Error ? error.message : "unknown error") })
  }
  projectReconcilers.set(store, reconcileProjects)
  const isHubLeader = async (channelId: string, caller: InterhubCaller) => isLocalHubLeader(db, channelId, await localHubId(), caller.id)

  return {
    /** Settles once the startup backfill has run; it never rejects. */
    ready: backfilled,
    reconcileProjects,
    dispose() { disposed = true; clearTimeout(expiryTimer); expiryTimer = undefined },
    async createChannel(caller, input) {
      const requested = await channelProject(caller, input.projectId)
      const usable = requested ? await sharedProjectUsable(db, requested, [await localHubId()]) : false
      // An explicit project that other hubs could never see is refused before the channel and its code exist; a project
      // inferred from the caller's context only starts the channel without project.
      check(!input.projectId || usable, "El proyecto indicado no es un proyecto compartido activo de este hub. Compártelo y reintenta, o crea el canal sin proyecto.", 422)
      const projectId = usable ? requested : null
      const created = await network.createChannel(caller, { name: input.name, projectId })
      transport?.topicsChanged()
      return { ...created, project_id: projectId, ...(requested && !projectId ? { project_notice: "El proyecto indicado no es un proyecto compartido activo de este hub; el canal quedó sin proyecto hasta que se asigne uno compartido." } : {}) }
    },
    async joinChannel(caller, code, projectId) {
      // Joining represents the whole local hub: only the leader of the caller's own local channel may do it.
      const own = (await db.query("SELECT leader_id,kind FROM chat_channels WHERE id=$1", [caller.channel_id]))[0]
      check(own && own.leader_id === caller.id && own.kind !== INTERHUB_CHANNEL_KIND, "Sólo el líder de tu canal local puede unir tu hub a un canal entre hubs.", 403)
      check(transport, "La red P2P entre hubs no está disponible en este servicio.", 503)
      // Validated before the P2P wait so an unknown project fails at once. The policies of the shared projects are the
      // only evidence once the creator hub is a member, so the project is decided after the join and never from local context.
      const explicit = projectId ? await channelProject(caller, projectId) : null
      const joined = await transport.join({ id: caller.id, label: String(caller.nickname ?? caller.label) }, code, null)
      if (explicit) {
        // An explicit project must be shared with every active hub of the channel.
        try { await assignProject(db, await localHubId(), caller.id, joined.channel_id, explicit) } catch (error) {
          check(false, `Tu hub se unió al canal ${joined.channel_id}, pero no se pudo asociar al proyecto indicado: ${error instanceof Error ? error.message : "error desconocido"} Asígnalo después con chat_interhub_assign_project.`, 422)
        }
        events?.emit("change")
        return { ...joined, project_id: explicit }
      }
      const { resolved } = await backfill(joined.channel_id)
      return resolved.length ? { ...joined, project_id: resolved[0]!.project_id } : joined
    },
    async listOrphans() { await backfilled; return listOrphans(db, localHubId) },
    async assignProject(caller, channelId, projectId) {
      await backfilled
      const result = await assignProject(db, await localHubId(), caller.id, channelId, projectId)
      events?.emit("change")
      return result
    },
    async localAgent(caller, channelId, sessionId, action) {
      const local = await localHubId()
      const result = await db.transaction(async sql => {
        const channel = (await sql.query("SELECT * FROM chat_channels WHERE id=$1 AND kind=$2 AND closed_at IS NULL AND deleted_at IS NULL", [channelId, INTERHUB_CHANNEL_KIND]))[0]
        check(channel, "Canal entre hubs inexistente.", 404)
        const leads = (await sql.query("SELECT 1 FROM interhub_members WHERE channel_id=$1 AND hub_id=$2 AND removed_at IS NULL AND leader_session_id=$3", [channelId, local, caller.id])).length > 0
        check(channel.leader_id === caller.id && leads, "Sólo el líder de tu hub en el canal puede sumar o quitar agentes locales.", 403)
        check(sessionId !== caller.id, "Ya participás del canal como líder de tu hub.", 400)
        if (action === "remove") {
          const removed = await sql.query("UPDATE interhub_local_agents SET removed_at=now(),removed_by=$3 WHERE channel_id=$1 AND session_id=$2 AND removed_at IS NULL RETURNING session_id", [channelId, sessionId, caller.id])
          if (removed.length) await sql.query(`UPDATE chat_deliveries SET cancelled_at=now(),error='Agente quitado del canal entre hubs' WHERE recipient_id=$1 AND handled_at IS NULL AND cancelled_at IS NULL
            AND message_id IN (SELECT m.id FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id WHERE t.channel_id=$2)`, [sessionId, channelId])
          return { channel_id: channelId, session_id: sessionId, associated: false }
        }
        const target = (await sql.query("SELECT * FROM chat_sessions WHERE id=$1", [sessionId]))[0]
        check(target && target.cli_kind !== INTERHUB_REMOTE_CLI_KIND && target.cli_kind !== "hub" && target.nickname && !target.closed_at && !target.removed_at,
          "La sesión no es un agente abierto y con nick de este hub.", 404)
        // Same project as the channel or as its leader here, or a joined member of an active team the leader coordinates.
        const project = await sessionProjectId(sql, target.id)
        const sameProject = Boolean(project && (project === channel.project_id || project === await sessionProjectId(sql, caller.id)))
        const teamMember = !sameProject && (await sql.query(`SELECT 1 FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id
          WHERE p.created_by=$1 AND m.session_id=$2 AND m.state='joined' AND p.state IN (${ACTIVE_TEAM_STATES.map(state => `'${state}'`).join(",")}) LIMIT 1`, [caller.id, target.id])).length > 0
        check(sameProject || teamMember, "Sólo podés sumar agentes de tu mismo proyecto o miembros de un equipo activo que coordinás.", 403)
        await sql.query(`INSERT INTO interhub_local_agents(channel_id,session_id,added_by) VALUES($1,$2,$3)
          ON CONFLICT(channel_id,session_id) DO UPDATE SET added_by=excluded.added_by,added_at=now(),removed_by=NULL,removed_at=NULL`, [channelId, target.id, caller.id])
        return { channel_id: channelId, session_id: String(target.id), associated: true }
      })
      events?.emit("change")
      return result
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
