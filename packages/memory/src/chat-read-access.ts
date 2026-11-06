import { randomUUID } from "node:crypto"
import { z } from "zod"
import { check, id } from "./contracts.js"
import type { Sql } from "./database.js"
import { ACTIVE_TEAM_STATES, channelMembership, channelProjectId, interhubAgentChannelIds, recordAuthorityEvent, sessionProjectId, teamChannelIds } from "./chat-access.js"

/** Hard cap of a cross-project read grant, even while the agent keeps working. */
export const READ_GRANT_MAX_TTL_MS = 8 * 60 * 60 * 1000
/** A grant ends once the Hub has not renewed the session lease for this long (lease_until is renewed every few seconds while connected). */
export const READ_GRANT_LIVENESS_GRACE_MS = 5 * 60 * 1000
/** An unanswered request is cancelled after this, so a stale request cannot be decided days later. */
export const READ_REQUEST_PENDING_TTL_MS = 24 * 60 * 60 * 1000
export const READ_DECISION_MAX = 1000
/** read_interest only informs the leader; these bounds keep it from flooding the audit and the leader's notices. */
export const READ_INTEREST_WINDOW_MS = 10 * 60_000
export const READ_INTEREST_PER_CHANNEL = 3
export const READ_INTEREST_PER_SESSION = 20
export const READ_INTEREST_REASON_MAX = 500

const activeStates = ACTIVE_TEAM_STATES.map(state => `'${state}'`).join(",")
const key = z.string().min(32).max(200).optional()
export const readAccessDefinitions = {
  chat_read_interest: ["Tell your leader you want to follow another channel of your own project. You can already read it (memory_chat_threads/memory_chat_read); reading never lets you write, mention or take part there. Leaders need not call this.",
    z.object({ session_key: key, channel_id: id, reason: z.string().trim().min(1).max(READ_INTEREST_REASON_MAX) }).strict()],
  chat_read_request: ["Ask to read the channels of another project. Your leader asks the person in its CLI and records the decision with memory_chat_read_decide. A grant is read-only, temporary and ends when your work completes, your session closes or goes offline. Never claim a grant yourself: the Hub records it.",
    z.object({ session_key: key, project_id: id, reason: z.string().trim().min(1).max(1000) }).strict()],
  chat_read_decide: ["Leader only: record the decision on a pending cross-project read request of your channel or team member. Ask the person in your CLI first; person_instruction quotes their answer and is audited as your declaration. decision='grant' gives read-only, temporary access (ends when that agent's work completes, its session closes or goes offline, or after 8 h); 'reject' declines it, with or without asking the person.",
    z.object({ session_key: key, request_id: id, decision: z.enum(["grant", "reject"]), person_instruction: z.string().trim().min(1).max(READ_DECISION_MAX).optional(),
      reason: z.string().trim().min(1).max(READ_DECISION_MAX).optional() }).strict()
      .refine(value => value.decision !== "grant" || Boolean(value.person_instruction), { message: "grant requires person_instruction", path: ["person_instruction"] })],
  chat_read_revoke: ["Leader only: end an active cross-project read grant of your channel or team member, on the person's request or when the task no longer needs it.",
    z.object({ session_key: key, grant_id: id, reason: z.string().trim().min(1).max(READ_DECISION_MAX) }).strict()],
} satisfies Record<string, [string, z.ZodType]>

const graceCutoff = (now = Date.now()) => new Date(now - READ_GRANT_LIVENESS_GRACE_MS).toISOString()

/**
 * Shared by reads and the sweep: a grant counts only while every condition holds, even before the sweep revokes it.
 * Any work completed after the grant ends it: otherwise starting another work item right after completing one would keep it.
 */
const workDone = "EXISTS(SELECT 1 FROM chat_work_state w WHERE w.session_id=g.session_id AND w.status='completed' AND w.updated_at>g.granted_at)"
const grantValid = `g.revoked_at IS NULL AND g.expires_at>now() AND s.closed_at IS NULL AND s.removed_at IS NULL
  AND s.lease_until IS NOT NULL AND s.lease_until>$CUTOFF AND NOT ${workDone}`

export interface ReadScope { projects: string[]; channels: string[] }

/** What an agent session may read. The person (no agent identity) is never scoped. */
export async function readScope(sql: Sql, sessionId: string): Promise<ReadScope> {
  const own = await sessionProjectId(sql, sessionId)
  const grants = await sql.query(`SELECT DISTINCT g.project_id FROM chat_read_grants g JOIN chat_sessions s ON s.id=g.session_id
    WHERE g.session_id=$1 AND ${grantValid.replace("$CUTOFF", "$2")}`, [sessionId, graceCutoff()])
  const session = (await sql.query("SELECT channel_id FROM chat_sessions WHERE id=$1", [sessionId]))[0]
  const led = await sql.query("SELECT id FROM chat_channels WHERE leader_id=$1", [sessionId])
  const channels = new Set<string>([...(session ? [String(session.channel_id)] : []), ...led.map(row => String(row.id)), ...await teamChannelIds(sql, sessionId),
    ...await interhubAgentChannelIds(sql, sessionId)])
  return { projects: [...new Set([...(own ? [own] : []), ...grants.map(row => String(row.project_id))])], channels: [...channels] }
}

export async function canReadChannel(sql: Sql, sessionId: string, channelId: string, scope?: ReadScope) {
  const value = scope ?? await readScope(sql, sessionId)
  if (value.channels.includes(channelId)) return true
  const project = await channelProjectId(sql, channelId)
  return Boolean(project && value.projects.includes(project))
}

export const readDenied = "No tenés acceso de lectura a este canal: es de otro proyecto. Pedí acceso con memory_chat_read_request; tu líder se lo consulta a la persona en su CLI y registra la decisión."

/** The coordinator who decides for this session: the linked team master, else the leader of its own channel. */
async function requesterLeader(sql: Sql, session: Record<string, any>) {
  const team = (await sql.query(`SELECT p.id,p.created_by FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id
    JOIN chat_channels master ON master.id=p.master_channel_id
    WHERE m.session_id=$1 AND m.channel_id=$2 AND m.state='joined' AND p.state IN (${activeStates}) AND master.leader_id=p.created_by
    ORDER BY p.created_at DESC LIMIT 1`, [session.id, session.channel_id]))[0]
  const leaderId = team?.created_by ?? (await sql.query("SELECT leader_id FROM chat_channels WHERE id=$1", [session.channel_id]))[0]?.leader_id ?? null
  if (!leaderId) return null
  const leader = (await sql.query("SELECT id,label,closed_at,removed_at FROM chat_sessions WHERE id=$1", [leaderId]))[0]
  if (!leader || leader.removed_at) return null
  return { id: String(leader.id), label: String(leader.label), team_id: team?.id ? String(team.id) : null }
}

/**
 * Private Hub notice. The schema allows one pending notice per sender/recipient pair: a newer read notice replaces an
 * informational one (interest, decision), but never a pending request or a turn alert, which keep their own meaning.
 */
async function notify(sql: Sql, input: { source: Record<string, any>; recipient: string; cause: string; turn: string; team_id: string | null; text: string }) {
  const insert = () => sql.query(`INSERT OR IGNORE INTO chat_status_notices(id,session_id,turn_id,cause,channel_id,team_id,recipient_id,text)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [randomUUID(), input.source.id, input.turn, input.cause, input.source.channel_id, input.team_id, input.recipient, input.text.slice(0, 4000)])
  if ((await insert()).length) return true
  const replaced = await sql.query(`UPDATE chat_status_notices SET cancelled_at=now(),error='Reemplazado por un aviso de lectura más reciente'
    WHERE session_id=$1 AND recipient_id=$2 AND handled_at IS NULL AND cancelled_at IS NULL AND cause IN ('read_interest','read_decision') RETURNING id`, [input.source.id, input.recipient])
  return replaced.length > 0 && (await insert()).length > 0
}
const notNotified = "El Hub no pudo dejarle un aviso nuevo a tu líder (ya tiene otro pendiente tuyo). Mencionalo en tu hilo de trabajo con este request_id."

/** Read notices stay valid while their request still needs that recipient. Called from cancelInvalidTurnAlerts. */
export async function readNoticeValid(sql: Sql, notice: Record<string, any>) {
  const recipient = (await sql.query("SELECT 1 FROM chat_sessions WHERE id=$1 AND closed_at IS NULL AND removed_at IS NULL", [notice.recipient_id])).length > 0
  if (!recipient) return false
  if (notice.cause !== "read_request") return true
  const request = (await sql.query("SELECT state FROM chat_read_requests WHERE id=$1", [String(notice.turn_id).slice("read_request:".length)]))[0]
  if (request?.state !== "pending_leader") return false
  const source = (await sql.query("SELECT * FROM chat_sessions WHERE id=$1", [notice.session_id]))[0]
  return Boolean(source && (await requesterLeader(sql, source))?.id === notice.recipient_id)
}

export async function readInterest(sql: Sql, who: Record<string, any>, input: { channel_id: string; reason: string }) {
  const channel = (await sql.query("SELECT id,name,deleted_at,kind,activated_at FROM chat_channels WHERE id=$1", [input.channel_id]))[0]
  check(channel && !channel.deleted_at && (channel.kind !== "virtual" || channel.activated_at), "Canal inexistente.", 404)
  const own = await sessionProjectId(sql, who.id), project = await channelProjectId(sql, channel.id)
  check(own && project === own, "Ese canal no es de tu proyecto. Para leer otro proyecto usá memory_chat_read_request.", 403)
  const sent = (await sql.query(`SELECT count(*) AS total,COALESCE(SUM(CASE WHEN channel_id=$2 THEN 1 ELSE 0 END),0) AS channel FROM chat_authority_events
    WHERE kind='read_interest' AND actor_session_id=$1 AND created_at>$3`, [who.id, channel.id, new Date(Date.now() - READ_INTEREST_WINDOW_MS).toISOString()]))[0]!
  check(Number(sent.channel) < READ_INTEREST_PER_CHANNEL && Number(sent.total) < READ_INTEREST_PER_SESSION,
    "Ya avisaste a tu líder de este interés hace poco; esperá su respuesta antes de repetirlo.", 429)
  const membership = await channelMembership(sql, who.id, channel.id)
  const leader = await requesterLeader(sql, who)
  const audit = await recordAuthorityEvent(sql, { kind: "read_interest", reason: input.reason, channel_id: channel.id, project_id: project,
    actor_session_id: who.id, target_session_id: leader?.id ?? null, evidence: { membership, requester_channel_id: who.channel_id } })
  let notified = false
  if (leader && leader.id !== who.id && !membership) notified = await notify(sql, { source: who, recipient: leader.id, cause: "read_interest", turn: `read_interest:${audit.id}`, team_id: leader.team_id,
    text: `${who.label} wants to follow channel «${channel.name}» (${channel.id}) of your project. Reason: ${input.reason}\nIt can already read it but cannot write there. Decide whether to involve it; no action is required. Mark this notice handled with memory_chat_ack.` })
  return { channel_id: channel.id, readable: true, writable: Boolean(membership), leader_id: leader?.id ?? null, notified, audit_id: audit.id }
}

export async function readRequest(sql: Sql, who: Record<string, any>, input: { project_id: string; reason: string }) {
  const target = (await sql.query("SELECT id,title FROM entities WHERE id=$1 AND kind='project'", [input.project_id]))[0]
  check(target, "Proyecto inexistente.", 404)
  const own = await sessionProjectId(sql, who.id)
  check(own !== target.id, "Ya podés leer los canales de tu propio proyecto; para avisar a tu líder usá memory_chat_read_interest.", 409)
  const active = (await sql.query(`SELECT g.id,g.expires_at FROM chat_read_grants g JOIN chat_sessions s ON s.id=g.session_id
    WHERE g.session_id=$1 AND g.project_id=$2 AND ${grantValid.replace("$CUTOFF", "$3")}`, [who.id, target.id, graceCutoff()]))[0]
  if (active) return { state: "granted", grant_id: active.id, expires_at: active.expires_at, project_id: target.id }
  const open = (await sql.query("SELECT * FROM chat_read_requests WHERE requester_session_id=$1 AND target_project_id=$2 AND state IN ('pending_leader','pending_person')", [who.id, target.id]))[0]
  if (open) return { request_id: open.id, state: open.state, project_id: target.id, notified: false }
  const leader = await requesterLeader(sql, who)
  check(leader, "Tu canal no tiene un líder reconocido que pueda decidir el pedido.", 409)
  const requestId = randomUUID()
  await sql.query(`INSERT INTO chat_read_requests(id,requester_session_id,requester_channel_id,requester_project_id,target_project_id,leader_session_id,team_id,reason,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending_leader')`, [requestId, who.id, who.channel_id, own, target.id, leader.id, leader.team_id, input.reason])
  await recordAuthorityEvent(sql, { kind: "read_request", reason: input.reason, channel_id: who.channel_id, project_id: target.id, actor_session_id: who.id,
    target_session_id: leader.id, evidence: { request_id: requestId, requester_project_id: own } })
  const notified = leader.id !== who.id && await notify(sql, { source: who, recipient: leader.id, cause: "read_request", turn: `read_request:${requestId}`, team_id: leader.team_id,
    text: `${who.label} asks to read the channels of project «${target.title}». Reason: ${input.reason}\nIf the task needs it, ask the person in your CLI and record the answer with memory_chat_read_decide request_id=${requestId} (decision grant or reject, person_instruction quoting the person). Otherwise reject it with the reason.` })
  return { request_id: requestId, state: "pending_leader", project_id: target.id, leader_id: leader.id, notified, ...(notified || leader.id === who.id ? {} : { next_action: notNotified }) }
}

/** The leader the Hub recomputes now: one replaced since the request (takeover, designation) cannot decide or revoke for that session. */
async function assertRequesterLeader(sql: Sql, who: Record<string, any>, requesterId: string, message: string) {
  const requester = (await sql.query("SELECT * FROM chat_sessions WHERE id=$1", [requesterId]))[0]
  check(requester, "La sesión que pidió acceso no existe.", 404)
  check((await requesterLeader(sql, requester))?.id === who.id, message, 403)
  return requester
}

/**
 * Records the leader's decision on a cross-project read request. The person decides in the leader's CLI, the only
 * approval path; the Hub audits person_instruction as the leader's declaration.
 */
export async function readDecide(sql: Sql, who: Record<string, any>, input: { request_id: string; decision: "grant" | "reject"; person_instruction?: string | undefined; reason?: string | undefined }, now = Date.now()) {
  const request = (await sql.query(`SELECT r.*,dst.title AS target_title FROM chat_read_requests r JOIN entities dst ON dst.id=r.target_project_id WHERE r.id=$1`, [input.request_id]))[0]
  check(request, "Pedido inexistente.", 404)
  check(request.state === "pending_leader", "El pedido ya fue resuelto.", 409)
  const requester = await assertRequesterLeader(sql, who, request.requester_session_id, "Sólo el líder actual del canal o equipo de quien pidió puede decidir este pedido.")
  // A team member leads its own virtual channel but has no person in its CLI: its own request needs its coordinator.
  if (requester.id === who.id) check(who.capability !== "hub_fleet" && !(await sql.query("SELECT 1 FROM chat_team_members WHERE session_id=$1 LIMIT 1", [who.id])).length,
    "Un miembro de equipo no decide su propio pedido de lectura: lo decide su coordinador.", 403)
  const instruction = input.person_instruction ?? null
  await sql.query("UPDATE chat_status_notices SET handled_at=COALESCE(handled_at,now()) WHERE turn_id=$1 AND recipient_id=$2", [`read_request:${request.id}`, who.id])
  if (input.decision === "reject") {
    check((await sql.query(`UPDATE chat_read_requests SET state='rejected',decided_at=now(),decided_by_session=$2,person_instruction=$3,decision_note=$4
      WHERE id=$1 AND state='pending_leader' RETURNING id`, [request.id, who.id, instruction, input.reason ?? null])).length, "El pedido ya fue resuelto.", 409)
    await recordAuthorityEvent(sql, { kind: "read_rejected", reason: input.reason ?? instruction ?? "Rechazado por el líder", channel_id: request.requester_channel_id,
      project_id: request.target_project_id, actor_session_id: who.id, target_session_id: requester.id,
      evidence: { request_id: request.id, approval_source: "coordinator_declaration", person_instruction: instruction } })
    if (!requester.closed_at && !requester.removed_at) await notify(sql, { source: requester, recipient: requester.id, cause: "read_decision", turn: `read_decision:${request.id}`, team_id: null,
      text: `Your leader declined your request to read the channels of project «${request.target_title}».${input.reason ? ` Reason: ${input.reason}` : ""}` })
    return { request_id: request.id, state: "rejected" }
  }
  check(!requester.closed_at && !requester.removed_at, "La sesión que pidió acceso ya no está activa; el pedido no puede otorgarse.", 409)
  check((await sql.query(`UPDATE chat_read_requests SET state='granted',decided_at=now(),decided_by_session=$2,person_instruction=$3
    WHERE id=$1 AND state='pending_leader' RETURNING id`, [request.id, who.id, instruction])).length, "El pedido ya fue resuelto.", 409)
  const grantId = randomUUID(), expiresAt = new Date(now + READ_GRANT_MAX_TTL_MS).toISOString()
  await sql.query("INSERT INTO chat_read_grants(id,request_id,session_id,project_id,granted_by_session,granted_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [grantId, request.id, requester.id, request.target_project_id, who.id, new Date(now).toISOString(), expiresAt])
  await recordAuthorityEvent(sql, { kind: "read_granted", reason: instruction!, channel_id: request.requester_channel_id, project_id: request.target_project_id,
    actor_session_id: who.id, target_session_id: requester.id,
    evidence: { request_id: request.id, grant_id: grantId, expires_at: expiresAt, max_ttl_ms: READ_GRANT_MAX_TTL_MS, approval_source: "coordinator_declaration" } })
  await notify(sql, { source: requester, recipient: requester.id, cause: "read_decision", turn: `read_decision:${request.id}`, team_id: null,
    text: `Your leader granted you, with the person's approval, read-only access to the channels of project «${request.target_title}» until ${expiresAt}. It ends when your work completes or your session closes or goes offline. You still cannot write there.` })
  return { request_id: request.id, state: "granted", grant: { id: grantId, project_id: request.target_project_id, session_id: requester.id, expires_at: expiresAt } }
}

export async function readRevoke(sql: Sql, who: Record<string, any>, input: { grant_id: string; reason: string }) {
  const grant = (await sql.query(`SELECT g.*,p.title AS project_title FROM chat_read_grants g JOIN entities p ON p.id=g.project_id WHERE g.id=$1`, [input.grant_id]))[0]
  check(grant, "El permiso no existe.", 404)
  check(!grant.revoked_at, "El permiso ya terminó.", 409)
  const requester = await assertRequesterLeader(sql, who, grant.session_id, "Sólo el líder actual del canal o equipo de quien tiene el permiso puede revocarlo.")
  check(await revokeReadGrant(sql, grant.id, input.reason, { session_id: who.id }), "El permiso ya terminó.", 409)
  if (!requester.closed_at && !requester.removed_at) await notify(sql, { source: requester, recipient: requester.id, cause: "read_decision", turn: `read_revoked:${grant.id}`, team_id: null,
    text: `Your leader ended your read-only access to the channels of project «${grant.project_title}». Reason: ${input.reason}` })
  return { grant_id: grant.id, revoked: true }
}

export async function personReadRequests(sql: Sql, filter: { state?: string | undefined; project_id?: string | undefined; limit: number; offset: number }) {
  const where = `($1 IS NULL OR r.state=$1) AND ($2 IS NULL OR r.target_project_id=$2 OR r.requester_project_id=$2)`
  const args = [filter.state ?? null, filter.project_id ?? null]
  const total = Number((await sql.query(`SELECT count(*) AS n FROM chat_read_requests r WHERE ${where}`, args))[0]!.n)
  const items = await sql.query(`SELECT r.id,r.state,r.reason,r.created_at,r.elevated_at,r.elevation_note,r.decided_at,r.decision_note,
      r.decided_by_session,d.label AS decided_by_label,r.person_instruction,
      r.requester_session_id,s.nickname AS requester_nickname,s.label AS requester_label,s.cli_kind AS requester_cli,
      r.requester_project_id,src.title AS requester_project_title,r.target_project_id,dst.title AS target_project_title,
      r.leader_session_id,l.label AS leader_label,r.elevated_by,e.label AS elevated_by_label,
      g.id AS grant_id,g.expires_at AS grant_expires_at,g.revoked_at AS grant_revoked_at
    FROM chat_read_requests r JOIN chat_sessions s ON s.id=r.requester_session_id JOIN entities dst ON dst.id=r.target_project_id
    LEFT JOIN entities src ON src.id=r.requester_project_id LEFT JOIN chat_sessions l ON l.id=r.leader_session_id
    LEFT JOIN chat_sessions e ON e.id=r.elevated_by LEFT JOIN chat_sessions d ON d.id=r.decided_by_session LEFT JOIN chat_read_grants g ON g.request_id=r.id
    WHERE ${where} ORDER BY r.created_at DESC,r.id LIMIT $3 OFFSET $4`, [...args, filter.limit, filter.offset])
  return { items, total, limit: filter.limit, offset: filter.offset }
}

export async function personReadGrants(sql: Sql, filter: { active: boolean; project_id?: string | undefined; limit: number; offset: number }) {
  const where = `($1=0 OR g.revoked_at IS NULL) AND ($2 IS NULL OR g.project_id=$2)`
  const args = [filter.active ? 1 : 0, filter.project_id ?? null]
  const total = Number((await sql.query(`SELECT count(*) AS n FROM chat_read_grants g WHERE ${where}`, args))[0]!.n)
  const items = await sql.query(`SELECT g.*,s.label AS session_label,p.title AS project_title,r.reason,r.confirmation_phrase,r.person_instruction,l.label AS granted_by_label
    FROM chat_read_grants g JOIN chat_sessions s ON s.id=g.session_id JOIN entities p ON p.id=g.project_id JOIN chat_read_requests r ON r.id=g.request_id
    LEFT JOIN chat_sessions l ON l.id=g.granted_by_session
    WHERE ${where} ORDER BY g.granted_at DESC,g.id LIMIT $3 OFFSET $4`, [...args, filter.limit, filter.offset])
  return { items, total, limit: filter.limit, offset: filter.offset }
}

export async function revokeReadGrant(sql: Sql, grantId: string, reason: string, actor: { session_id: string } | null, evidence: Record<string, unknown> = {}) {
  const grant = (await sql.query("UPDATE chat_read_grants SET revoked_at=now(),revoke_reason=$2 WHERE id=$1 AND revoked_at IS NULL RETURNING *", [grantId, reason]))[0]
  if (!grant) return null
  const request = (await sql.query("SELECT requester_channel_id FROM chat_read_requests WHERE id=$1", [grant.request_id]))[0]
  await recordAuthorityEvent(sql, { kind: "read_revoked", reason, channel_id: request?.requester_channel_id ?? null, project_id: grant.project_id,
    actor_session_id: actor?.session_id ?? null, target_session_id: grant.session_id, evidence: { grant_id: grant.id, request_id: grant.request_id, ...evidence } })
  return grant
}

/** Revokes every grant whose validity condition no longer holds and cancels stale requests, each with an audit entry. */
export async function sweepReadAccess(sql: Sql, now = Date.now()) {
  const cutoff = graceCutoff(now)
  const stale = await sql.query(`SELECT g.id,g.expires_at,g.granted_at,s.closed_at,s.removed_at,s.lease_until,s.last_seen_at,${workDone} AS work_done
    FROM chat_read_grants g JOIN chat_sessions s ON s.id=g.session_id
    WHERE g.revoked_at IS NULL AND NOT (${grantValid.replace("$CUTOFF", "$1").replace("g.expires_at>now()", "g.expires_at>$2")})`, [cutoff, new Date(now).toISOString()])
  for (const grant of stale) {
    const reason = grant.removed_at ? "session_removed" : grant.closed_at ? "session_closed" : grant.expires_at <= new Date(now).toISOString() ? "max_ttl"
      : grant.work_done ? "work_completed" : "liveness_lost"
    const evidence = reason === "liveness_lost"
      ? { lease_until: grant.lease_until, last_seen_at: grant.last_seen_at, offline_ms: grant.lease_until ? now - Date.parse(grant.lease_until) : null, threshold_ms: READ_GRANT_LIVENESS_GRACE_MS }
      : reason === "max_ttl" ? { expires_at: grant.expires_at, granted_at: grant.granted_at, max_ttl_ms: READ_GRANT_MAX_TTL_MS }
        : reason === "work_completed" ? { granted_at: grant.granted_at } : { closed_at: grant.closed_at, removed_at: grant.removed_at }
    await revokeReadGrant(sql, grant.id, reason, null, evidence)
  }
  const requests = await sql.query(`SELECT r.id,r.requester_channel_id,r.target_project_id,r.requester_session_id,s.closed_at,s.removed_at,r.created_at
    FROM chat_read_requests r JOIN chat_sessions s ON s.id=r.requester_session_id
    WHERE r.state IN ('pending_leader','pending_person') AND (s.closed_at IS NOT NULL OR s.removed_at IS NOT NULL OR r.created_at<=$1)`, [new Date(now - READ_REQUEST_PENDING_TTL_MS).toISOString()])
  for (const request of requests) {
    if (!(await sql.query("UPDATE chat_read_requests SET state='cancelled',decided_at=now() WHERE id=$1 AND state IN ('pending_leader','pending_person') RETURNING id", [request.id])).length) continue
    await recordAuthorityEvent(sql, { kind: "read_cancelled", reason: request.closed_at || request.removed_at ? "session_ended" : "pending_ttl", channel_id: request.requester_channel_id,
      project_id: request.target_project_id, target_session_id: request.requester_session_id, evidence: { request_id: request.id, created_at: request.created_at, pending_ttl_ms: READ_REQUEST_PENDING_TTL_MS } })
  }
  return { revoked: stale.length, cancelled: requests.length }
}

