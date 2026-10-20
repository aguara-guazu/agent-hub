/** Native observations only. This contract is not a writable LLM tool. */
export type UsageQuotaState = 'available' | 'low' | 'exhausted' | 'cooldown' | 'unknown'
export interface UsageQuotaWindow {
  id: string
  unit: 'percent' | 'credits' | 'tokens' | 'requests' | 'unknown'
  used?: number
  limit?: number
  remaining?: number
  resets_at?: string
  duration_minutes?: number
  status?: UsageQuotaState
}
export interface UsageQuotaObservation {
  cli: string
  provider: string
  /** Opaque native identity, never email, token or a session id. Omit if not verified. */
  account_ref?: string
  pool_id: string
  model_ids?: string[]
  observed_at: string
  expires_at: string
  source: { kind: 'native'; adapter: string; reference?: string }
  windows: UsageQuotaWindow[]
  /** False when the native response omits a known constraint. */
  complete?: boolean
  status?: UsageQuotaState
  reason?: string
}
/** Issued by the server before collection; retain this ticket through ingestion. */
export interface UsageQuotaBinding {
  binding_id: string
  binding_version: number
  cli: string
  provider: string
  account_ref?: string
}
/** A constraint retained from an earlier native sample, with its original validity. */
export interface UsageQuotaWindowEvidence {
  window: UsageQuotaWindow
  observed_at: string
  expires_at: string
  source: UsageQuotaObservation['source']
}
export interface UsageQuotaSnapshot {
  id: string
  provider: string
  account_ref?: string
  pool_id: string
  scope: 'account' | 'binding'
  identity_confidence: 'verified' | 'unknown_account'
  binding_ids: string[]
  clis: string[]
  model_ids: string[]
  status: UsageQuotaState
  observed_status: UsageQuotaState
  stale: boolean
  reason?: string
  observation: UsageQuotaObservation
  last_known: UsageQuotaObservation | null
  retained_windows?: UsageQuotaWindowEvidence[]
}
export interface UsageQuotaTransition {
  id: string
  pool_key: string
  before: UsageQuotaState
  after: UsageQuotaState
  observed_at: string
  binding_ids: string[]
  clis: string[]
}
export interface UsageQuotaFilter {
  cli?: string
  provider?: string
  account_ref?: string
  binding_id?: string
  model?: string
  now?: string
}
export interface UsageQuotaAvailability {
  status: UsageQuotaState
  reason?: string
  pools: UsageQuotaSnapshot[]
}
export interface UsageQuotaIngestResult {
  accepted: boolean
  reason?: 'stale_binding' | 'out_of_order' | 'duplicate' | 'conflicting_observation'
  snapshot?: UsageQuotaSnapshot
  transitions: UsageQuotaTransition[]
}
