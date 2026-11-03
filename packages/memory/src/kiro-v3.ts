import { effortLevels, kiroEfforts } from './reasoning.js'
import type { CliModel } from './cli-extraction.js'

/**
 * Kiro's v3 engine ("the next generation Kiro agent") offers models the legacy engine neither lists nor serves,
 * such as claude-opus-5.5. Its ACP mode takes no --model, --effort or --trust-all-tools: the session reports its
 * settings as ACP configOptions and the client changes them with session/set_config_option. Tool prompts reach the
 * client as session/request_permission even when Kiro's own client was started with --trust-all-tools.
 */
export const KIRO_V3_ACP_ARGS = ['acp', '--agent-engine=v3'] as const
export const KIRO_V3_MODEL_OPTION = 'model'
export const KIRO_V3_EFFORT_OPTION = 'effortLevel'
/** Autopilot keeps a v3 session working without stopping for the user; tool trust is a separate per-prompt grant. */
export const KIRO_V3_AUTOPILOT_OPTION = 'autopilot'

/** Sessions created by the v3 engine carry this prefix; the legacy engine returns bare UUIDs. */
export function isKiroV3Session(id: string | undefined): boolean { return typeof id === 'string' && id.startsWith('sess_') }

export interface KiroConfigOption { id: string; currentValue?: unknown; options: Array<{ value: string; name?: string; description?: string; _meta?: any }> }

/** A select option from session/new, session/load or session/set_config_option, or undefined when absent or malformed. */
export function kiroConfigOption(configOptions: unknown, id: string): KiroConfigOption | undefined {
  if (!Array.isArray(configOptions)) return undefined
  const option = configOptions.find((item: any) => item?.id === id)
  if (!option || !Array.isArray(option.options)) return undefined
  const options = option.options.filter((item: any) => typeof item?.value === 'string' && item.value)
  return { id, currentValue: option.currentValue, options }
}

/** Models of the v3 catalog with the effort levels Kiro reports for each one. */
export function kiroV3Models(configOptions: unknown): CliModel[] {
  const option = kiroConfigOption(configOptions, KIRO_V3_MODEL_OPTION)
  if (!option) return []
  return option.options.map(item => {
    const meta = item._meta?.kiro ?? {}
    const reported = Array.isArray(meta.effortLevels) ? effortLevels(meta.effortLevels) : meta.hasEffort === false ? [] : undefined
    const description = typeof item.description === 'string' ? item.description.trim().slice(0, 2000) : ''
    const multiplier = Number(meta.rateMultiplier)
    return {
      id: item.value,
      name: typeof item.name === 'string' && item.name ? item.name : item.value,
      ...(description ? { description } : {}),
      ...(Number.isFinite(multiplier) && multiplier > 0 ? { rate_multiplier: multiplier } : {}),
      ...(option.currentValue === item.value ? { default: true } : {}),
      reasoning_efforts: reported ?? kiroEfforts(item.value),
      reasoning_efforts_source: reported ? 'native' as const : 'fallback' as const,
    }
  })
}
