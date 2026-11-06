import type { Sql } from "../database.js"

/**
 * Sessions a channel or team leader may see: sessions of channels it leads, members of plans it created, sessions of
 * the master channel of those plans, and its own session. Returns null when it leads neither a channel nor a plan.
 */
export async function teamSessionIds(sql: Sql, leaderId: string): Promise<string[] | null> {
  const leads = await sql.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM chat_channels WHERE leader_id=$1)+(SELECT count(*) FROM chat_team_plans WHERE created_by=$1) AS n`,
    [leaderId],
  )
  if (Number(leads[0]?.n ?? 0) === 0) return null
  const rows = await sql.query<{ id: string }>(
    `SELECT id FROM chat_sessions WHERE channel_id IN (SELECT id FROM chat_channels WHERE leader_id=$1)
     UNION SELECT session_id AS id FROM chat_team_members WHERE session_id IS NOT NULL AND team_id IN (SELECT id FROM chat_team_plans WHERE created_by=$1)
     UNION SELECT id FROM chat_sessions WHERE channel_id IN (SELECT master_channel_id FROM chat_team_plans WHERE created_by=$1)
     UNION SELECT $1 AS id`,
    [leaderId],
  )
  return [...new Set(rows.map(row => String(row.id)))]
}
