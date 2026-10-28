/**
 * Shapes the brief and the close share with the scheduler core. `PublicItem`, `JiraGuard` and `AttentionReaders` mirror schedule-contract.ts
 * and are replaced by imports from it once that file is on the integration branch.
 */
export interface PublicItem { ordinal: number; kind: 'jira_worklog' | 'jira_transition' | 'jira_comment' | 'git_push' | 'info'; project_id: string; summary: string; effect_digest?: string }

export interface JiraGuard {
  /** Account the owner connected to Atlassian (atlassianUserInfo); null when it cannot be read. */
  ownerAccountId(): Promise<string | null>
  /** Current assignee of an issue as Jira reports it right now. */
  assigneeOf(key: string): Promise<{ account_id: string | null; verified: boolean }>
}

export interface AttentionLine { ref: string; summary: string; at: string; project_id?: string }
export interface AttentionReaders {
  pending_responses?: () => Promise<AttentionLine[]>
  liveness_incidents?: () => Promise<AttentionLine[]>
  uncertain_deliveries?: () => Promise<AttentionLine[]>
  overdue_close?: () => Promise<AttentionLine[]>
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
  attention?: AttentionReaders
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
