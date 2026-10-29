import type { ItemState, RequestState } from './contract.js'

/**
 * Operaciones del dueño sobre la solicitud de decisión de un run, desde la app. Ninguna devuelve el código de aprobación ni una línea de respuesta:
 * el código solo viaja en el mensaje del canal. La autoridad de una aprobación desde la app es el digest exacto de lo que la persona vio.
 */
export interface DecisionItemView { ordinal: number; kind: string; summary: string; state: ItemState; effect_digest: string }
export interface DecisionView {
  request_id: string
  revision: number
  state: RequestState
  expires_at: string
  digest: string
  authority: 'verified' | 'authority_unavailable'
  items: DecisionItemView[]
}
/** Resultado de aprobar, rechazar, corregir o reproponer. Un ítem incierto no es un error: vuelve en `blocked_uncertain` y la app lo rotula «en reconciliación». */
export interface DecisionMutation {
  request_id: string
  revision: number
  state: RequestState
  expires_at: string
  digest: string
  items: DecisionItemView[]
  approved?: number[]
  rejected?: number[]
  blocked_uncertain?: number[]
}

/** `code` es cerrado: digest_mismatch | expired | revoked | superseded | locked | authority_unavailable | bad_selection | not_revisable | no_decision | not_reproposable | not_retryable. */
export class DecisionReviewError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = 'DecisionReviewError' }
}

export interface DecisionReview {
  view(runId: string): Promise<DecisionView | null>
  decide(runId: string, input: { kind: 'approve' | 'reject'; ordinals: number[]; digest?: string }): Promise<DecisionMutation>
  /** Solo ítems `jira_worklog` pendientes; la solicitud anterior queda anulada y hay que aprobar de nuevo con el digest nuevo. */
  revise(runId: string, input: { ordinal: number; seconds: number }): Promise<DecisionMutation>
  /** Solo ítems vencidos o nunca despachados; los inciertos se excluyen y se reconcilian. */
  repropose(runId: string): Promise<DecisionMutation>
  /** Decisión humana de reintentar una entrega incierta: cierra la entrega anterior para poder reservar otra. Devuelve cuántas cerró. */
  releaseDelivery(runId: string, integration: 'gmail' | 'slack'): Promise<number>
}
