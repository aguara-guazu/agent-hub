import { z } from "zod"

export const CONSUMPTION_CLIS = ["claude_code", "codex_cli", "kiro"] as const
export type ConsumptionCli = (typeof CONSUMPTION_CLIS)[number]

export const CONSUMPTION_ORIGINS = ["model", "person", "cli_tools", "mcp_tools", "hub_tools", "fixed", "compaction", "unknown"] as const
export type ConsumptionOrigin = (typeof CONSUMPTION_ORIGINS)[number]

export const LINK_SOURCES = ["hook", "fleet_runtime", "kiro_env"] as const
export type LinkSource = (typeof LINK_SOURCES)[number]

export interface ConsumptionEvent {
  dedupe_key: string
  hub_session_id: string
  native_session_id: string
  cli_kind: ConsumptionCli
  model: string | null
  occurred_at: string
  /** Kiro reports credits; Claude Code and Codex report tokens. */
  unit: "tokens" | "credits"
  /** Excludes cache reads and writes, in every unit. */
  input: number
  output: number
  cache_write: number
  /** Part of `cache_write` billed with the 1 h retention rate. */
  cache_write_1h: number
  cache_read: number
  credits: number
  context_tokens: number | null
  context_window: number | null
  context_pct: number | null
  compaction: boolean
  model_calls: number
  /** Amount per origin, in the event's unit. */
  breakdown: Partial<Record<ConsumptionOrigin, number>>
  source: "file" | "acp"
}

export interface LinkCursor {
  hub_session_id: string
  native_session_id: string
  cli_kind: ConsumptionCli
  source: LinkSource
  file_path: string | null
  file_offset: number
  scan_state: unknown
}

const nonNegative = z.number().finite().nonnegative()

export const consumptionEventSchema = z
  .object({
    dedupe_key: z.string().min(1).max(300),
    hub_session_id: z.string().min(1).max(200),
    native_session_id: z.string().min(1).max(200),
    cli_kind: z.enum(CONSUMPTION_CLIS),
    model: z.string().max(200).nullable(),
    occurred_at: z.iso.datetime(),
    unit: z.enum(["tokens", "credits"]),
    input: nonNegative,
    output: nonNegative,
    cache_write: nonNegative,
    cache_write_1h: nonNegative,
    cache_read: nonNegative,
    credits: nonNegative,
    context_tokens: nonNegative.nullable(),
    context_window: nonNegative.nullable(),
    context_pct: nonNegative.nullable(),
    compaction: z.boolean(),
    model_calls: z.number().int().nonnegative(),
    breakdown: z.record(z.enum(CONSUMPTION_ORIGINS), nonNegative),
    source: z.enum(["file", "acp"]),
  })
  .strict() as z.ZodType<ConsumptionEvent>
