import { z } from "zod"
import { CHAT_AGENT_INACTIVITY_MS, CHAT_CHANNEL_ARCHIVE_IDLE_MS, CHAT_CHANNEL_ARCHIVE_PROPOSED_MS, CHAT_CHANNEL_ARCHIVE_SWEEP_MS, INTERHUB_CHANNEL_KIND,
  type ChatChannelArchiveCause, type ChatCleanAgentsResult, type ChatCleanupCandidate, type ChatProposeArchiveResult } from "@agenthub/shared"
import { check, id } from "./contracts.js"
import type { Sql } from "./database.js"
import { ACTIVE_TEAM_STATES, channelProjectId, recordAuthorityEvent } from "./chat-access.js"
import { NON_AGENT_CLI_KINDS } from "./chat-debate.js"
import { INTERHUB_REMOTE_CLI_KIND } from "./interhub/chat.js"

/** Spacing of activity writes per session; a cleaned session is always written so it is listed again at once. */
const ACTIVITY_WRITE_INTERVAL_MS = 15_000
const AUTOMATION_SCOPE = "automation:"
const nonAgentKinds = [...NON_AGENT_CLI_KINDS, INTERHUB_REMOTE_CLI_KIND].map(kind => `'${kind}'`).join(",")
const activeStates = ACTIVE_TEAM_STATES.map(state => `'${state}'`).join(",")
const hours = (ms: number) => ms / 3_600_000

const testOverride = (name: string, fallback: number) => {
  const value = process.env.NODE_ENV === "test" ? Number(process.env[name]) : NaN
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}
/** Production values are the shared constants; only a test process (NODE_ENV=test) may shorten them. */
export const wrapUpTiming = () => ({
  agentInactivityMs: testOverride("AGENTHUB_CHAT_AGENT_INACTIVITY_MS", CHAT_AGENT_INACTIVITY_MS),
  archiveIdleMs: testOverride("AGENTHUB_CHAT_ARCHIVE_IDLE_MS", CHAT_CHANNEL_ARCHIVE_IDLE_MS),
  archiveProposedMs: testOverride("AGENTHUB_CHAT_ARCHIVE_PROPOSED_MS", CHAT_CHANNEL_ARCHIVE_PROPOSED_MS),
  archiveSweepMs: testOverride("AGENTHUB_CHAT_ARCHIVE_SWEEP_MS", CHAT_CHANNEL_ARCHIVE_SWEEP_MS),
})

const key = z.string().min(32).max(200).optional()
const participant = z.string().min(8).max(200)
export const chatCleanAgentsInput = z.object({ session_key: key, channel_id: id.optional(), apply: z.boolean().default(false),
  participant_ids: z.array(participant).max(100).optional(), finished_ids: z.array(participant).max(100).default([]),
  reason: z.string().trim().min(1).max(1000).optional() }).strict()
export const chatProposeArchiveInput = z.object({ session_key: key, channel_id: id.optional(), reason: z.string().trim().min(1).max(1000) }).strict()

export const wrapUpDefinitions = {
  chat_clean_agents: [`Wrap up, leader only: clean the agent list of a channel you lead (channel_id; default your session channel). Without apply it only evaluates: each listed agent with last_activity_at as the Hub observed it (hooks, tool uses, Hub calls, reports; never what an agent claims). apply=true + reason hides agents with no activity for ${hours(CHAT_AGENT_INACTIVITY_MS)} h or more, and newer ones only if you list them in finished_ids because they were closed, finished their task and won't be used again; participant_ids limits the set. Never yourself or the displaced leader that may reclaim the channel. Keeps history, rights, inbox and mentions; any later activity lists the agent again and restarts its ${hours(CHAT_AGENT_INACTIVITY_MS)} h count. Kicked sessions and workers replaced with memory_team_control(clear) already leave the list. Not for inter-hub channels.`, chatCleanAgentsInput],
  chat_propose_archive: [`Wrap up, leader only, as your last action in a finished local channel you lead (channel_id; default your session channel), with a reason. The Hub archives a channel ${hours(CHAT_CHANNEL_ARCHIVE_IDLE_MS)} h after its last activity once none of its agents or its leader is connected; this proposal shortens it to ${hours(CHAT_CHANNEL_ARCHIVE_PROPOSED_MS)} h and your own connection no longer holds it (waiting_for lists agents still connected). Any later message, thread or work update, join or leadership change there cancels it. Archived channels leave the default memory_chat_channels list, keep history and read rules, and return to it when used. Not for inter-hub, automation or team worker channels.`, chatProposeArchiveInput],
} satisfies Record<string, [string, z.ZodType]>

/**
 * Records Hub-observed activity of a session on the server clock. Callers pass real activity only: hook events other than
 * Heartbeat, Watch and SessionEnd, authenticated collaboration calls and fleet protocol events. Leases, PID checks and fleet
 * probes prove connection and never call this.
 */
export async function markSessionActivity(sql: Sql, sessionId: string, now = Date.now()) {
  // Spacing never exceeds a tenth of the inactivity threshold, so a shortened test threshold keeps the same precision.
  const spacing = Math.min(ACTIVITY_WRITE_INTERVAL_MS, Math.floor(wrapUpTiming().agentInactivityMs / 10))
  await sql.query(`UPDATE chat_sessions SET activity_at=now() WHERE id=$1 AND removed_at IS NULL
    AND (activity_at IS NULL OR activity_at<$2 OR (dismissed_at IS NOT NULL AND activity_at<=dismissed_at))`,
  [sessionId, new Date(now - spacing).toISOString()])
}

/** Predicate on session alias `s`: false while a leader's cleanup stands, that is, until the session shows activity after it. */
export const LISTED_SESSION_SQL = "(s.dismissed_at IS NULL OR COALESCE(s.activity_at,s.created_at)>s.dismissed_at)"

/**
 * Last use of channel alias `c` as the Hub observed it: channel lifecycle, threads, messages, work reports and the activity of
 * its home sessions and team members. `exclude` is an SQL expression naming a session whose own activity does not count
 * (the archive proposer); its messages and work reports in the channel still count. leader_changed_at is left out on purpose:
 * a kick or a worker replacement releases leadership without using the channel; taking it goes through channelUsed.
 */
export const channelActivitySql = (exclude = "NULL") => `max(c.created_at,COALESCE(c.activated_at,c.created_at),COALESCE(c.unarchived_at,c.created_at),
  COALESCE((SELECT max(t.updated_at) FROM chat_threads t WHERE t.channel_id=c.id),c.created_at),
  COALESCE((SELECT max(m.created_at) FROM chat_threads t JOIN chat_messages m ON m.thread_id=t.id WHERE t.channel_id=c.id),c.created_at),
  COALESCE((SELECT max(w.updated_at) FROM chat_threads t JOIN chat_work_state w ON w.thread_id=t.id WHERE t.channel_id=c.id),c.created_at),
  COALESCE((SELECT max(COALESCE(s.activity_at,s.created_at)) FROM chat_sessions s WHERE s.channel_id=c.id AND s.removed_at IS NULL
    AND s.cli_kind NOT IN (${nonAgentKinds}) AND s.id IS NOT ${exclude}),c.created_at),
  COALESCE((SELECT max(COALESCE(s.activity_at,s.created_at)) FROM chat_team_members tm JOIN chat_team_plans p ON p.id=tm.team_id
    JOIN chat_sessions s ON s.id=tm.session_id WHERE p.master_channel_id=c.id AND s.removed_at IS NULL AND s.id IS NOT ${exclude}),c.created_at))`

/** Sessions of channel alias `c` that hold it open: connected home sessions, its leader and joined members of its live plans. */
const holdersSql = (exclude: string, now: string) => `s.closed_at IS NULL AND s.removed_at IS NULL AND s.lease_until>${now}
  AND s.cli_kind NOT IN (${nonAgentKinds}) AND s.id IS NOT ${exclude}
  AND (s.channel_id=c.id OR s.id=c.leader_id OR s.id IN (SELECT tm.session_id FROM chat_team_members tm JOIN chat_team_plans p ON p.id=tm.team_id
    WHERE p.master_channel_id=c.id AND tm.state='joined' AND p.state IN (${activeStates})))`
const connectedSql = (exclude = "NULL") => `EXISTS(SELECT 1 FROM chat_sessions s WHERE ${holdersSql(exclude, "$1")})`

/** Local channels the sweep may archive: never inter-hub, project automation, team worker or private (inactive virtual) ones. */
const ARCHIVABLE_SQL = `c.deleted_at IS NULL AND c.kind<>'${INTERHUB_CHANNEL_KIND}' AND (c.kind<>'virtual' OR c.activated_at IS NOT NULL)
  AND c.scope_key NOT LIKE '${AUTOMATION_SCOPE}%' AND NOT EXISTS(SELECT 1 FROM chat_team_members m WHERE m.channel_id=c.id)`

type Actor = { session_id?: string | null; user_id?: string | null }

async function cancelProposal(sql: Sql, channelId: string, cause: string, actor: Actor, evidence: Record<string, unknown> = {}) {
  const channel = (await sql.query("SELECT archive_proposed_at,archive_proposed_by FROM chat_channels WHERE id=$1 AND archive_proposed_at IS NOT NULL AND archived_at IS NULL", [channelId]))[0]
  if (!channel) return false
  await sql.query("UPDATE chat_channels SET archive_proposed_at=NULL,archive_proposed_by=NULL,archive_proposal_reason=NULL WHERE id=$1", [channelId])
  await recordAuthorityEvent(sql, { kind: "channel_archive_proposal_cancelled", channel_id: channelId, project_id: await channelProjectId(sql, channelId),
    actor_session_id: actor.session_id ?? null, actor_user_id: actor.user_id ?? null, target_session_id: channel.archive_proposed_by ?? null,
    reason: "Propuesta de archivado cancelada por un uso posterior del canal", evidence: { cause, proposed_at: channel.archive_proposed_at, ...evidence } })
  return true
}

async function unarchive(sql: Sql, channelId: string, cause: string, actor: Actor, evidence: Record<string, unknown> = {}) {
  const channel = (await sql.query("SELECT archived_at,archive_cause,archive_proposed_by FROM chat_channels WHERE id=$1 AND archived_at IS NOT NULL", [channelId]))[0]
  if (!channel) return false
  await sql.query(`UPDATE chat_channels SET archived_at=NULL,archive_cause=NULL,unarchived_at=now(),archive_proposed_at=NULL,archive_proposed_by=NULL,
    archive_proposal_reason=NULL WHERE id=$1`, [channelId])
  await recordAuthorityEvent(sql, { kind: "channel_unarchived", channel_id: channelId, project_id: await channelProjectId(sql, channelId),
    actor_session_id: actor.session_id ?? null, actor_user_id: actor.user_id ?? null, reason: "El canal archivado volvió a usarse",
    evidence: { cause, archived_at: channel.archived_at, archive_cause: channel.archive_cause, proposed_by: channel.archive_proposed_by ?? null, ...evidence } })
  return true
}

/** Explicit use of a channel (message, leadership): revives it at once and cancels a pending proposal. The sweep covers any other use. */
export async function channelUsed(sql: Sql, channelId: string, cause: "message" | "leadership" | "designation", actor: Actor) {
  const channel = (await sql.query("SELECT archived_at,archive_proposed_at FROM chat_channels WHERE id=$1", [channelId]))[0]
  if (!channel || (!channel.archived_at && !channel.archive_proposed_at)) return { unarchived: false, proposal_cancelled: false }
  const unarchived = await unarchive(sql, channelId, cause, actor)
  return { unarchived, proposal_cancelled: !unarchived && await cancelProposal(sql, channelId, cause, actor) }
}

export interface ArchiveSweepResult { archived: string[]; unarchived: string[]; proposals_cancelled: string[] }

/**
 * Idempotent and restart-safe: every decision is recomputed from durable timestamps inside one transaction. Proposals are
 * checked first so one cancelled by later use never shortens the delay; a revival restarts the 48 h count through unarchived_at.
 * The proposer's own activity is ignored for its proposal and for the archive it caused; its writes in the channel are not.
 */
export async function sweepChannelArchive(sql: Sql, now = Date.now(), archive = true): Promise<ArchiveSweepResult> {
  const at = new Date(now).toISOString(), timing = wrapUpTiming()
  const result: ArchiveSweepResult = { archived: [], unarchived: [], proposals_cancelled: [] }
  const proposals = await sql.query(`SELECT c.id,c.archive_proposed_at,${channelActivitySql("c.archive_proposed_by")} AS last_activity_at
    FROM chat_channels c WHERE c.archive_proposed_at IS NOT NULL AND c.archived_at IS NULL AND c.deleted_at IS NULL`)
  for (const channel of proposals) {
    if (!(String(channel.last_activity_at) > String(channel.archive_proposed_at))) continue
    if (await cancelProposal(sql, String(channel.id), "activity", {}, { activity_at: channel.last_activity_at })) result.proposals_cancelled.push(String(channel.id))
  }
  const archived = await sql.query(`SELECT c.id,c.archived_at,${channelActivitySql("CASE WHEN c.archive_cause='proposed' THEN c.archive_proposed_by END")} AS last_activity_at
    FROM chat_channels c WHERE c.archived_at IS NOT NULL AND c.deleted_at IS NULL`)
  for (const channel of archived) {
    if (!(String(channel.last_activity_at) > String(channel.archived_at))) continue
    if (await unarchive(sql, String(channel.id), "activity", {}, { activity_at: channel.last_activity_at })) result.unarchived.push(String(channel.id))
  }
  if (!archive) return result
  const due = await sql.query(`SELECT c.id,c.archive_proposed_at,c.archive_proposed_by,${channelActivitySql()} AS last_activity_at,
    ${connectedSql()} AS connected,${connectedSql("c.archive_proposed_by")} AS others_connected
    FROM chat_channels c WHERE c.archived_at IS NULL AND ${ARCHIVABLE_SQL}`, [at])
  for (const channel of due) {
    const proposedDue = channel.archive_proposed_at ? Date.parse(channel.archive_proposed_at) + timing.archiveProposedMs : Infinity
    const idleDue = Date.parse(channel.last_activity_at) + timing.archiveIdleMs
    const cause: ChatChannelArchiveCause | null = !Number(channel.others_connected) && proposedDue <= now ? "proposed"
      : !Number(channel.connected) && idleDue <= now ? "inactive" : null
    if (!cause) continue
    const changed = await sql.query("UPDATE chat_channels SET archived_at=$2,archive_cause=$3 WHERE id=$1 AND archived_at IS NULL AND deleted_at IS NULL RETURNING id", [channel.id, at, cause])
    if (!changed.length) continue
    await recordAuthorityEvent(sql, { kind: "channel_archived", channel_id: String(channel.id), project_id: await channelProjectId(sql, String(channel.id)),
      reason: cause === "proposed" ? "Archivado por la propuesta del líder" : "Archivado por inactividad",
      evidence: { cause, last_activity_at: channel.last_activity_at, archive_proposed_at: channel.archive_proposed_at ?? null, proposed_by: channel.archive_proposed_by ?? null,
        delay_ms: cause === "proposed" ? timing.archiveProposedMs : timing.archiveIdleMs } })
    result.archived.push(String(channel.id))
  }
  return result
}

type Presence = (session: Record<string, any>, now: number) => { state: string; connection_state: string }

/** Leader only: authority comes from the authenticated session row and the channel's leader_id, never from the input. */
export async function cleanAgents(sql: Sql, caller: Record<string, any>, input: z.infer<typeof chatCleanAgentsInput>, presence: Presence, now = Date.now()): Promise<ChatCleanAgentsResult> {
  check(!caller.closed_at, "Sólo una sesión de agente abierta puede limpiar la lista de agentes.", 403)
  const channel = (await sql.query("SELECT * FROM chat_channels WHERE id=$1", [input.channel_id ?? caller.channel_id]))[0]
  check(channel && !channel.deleted_at, "Canal inexistente.", 404)
  check(channel.leader_id === caller.id, "Sólo el líder vigente del canal puede limpiar su lista de agentes.", 403)
  check(channel.kind !== INTERHUB_CHANNEL_KIND, "En un canal entre hubs los agentes locales se retiran con memory_chat_interhub_remove_local_agent.", 409)
  check(!input.apply || input.reason, "apply=true requiere reason.", 400)
  const threshold = wrapUpTiming().agentInactivityMs, finished = new Set(input.finished_ids)
  // Same rows as the default chat_agents listing of this channel with include_team_history, which is what the UI shows.
  const rows = await sql.query(`SELECT s.*,m.team_id,m.state AS member_state FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id
    LEFT JOIN chat_team_members m ON m.session_id=s.id AND m.channel_id=c.id AND m.state IN ('joined','closed')
    LEFT JOIN chat_team_plans p ON p.id=m.team_id
    WHERE (c.id=$1 OR p.master_channel_id=$1) AND s.id<>$2 AND s.removed_at IS NULL AND s.nickname IS NOT NULL AND trim(s.nickname)<>''
    AND s.cli_kind NOT IN (${nonAgentKinds}) AND c.deleted_at IS NULL AND (c.kind<>'virtual' OR c.activated_at IS NOT NULL)
    AND (m.team_id IS NOT NULL OR (s.closed_at IS NULL AND c.closed_at IS NULL)) AND ${LISTED_SESSION_SQL}
    ORDER BY s.created_at,s.id`, [channel.id, caller.id])
  const candidates: ChatCleanupCandidate[] = rows.map(row => {
    const last = String(row.activity_at ?? row.created_at), inactive = Math.max(0, now - Date.parse(last))
    const blocked = row.id === channel.displaced_leader_id ? "reclaim_right" as const : inactive >= threshold || finished.has(row.id) ? null : "recent_activity" as const
    const status = presence(row, now)
    return { id: String(row.id), label: String(row.label), cli_kind: String(row.cli_kind), role: row.team_id ? "team_member" : "member", team_id: row.team_id ?? null,
      member_state: row.member_state ?? null, state: status.state, connection_state: status.connection_state, closed_at: row.closed_at ?? null,
      last_activity_at: last, inactive_ms: inactive, eligible: !blocked, basis: blocked ? null : inactive >= threshold ? "inactive" : "declared_finished", blocked }
  })
  const listed = new Set(candidates.map(candidate => candidate.id)), requested = input.participant_ids ? new Set(input.participant_ids) : null
  const skipped: ChatCleanAgentsResult["skipped"] = [...new Set([...(input.participant_ids ?? []), ...input.finished_ids])]
    .filter(sessionId => !listed.has(sessionId)).map(sessionId => ({ id: sessionId, code: "not_listed" as const }))
  const base = { channel_id: String(channel.id), evaluated_at: new Date(now).toISOString(), inactivity_threshold_ms: threshold, candidates }
  if (!input.apply) return { ...base, applied: false, cleaned: [], skipped, event_id: null }
  const cleaned: ChatCleanAgentsResult["cleaned"] = []
  for (const candidate of candidates) {
    if (requested && !requested.has(candidate.id)) continue
    if (!candidate.eligible) { skipped.push({ id: candidate.id, code: candidate.blocked! }); continue }
    const row = (await sql.query("UPDATE chat_sessions SET dismissed_at=now(),dismissed_by=$2,dismissal_reason=$3 WHERE id=$1 AND removed_at IS NULL RETURNING dismissed_at",
      [candidate.id, `agent:${caller.id}`, input.reason]))[0]
    if (row) cleaned.push({ id: candidate.id, label: candidate.label, basis: candidate.basis!, dismissed_at: String(row.dismissed_at) })
  }
  const event = cleaned.length ? await recordAuthorityEvent(sql, { kind: "agents_cleaned", channel_id: String(channel.id), project_id: await channelProjectId(sql, String(channel.id)),
    actor_session_id: String(caller.id), target_session_id: cleaned.length === 1 ? cleaned[0]!.id : null, reason: input.reason!,
    evidence: { cleaned: cleaned.map(item => ({ id: item.id, basis: item.basis, last_activity_at: candidates.find(candidate => candidate.id === item.id)!.last_activity_at })),
      skipped, inactivity_threshold_ms: threshold } }) : null
  return { ...base, applied: true, cleaned, skipped, event_id: event?.id ?? null }
}

/** Leader only. The proposal is cleared by any later use of the channel other than the proposer's own terminal activity. */
export async function proposeArchive(sql: Sql, caller: Record<string, any>, input: z.infer<typeof chatProposeArchiveInput>, now = Date.now()): Promise<ChatProposeArchiveResult> {
  check(!caller.closed_at, "Sólo una sesión de agente abierta puede proponer el archivado.", 403)
  const channel = (await sql.query("SELECT * FROM chat_channels WHERE id=$1", [input.channel_id ?? caller.channel_id]))[0]
  check(channel && !channel.deleted_at, "Canal inexistente.", 404)
  check(channel.leader_id === caller.id, "Sólo el líder vigente del canal puede proponer archivarlo.", 403)
  check(channel.kind !== INTERHUB_CHANNEL_KIND, "Los canales entre hubs no se archivan.", 409)
  check(channel.kind !== "virtual" || channel.activated_at, "El canal no está activo.", 409)
  check(!String(channel.scope_key ?? "").startsWith(AUTOMATION_SCOPE) && !(await sql.query("SELECT 1 FROM chat_team_members WHERE channel_id=$1 LIMIT 1", [channel.id])).length,
    "Los canales de automatización y de workers de equipo no se archivan.", 409)
  check(!channel.archived_at, "El canal ya está archivado; usarlo lo devuelve a la lista.", 409)
  const unchanged = Boolean(channel.archive_proposed_at && channel.archive_proposed_by === caller.id)
  let proposedAt = String(channel.archive_proposed_at), eventId: string | null = null
  const waiting = (await sql.query(`SELECT s.id,s.label FROM chat_channels c JOIN chat_sessions s ON ${holdersSql("$3", "$1")}
    WHERE c.id=$2 ORDER BY s.created_at,s.id`, [new Date(now).toISOString(), channel.id, caller.id])).map(row => ({ id: String(row.id), label: String(row.label) }))
  if (!unchanged) {
    proposedAt = String((await sql.query("UPDATE chat_channels SET archive_proposed_at=now(),archive_proposed_by=$2,archive_proposal_reason=$3 WHERE id=$1 RETURNING archive_proposed_at",
      [channel.id, caller.id, input.reason]))[0]!.archive_proposed_at)
    eventId = (await recordAuthorityEvent(sql, { kind: "channel_archive_proposed", channel_id: String(channel.id), project_id: await channelProjectId(sql, String(channel.id)),
      actor_session_id: String(caller.id), reason: input.reason, evidence: { waiting_for: waiting.map(item => item.id), replaced_proposal_by: channel.archive_proposed_by ?? null } })).id
  }
  return { channel_id: String(channel.id), archive_proposed_at: proposedAt, archive_proposed_by: String(caller.id),
    archive_due_at: new Date(Date.parse(proposedAt) + wrapUpTiming().archiveProposedMs).toISOString(), unchanged, waiting_for: waiting, event_id: eventId }
}
