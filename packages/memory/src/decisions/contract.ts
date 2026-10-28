import { createHash } from 'node:crypto'

export type Integration = 'gmail' | 'slack'
export type DecisionItemKind = 'jira_worklog' | 'jira_transition' | 'jira_comment' | 'git_push'
export const decisionItemKinds: readonly DecisionItemKind[] = ['jira_worklog', 'jira_transition', 'jira_comment', 'git_push']

export type RequestState = 'open' | 'locked' | 'expired' | 'revoked' | 'superseded' | 'closed'
export type ItemState = 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked' | 'superseded' | 'blocked_uncertain'
export type BindingState = 'reserved' | 'active' | 'quarantined' | 'closed'
export type OutboxState = 'reserved' | 'sent' | 'uncertain' | 'failed'
export type IntentState = 'pending' | 'prepared' | 'dispatching' | 'succeeded' | 'rejected_before_dispatch' | 'uncertain'

/** Recibo de una acción externa. `uncertain` nunca se reintenta solo. */
export interface ActionReceipt { intent_id: string; state: 'succeeded' | 'rejected_before_dispatch' | 'uncertain'; remote_ref?: string; result_digest?: string; error_code?: string }
export interface DeliveryReceipt { state: 'sent' | 'failed' | 'uncertain' | 'skipped'; outbox_ref?: string; error_code?: string }

export type DeliveryUnavailableReason = 'not_connected' | 'scope_missing' | 'identity_unverified' | 'identity_is_bot' | 'tool_off'
export interface DeliveryAvailability { available: boolean; reason?: DeliveryUnavailableReason }

export interface DeliveryAdapters {
  available(): Promise<Record<'gmail_self' | 'slack_self', DeliveryAvailability>>
  executeDelivery(input: { delivery_id: string; run_id: string; artifact_id: string; target: 'gmail_self' | 'slack_self'; expected_generation: number }): Promise<DeliveryReceipt>
}
export interface ActionExecutor {
  executeApprovedAction(input: { intent_id: string; expected_generation: number }): Promise<ActionReceipt>
  reconcile(intent_id: string): Promise<ActionReceipt>
}

/** Ítem tal como lo propone la síntesis. `exact_effect` es el efecto canónico que el ejecutor aplicará sin interpretación. */
export interface DecisionItemInput { kind: DecisionItemKind; project_id: string; summary: string; exact_effect: unknown }
export interface DecisionRequestInput {
  run_id: string
  artifact_id: string
  owner_id: string
  project_ids: string[]
  items: DecisionItemInput[]
  expires_at: string
}
export interface PublicDecisionItem { ordinal: number; kind: DecisionItemKind; summary: string; state: ItemState; effect_digest: string }
export interface PublicDecisionRequest { request_id: string; run_id: string; revision: number; state: RequestState; expires_at: string; canonical_digest: string; items: PublicDecisionItem[] }
export interface ApprovedItem { item_id: string; ordinal: number; kind: DecisionItemKind; project_id: string; effect_digest: string; state: IntentState }

/** Registro de exclusión no secreto: sobrevive al respaldo y evita ingerir mensajes de control tras restaurar sin decisions.sqlite. */
export interface Exclusion { integration: Integration; account: string; kind: 'message' | 'thread' | 'rfc_message_id' | 'conversation'; native_id: string }
export interface ExclusionSink { add(entries: Exclusion[]): Promise<void> }

/** Espejo público del estado por ítem (tabla schedule_item_states de la memoria). Sin códigos ni autoridad. */
export type PublicItemState = 'proposed' | 'approved' | 'rejected' | 'dispatching' | 'succeeded' | 'uncertain' | 'expired' | 'superseded' | 'unverifiable'
export interface PublicStateSink { set(entry: { run_id: string; ordinal: number; kind: DecisionItemKind; effect_digest: string; state: PublicItemState }): Promise<void> }

export type ParsedReply =
  | { kind: 'approve'; code: string; items: number[] | 'all' }
  | { kind: 'reject'; code: string | null; items: number[] | 'all' }
  | { kind: 'revise'; code: string; ordinal: number; value: string }
  | { kind: 'unrecognized'; reason: 'empty' | 'no_command' | 'missing_code' | 'bad_selection' | 'ambiguous_text' }

export type ConsumeOutcome =
  | 'approved' | 'rejected' | 'revision_requested'
  | 'duplicate' | 'no_open_request' | 'invalid_code' | 'locked' | 'rate_limited'
  | 'expired' | 'revoked' | 'bad_selection' | 'unrecognized' | 'binding_unavailable'

export interface ConsumeResult {
  outcome: ConsumeOutcome
  request_id?: string
  approved?: Array<{ item_id: string; ordinal: number; intent_id: string }>
  blocked_uncertain?: number[]
  rejected?: number[]
  revision?: { ordinal: number; value: string }
}

/** JSON con claves ordenadas: misma entrada lógica, mismos bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const row = value as Record<string, unknown>
  return `{${Object.keys(row).filter(key => row[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export class DecisionError extends Error {
  constructor(readonly code: string, message = code) { super(message) }
}
