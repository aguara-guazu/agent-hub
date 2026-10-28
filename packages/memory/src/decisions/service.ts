import type { ConsumeResult, Integration, ParsedReply } from './contract.js'
import type { DecisionStore, IntentRow } from './store.js'

/** Vigencia de la autoridad de un artefacto, tal como la lee el runtime del scheduler (schedule_artifacts.authority). */
export type ArtifactAuthority = 'live' | 'unavailable' | 'unknown'
export type ArtifactAuthorityReader = (decisionRequestRef: string) => Promise<ArtifactAuthority>

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
    if (this.store.authorityOf(requestId) !== 'verified') return false
    try { return (await this.authority(requestId)) === 'live' } catch { return false }
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

  /** Volver a proponer solo es posible con autoridad vigente; lo incierto nunca se repropone (lo bloquea el almacén al aprobar). */
  async canRepropose(requestId: string): Promise<boolean> { return this.live(requestId) }

  /** Intenciones pendientes con autoridad vigente, para el ciclo de despacho. */
  async dispatchable(): Promise<IntentRow[]> {
    const ready: IntentRow[] = []
    for (const intent of this.store.pendingIntents()) if (await this.live(intent.request_id)) ready.push(intent)
    return ready
  }
}
