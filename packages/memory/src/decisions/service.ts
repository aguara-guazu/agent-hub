import type { ConsumeResult, DecisionRequestInput, FollowUpClaim, Integration, ParsedReply } from './contract.js'
import type { DecisionStore, IntentRow } from './store.js'

/** Vigencia de la autoridad de un artefacto, tal como la lee el runtime del scheduler (schedule_artifacts.authority). */
export type ArtifactAuthority = 'live' | 'unavailable' | 'unknown'
/** Se resuelve por run; si viene la referencia, el lector valida que pertenezca a ese artefacto (`unknown` si no). */
export type ArtifactAuthorityReader = (query: { run_id: string; decision_request_ref?: string }) => Promise<ArtifactAuthority>

export type GatedOutcome<T> = { gated: false; value: T } | { gated: true; reason: 'authority_unavailable' }

/**
 * Compuerta de autoridad delante del almacén privado.
 *
 * La memoria es asíncrona y el almacén es síncrono, así que la vigencia del artefacto se consulta aquí ANTES de tocar decisions.sqlite:
 * al procesar una respuesta, antes de reclamar una intención para despacho o reintento, y antes de volver a proponer.
 * `unavailable` y `unknown` deniegan; que la solicitud exista en el almacén no promueve nada a `live`. Los efectos inciertos se conservan.
 */
export class DecisionService {
  constructor(readonly store: DecisionStore, private readonly authority: ArtifactAuthorityReader) {}

  /** `live` solo si el lector lo afirma y el almacén conoce la solicitud; cualquier otra cosa deniega. */
  async live(requestId: string): Promise<boolean> {
    const run = this.store.runOfRequest(requestId)
    if (!run || this.store.authorityOf(requestId) !== 'verified') return false
    return this.runLive({ run_id: run, decision_request_ref: requestId })
  }

  private async runLive(query: { run_id: string; decision_request_ref?: string }): Promise<boolean> {
    try { return (await this.authority(query)) === 'live' } catch { return false }
  }

  /** Prepara la solicitud de un run solo si el artefacto del run tiene autoridad vigente (también en la reparación tras una caída). */
  async prepareDecision(input: DecisionRequestInput): Promise<GatedOutcome<ReturnType<DecisionStore['prepareDecision']>>> {
    if (!(await this.runLive({ run_id: input.run_id }))) return { gated: true, reason: 'authority_unavailable' }
    return { gated: false, value: this.store.prepareDecision(input) }
  }

  async processReply(input: { integration: Integration; account: string; native_message_id: string; binding_id: string; parsed: ParsedReply }): Promise<GatedOutcome<ConsumeResult>> {
    const requestId = this.store.requestOfBinding(input.binding_id)
    if (!requestId || !(await this.live(requestId))) return { gated: true, reason: 'authority_unavailable' }
    return { gated: false, value: this.store.consumeReply(input) }
  }

  /** Reclama una intención para despacho o reintento. Sin autoridad vigente no se reclama y la intención queda intacta. */
  async claimForDispatch(intentId: string, expectedGeneration: number): Promise<GatedOutcome<ReturnType<DecisionStore['claimIntent']>>> {
    const requestId = this.store.requestOfIntent(intentId)
    if (!requestId || !(await this.live(requestId))) return { gated: true, reason: 'authority_unavailable' }
    return { gated: false, value: this.store.claimIntent(intentId, expectedGeneration) }
  }

  /** Reclama el seguimiento de un proyecto solo con autoridad vigente, solicitud ni revocada ni superseded y sin vencer. */
  async claimFollowUp(requestId: string, projectId: string, consumerRef: string): Promise<GatedOutcome<FollowUpClaim>> {
    const request = this.store.publicRequest(requestId)
    const usable = request.state !== 'revoked' && request.state !== 'superseded' && request.state !== 'expired' && Date.parse(request.expires_at) > this.store.clock().getTime()
    if (!usable || !(await this.live(requestId))) return { gated: true, reason: 'authority_unavailable' }
    return { gated: false, value: this.store.claimFollowUp(requestId, projectId, consumerRef) }
  }

  /** Volver a proponer solo es posible con autoridad vigente; lo incierto nunca se repropone (lo bloquea el almacén al aprobar). */
  async canRepropose(requestId: string): Promise<boolean> { return this.live(requestId) }

  /** Intenciones pendientes con autoridad vigente, para el ciclo de despacho. */
  async dispatchable(): Promise<IntentRow[]> {
    const ready: IntentRow[] = []
    for (const intent of this.store.pendingIntents()) if (await this.live(intent.request_id)) ready.push(intent)
    return ready
  }
}
