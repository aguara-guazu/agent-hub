import { randomUUID } from 'node:crypto'
import type { GmailSelfSender, SelfSendOutcome } from '../connectors/gmail-send.js'
import { formatCode, normalizeCode } from './codes.js'
import type { DeliveryReceipt, PublicDecisionRequest } from './contract.js'
import { DecisionError } from './contract.js'
import type { DecisionStore } from './store.js'

export interface GmailDeliveryInput {
  request_id: string
  connector_id: string
  subject: string
  /** Texto ya sintetizado del artefacto. Los códigos se agregan aquí, después de la síntesis, y nunca vuelven a ningún agente. */
  text: string
}

/** Pie con la instrucción de respuesta y los ítems pendientes. El código sale del almacén privado y solo viaja en este mensaje. */
export function renderDecisionFooter(request: PublicDecisionRequest, code: string): string {
  const pending = request.items.filter(item => item.state === 'pending')
  if (!pending.length) return ''
  const shown = formatCode(normalizeCode(code) ?? code)
  return [
    '', '---', 'Para decidir, responde a este mismo mensaje con una sola línea:',
    ...pending.map(item => `${item.ordinal}. ${item.summary}`),
    `aprobar ${shown} 1,2  ·  ${shown} ok (todo)  ·  rechazar ${shown} 2  ·  ${shown} 2=1.5 (corregir)`,
    `Vence: ${request.expires_at}`,
  ].join('\n')
}

const receiptOf = (outcome: Exclude<SelfSendOutcome, { state: 'sent' }>): DeliveryReceipt =>
  ({ state: outcome.state, error_code: outcome.reason })

/**
 * Entrega la solicitud de decisión por Gmail a la propia cuenta: reserva (outbox y exclusión persistidos) → `sending` durable → envío → recibo.
 *
 * Un resultado ambiguo deja la entrega `uncertain` y su binding en cuarentena; `failed` solo se registra cuando Google rechazó la solicitud o
 * no hubo solicitud. Cualquier excepción tras `beginSend` deja `sending`, que `recover()` convierte en `uncertain` tras un reinicio.
 */
export async function deliverDecisionByGmail(deps: { store: DecisionStore; sender: GmailSelfSender; messageId?: () => string }, input: GmailDeliveryInput): Promise<DeliveryReceipt> {
  const { store, sender } = deps
  const account = await sender.account(input.connector_id)
  if (!account) return { state: 'failed', error_code: 'identity_unverified' }
  let reservation
  try {
    reservation = await store.reserveDelivery({ request_id: input.request_id, integration: 'gmail', account, provenance: 'oauth-gmail-send',
      correlation: (deps.messageId ?? (() => `<hub-${randomUUID()}@agent-hub.invalid>`))() })
  } catch (error) {
    if (!(error instanceof DecisionError)) throw error
    if (error.code === 'request_not_open') return { state: 'skipped', error_code: error.code }
    const prior = store.bindingsOf(input.request_id).filter(binding => binding.integration === 'gmail' && binding.account === account && binding.delivery_state !== 'failed').at(-1)
    if (error.code === 'delivery_already_dispatched' && prior) return { state: prior.delivery_state === 'sent' ? 'sent' : 'uncertain', error_code: error.code }
    throw error
  }
  if (reservation.state === 'sending') return { state: 'uncertain', error_code: 'delivery_in_flight', outbox_ref: reservation.delivery_id }
  if (!store.beginSend(reservation.delivery_id)) return { state: 'uncertain', error_code: 'delivery_in_flight', outbox_ref: reservation.delivery_id }

  const text = `${input.text.trimEnd()}\n${renderDecisionFooter(store.publicRequest(input.request_id), store.codeFor(input.request_id))}`
  let outcome: SelfSendOutcome
  try {
    outcome = await sender.send(input.connector_id, { message_id: reservation.correlation, subject: input.subject, text }, account)
  } catch {
    store.markDeliveryUncertain(reservation.delivery_id)
    return { state: 'uncertain', error_code: 'send_threw', outbox_ref: reservation.delivery_id }
  }
  if (outcome.state === 'failed') { store.markDeliveryFailed(reservation.delivery_id); return { ...receiptOf(outcome), outbox_ref: reservation.delivery_id } }
  if (outcome.state === 'uncertain') { store.markDeliveryUncertain(reservation.delivery_id); return { ...receiptOf(outcome), outbox_ref: reservation.delivery_id } }
  try {
    await store.recordNative(reservation.delivery_id, { native_id: outcome.native_id, ...(outcome.thread_id ? { thread_id: outcome.thread_id } : {}) })
  } catch {
    return { state: 'uncertain', error_code: 'receipt_not_recorded', outbox_ref: reservation.delivery_id }
  }
  return { state: 'sent', outbox_ref: reservation.delivery_id }
}
