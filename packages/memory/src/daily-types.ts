import type { JiraGuard, PublicItem } from './schedule-contract.js'

/** Shapes the brief and the close share with the scheduler core; the item and guard types come from schedule-contract.ts. */

export interface OwnerAttentionLine { ref: string; summary: string; at: string; project_id?: string }
/** Readers the owner-level templates use; each is injected by the area that owns the data, and a block is omitted when its reader is missing. */
export interface OwnerAttentionReaders {
  pending_responses?: () => Promise<OwnerAttentionLine[]>
  liveness_incidents?: () => Promise<OwnerAttentionLine[]>
  uncertain_deliveries?: () => Promise<OwnerAttentionLine[]>
  overdue_close?: () => Promise<OwnerAttentionLine[]>
  /** Approved items that expired or never reached the executor; uncertain ones are never offered again. */
  carryover_items?: () => Promise<ProposedItem[]>
  /** Pushes the project agents propose for the close; each carries its exact effect. */
  push_candidates?: () => Promise<ProposedItem[]>
  /** Projects whose owner activated the automation: only they get write proposals in the close. */
  activated_projects?: () => Promise<string[]>
}

/** An item another area proposes, already carrying its exact effect and the digest of that effect. */
export interface ProposedItem { project_id: string; kind: PublicItem['kind']; summary: string; effect: Record<string, unknown>; effect_digest: string; estimate_id?: string }

/** Exact effects a close may propose; the approved copy is executed by the core without a model in between. */
export type JiraEffect =
  /** `marker` lacks the request id: the decision layer appends it when it dispatches. */
  | { kind: 'jira_worklog'; site: string | null; issue_key: string; account_id: string | null; seconds: number; started: string; marker: string; estimate_id: string }
  | { kind: 'jira_transition'; site: string | null; issue_key: string; account_id: string | null; to_category: 'done'; to_name: string | null; evidence_ref: string }
  | { kind: 'jira_comment'; site: string | null; issue_key: string; account_id: string | null; text: string; evidence_ref: string }
export interface ProposedEffect { ordinal: number; effect: JiraEffect | Record<string, unknown> }

export interface DailyDeps {
  store: import('./store.js').MemoryStore
  now(): Date
  /** Projects with a live project_status schedule, from the scheduler's typed reader. */
  statusProjects(): Promise<string[]>
  jira?: JiraGuard
  attention?: OwnerAttentionReaders
  options?: { workday_hours?: number }
}

export const DEFAULT_WORKDAY_HOURS = 9

export const clip = (value: unknown, max: number) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const two = (n: number) => String(n).padStart(2, '0')
/** Local (system time zone) wall-clock time, without a suffix. */
export const localTime = (value: string | Date) => { const d = new Date(value); return `${two(d.getHours())}:${two(d.getMinutes())}` }
/** «martes 28/10» in the system time zone. */
export const dayLabel = (value: string | Date) => { const d = new Date(value); return `${d.toLocaleDateString('es', { weekday: 'long' })} ${d.getDate()}/${d.getMonth() + 1}` }
export const localDate = (value: string | Date) => { const d = new Date(value); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}` }
export const startOfLocalDay = (value: string | Date) => { const d = new Date(value); return new Date(d.getFullYear(), d.getMonth(), d.getDate()) }
export const endOfLocalDay = (value: string | Date) => { const d = new Date(value); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) }

/**
 * Semantic identity of an action, independent of the estimated value: a second close of the same window proposes the same worklog with other seconds,
 * and the decision store must see one operation. `kind` defaults to the one inside the effect; a git_push effect carries none, so its caller passes it.
 */
export function operationKeyOf(effect: Record<string, unknown>, kind: unknown = effect['kind']): string | undefined {
  if (kind === 'git_push') return ['repo_id', 'ref', 'local_sha'].every(key => typeof effect[key] === 'string') ? `git_push:${effect['repo_id']}:${effect['ref']}:${effect['local_sha']}` : undefined
  const site = typeof effect['site'] === 'string' ? effect['site'] : 'null', issue = effect['issue_key']
  if (typeof issue !== 'string') return undefined
  switch (kind) {
    case 'jira_worklog': return typeof effect['started'] === 'string' ? `jira_worklog:${site}:${issue}:${effect['started']}` : undefined
    case 'jira_transition': return `jira_transition:${site}:${issue}:done`
    case 'jira_comment': return typeof effect['evidence_ref'] === 'string' ? `jira_comment:${site}:${issue}:${effect['evidence_ref']}` : undefined
    default: return undefined
  }
}
