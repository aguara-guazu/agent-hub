import type { ConsumptionOrigin } from '@agenthub/shared'

/** Characters seen per origin since the session start (or since the last compaction). Text is never stored. */
export interface OriginState {
  chars: Partial<Record<ConsumptionOrigin, number>>
}

const CHARS_PER_TOKEN = 4

/**
 * Splits the input side of one event among origins in proportion to the characters seen.
 * Estimates are scaled down when they exceed the real input; the remainder is `fixed`.
 * The output tokens go to `model`.
 */
export function distribute(state: OriginState, inputSide: number, output: number): Partial<Record<ConsumptionOrigin, number>> {
  const estimated: Partial<Record<ConsumptionOrigin, number>> = {}
  let sum = 0
  for (const [origin, chars] of Object.entries(state.chars) as [ConsumptionOrigin, number | undefined][]) {
    const value = (chars ?? 0) / CHARS_PER_TOKEN
    if (value > 0) {
      estimated[origin] = value
      sum += value
    }
  }
  const scale = sum > 0 && sum >= inputSide ? inputSide / sum : 1
  const fixed = sum > 0 && sum >= inputSide ? 0 : inputSide - sum
  const result: Partial<Record<ConsumptionOrigin, number>> = {}
  for (const [origin, value] of Object.entries(estimated) as [ConsumptionOrigin, number][]) {
    result[origin] = value * scale
  }
  result.fixed = fixed
  result.model = (result.model ?? 0) + output
  return result
}

export function cloneOriginState(state: OriginState): OriginState {
  return { chars: { ...state.chars } }
}
