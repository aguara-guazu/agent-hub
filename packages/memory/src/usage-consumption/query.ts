import type { ConsumptionCli, ConsumptionOrigin } from "@agenthub/shared"
import type { Sql } from "../database.js"

export const CONSUMPTION_RANGES = ["1h", "12h", "24h", "48h", "7d", "30d", "90d", "1y", "3y"] as const
export type ConsumptionRange = (typeof CONSUMPTION_RANGES)[number]

export interface SummaryRow {
  key: string
  label: string
  cli_kind: string | null
  unit: "tokens" | "credits" | null
  total: number
  input: number
  output: number
  cache_write: number
  cache_read: number
  credits: number
  cost_usd: number | null
  unpriced: boolean
  context_peak_pct: number | null
  context_peak_tokens: number | null
  compactions: number
  /** Only set by the per-agent summary. */
  project_title: string | null
  channel_name: string | null
  top_origins: { origin: ConsumptionOrigin; amount: number }[]
}

export interface ScopeInput {
  range: ConsumptionRange
  /** Restricts to these hub sessions. An empty array matches nothing. */
  sessionIds?: string[] | null
  projectId?: string | null
  now?: Date | undefined
}

const RANGE_MS: Record<Exclude<ConsumptionRange, "1y" | "3y">, number> = {
  "1h": 3_600_000, "12h": 43_200_000, "24h": 86_400_000, "48h": 172_800_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000,
}

/** Start of the range as the ISO instant hourly buckets are stored with. */
export function rangeStart(range: ConsumptionRange, now: Date = new Date()): string {
  const start = new Date(now)
  if (range === "1y" || range === "3y") start.setUTCFullYear(start.getUTCFullYear() - (range === "1y" ? 1 : 3))
  else start.setTime(now.getTime() - RANGE_MS[range])
  // Rounded down to the hour, so the hour where the range begins is part of it.
  start.setUTCMinutes(0, 0, 0)
  return start.toISOString()
}

/** Positional parameters for the SQL below; each `add` returns the placeholder to put in the statement. */
class Args {
  readonly values: unknown[] = []
  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

/** Project of a session as chat_threads resolves it: the master channel's project for team members, else the channel's. */
function projectOfSession(alias: string): string {
  return `COALESCE((SELECT mc.project_id FROM chat_team_members tm JOIN chat_team_plans tp ON tp.id=tm.team_id
    JOIN chat_channels mc ON mc.id=tp.master_channel_id WHERE tm.channel_id=${alias}.channel_id LIMIT 1),
    (SELECT c.project_id FROM chat_channels c WHERE c.id=${alias}.channel_id))`
}

function sessionScope(args: Args, input: ScopeInput, column: string): string[] {
  const clauses: string[] = []
  if (input.sessionIds) clauses.push(`${column} IN (SELECT value FROM json_each(${args.add(JSON.stringify(input.sessionIds))}))`)
  if (input.projectId) clauses.push(`${projectOfSession("s")}=${args.add(input.projectId)}`)
  return clauses
}

function where(clauses: string[]): string {
  return clauses.length ? ` AND ${clauses.join(" AND ")}` : ""
}

function num(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value)
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

export async function summary(
  sql: Sql,
  input: ScopeInput & { group: "agent" | "cli" | "origin" },
): Promise<SummaryRow[]> {
  if (input.sessionIds?.length === 0) return []
  const start = rangeStart(input.range, input.now)
  if (input.group === "origin") return originSummary(sql, input, start)

  const args = new Args()
  const from = args.add(start)
  const clauses = sessionScope(args, input, "s.id")
  const keyColumn = input.group === "cli" ? "h.cli_kind" : "h.hub_session_id"
  const rows = await sql.query(
    `SELECT ${keyColumn} AS key, h.unit AS unit, MAX(h.cli_kind) AS cli_kind, MAX(s.nickname) AS nickname, MAX(s.label) AS label, MAX(sc.name) AS channel_name,
       MAX((SELECT e.title FROM entities e WHERE e.id=${projectOfSession("s")})) AS project_title,
       SUM(h.input) AS input, SUM(h.output) AS output, SUM(h.cache_write) AS cache_write, SUM(h.cache_read) AS cache_read,
       SUM(h.credits) AS credits, SUM(h.cost_usd) AS cost, SUM(h.events-h.unpriced_events) AS priced, SUM(h.unpriced_events) AS unpriced,
       MAX(h.context_peak_pct) AS peak_pct, MAX(h.context_peak_tokens) AS peak_tokens, SUM(h.compactions) AS compactions
     FROM usage_consumption_hourly h JOIN chat_sessions s ON s.id=h.hub_session_id LEFT JOIN chat_channels sc ON sc.id=s.channel_id
     WHERE h.hour>=${from}${where(clauses)}
     GROUP BY ${keyColumn}, h.unit`,
    args.values,
  )
  const result: SummaryRow[] = rows.map(row => {
    const unit = row.unit === "credits" ? "credits" : "tokens"
    const input_ = num(row.input), output = num(row.output), cacheWrite = num(row.cache_write), cacheRead = num(row.cache_read), credits = num(row.credits)
    return {
      key: String(row.key),
      label: input.group === "cli" ? String(row.key) : String(row.nickname ?? row.label ?? row.key),
      cli_kind: row.cli_kind === null ? null : String(row.cli_kind),
      unit,
      total: unit === "credits" ? credits : input_ + output + cacheWrite + cacheRead,
      input: input_, output, cache_write: cacheWrite, cache_read: cacheRead, credits,
      cost_usd: unit === "tokens" && num(row.priced) > 0 ? num(row.cost) : null,
      unpriced: num(row.unpriced) > 0,
      context_peak_pct: nullableNum(row.peak_pct),
      context_peak_tokens: nullableNum(row.peak_tokens),
      compactions: num(row.compactions),
      project_title: input.group === "agent" && row.project_title !== null ? String(row.project_title) : null,
      channel_name: input.group === "agent" && row.channel_name !== null ? String(row.channel_name) : null,
      top_origins: [],
    }
  })

  if (input.group === "agent") {
    const origins = await sql.query(
      `SELECT o.hub_session_id AS key, o.origin AS origin, SUM(o.amount) AS amount
       FROM usage_consumption_hourly_origin o JOIN chat_sessions s ON s.id=o.hub_session_id
       WHERE o.hour>=${from}${where(clauses)} GROUP BY o.hub_session_id, o.origin ORDER BY amount DESC`,
      args.values,
    )
    const byKey = new Map<string, SummaryRow["top_origins"]>()
    for (const row of origins) {
      const list = byKey.get(String(row.key)) ?? []
      if (list.length < 2) list.push({ origin: row.origin as ConsumptionOrigin, amount: num(row.amount) })
      byKey.set(String(row.key), list)
    }
    for (const row of result) row.top_origins = byKey.get(row.key) ?? []

    // Sessions with activity in the range but no registered consumption: shown as "Sin dato" by the interface.
    const idle = await sql.query(
      `SELECT s.id AS key, COALESCE(s.nickname,s.label) AS label, s.cli_kind AS cli_kind, sc.name AS channel_name,
         (SELECT e.title FROM entities e WHERE e.id=${projectOfSession("s")}) AS project_title
       FROM chat_sessions s LEFT JOIN chat_channels sc ON sc.id=s.channel_id
       WHERE s.cli_kind NOT IN ('hub','interhub-remote') AND (s.activity_at>=${from} OR s.last_seen_at>=${from})
         AND NOT EXISTS (SELECT 1 FROM usage_consumption_hourly h WHERE h.hub_session_id=s.id AND h.hour>=${from})${where(clauses)}`,
      args.values,
    )
    for (const row of idle) {
      result.push({
        key: String(row.key), label: String(row.label), cli_kind: String(row.cli_kind), unit: null, total: 0, input: 0, output: 0,
        cache_write: 0, cache_read: 0, credits: 0, cost_usd: null, unpriced: false, context_peak_pct: null, context_peak_tokens: null,
        compactions: 0, project_title: row.project_title === null ? null : String(row.project_title),
        channel_name: row.channel_name === null ? null : String(row.channel_name), top_origins: [],
      })
    }
  }
  return result.sort((a, b) => (b.total - a.total) || a.label.localeCompare(b.label))
}

async function originSummary(sql: Sql, input: ScopeInput, start: string): Promise<SummaryRow[]> {
  const args = new Args()
  const from = args.add(start)
  const clauses = sessionScope(args, input, "s.id")
  const rows = await sql.query(
    `SELECT o.origin AS key, o.unit AS unit, SUM(o.amount) AS amount, SUM(o.cost_usd) AS cost,
       SUM(o.events-o.unpriced_events) AS priced, SUM(o.unpriced_events) AS unpriced
     FROM usage_consumption_hourly_origin o JOIN chat_sessions s ON s.id=o.hub_session_id
     WHERE o.hour>=${from}${where(clauses)} GROUP BY o.origin, o.unit ORDER BY amount DESC`,
    args.values,
  )
  return rows.map(row => {
    const unit = row.unit === "credits" ? "credits" : "tokens"
    const amount = num(row.amount)
    return {
      key: String(row.key), label: String(row.key), cli_kind: null, unit, total: amount, input: 0, output: 0, cache_write: 0, cache_read: 0,
      credits: unit === "credits" ? amount : 0, cost_usd: unit === "tokens" && num(row.priced) > 0 ? num(row.cost) : null,
      unpriced: num(row.unpriced) > 0,
      context_peak_pct: null, context_peak_tokens: null, compactions: 0, project_title: null, channel_name: null, top_origins: [],
    }
  })
}

export type SeriesGranularity = "hour" | "day" | "week" | "month"

export function granularityFor(range: ConsumptionRange): SeriesGranularity {
  if (range === "1h" || range === "12h" || range === "24h" || range === "48h") return "hour"
  if (range === "7d" || range === "30d" || range === "90d") return "day"
  return range === "1y" ? "week" : "month"
}

export async function series(
  sql: Sql,
  input: ScopeInput & { cli?: ConsumptionCli },
): Promise<{ bucket: string; unit: "tokens" | "credits"; total: number; cost_usd: number | null }[]> {
  if (input.sessionIds?.length === 0) return []
  const start = rangeStart(input.range, input.now)
  const bucket = {
    hour: "h.hour",
    day: "substr(h.hour,1,10)",
    week: "strftime('%Y-W%W', h.hour)",
    month: "substr(h.hour,1,7)",
  }[granularityFor(input.range)]
  const args = new Args()
  const from = args.add(start)
  const clauses = sessionScope(args, input, "s.id")
  if (input.cli) clauses.push(`h.cli_kind=${args.add(input.cli)}`)
  const rows = await sql.query(
    `SELECT ${bucket} AS bucket, h.unit AS unit,
       SUM(CASE WHEN h.unit='credits' THEN h.credits ELSE h.input+h.output+h.cache_write+h.cache_read END) AS total,
       CASE WHEN SUM(CASE WHEN h.unit='tokens' THEN h.events-h.unpriced_events ELSE 0 END)=0 THEN NULL ELSE SUM(h.cost_usd) END AS cost
     FROM usage_consumption_hourly h JOIN chat_sessions s ON s.id=h.hub_session_id
     WHERE h.hour>=${from}${where(clauses)} GROUP BY bucket, h.unit ORDER BY bucket, h.unit`,
    args.values,
  )
  return rows.map(row => ({
    bucket: String(row.bucket),
    unit: row.unit === "credits" ? "credits" : "tokens",
    total: num(row.total),
    cost_usd: nullableNum(row.cost),
  }))
}

export const CURVE_POINTS = 300

export interface ContextPoint { at: string; pct: number | null; tokens: number | null; compaction: boolean }

export interface AgentDetail {
  row: SummaryRow | null
  breakdown: { origin: ConsumptionOrigin; unit: "tokens" | "credits"; amount: number; cost_usd: number | null }[]
  /** Latest context percentage in the range, from the full data before the curve is capped. */
  context_last_pct: number | null
  context: ContextPoint[]
}

/** Keeps the peak of each equal slice of the range, so at most `max` points remain. Compaction flags survive. */
function capCurve(points: ContextPoint[], start: string, end: Date, max: number): ContextPoint[] {
  if (points.length <= max) return points
  const from = Date.parse(start)
  const width = (end.getTime() - from) / max
  const slots = new Map<number, ContextPoint>()
  for (const point of points) {
    const index = Math.min(max - 1, Math.max(0, Math.floor((Date.parse(point.at) - from) / width)))
    const current = slots.get(index)
    if (!current) { slots.set(index, point); continue }
    const winner = (point.pct ?? -1) > (current.pct ?? -1) ? point : current
    slots.set(index, { ...winner, compaction: current.compaction || point.compaction })
  }
  return [...slots.entries()].sort((a, b) => a[0] - b[0]).map(([, point]) => point)
}

/** Detail of one session. The context curve uses event rows up to 90 days, and hourly peaks beyond that. */
export async function agentDetail(sql: Sql, hubSessionId: string, range: ConsumptionRange, now?: Date): Promise<AgentDetail> {
  const start = rangeStart(range, now)
  const [row] = await summary(sql, { range, sessionIds: [hubSessionId], group: "agent", now })
  const breakdownRows = await sql.query(
    `SELECT o.origin AS origin, o.unit AS unit, SUM(o.amount) AS amount, SUM(o.cost_usd) AS cost, SUM(o.events-o.unpriced_events) AS priced
     FROM usage_consumption_hourly_origin o WHERE o.hub_session_id=$1 AND o.hour>=$2 GROUP BY o.origin, o.unit ORDER BY amount DESC`,
    [hubSessionId, start],
  )
  const breakdown = breakdownRows.map(item => {
    const unit = item.unit === "credits" ? "credits" as const : "tokens" as const
    return { origin: item.origin as ConsumptionOrigin, unit, amount: num(item.amount), cost_usd: unit === "tokens" && num(item.priced) > 0 ? num(item.cost) : null }
  })
  // Up to 48 h the curve comes from event rows; longer ranges use hourly peaks.
  const detailed = range === "1h" || range === "12h" || range === "24h" || range === "48h"
  const contextRows = detailed
    ? await sql.query(
      `SELECT occurred_at AS at, context_pct AS pct, context_tokens AS tokens, compaction AS compaction
       FROM usage_consumption_events WHERE hub_session_id=$1 AND occurred_at>=$2 ORDER BY occurred_at`,
      [hubSessionId, start],
    )
    : await sql.query(
      `SELECT hour AS at, MAX(context_peak_pct) AS pct, MAX(context_peak_tokens) AS tokens, SUM(compactions)>0 AS compaction
       FROM usage_consumption_hourly WHERE hub_session_id=$1 AND hour>=$2 GROUP BY hour ORDER BY hour`,
      [hubSessionId, start],
    )
  const points: ContextPoint[] = contextRows.map(item => ({
    at: String(item.at),
    pct: nullableNum(item.pct),
    tokens: nullableNum(item.tokens),
    compaction: Number(item.compaction) === 1,
  }))
  const latest = [...points].reverse().find(point => point.pct !== null)
  return {
    row: row ?? null,
    breakdown,
    context_last_pct: latest?.pct ?? null,
    context: capCurve(points, start, now ?? new Date(), CURVE_POINTS),
  }
}

/** Facts about one session for the interface panel. Kept apart from `agentDetail`, which the MCP tools return as is. */
export interface AgentFacts {
  cli_kind: string | null
  /** Most recent model used in the range. */
  model: string | null
  /** Number of recorded events (turns or requests) in the range. */
  turns: number
  model_calls: number
  /** Where the latest event of the session came from; null when no event is retained. */
  source: "file" | "acp" | null
}

export async function agentFacts(sql: Sql, hubSessionId: string, range: ConsumptionRange, now?: Date): Promise<AgentFacts> {
  const start = rangeStart(range, now)
  const [totals] = await sql.query(
    "SELECT MAX(cli_kind) AS cli, SUM(events) AS turns, SUM(model_calls) AS calls FROM usage_consumption_hourly WHERE hub_session_id=$1 AND hour>=$2",
    [hubSessionId, start],
  )
  const [latest] = await sql.query(
    "SELECT model FROM usage_consumption_hourly WHERE hub_session_id=$1 AND hour>=$2 AND model<>'' ORDER BY hour DESC LIMIT 1",
    [hubSessionId, start],
  )
  const [event] = await sql.query("SELECT source FROM usage_consumption_events WHERE hub_session_id=$1 ORDER BY occurred_at DESC LIMIT 1", [hubSessionId])
  const [session] = await sql.query("SELECT cli_kind FROM chat_sessions WHERE id=$1", [hubSessionId])
  return {
    cli_kind: totals?.cli ? String(totals.cli) : session?.cli_kind ? String(session.cli_kind) : null,
    model: latest ? String(latest.model) : null,
    turns: num(totals?.turns),
    model_calls: num(totals?.calls),
    source: event?.source === "acp" || event?.source === "file" ? event.source : null,
  }
}

/** Week number as SQLite's strftime('%W'): Monday-based, days before the first Monday belong to week 00. */
function weekKey(date: Date): string {
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  const dayOfYear = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - yearStart) / 86_400_000)
  const week = Math.floor((dayOfYear + 7 - ((date.getUTCDay() + 6) % 7)) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

/** Every bucket key of the range, in the same format `series` stores, oldest first. */
export function bucketKeys(range: ConsumptionRange, now: Date = new Date()): string[] {
  const granularity = granularityFor(range)
  const first = new Date(rangeStart(range, now))
  const hour = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate(), first.getUTCHours()))
  if (hour.getTime() < first.getTime()) hour.setUTCHours(hour.getUTCHours() + 1)
  const keys = new Set<string>()
  for (const cursor = new Date(hour); cursor.getTime() <= now.getTime(); cursor.setUTCHours(cursor.getUTCHours() + 1)) {
    const iso = cursor.toISOString()
    keys.add(granularity === "hour" ? iso : granularity === "day" ? iso.slice(0, 10) : granularity === "month" ? iso.slice(0, 7) : weekKey(cursor))
  }
  return [...keys]
}

/** Completes a sparse series with zero for the buckets without consumption. Buckets outside the range are kept. */
export function fillSeries<T extends { bucket: string; total: number | null }>(range: ConsumptionRange, points: readonly T[], now?: Date): { bucket: string; total: number | null }[] {
  const byBucket = new Map(points.map(point => [point.bucket, point.total]))
  const keys = bucketKeys(range, now)
  const known = new Set(keys)
  const extra = points.map(point => point.bucket).filter(bucket => !known.has(bucket))
  return [...keys, ...extra].sort().map(bucket => ({ bucket, total: byBucket.has(bucket) ? byBucket.get(bucket)! : 0 }))
}
