import { randomUUID } from "node:crypto"
import type { Sql } from "./database.js"

/** Plan states whose members still coordinate. Shared by membership, team reads and leadership checks. */
export const ACTIVE_TEAM_STATES = ["launching", "launched", "partial", "uncertain", "active"] as const
const activeStates = ACTIVE_TEAM_STATES.map(state => `'${state}'`).join(",")

export type ChannelMembership = "leader" | "member" | "team"

/**
 * Write authority in a channel. Read access is broader (same project, temporary grants) and never implies this.
 * Only Hub data counts: the session row, the channel leader column and joined team rows.
 */
export async function channelMembership(sql: Sql, sessionId: string, channelId: string): Promise<ChannelMembership | null> {
  const session = (await sql.query("SELECT id,channel_id,closed_at,removed_at FROM chat_sessions WHERE id=$1", [sessionId]))[0]
  if (!session || session.closed_at || session.removed_at) return null
  if ((await sql.query("SELECT 1 FROM chat_channels WHERE id=$1 AND leader_id=$2", [channelId, sessionId])).length) return "leader"
  if (session.channel_id === channelId) return "member"
  return (await teamChannelIds(sql, sessionId)).includes(channelId) ? "team" : null
}

/** Master and worker channels of the active plans this session coordinates or joined. */
export async function teamChannelIds(sql: Sql, sessionId: string): Promise<string[]> {
  const rows = await sql.query(`SELECT p.master_channel_id AS channel_id FROM chat_team_plans p
      WHERE p.state IN (${activeStates}) AND (p.created_by=$1 OR EXISTS(SELECT 1 FROM chat_team_members m WHERE m.team_id=p.id AND m.session_id=$1 AND m.state='joined'))
    UNION SELECT m2.channel_id FROM chat_team_members m2 JOIN chat_team_plans p ON p.id=m2.team_id
      WHERE m2.channel_id IS NOT NULL AND m2.state='joined' AND p.state IN (${activeStates}) AND (p.created_by=$1 OR EXISTS(SELECT 1 FROM chat_team_members m WHERE m.team_id=p.id AND m.session_id=$1 AND m.state='joined'))`, [sessionId])
  return rows.map(row => String(row.channel_id))
}

/** A joined worker belongs to its master's project; its own worker channel may have no project of its own. */
export async function sessionProjectId(sql: Sql, sessionId: string): Promise<string | null> {
  const row = (await sql.query(`SELECT COALESCE((SELECT master.project_id FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id
      JOIN chat_channels master ON master.id=p.master_channel_id
      WHERE m.session_id=s.id AND m.channel_id=s.channel_id AND m.state='joined' AND p.state IN (${activeStates})
      ORDER BY p.created_at DESC LIMIT 1),c.project_id) AS project_id
    FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id WHERE s.id=$1`, [sessionId]))[0]
  return row?.project_id ?? null
}

/** Effective project of a channel: a worker channel belongs to its master's project. */
export async function channelProjectId(sql: Sql, channelId: string): Promise<string | null> {
  const row = (await sql.query(`SELECT COALESCE((SELECT master.project_id FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id
    JOIN chat_channels master ON master.id=p.master_channel_id WHERE m.channel_id=c.id ORDER BY p.created_at DESC LIMIT 1),c.project_id) AS project_id
    FROM chat_channels c WHERE c.id=$1`, [channelId]))[0]
  return row?.project_id ?? null
}

export type AuthorityEventKind = "leadership_takeover" | "leadership_kick" | "leadership_reclaim" | "leadership_rejected" | "leadership_designated" | "leadership_assigned" | "session_kicked" |
  "read_interest" | "read_request" | "read_elevated" | "read_granted" | "read_rejected" | "read_revoked" | "read_cancelled"

export interface AuthorityEvent {
  kind: AuthorityEventKind
  reason: string
  channel_id?: string | null
  project_id?: string | null
  actor_session_id?: string | null
  actor_user_id?: string | null
  target_session_id?: string | null
  evidence?: Record<string, unknown>
}

/** Append-only. Call inside the transaction that performs the change so the audit and the effect commit together. */
export async function recordAuthorityEvent(sql: Sql, event: AuthorityEvent): Promise<{ id: string; seq: number }> {
  const id = randomUUID()
  const row = (await sql.query(`INSERT INTO chat_authority_events(id,kind,channel_id,project_id,actor_session_id,actor_user_id,target_session_id,reason,evidence)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING seq`, [id, event.kind, event.channel_id ?? null, event.project_id ?? null, event.actor_session_id ?? null,
    event.actor_user_id ?? null, event.target_session_id ?? null, event.reason.slice(0, 2000), JSON.stringify(event.evidence ?? {})]))[0]!
  return { id, seq: Number(row.seq) }
}

export async function listAuthorityEvents(sql: Sql, filter: { project_id?: string | undefined; channel_id?: string | undefined; kinds?: string[] | undefined; limit: number; offset: number }) {
  const where = `($1 IS NULL OR e.project_id=$1) AND ($2 IS NULL OR e.channel_id=$2) AND ($3 IS NULL OR e.kind IN (SELECT value FROM json_each($3)))`
  const args = [filter.project_id ?? null, filter.channel_id ?? null, filter.kinds?.length ? JSON.stringify(filter.kinds) : null]
  const total = Number((await sql.query(`SELECT count(*) AS n FROM chat_authority_events e WHERE ${where}`, args))[0]!.n)
  const items = await sql.query(`SELECT e.*,actor.label AS actor_label,target.label AS target_label,c.name AS channel_name,p.title AS project_title
    FROM chat_authority_events e LEFT JOIN chat_sessions actor ON actor.id=e.actor_session_id LEFT JOIN chat_sessions target ON target.id=e.target_session_id
    LEFT JOIN chat_channels c ON c.id=e.channel_id LEFT JOIN entities p ON p.id=e.project_id
    WHERE ${where} ORDER BY e.seq DESC LIMIT $4 OFFSET $5`, [...args, filter.limit, filter.offset])
  return { items, total, limit: filter.limit, offset: filter.offset }
}
