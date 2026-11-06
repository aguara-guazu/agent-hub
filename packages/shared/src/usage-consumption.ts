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
    breakdown: z.partialRecord(z.enum(CONSUMPTION_ORIGINS), nonNegative),
    source: z.enum(["file", "acp"]),
  })
  .strict() as z.ZodType<ConsumptionEvent>

/**
 * Origin of a tool result. Claude Code names Hub tools `mcp__hub__*`, Codex `mcp__hub.*`;
 * any other MCP tool counts as `mcp_tools`, and built-in CLI tools as `cli_tools`.
 */
export function classifyTool(cli: ConsumptionCli, name: string, server?: string): 'cli_tools' | 'mcp_tools' | 'hub_tools' {
  if (server === 'hub' || name.startsWith('mcp__hub__') || name.startsWith('mcp__hub.')) return 'hub_tools'
  if (server || name.startsWith('mcp__')) return 'mcp_tools'
  return 'cli_tools'
}

const kiroCategory = z.looseObject({ chars: z.number().finite().nonnegative().optional() })

const kiroTurnCompletion = z.looseObject({
  promptTurnSummaries: z.array(z.looseObject({
    usage: z.number().finite().nonnegative().optional(),
    unit: z.string().optional(),
    unitPlural: z.string().optional(),
    usedTools: z.array(z.string()).optional(),
  })),
  requestIds: z.array(z.string()).optional(),
  contextBreakdown: z.looseObject({
    modelCalls: z.number().finite().nonnegative().optional(),
    window: z.looseObject({
      usagePercentage: z.number().finite().nonnegative().optional(),
      sizeTokens: z.number().finite().nonnegative(),
    }),
    compacted: z.boolean().optional(),
    categories: z.looseObject({
      kiroInstructions: kiroCategory.optional(),
      toolSpecs: kiroCategory.optional(),
      mcpTools: kiroCategory.optional(),
      agentsIndex: kiroCategory.optional(),
      skillsIndex: kiroCategory.optional(),
      powersIndex: kiroCategory.optional(),
      steering: kiroCategory.optional(),
      skills: kiroCategory.optional(),
      attachedFiles: kiroCategory.optional(),
      other: kiroCategory.optional(),
      workspace: kiroCategory.optional(),
      memory: kiroCategory.optional(),
      toolIO: z.looseObject({
        inputChars: z.number().finite().nonnegative().optional(),
        outputChars: z.number().finite().nonnegative().optional(),
      }).optional(),
      history: z.looseObject({
        userChars: z.number().finite().nonnegative().optional(),
        assistantChars: z.number().finite().nonnegative().optional(),
        thinkingChars: z.number().finite().nonnegative().optional(),
        compactionSummaryChars: z.number().finite().nonnegative().optional(),
      }).optional(),
    }),
  }).optional(),
})

const kiroContextUsage = z.looseObject({
  usagePercentage: z.number().finite().nonnegative().optional(),
  contextUsage: z.looseObject({ usagePercentage: z.number().finite().nonnegative() }).optional(),
})

const kiroUpdate = z.looseObject({
  sessionUpdate: z.string(),
  _meta: z.looseObject({ kiro: z.looseObject({ kind: z.string().optional() }).optional() }).optional(),
})

export interface KiroSessionInfoContext {
  hub_session_id: string
  native_session_id: string
  seq: number
  at: string
  lastContextPct: number | null
}

export interface KiroSessionInfoResult {
  event?: ConsumptionEvent
  contextPct?: number
}

/**
 * Reads the usage that Kiro's ACP server reports in `session_info_update` (`_meta.kiro`). Returns `{}` for updates that
 * carry no usage and null when a usage update does not match the expected shape, so the session shows no data
 * instead of wrong numbers. Never throws.
 */
export function parseKiroSessionInfo(update: unknown, ctx: KiroSessionInfoContext): KiroSessionInfoResult | null {
  try {
    const head = kiroUpdate.safeParse(update)
    if (!head.success) return null
    if (head.data.sessionUpdate !== "session_info_update") return {}
    const meta: unknown = head.data._meta?.kiro
    if (!meta) return {}
    const kind = head.data._meta?.kiro?.kind

    if (kind === "context_usage") {
      const usage = kiroContextUsage.safeParse(meta)
      const pct = usage.success ? (usage.data.contextUsage?.usagePercentage ?? usage.data.usagePercentage) : undefined
      return pct === undefined ? null : { contextPct: pct }
    }

    const completion = kind === "turn_completion" || (kind === undefined && Array.isArray((meta as { promptTurnSummaries?: unknown }).promptTurnSummaries))
    if (!completion) return {}
    const parsed = kiroTurnCompletion.safeParse(meta)
    if (!parsed.success) return null
    const { promptTurnSummaries, requestIds, contextBreakdown } = parsed.data

    const metered = promptTurnSummaries.filter(item => item.usage !== undefined)
    if (metered.length === 0) return {}
    const creditItems = metered.filter(item => item.unit === "credit" || item.unitPlural === "credits")
    if (creditItems.length === 0) return null
    const credits = creditItems.reduce((sum, item) => sum + (item.usage ?? 0), 0)

    const pct = contextBreakdown?.window.usagePercentage ?? ctx.lastContextPct
    const breakdown: Partial<Record<ConsumptionOrigin, number>> = {}
    if (contextBreakdown) {
      const categories = contextBreakdown.categories
      const chars = (value: { chars?: number | undefined } | undefined) => value?.chars ?? 0
      const history = categories.history
      const toolIO = (categories.toolIO?.inputChars ?? 0) + (categories.toolIO?.outputChars ?? 0)
      const weights: Partial<Record<ConsumptionOrigin, number>> = {
        fixed: [categories.kiroInstructions, categories.toolSpecs, categories.mcpTools, categories.agentsIndex, categories.skillsIndex,
          categories.powersIndex, categories.steering, categories.skills, categories.workspace, categories.memory]
          .reduce((sum, value) => sum + chars(value), 0),
        person: (history?.userChars ?? 0) + chars(categories.attachedFiles),
        model: (history?.assistantChars ?? 0) + (history?.thinkingChars ?? 0),
        compaction: history?.compactionSummaryChars ?? 0,
        unknown: chars(categories.other),
      }
      const counts: Record<"cli_tools" | "mcp_tools" | "hub_tools", number> = { cli_tools: 0, mcp_tools: 0, hub_tools: 0 }
      for (const item of creditItems) for (const name of item.usedTools ?? []) counts[classifyTool("kiro", name)]++
      const used = counts.cli_tools + counts.mcp_tools + counts.hub_tools
      if (used === 0) weights.cli_tools = toolIO
      else for (const origin of ["cli_tools", "mcp_tools", "hub_tools"] as const) weights[origin] = toolIO * counts[origin] / used
      const total = Object.values(weights).reduce((sum, value) => sum + value, 0)
      if (total > 0) {
        for (const [origin, weight] of Object.entries(weights) as [ConsumptionOrigin, number][]) {
          if (weight > 0) breakdown[origin] = credits * weight / total
        }
      }
    }

    const event: ConsumptionEvent = {
      dedupe_key: `kr:${ctx.native_session_id}:${requestIds && requestIds.length > 0 ? requestIds.join(",") : ctx.seq}`.slice(0, 300),
      hub_session_id: ctx.hub_session_id,
      native_session_id: ctx.native_session_id,
      cli_kind: "kiro",
      model: null,
      occurred_at: ctx.at,
      unit: "credits",
      input: 0,
      output: 0,
      cache_write: 0,
      cache_write_1h: 0,
      cache_read: 0,
      credits,
      context_tokens: null,
      context_window: contextBreakdown?.window.sizeTokens ?? null,
      context_pct: pct,
      compaction: contextBreakdown?.compacted === true,
      model_calls: contextBreakdown?.modelCalls ?? 1,
      breakdown,
      source: "acp",
    }
    return pct === null ? { event } : { event, contextPct: pct }
  } catch {
    return null
  }
}
