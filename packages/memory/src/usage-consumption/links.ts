import { CONSUMPTION_CLIS, type ConsumptionCli, type LinkSource } from '@agenthub/shared'
import type { Sql } from '../database.js'

export interface SessionLink {
  hub_session_id: string
  cli_kind: ConsumptionCli
  native_session_id: string
  source: LinkSource
}

export function isConsumptionCli(value: unknown): value is ConsumptionCli {
  return typeof value === 'string' && (CONSUMPTION_CLIS as readonly string[]).includes(value)
}

/** Idempotent. Skips empty ids and the `tui:` ids, which name no native session file. */
export async function recordLink(sql: Sql, link: SessionLink): Promise<void> {
  if (!isConsumptionCli(link.cli_kind)) return
  if (!link.native_session_id || link.native_session_id.startsWith('tui:')) return
  await sql.query(
    `INSERT INTO usage_session_links(hub_session_id,cli_kind,native_session_id,source) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [link.hub_session_id, link.cli_kind, link.native_session_id, link.source],
  )
}

/** Adds the links that sessions already have, recorded before this table existed. Returns how many were inserted. */
export async function backfillLinks(sql: Sql): Promise<number> {
  const hooks = await sql.query<{ n: number }>(
    `INSERT INTO usage_session_links(hub_session_id,cli_kind,native_session_id,source)
     SELECT id,cli_kind,native_id,'hook' FROM chat_sessions
     WHERE cli_kind IN ('claude_code','codex_cli','kiro') AND native_id IS NOT NULL AND native_id<>'' AND native_id NOT LIKE 'tui:%'
     ON CONFLICT DO NOTHING RETURNING 1 AS n`,
  )
  const fleet = await sql.query<{ n: number }>(
    `INSERT INTO usage_session_links(hub_session_id,cli_kind,native_session_id,source)
     SELECT m.session_id,s.cli_kind,m.runtime->>'native_id','fleet_runtime' FROM chat_team_members m JOIN chat_sessions s ON s.id=m.session_id
     WHERE s.cli_kind IN ('claude_code','codex_cli','kiro') AND m.runtime->>'native_id' IS NOT NULL AND m.runtime->>'native_id'<>''
       AND m.runtime->>'native_id' NOT LIKE 'tui:%'
     ON CONFLICT DO NOTHING RETURNING 1 AS n`,
  )
  return hooks.length + fleet.length
}
