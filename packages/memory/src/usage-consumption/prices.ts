export type PriceProvider = "anthropic" | "openai"

// Usage in the event's own unit (tokens). `input` excludes cache, as in ConsumptionEvent.
export interface PriceUsage {
  input: number
  output: number
  cache_write: number
  cache_write_1h: number
  cache_read: number
  context_tokens: number | null
}

export interface LongContextRates {
  above_tokens: number
  input: number
  output: number
  cache_read: number
  cache_write_5m: number | null
  cache_write_1h: number | null
}

// USD per million tokens. cache_write_5m is the short-retention write rate (Anthropic 5 min,
// OpenAI 30 min) and cache_write_1h the long one (Anthropic 1 h, OpenAI 12 h). Codex reports
// writes without their retention, so they are priced at the short rate. A null rate marks the
// event as unpriced instead of charging zero. valid_from is the release date when known, or
// the date the price was read.
export interface PriceEntry {
  provider: PriceProvider
  model: string
  valid_from: string
  input: number
  output: number
  cache_write_5m: number | null
  cache_write_1h: number | null
  cache_read: number
  context_window: number | null
  long_context: LongContextRates | null
  source_url: string
}

const ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing"
const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing"

// Only models observed in sessions, with prices read from the official pages above.
export const PRICES: PriceEntry[] = [
  {
    provider: "anthropic",
    model: "claude-opus-5-5",
    valid_from: "2026-09-22",
    input: 4,
    output: 20,
    cache_write_5m: 5,
    cache_write_1h: 8,
    cache_read: 0.2,
    context_window: 1_000_000,
    long_context: null,
    source_url: ANTHROPIC_PRICING_URL,
  },
  {
    provider: "openai",
    model: "gpt-6-astra",
    valid_from: "2026-09-03",
    input: 10,
    output: 50,
    cache_write_5m: 12.5,
    cache_write_1h: 25,
    cache_read: 1,
    context_window: 1_050_000,
    long_context: { above_tokens: 272_000, input: 20, output: 75, cache_read: 2, cache_write_5m: 25, cache_write_1h: 50 },
    source_url: OPENAI_PRICING_URL,
  },
  {
    provider: "anthropic",
    model: "claude-haiku-5-5",
    valid_from: "2026-11-06",
    input: 0.1,
    output: 0.5,
    cache_write_5m: 0.125,
    cache_write_1h: 0.2,
    cache_read: 0.01,
    context_window: 1_000_000,
    long_context: { above_tokens: 100_000, input: 0.5, output: 2.5, cache_read: 0.05, cache_write_5m: 0.625, cache_write_1h: 1 },
    source_url: ANTHROPIC_PRICING_URL,
  },
]

function latestEntry(model: string, at: number | null): PriceEntry | null {
  let best: PriceEntry | null = null
  for (const entry of PRICES) {
    if (entry.model !== model) continue
    if (at !== null && Date.parse(entry.valid_from) > at) continue
    if (best === null || Date.parse(entry.valid_from) > Date.parse(best.valid_from)) best = entry
  }
  return best
}

function costUsd(entry: PriceEntry, usage: PriceUsage): number | null {
  const longRates =
    entry.long_context !== null && usage.context_tokens !== null && usage.context_tokens > entry.long_context.above_tokens
      ? entry.long_context
      : null
  const input = longRates?.input ?? entry.input
  const output = longRates?.output ?? entry.output
  const cacheRead = longRates?.cache_read ?? entry.cache_read
  const write5mRate = longRates ? longRates.cache_write_5m : entry.cache_write_5m
  const write1hRate = longRates ? longRates.cache_write_1h : entry.cache_write_1h

  const writes1h = usage.cache_write_1h
  const writes5m = Math.max(0, usage.cache_write - writes1h)
  let writeCost = 0
  if (writes5m > 0) {
    if (write5mRate === null) return null
    writeCost += writes5m * write5mRate
  }
  if (writes1h > 0) {
    if (write1hRate === null) return null
    writeCost += writes1h * write1hRate
  }

  const total =
    usage.input * input + usage.output * output + usage.cache_read * cacheRead + writeCost
  return total / 1_000_000
}

// Price in effect at `at` (ISO instant). Returns null for models without a verified price.
export function priceFor(
  model: string,
  at: string,
): { ref: string; usd: (usage: PriceUsage) => number | null } | null {
  const instant = Date.parse(at)
  if (!Number.isFinite(instant)) return null
  const entry = latestEntry(model, instant)
  if (entry === null) return null
  return {
    ref: `${entry.model}@${entry.valid_from}`,
    usd: (usage) => costUsd(entry, usage),
  }
}

export function contextWindowFor(model: string): number | null {
  return latestEntry(model, null)?.context_window ?? null
}
