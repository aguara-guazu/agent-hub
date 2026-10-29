import { z } from 'zod'
import type { MemoryStore } from './store.js'
import type { TransactionSql } from './database.js'
import { instant } from './contracts.js'

// Shared types for the scheduler. Every area imports from here; the SQL shape lives in migrations.ts and schedule-store.ts.

export const scheduleTemplates = ['reminder', 'custom_synthesis', 'daily_brief', 'daily_close', 'project_status', 'team_health'] as const
export type ScheduleTemplate = typeof scheduleTemplates[number]
export type ScheduleKind = 'notice' | 'synthesis'
/** `action` belongs to fleet members of derived plans with approved items; a schedule never has it. */
export type RunProfile = 'notice' | 'synthesis' | 'action'
export const deliveryTargets = ['hub_inbox', 'app_window', 'gmail_self', 'slack_self'] as const
export type DeliveryTarget = typeof deliveryTargets[number]
export const scheduleStates = ['active', 'paused', 'cancelled', 'expired', 'completed'] as const
export type ScheduleState = typeof scheduleStates[number]
export const runStates = ['pending', 'running', 'deferred', 'succeeded', 'partial', 'failed', 'uncertain', 'skipped', 'cancelled', 'interrupted'] as const
export type RunState = typeof runStates[number]
export const runPhases = ['collect', 'synthesize', 'persist', 'deliver'] as const
export type RunPhase = typeof runPhases[number]
export type Continuity = 'live_destination' | 'fork' | 'exclusive_resume' | 'linked_new' | 'none'
export type Actor = 'agent' | 'human' | 'system'
/** `owner` schedules aggregate every activated project into one delivery; `project` schedules belong to a single project. */
export type ScheduleScope = 'project' | 'owner'
/** `until_next` keeps a lost occurrence valid until the following one; `until_local_time` until a wall-clock cutoff of the same local day. */
export type GracePolicy = 'minutes' | 'until_next' | 'until_local_time'
export type ItemState = 'proposed' | 'approved' | 'rejected' | 'dispatching' | 'succeeded' | 'uncertain' | 'expired' | 'superseded' | 'unverifiable'
export type RunTrigger = 'clock' | 'misfire' | 'run_now'
export type AttemptState = 'starting' | 'running' | 'exited' | 'deadline_exceeded' | 'terminated' | 'orphan_terminated' | 'orphan_unverified' | 'termination_unknown' | 'spawn_failed'
export type IncidentCause = 'hub_restart' | 'deadline_exceeded' | 'automations_off' | 'collaboration_off' | 'cancelled' | 'spawn_failed' | 'process_exited' | 'quota_exhausted' | 'quota_resume'
export type IncidentAction = 'terminated' | 'already_exited' | 'unverified_left_running' | 'termination_unknown' | 'none' | 'resumed' | 'resume_unsupported' | 'resume_failed'

export const scheduleEventTypes = ['schedule.created', 'schedule.updated', 'schedule.paused', 'schedule.resumed', 'schedule.cancelled', 'schedule.constrained',
  'run.started', 'run.deferred', 'decisions.revoked', 'replies.processed', 'run.persisted', 'run.delivered', 'run.finished', 'run.interrupted', 'decision.received', 'action.receipt',
  'schedule.restored'] as const
export type ScheduleEventType = typeof scheduleEventTypes[number]

/** Closed error codes stored in schedule_runs.error_code and phase receipts; provider or CLI text never reaches them. */
export const runErrorCodes = ['remote_processing_excluded', 'collect_failed', 'synthesis_failed', 'synthesis_invalid_output', 'synthesis_unavailable', 'blocked_unsupported', 'transient_failure', 'quota_exhausted',
  'deadline_exceeded', 'spawn_failed', 'persist_failed', 'delivery_failed', 'delivery_unavailable', 'delivery_uncertain', 'hub_restart', 'automations_off', 'schedule_cancelled'] as const
export type RunErrorCode = typeof runErrorCodes[number]

export type Recurrence = { type: 'once'; at: string } | { type: 'daily'; time: string; weekdays?: number[] | undefined } | { type: 'interval'; minutes: number }
export const recurrenceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('once'), at: instant }).strict(),
  z.object({ type: z.literal('daily'), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional() }).strict(),
  z.object({ type: z.literal('interval'), minutes: z.number().int().min(5).max(10080) }).strict()])

/** Immutable copy of the mutable columns, stored in schedule_runs.definition so a deferred run is rebuilt from the definition it was created under. */
export interface ScheduleSnapshot {
  template: ScheduleTemplate; template_version: number; kind: ScheduleKind; title: string; instructions: string; params: Record<string, unknown>
  recurrence: Recurrence; delivery: DeliveryTarget[]; misfire: 'run_once' | 'skip'; grace_minutes: number; grace_policy: GracePolicy; grace_until: string | null; expires_at: string | null
}

export interface RunContext {
  run_id: string; schedule_id: string; generation: number; scheduled_for: string; scope: ScheduleScope; project_id: string | null; template: ScheduleTemplate; template_version: number; title: string
  params: Record<string, unknown>; instructions: string; covered_since: string | null; trigger: RunTrigger
  /** Set when the run waited for quota or for the machine to wake; lets a template label the delivery. */
  deferred_until: string | null
  /** Set only when the previous occurrence of an end-of-day template was skipped, so the content spans the gap. */
  extend_from: string | null
  signal: AbortSignal
}
/** Optional readers injected by the owning area; a template must omit its block when the reader is absent. */
export interface CollectDeps {
  store: MemoryStore; now(): Date; jira?: JiraGuard; attention?: AttentionReaders; options?: Record<string, unknown>
  /** Projects that have a live project_status schedule; owner-level templates aggregate only these. */
  statusProjects?(): Promise<string[]>
}
export interface JiraGuard {
  ownerAccountId(): Promise<string | null>
  assigneeOf(issueKey: string): Promise<{ account_id: string | null; verified: boolean }>
  /** A Jira effects server is selected; then a `null` ownerAccountId means unreadable, not absent. Missing method = unknown, treated as configured. */
  configured?(): boolean
}
/** `kind` travels beside `effect` for effects whose strict parser admits no extra key (git_push); Jira effects still carry it inside. */
export interface AttentionLine { ref: string; summary: string; at: string; project_id?: string; effect?: unknown; kind?: PublicItem['kind'] }
export const attentionKeys = ['pending_responses', 'liveness_incidents', 'uncertain_deliveries', 'overdue_close', 'carryover_items', 'push_candidates', 'activated_projects'] as const
/** Read-only views over the state of other areas (requests awaiting a reply, supervisor incidents, uncertain deliveries, push candidates). */
export type AttentionReaders = Partial<Record<typeof attentionKeys[number], () => Promise<AttentionLine[]>>>
export interface RunPackage {
  project_ids: string[]
  /** Only sections with model_visible !== false reach a model; the rest are for rendering. */
  sections: Array<{ id: string; title: string; data: unknown; sources: Array<{ entity_id?: string; task_id?: string; as_of: string }>; model_visible?: boolean }>
  remote_allowed: boolean; char_count: number
}
/** `operation_key` identifies the operation across runs (site, issue and window of a worklog); the decision store refuses a second intention under the same key. */
export interface PublicItem { ordinal: number; estimate_id?: string; operation_key?: string; kind: 'jira_worklog' | 'jira_transition' | 'jira_comment' | 'git_push' | 'info'; project_id: string; summary: string; effect_digest?: string }
export interface ArtifactDraft {
  kind: 'notice' | 'brief' | 'close' | 'status' | 'report'; title: string; body_md: string; items: PublicItem[]
  snapshot_refs: Array<{ project_id: string; version: number }>; proposed_effects?: Array<{ ordinal: number; effect: unknown }>
  /** Executed by the persist phase inside the artifact transaction; the returned version is appended to snapshot_refs. */
  snapshots?: Array<{ project_id: string; write(sql: TransactionSql): Promise<number> }>
  /** Other rows written in the same transaction (hour estimates). */
  writers?: Array<{ write(sql: TransactionSql): Promise<unknown> }>
}
export interface PhaseReceipt {
  phase: RunPhase; generation: number; at: string; digest?: string; counts?: Record<string, number>; cli?: string; model?: string
  usage?: { input_tokens?: number; output_tokens?: number }; error_code?: string; covered_since?: string | null
}

/** Each area registers its template; `identity` feeds target_key, so it must exclude time and ids. */
export interface ScheduleTemplateDefinition<P = unknown> {
  id: ScheduleTemplate; version: number; kind: ScheduleKind
  params: z.ZodType<P>; identity(params: P): unknown
  min_interval_minutes: number; max_live_per_project: number; max_runtime_ms: number
  allowed_targets: DeliveryTarget[]; misfire: 'run_once' | 'skip'; grace_minutes: number; grace_policy: GracePolicy; grace_until?: string
  scope: ScheduleScope
  admission_note: string
  collect(ctx: RunContext, deps: CollectDeps): Promise<RunPackage>
  /** `when` skips the process for a package that has nothing to synthesize. */
  synthesize?: { system: string; output: Record<string, unknown>; max_input_chars: number; when?(pkg: RunPackage): boolean }
  render(ctx: RunContext, pkg: RunPackage, synthesis: unknown | null, meta?: { model?: string }): ArtifactDraft
}

export type RunEvents = {
  'run.persisted': [{ run_id: string; artifact_id: string; has_items: boolean }]
  'run.finished': [{ run_id: string; state: RunState }]
  'schedule.changed': [{ schedule_id: string; type: ScheduleEventType }]
  /** Fires when the set of running runs changes; the desktop uses it to keep the machine awake while a run is active. */
  'runs.changed': [{ active: Array<{ run_id: string; phase: string }> }]
}

export interface DeliveryReceipt { state: 'sent' | 'failed' | 'uncertain' | 'skipped'; outbox_ref?: string; error_code?: string }
export interface DeliveryAdapters {
  /** `destination` es la cuenta propia a la que iría la entrega, cuando se conoce; guía la autorización si falta el envío. */
  available(): Promise<Record<'gmail_self' | 'slack_self', { available: boolean; reason?: 'not_connected' | 'scope_missing' | 'identity_unverified' | 'identity_is_bot' | 'tool_off'; destination?: string }>>
  executeDelivery(input: { delivery_id: string; run_id: string; artifact_id: string; target: 'gmail_self' | 'slack_self'; expected_generation: number }): Promise<DeliveryReceipt>
}
export interface ActionReceipt { intent_id: string; state: 'succeeded' | 'rejected_before_dispatch' | 'uncertain'; remote_ref?: string; result_digest?: string; error_code?: string }
export interface ActionExecutor {
  executeApprovedAction(input: { intent_id: string; expected_generation: number }): Promise<ActionReceipt>
  /** Read-only. */
  reconcile(intent_id: string): Promise<ActionReceipt>
}
/** Idempotent by run_id: a retry after a crash returns the same request reference. */
export interface DecisionRequests {
  /** Revokes every request with something awaiting approval or dispatch; called when the automations switch goes off. Returns how many were revoked. */
  revokeAll?(): Promise<number>
  prepareDecision(input: { run_id: string; artifact_id: string; owner_id: string; project_ids: string[]; items: Array<{ ordinal: number; kind: PublicItem['kind']; project_id: string; summary: string; effect: unknown; operation_key?: string }>; expires_at: string }): Promise<{ decision_request_ref: string }>
}
/** Implemented by the schedule store; the decision module calls it after each transition of an item. */
export interface PublicStateSink {
  set(input: { run_id: string; ordinal: number; kind: string; effect_digest?: string; estimate_id?: string; state: ItemState }): Promise<void>
}
/** Direction A to B: the decision module consults it before preparing, consuming, redispatching or reproposing, and denies anything but 'live'. */
export interface ArtifactAuthorityReader {
  /** 'unavailable' on every artifact after a restore, even without a reference; 'unknown' when no artifact matches. */
  artifactAuthority(input: { run_id: string; decision_request_ref?: string }): Promise<'live' | 'unavailable' | 'unknown'>
}
/** `skipped` means nothing ran: the automations are off or a previous cycle is still in flight; `errors` counts cycles or intentions that failed without a receipt. */
export type ActionTickResult = { attempted: number; succeeded: number; rejected: number; uncertain: number; errors?: number } | { skipped: 'automations_off' | 'in_flight' }
export interface ScheduleEffects {
  deliveries: DeliveryAdapters; actions: ActionExecutor; decisions: DecisionRequests
  /** One cycle of channel reply reading and request expiry; the clock calls it about once a minute. */
  replyTick?(): Promise<unknown>
  /** Executes the approved intentions that are ready, one at a time; returns only counts. The clock calls it every 30 seconds and right after a decision is consumed. */
  actionTick?(): Promise<ActionTickResult>
  /** Owner operations of the app on the decision request of a run; none of them returns an approval code. */
  review?: import('./decisions/review.js').DecisionReview
  /** Jira identity of the owner for the close templates; read on every run, never cached across runs. */
  jira?: JiraGuard
  /** Readers over the decision store that the brief and the close consume: replies awaiting and approved items that never reached the executor. */
  attention?: Pick<AttentionReaders, 'pending_responses' | 'carryover_items'>
}

/** Switch and effects injected by the core; the memory package never reads the core database. */
export interface ScheduleAutomation { enabled(): boolean; effects?: ScheduleEffects }

/** Identities registered by the core for run profiles; they never administer schedules. */
export const RUN_PROFILE_CLI_KINDS: readonly string[] = ['hub_run_action', 'hub_effects']
export function isRunProfileAgent(agent: { cli_kind: string }): boolean { return RUN_PROFILE_CLI_KINDS.includes(agent.cli_kind) }

/** Public summary of the decision of a run, built from item states only; `expires_at` is when the request stops accepting replies. */
export interface DecisionSummary { state: 'none' | 'pending' | 'dispatching' | 'uncertain' | 'expired' | 'done'; expires_at: string | null; approved: number; total: number }

/** Fields of a schedule a person changed from the app; an agent cannot change them afterwards. */
export type HumanOverrideField = 'recurrence' | 'delivery'

/** `next_run_local` carries the system offset; `delivery_unavailable` lists requested targets whose adapter reports unavailable; `delivery_allowed` are the targets the template admits. */
export interface ScheduleView {
  id: string; scope: ScheduleScope; project_id: string | null; template: ScheduleTemplate; template_version: number; kind: ScheduleKind; title: string; recurrence: Recurrence
  timezone: string; next_run_at: string | null; next_run_local: string | null; delivery: DeliveryTarget[]; delivery_unavailable: DeliveryTarget[]; delivery_allowed: DeliveryTarget[]
  state: ScheduleState; paused_by: Actor | null; revision: number; human_override: HumanOverrideField[]; created_by: { kind: Actor; agent_id: string | null; label: string }; admission_note: string
  last_run?: { id: string; state: RunState; scheduled_for: string; trigger: RunTrigger; skip_reason?: string; deferred_reason?: string }
  /** Present while a run waits for quota or for the machine to wake. */
  deferred?: { reason: string; resets_at: string | null; next_attempt_at: string | null }
}
