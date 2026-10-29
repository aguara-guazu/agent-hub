import { randomUUID } from "node:crypto"
import { z } from "zod"
import { check, id } from "./contracts.js"
import type { Sql } from "./database.js"
import { ACTIVE_TEAM_STATES, channelMembership, channelProjectId, recordAuthorityEvent, sessionProjectId, teamChannelIds } from "./chat-access.js"

/** Hard cap of a cross-project read grant, even while the agent keeps working. */
export const READ_GRANT_MAX_TTL_MS = 8 * 60 * 60 * 1000
/** A grant ends once the Hub has not renewed the session lease for this long (lease_until is renewed every few seconds while connected). */
export const READ_GRANT_LIVENESS_GRACE_MS = 5 * 60 * 1000
/** An unanswered request is cancelled after this, so a stale elevation cannot be confirmed days later. */
export const READ_REQUEST_PENDING_TTL_MS = 24 * 60 * 60 * 1000
export const READ_PHRASE_MAX = 500

const activeStates = ACTIVE_TEAM_STATES.map(state => `'${state}'`).join(",")
const key = z.string().min(32).max(200).optional()
export const readAccessDefinitions = {
  chat_read_interest: ["Tell your leader you want to follow another channel of your own project. You can already read it (memory_chat_threads/memory_chat_read); reading never lets you write, mention or take part there. Leaders need not call this.",
    z.object({ session_key: key, channel_id: id, reason: z.string().trim().min(1).max(1000) }).strict()],
  chat_read_request: ["Ask to read the channels of another project. Your leader must elevate it with memory_chat_read_elevate and only the person grants it, in the Hub UI. A grant is read-only, temporary and ends when your work completes, your session closes or goes offline. Never claim the person approved: the Hub records it.",
    z.object({ session_key: key, project_id: id, reason: z.string().trim().min(1).max(1000) }).strict()],
  chat_read_elevate: ["Leader only: forward a pending cross-project read request of your channel or team member to the person. It stays pending until the person confirms it in the Hub UI; you cannot grant it.",
    z.object({ session_key: key, request_id: id, note: z.string().trim().min(1).max(1000).optional() }).strict()],
} satisfies Record<string, [string, z.ZodType]>

const graceCutoff = (now = Date.now()) => new Date(now - READ_GRANT_LIVENESS_GRACE_MS).toISOString()

/** Shared by reads and the sweep: a grant counts only while every condition holds, even before the sweep revokes it. */
const grantValid = `g.revoked_at IS NULL AND g.expires_at>now() AND s.closed_at IS NULL AND s.removed_at IS NULL
  AND s.lease_until IS NOT NULL AND s.lease_until>$CUTOFF
  AND NOT (EXISTS(SELECT 1 FROM chat_work_state w WHERE w.session_id=g.session_id AND w.status='completed' AND w.updated_at>g.granted_at)
    AND NOT EXISTS(SELECT 1 FROM chat_work_state w WHERE w.session_id=g.session_id AND w.status<>'completed'))`

export interface ReadScope { projects: string[]; channels: string[] }

/** What an agent session may read. The person (no agent identity) is never scoped. */
export async function readScope(sql: Sql, sessionId: string): Promise<ReadScope> {
  const own = await sessionProjectId(sql, sessionId)
  const grants = await sql.query(`SELECT DISTINCT g.project_id FROM chat_read_grants g JOIN chat_sessions s ON s.id=g.session_id
    WHERE g.session_id=$1 AND ${grantValid.replace("$CUTOFF", "$2")}`, [sessionId, graceCutoff()])
  const session = (await sql.query("SELECT channel_id FROM chat_sessions WHERE id=$1", [sessionId]))[0]
  const led = await sql.query("SELECT id FROM chat_channels WHERE leader_id=$1", [sessionId])
  const channels = new Set<string>([...(session ? [String(session.channel_id)] : []), ...led.map(row => String(row.id)), ...await teamChannelIds(sql, sessionId)])
  return { projects: [...new Set([...(own ? [own] : []), ...grants.map(row => String(row.project_id))])], channels: [...channels] }
}

export async function canReadChannel(sql: Sql, sessionId: string, channelId: string, scope?: ReadScope) {
  const value = scope ?? await readScope(sql, sessionId)
  if (value.channels.includes(channelId)) return true
  const project = await channelProjectId(sql, channelId)
  return Boolean(project && value.projects.includes(project))
}

export const readDenied = "No tenés acceso de lectura a este canal: es de otro proyecto. Pedí acceso con memory_chat_read_request; tu líder lo eleva y solo la persona lo otorga desde el Hub."

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

/** Private Hub notice. Best effort: one pending notice per sender/recipient pair is a schema invariant. */
async function notify(sql: Sql, input: { source: Record<string, any>; recipient: string; cause: string; turn: string; team_id: string | null; text: string }) {
  const rows = await sql.query(`INSERT OR IGNORE INTO chat_status_notices(id,session_id,turn_id,cause,channel_id,team_id,recipient_id,text)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [randomUUID(), input.source.id, input.turn, input.cause, input.source.channel_id, input.team_id, input.recipient, input.text.slice(0, 4000)])
  return rows.length > 0
}

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
  check(leader, "Tu canal no tiene un líder reconocido que pueda elevar el pedido. Pedile a la persona que designe uno.", 409)
  const requestId = randomUUID()
  await sql.query(`INSERT INTO chat_read_requests(id,requester_session_id,requester_channel_id,requester_project_id,target_project_id,leader_session_id,team_id,reason,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending_leader')`, [requestId, who.id, who.channel_id, own, target.id, leader.id, leader.team_id, input.reason])
  await recordAuthorityEvent(sql, { kind: "read_request", reason: input.reason, channel_id: who.channel_id, project_id: target.id, actor_session_id: who.id,
    target_session_id: leader.id, evidence: { request_id: requestId, requester_project_id: own } })
  const notified = leader.id !== who.id && await notify(sql, { source: who, recipient: leader.id, cause: "read_request", turn: `read_request:${requestId}`, team_id: leader.team_id,
    text: `${who.label} asks to read the channels of project «${target.title}». Reason: ${input.reason}\nIf the task needs it, forward it to the person with memory_chat_read_elevate request_id=${requestId}; only the person can grant it in the Hub. Otherwise tell the agent why not.` })
  return { request_id: requestId, state: "pending_leader", project_id: target.id, leader_id: leader.id, notified }
}

export async function readElevate(sql: Sql, who: Record<string, any>, input: { request_id: string; note?: string | undefined }) {
  const request = (await sql.query("SELECT * FROM chat_read_requests WHERE id=$1", [input.request_id]))[0]
  check(request, "Pedido inexistente.", 404)
  check(request.state === "pending_leader", request.state === "pending_person" ? "El pedido ya está esperando a la persona." : "El pedido ya no está pendiente.", 409)
  const requester = (await sql.query("SELECT * FROM chat_sessions WHERE id=$1", [request.requester_session_id]))[0]
  check(requester && !requester.closed_at && !requester.removed_at, "La sesión que pidió acceso ya no está activa.", 409)
  // Recomputed now: a leader replaced since the request (takeover, designation) cannot elevate it.
  check((await requesterLeader(sql, requester))?.id === who.id, "Sólo el líder actual del canal o equipo de quien pidió puede elevar este pedido.", 403)
  await sql.query("UPDATE chat_read_requests SET state='pending_person',elevated_at=now(),elevated_by=$2,elevation_note=$3 WHERE id=$1 AND state='pending_leader'", [request.id, who.id, input.note ?? null])
  await recordAuthorityEvent(sql, { kind: "read_elevated", reason: input.note ?? "Elevado a la persona", channel_id: request.requester_channel_id, project_id: request.target_project_id,
    actor_session_id: who.id, target_session_id: requester.id, evidence: { request_id: request.id } })
  await sql.query("UPDATE chat_status_notices SET handled_at=COALESCE(handled_at,now()) WHERE turn_id=$1 AND recipient_id=$2", [`read_request:${request.id}`, who.id])
  return { request_id: request.id, state: "pending_person" }
}

const normalize = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[«»"“”'‘’`´.,;:!¡¿?()[\]]/g, " ").replace(/\s+/g, " ").trim()
const PHRASES = [
  /^confirmo que (.+?) (?:puede|pueda) (?:ver|leer) (?:los|todos los) canales (?:del proyecto|de proyecto|del|de) (.+)$/,
  /^i confirm that (.+?) (?:can|may) (?:see|read) (?:the|all the|all) channels (?:of the project|of project|of) (.+)$/,
]

/**
 * The person's single-message confirmation. Structure plus names: the target project exactly, and the requester by nickname
 * or by its project. Only reachable from the authenticated owner route; an agent claiming approval never gets here.
 */
export function validateGrantPhrase(phrase: string, names: { target: string; nickname: string | null; requesterProject: string | null }) {
  const text = normalize(phrase)
  const match = PHRASES.map(pattern => text.match(pattern)).find(Boolean)
  if (!match) return { ok: false as const, code: "structure" }
  const target = normalize(names.target)
  if (!target || match[2] !== target) return { ok: false as const, code: "target" }
  const subject = ` ${match[1]} `
  const named = (value: string | null) => Boolean(value && normalize(value) && subject.includes(` ${normalize(value)} `))
  // A requester project titled like the target would let the target name stand in for the requester.
  const byProject = names.requesterProject && normalize(names.requesterProject) !== target && named(names.requesterProject)
  if (!named(names.nickname) && !byProject) return { ok: false as const, code: "requester" }
  return { ok: true as const }
}

const phraseErrors: Record<string, string> = {
  structure: "La frase debe decir «confirmo que el agente … del proyecto … puede ver los canales del proyecto …».",
  target: "La frase debe nombrar exactamente el proyecto de destino.",
  requester: "La frase debe nombrar al agente que pidió acceso o a su proyecto.",
}

export async function personReadRequests(sql: Sql, filter: { state?: string | undefined; project_id?: string | undefined; limit: number; offset: number }) {
  const where = `($1 IS NULL OR r.state=$1) AND ($2 IS NULL OR r.target_project_id=$2 OR r.requester_project_id=$2)`
  const args = [filter.state ?? null, filter.project_id ?? null]
  const total = Number((await sql.query(`SELECT count(*) AS n FROM chat_read_requests r WHERE ${where}`, args))[0]!.n)
  const items = await sql.query(`SELECT r.id,r.state,r.reason,r.created_at,r.elevated_at,r.elevation_note,r.decided_at,r.decision_note,
      r.requester_session_id,s.nickname AS requester_nickname,s.label AS requester_label,s.cli_kind AS requester_cli,
      r.requester_project_id,src.title AS requester_project_title,r.target_project_id,dst.title AS target_project_title,
      r.leader_session_id,l.label AS leader_label,r.elevated_by,e.label AS elevated_by_label,
      g.id AS grant_id,g.expires_at AS grant_expires_at,g.revoked_at AS grant_revoked_at
    FROM chat_read_requests r JOIN chat_sessions s ON s.id=r.requester_session_id JOIN entities dst ON dst.id=r.target_project_id
    LEFT JOIN entities src ON src.id=r.requester_project_id LEFT JOIN chat_sessions l ON l.id=r.leader_session_id
    LEFT JOIN chat_sessions e ON e.id=r.elevated_by LEFT JOIN chat_read_grants g ON g.request_id=r.id
    WHERE ${where} ORDER BY r.created_at DESC,r.id LIMIT $3 OFFSET $4`, [...args, filter.limit, filter.offset])
  return { items, total, limit: filter.limit, offset: filter.offset }
}

export async function personReadGrants(sql: Sql, filter: { active: boolean; project_id?: string | undefined; limit: number; offset: number }) {
  const where = `($1=0 OR g.revoked_at IS NULL) AND ($2 IS NULL OR g.project_id=$2)`
  const args = [filter.active ? 1 : 0, filter.project_id ?? null]
  const total = Number((await sql.query(`SELECT count(*) AS n FROM chat_read_grants g WHERE ${where}`, args))[0]!.n)
  const items = await sql.query(`SELECT g.*,s.label AS session_label,p.title AS project_title,r.reason,r.confirmation_phrase
    FROM chat_read_grants g JOIN chat_sessions s ON s.id=g.session_id JOIN entities p ON p.id=g.project_id JOIN chat_read_requests r ON r.id=g.request_id
    WHERE ${where} ORDER BY g.granted_at DESC,g.id LIMIT $3 OFFSET $4`, [...args, filter.limit, filter.offset])
  return { items, total, limit: filter.limit, offset: filter.offset }
}

async function pendingForPerson(sql: Sql, requestId: string) {
  const request = (await sql.query(`SELECT r.*,s.nickname,s.label,s.closed_at,s.removed_at,dst.title AS target_title,src.title AS requester_title
    FROM chat_read_requests r JOIN chat_sessions s ON s.id=r.requester_session_id JOIN entities dst ON dst.id=r.target_project_id
    LEFT JOIN entities src ON src.id=r.requester_project_id WHERE r.id=$1`, [requestId]))[0]
  check(request, "Pedido inexistente.", 404)
  check(request.state === "pending_person", request.state === "pending_leader" ? "El líder todavía no elevó este pedido." : "El pedido ya fue resuelto.", 409)
  return request
}

export async function confirmReadRequest(sql: Sql, requestId: string, phrase: string, userId: string, now = Date.now()) {
  const request = await pendingForPerson(sql, requestId)
  check(!request.closed_at && !request.removed_at, "La sesión que pidió acceso ya no está activa; el pedido no puede otorgarse.", 409)
  const verdict = validateGrantPhrase(phrase, { target: request.target_title, nickname: request.nickname, requesterProject: request.requester_title })
  check(verdict.ok, verdict.ok ? "" : phraseErrors[verdict.code]!, 400)
  const decided = await sql.query("UPDATE chat_read_requests SET state='granted',decided_at=now(),decided_by_user=$2,confirmation_phrase=$3 WHERE id=$1 AND state='pending_person' RETURNING id", [request.id, userId, phrase.trim()])
  check(decided.length, "El pedido ya fue resuelto.", 409)
  const grantId = randomUUID(), expiresAt = new Date(now + READ_GRANT_MAX_TTL_MS).toISOString()
  await sql.query("INSERT INTO chat_read_grants(id,request_id,session_id,project_id,granted_by_user,granted_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [grantId, request.id, request.requester_session_id, request.target_project_id, userId, new Date(now).toISOString(), expiresAt])
  await recordAuthorityEvent(sql, { kind: "read_granted", reason: phrase.trim(), channel_id: request.requester_channel_id, project_id: request.target_project_id,
    actor_user_id: userId, target_session_id: request.requester_session_id, evidence: { request_id: request.id, grant_id: grantId, expires_at: expiresAt, max_ttl_ms: READ_GRANT_MAX_TTL_MS } })
  const requester = (await sql.query("SELECT * FROM chat_sessions WHERE id=$1", [request.requester_session_id]))[0]!
  await notify(sql, { source: requester, recipient: requester.id, cause: "read_decision", turn: `read_decision:${request.id}`, team_id: null,
    text: `The person granted you read-only access to the channels of project «${request.target_title}» until ${expiresAt}. It ends when your work completes or your session closes or goes offline. You still cannot write there.` })
  return { request_id: request.id, state: "granted", grant: { id: grantId, project_id: request.target_project_id, session_id: request.requester_session_id, expires_at: expiresAt } }
}

export async function rejectReadRequest(sql: Sql, requestId: string, userId: string, note?: string) {
  const request = await pendingForPerson(sql, requestId)
  check((await sql.query("UPDATE chat_read_requests SET state='rejected',decided_at=now(),decided_by_user=$2,decision_note=$3 WHERE id=$1 AND state='pending_person' RETURNING id", [request.id, userId, note ?? null])).length, "El pedido ya fue resuelto.", 409)
  await recordAuthorityEvent(sql, { kind: "read_rejected", reason: note ?? "Rechazado por la persona", channel_id: request.requester_channel_id, project_id: request.target_project_id,
    actor_user_id: userId, target_session_id: request.requester_session_id, evidence: { request_id: request.id } })
  const requester = (await sql.query("SELECT * FROM chat_sessions WHERE id=$1 AND closed_at IS NULL AND removed_at IS NULL", [request.requester_session_id]))[0]
  if (requester) await notify(sql, { source: requester, recipient: requester.id, cause: "read_decision", turn: `read_decision:${request.id}`, team_id: null,
    text: `The person declined your request to read the channels of project «${request.target_title}».` })
  return { request_id: request.id, state: "rejected" }
}

export async function revokeReadGrant(sql: Sql, grantId: string, reason: string, actor: { user_id: string } | null, evidence: Record<string, unknown> = {}) {
  const grant = (await sql.query("UPDATE chat_read_grants SET revoked_at=now(),revoke_reason=$2 WHERE id=$1 AND revoked_at IS NULL RETURNING *", [grantId, reason]))[0]
  if (!grant) return null
  const request = (await sql.query("SELECT requester_channel_id FROM chat_read_requests WHERE id=$1", [grant.request_id]))[0]
  await recordAuthorityEvent(sql, { kind: "read_revoked", reason, channel_id: request?.requester_channel_id ?? null, project_id: grant.project_id,
    actor_user_id: actor?.user_id ?? null, target_session_id: grant.session_id, evidence: { grant_id: grant.id, request_id: grant.request_id, ...evidence } })
  return grant
}

/** Revokes every grant whose validity condition no longer holds and cancels stale requests, each with an audit entry. */
export async function sweepReadAccess(sql: Sql, now = Date.now()) {
  const cutoff = graceCutoff(now)
  const stale = await sql.query(`SELECT g.id,g.expires_at,g.granted_at,s.closed_at,s.removed_at,s.lease_until,s.last_seen_at,
      EXISTS(SELECT 1 FROM chat_work_state w WHERE w.session_id=g.session_id AND w.status='completed' AND w.updated_at>g.granted_at)
        AND NOT EXISTS(SELECT 1 FROM chat_work_state w WHERE w.session_id=g.session_id AND w.status<>'completed') AS work_done
    FROM chat_read_grants g JOIN chat_sessions s ON s.id=g.session_id
    WHERE g.revoked_at IS NULL AND NOT (${grantValid.replace("$CUTOFF", "$1").replace("g.expires_at>now()", "g.expires_at>$2")})`, [cutoff, new Date(now).toISOString()])
  for (const grant of stale) {
    const reason = grant.removed_at ? "session_removed" : grant.closed_at ? "session_closed" : grant.expires_at <= new Date(now).toISOString() ? "max_ttl"
      : grant.work_done ? "work_completed" : "liveness_lost"
    const offline = grant.lease_until ? now - Date.parse(grant.lease_until) : null
    await revokeReadGrant(sql, grant.id, reason, null, { lease_until: grant.lease_until, last_seen_at: grant.last_seen_at, offline_ms: offline, threshold_ms: READ_GRANT_LIVENESS_GRACE_MS })
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

