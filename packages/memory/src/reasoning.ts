import { z } from 'zod'

// OpenCode can expose custom variant names, not just the standard effort levels.
export const reasoningEffortSchema = z.string().max(80).regex(/^[a-zA-Z0-9_-]*$/).default('')
export const cliEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export function effortLevels(values: unknown): string[] {
  return Array.isArray(values) ? [...new Set(values.filter((v): v is string => typeof v === 'string' && cliEfforts.includes(v)))] : []
}

/** Kiro's list-models currently omits effort metadata. Keep the documented fallback
 * explicit so unsupported/unknown models never silently ignore a selected effort.
 * https://kiro.dev/docs/models/effort/ (2026-10-07)
 */
export function kiroEfforts(model: string): string[] {
  if (['claude-opus-4.6', 'claude-sonnet-4.6'].includes(model)) return ['low', 'medium', 'high', 'max']
  if (['claude-opus-4.7', 'claude-opus-4.8', 'claude-opus-5', 'claude-opus-5.5', 'claude-sonnet-5', 'claude-sonnet-5.5',
    'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].includes(model)) return ['low', 'medium', 'high', 'xhigh', 'max']
  return []
}
