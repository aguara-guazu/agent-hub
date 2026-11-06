import type { ConsumptionCli, ConsumptionEvent, LinkCursor, LinkSource } from "@agenthub/shared"
import { check } from "../contracts.js"
import type { MemoryDatabase } from "../database.js"
import { contextWindowFor, priceFor } from "./prices.js"

const DETAIL_RETENTION_DAYS = 90
const HOURLY_RETENTION_YEARS = 3

export interface CursorUpdate {
  hub_session_id: string
  native_session_id: string
  file_path: string | null
  file_offset: number
  scan_state: unknown
}

export class ConsumptionStore {
  constructor(private readonly db: MemoryDatabase) {}

  async links(cli?: ConsumptionCli): Promise<LinkCursor[]> {
    const columns = "SELECT hub_session_id,native_session_id,cli_kind,source,file_path,file_offset,scan_state FROM usage_session_links"
    const order = " ORDER BY cli_kind,hub_session_id,native_session_id"
    const rows = cli
      ? await this.db.query(`${columns} WHERE cli_kind=$1${order}`, [cli])
      : await this.db.query(`${columns}${order}`)
    return rows.map(row => ({
      hub_session_id: String(row.hub_session_id),
      native_session_id: String(row.native_session_id),
      cli_kind: row.cli_kind as ConsumptionCli,
      source: row.source as LinkSource,
      file_path: row.file_path === null ? null : String(row.file_path),
      file_offset: Number(row.file_offset),
      scan_state: typeof row.scan_state === "string" ? JSON.parse(row.scan_state) : (row.scan_state ?? null),
    }))
  }

  /**
   * Stores events once per dedupe_key and folds the new ones into the hourly totals, in one transaction. Every session
   * in the batch must be linked to `cli`; otherwise the whole batch is rejected. The cursor advances only with the batch.
   */
  async ingest(events: ConsumptionEvent[], cli: ConsumptionCli, cursor?: CursorUpdate): Promise<{ inserted: number }> {
    return this.db.transaction(async sql => {
      const pairs = new Map(events.map(event => [`${event.hub_session_id}\u0000${event.native_session_id}`, event]))
      for (const event of pairs.values()) {
        const linked = await sql.query(
          "SELECT 1 AS ok FROM usage_session_links WHERE hub_session_id=$1 AND native_session_id=$2 AND cli_kind=$3",
          [event.hub_session_id, event.native_session_id, cli],
        )
        check(linked.length > 0, "Hay consumo de una sesión sin vínculo con el Hub", 409)
      }

      let inserted = 0
      for (const event of events) {
        const occurredAt = new Date(event.occurred_at).toISOString()
        const window = event.context_window ?? (event.model ? contextWindowFor(event.model) : null)
        const pct = event.context_pct ?? (window && event.context_tokens !== null ? (event.context_tokens / window) * 100 : null)
        // An event without tokens (for example a synthetic placeholder model) costs nothing and is not unpriced.
        const noTokens = event.unit === "tokens" && event.input + event.output + event.cache_write + event.cache_read === 0
        const price = event.unit === "tokens" && event.model && !noTokens ? priceFor(event.model, occurredAt) : null
        const cost = noTokens ? 0 : price ? price.usd(event) : null
        const priceRef = price && cost !== null ? price.ref : null

        const row = await sql.query(
          `INSERT INTO usage_consumption_events(dedupe_key,hub_session_id,native_session_id,cli_kind,model,occurred_at,unit,input,output,
             cache_write,cache_write_1h,cache_read,credits,cost_usd,price_ref,context_tokens,context_window,context_pct,compaction,model_calls,breakdown,source)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
           ON CONFLICT(dedupe_key) DO NOTHING RETURNING dedupe_key`,
          [event.dedupe_key, event.hub_session_id, event.native_session_id, event.cli_kind, event.model, occurredAt, event.unit,
            event.input, event.output, event.cache_write, event.cache_write_1h, event.cache_read, event.credits, cost, priceRef,
            event.context_tokens, window, pct, event.compaction ? 1 : 0, event.model_calls, JSON.stringify(event.breakdown), event.source],
        )
        if (row.length === 0) continue
        inserted++
        await this.addHourly(sql, { ...event, occurred_at: occurredAt, context_pct: pct, context_window: window }, cost)
      }

      if (cursor) {
        await sql.query(
          "UPDATE usage_session_links SET file_path=$3,file_offset=$4,scan_state=$5 WHERE hub_session_id=$1 AND native_session_id=$2 AND cli_kind=$6",
          [cursor.hub_session_id, cursor.native_session_id, cursor.file_path, cursor.file_offset, JSON.stringify(cursor.scan_state ?? null), cli],
        )
      }
      return { inserted }
    })
  }

  async prune(now = new Date()): Promise<void> {
    const detailCutoff = new Date(now.getTime() - DETAIL_RETENTION_DAYS * 86_400_000).toISOString()
    const hourlyCutoff = new Date(now)
    hourlyCutoff.setUTCFullYear(hourlyCutoff.getUTCFullYear() - HOURLY_RETENTION_YEARS)
    const cutoff = hourlyCutoff.toISOString()
    await this.db.transaction(async sql => {
      await sql.query("DELETE FROM usage_consumption_events WHERE occurred_at<$1", [detailCutoff])
      await sql.query("DELETE FROM usage_consumption_hourly WHERE hour<$1", [cutoff])
      await sql.query("DELETE FROM usage_consumption_hourly_origin WHERE hour<$1", [cutoff])
    })
  }

  private async addHourly(
    sql: { query<T = Record<string, any>>(text: string, params?: unknown[]): Promise<T[]> },
    event: ConsumptionEvent & { occurred_at: string; context_pct: number | null; context_window: number | null },
    cost: number | null,
  ): Promise<void> {
    const date = new Date(event.occurred_at)
    date.setUTCMinutes(0, 0, 0)
    const hour = date.toISOString()
    const unpriced = event.unit === "tokens" && cost === null ? 1 : 0
    const usd = cost ?? 0
    const peak = (column: string) => `CASE WHEN usage_consumption_hourly.${column} IS NULL THEN excluded.${column}
      WHEN excluded.${column} IS NULL THEN usage_consumption_hourly.${column} ELSE MAX(usage_consumption_hourly.${column}, excluded.${column}) END`
    await sql.query(
      `INSERT INTO usage_consumption_hourly(hour,hub_session_id,native_session_id,cli_kind,model,unit,input,output,cache_write,cache_read,
         credits,cost_usd,unpriced_events,events,model_calls,compactions,context_peak_tokens,context_peak_pct)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15,$16,$17)
       ON CONFLICT(hour,hub_session_id,native_session_id,model) DO UPDATE SET
         input=usage_consumption_hourly.input+excluded.input, output=usage_consumption_hourly.output+excluded.output,
         cache_write=usage_consumption_hourly.cache_write+excluded.cache_write, cache_read=usage_consumption_hourly.cache_read+excluded.cache_read,
         credits=usage_consumption_hourly.credits+excluded.credits, cost_usd=usage_consumption_hourly.cost_usd+excluded.cost_usd,
         unpriced_events=usage_consumption_hourly.unpriced_events+excluded.unpriced_events, events=usage_consumption_hourly.events+1,
         model_calls=usage_consumption_hourly.model_calls+excluded.model_calls, compactions=usage_consumption_hourly.compactions+excluded.compactions,
         context_peak_tokens=${peak("context_peak_tokens")}, context_peak_pct=${peak("context_peak_pct")}`,
      [hour, event.hub_session_id, event.native_session_id, event.cli_kind, event.model ?? "", event.unit,
        event.input, event.output, event.cache_write, event.cache_read, event.credits, usd, unpriced, event.model_calls,
        event.compaction ? 1 : 0, event.context_tokens, event.context_pct],
    )

    const entries = Object.entries(event.breakdown).filter((entry): entry is [string, number] => typeof entry[1] === "number")
    const total = entries.reduce((sum, [, amount]) => sum + amount, 0)
    for (const [origin, amount] of entries) {
      const share = total > 0 && cost !== null ? (cost * amount) / total : 0
      await sql.query(
        `INSERT INTO usage_consumption_hourly_origin(hour,hub_session_id,native_session_id,origin,unit,amount,cost_usd,events,unpriced_events)
         VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)
         ON CONFLICT(hour,hub_session_id,native_session_id,origin) DO UPDATE SET
           amount=usage_consumption_hourly_origin.amount+excluded.amount, cost_usd=usage_consumption_hourly_origin.cost_usd+excluded.cost_usd,
           events=usage_consumption_hourly_origin.events+1, unpriced_events=usage_consumption_hourly_origin.unpriced_events+excluded.unpriced_events`,
        [hour, event.hub_session_id, event.native_session_id, origin, event.unit, amount, share, unpriced],
      )
    }
  }
}
