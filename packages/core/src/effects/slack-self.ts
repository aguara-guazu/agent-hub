import { randomUUID } from 'node:crypto'
import { resultText, type CallResult } from '@agenthub/gateway'
import { renderDecisionFooter, type DecisionStore, type DeliveryReceipt, type ExclusionSink } from '@agenthub/memory'
import { EffectToolDenied, type EffectToolResolver, type EffectTools } from './tools.js'

export type SlackSelfAvailability = { available: true; user_id: string } | { available: false; reason: 'not_connected' | 'identity_unverified' | 'identity_is_bot' | 'tool_off' }

const SEND = 'slack_send_message'
const PROFILE = 'slack_read_user_profile'
const USER_ID = /^U[A-Z0-9]{8,}$/
const CHANNEL_ID = /^[CDG][A-Z0-9]{8,}$/
const TS = /^\d{10}\.\d{6}$/
const PERMALINK = /\/archives\/([CDG][A-Z0-9]{8,})\/p(\d{16})\b/g

function structured(result: CallResult): Record<string, any> | undefined {
  if (result.structured_content) return result.structured_content
  try { const parsed = JSON.parse(resultText(result)); return parsed && typeof parsed === 'object' ? parsed : undefined } catch { return undefined }
}

/**
 * Identidad humana del usuario conectado según el MCP de Slack del dueño. Solo cuenta un campo estructurado (`user.id`, `user_id` o `profile.user_id`):
 * un id que aparezca en texto libre puede ser el de otra persona. Devuelve `null` cuando la respuesta no permite acreditarla.
 * La forma exacta de la respuesta de `slack_read_user_profile` no está verificada contra un MCP real: ante cualquier duda, no hay identidad.
 */
export function parseSlackIdentity(result: CallResult): { user_id: string; is_bot: boolean; team: string | null } | null {
  if (result.is_error) return null
  const data = structured(result)
  if (!data) return null
  const user = data['user'] ?? data['profile'] ?? data
  const candidate = user?.['user_id'] ?? user?.['id'] ?? data['user_id']
  if (typeof candidate !== 'string' || !USER_ID.test(candidate)) return null
  const bot = user?.['is_bot'] ?? data['is_bot'] ?? user?.['is_app_user'] ?? false
  const team = user?.['team_id'] ?? data['team_id']
  return { user_id: candidate, is_bot: bot === true, team: typeof team === 'string' ? team : null }
}

/**
 * Recibo del mensaje enviado: `ts` y canal juntos, desde campos estructurados o desde el ÚNICO permalink `/archives/<canal>/p<16 dígitos>` de la respuesta.
 * Un ts suelto en el texto no sirve (puede ser el de un mensaje citado); si falta cualquiera de los dos, no hay recibo.
 */
export function parseSlackSent(result: CallResult): { ts: string; channel: string } | null {
  if (result.is_error) return null
  const data = structured(result)
  const ts = [data?.['ts'], data?.['message_ts'], data?.['message']?.['ts']].find((value): value is string => typeof value === 'string' && TS.test(value))
  const channel = [data?.['channel'], data?.['channel_id'], data?.['message']?.['channel']].find((value): value is string => typeof value === 'string' && CHANNEL_ID.test(value))
  if (ts && channel) return { ts, channel }
  const links = new Map([...resultText(result).matchAll(PERMALINK)].map(match => [`${match[1]}:${match[2]}`, { channel: match[1]!, digits: match[2]! }]))
  if (links.size !== 1) return null
  const { channel: linked, digits } = [...links.values()][0]!
  return { ts: `${digits.slice(0, 10)}.${digits.slice(10)}`, channel: linked }
}

/**
 * Entrega de la solicitud de decisión como mensaje directo al propio usuario por el MCP de Slack del dueño, con la identidad `hub_effects`.
 * El destino es siempre el user ID acreditado por el mismo servidor; un servidor que devuelva identidad de bot o ninguna deja el canal no disponible.
 */
export class SlackSelfDelivery {
  constructor(private readonly options: { store: DecisionStore; tools: EffectToolResolver; exclusions?: ExclusionSink }) {}

  private server(): { tools: EffectTools } | 'not_connected' | 'ambiguous' {
    const candidates = this.options.tools.candidates([SEND, PROFILE])
    if (!candidates.length) return 'not_connected'
    if (candidates.length > 1) return 'ambiguous'
    return { tools: this.options.tools.forServer(candidates[0]!) }
  }

  async available(): Promise<SlackSelfAvailability> {
    const server = this.server()
    if (server === 'not_connected') return { available: false, reason: this.options.tools.published?.([SEND, PROFILE]) ? 'tool_off' : 'not_connected' }
    if (server === 'ambiguous') return { available: false, reason: 'identity_unverified' }
    let identity
    try { identity = parseSlackIdentity(await server.tools.call(PROFILE, {})) } catch (error) {
      return { available: false, reason: error instanceof EffectToolDenied ? 'tool_off' : 'identity_unverified' }
    }
    if (!identity) return { available: false, reason: 'identity_unverified' }
    return identity.is_bot ? { available: false, reason: 'identity_is_bot' } : { available: true, user_id: identity.user_id }
  }

  /**
   * Mensaje directo sin solicitud de decisión (avisos y resúmenes sin acciones). No hay binding ni código; el canal devuelto por el envío
   * se excluye de la ingesta para que el resumen no vuelva a la memoria. Un resultado sin recibo interpretable queda incierto.
   */
  async deliverPlain(input: { text: string }): Promise<DeliveryReceipt> {
    const server = this.server()
    if (typeof server === 'string') return { state: 'failed', error_code: server === 'ambiguous' ? 'ambiguous_server' : 'tool_off' }
    let identity
    try { identity = parseSlackIdentity(await server.tools.call(PROFILE, {})) } catch { return { state: 'failed', error_code: 'identity_unverified' } }
    if (!identity) return { state: 'failed', error_code: 'identity_unverified' }
    if (identity.is_bot) return { state: 'failed', error_code: 'identity_is_bot' }
    let result: CallResult
    try { result = await server.tools.call(SEND, { channel_id: identity.user_id, message: input.text }) } catch (error) {
      return error instanceof EffectToolDenied ? { state: 'failed', error_code: 'tool_off' } : { state: 'uncertain', error_code: 'send_threw' }
    }
    const sent = parseSlackSent(result)
    if (!sent) return { state: 'uncertain', error_code: result.is_error ? 'tool_error' : 'receipt_unparsed' }
    try {
      await this.options.exclusions?.add([{ integration: 'slack', account: identity.user_id, kind: 'conversation', native_id: sent.channel },
        { integration: 'slack', account: identity.user_id, kind: 'message', native_id: sent.ts }])
    } catch { return { state: 'sent', error_code: 'exclusion_not_recorded' } }
    return { state: 'sent' }
  }

  async deliver(input: { request_id: string; text: string }): Promise<DeliveryReceipt> {
    const { store } = this.options
    const server = this.server()
    if (typeof server === 'string') return { state: 'failed', error_code: server === 'ambiguous' ? 'ambiguous_server' : 'tool_off' }
    let identity
    try { identity = parseSlackIdentity(await server.tools.call(PROFILE, {})) } catch { return { state: 'failed', error_code: 'identity_unverified' } }
    if (!identity) return { state: 'failed', error_code: 'identity_unverified' }
    if (identity.is_bot) return { state: 'failed', error_code: 'identity_is_bot' }

    let reservation
    try {
      reservation = await store.reserveDelivery({ request_id: input.request_id, integration: 'slack', account: identity.user_id, correlation: `slack-${randomUUID()}`,
        conversation: identity.user_id, remote_user: identity.user_id, ...(identity.team ? { team: identity.team } : {}), provenance: 'slack-mcp-user' })
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'request_not_open') return { state: 'skipped', error_code: code }
      if (code === 'delivery_already_dispatched') {
        const prior = store.bindingsOf(input.request_id).filter(binding => binding.integration === 'slack' && binding.account === identity.user_id && binding.delivery_state !== 'failed').at(-1)
        return { state: prior?.delivery_state === 'sent' ? 'sent' : 'uncertain', error_code: code }
      }
      throw error
    }
    if (reservation.state === 'sending' || !store.beginSend(reservation.delivery_id)) return { state: 'uncertain', error_code: 'delivery_in_flight', outbox_ref: reservation.delivery_id }

    const text = `${input.text.trimEnd()}\n${renderDecisionFooter(store.publicRequest(input.request_id), store.codeFor(input.request_id))}`
    let result: CallResult
    try { result = await server.tools.call(SEND, { channel_id: identity.user_id, message: text }) } catch (error) {
      if (error instanceof EffectToolDenied) { store.markDeliveryFailed(reservation.delivery_id); return { state: 'failed', error_code: 'tool_off', outbox_ref: reservation.delivery_id } }
      store.markDeliveryUncertain(reservation.delivery_id)
      return { state: 'uncertain', error_code: 'send_threw', outbox_ref: reservation.delivery_id }
    }
    const sent = parseSlackSent(result)
    if (!sent) {
      store.markDeliveryUncertain(reservation.delivery_id)
      return { state: 'uncertain', error_code: result.is_error ? 'tool_error' : 'receipt_unparsed', outbox_ref: reservation.delivery_id }
    }
    try { await store.recordNative(reservation.delivery_id, { native_id: sent.ts, delivery_ref: sent.ts, conversation: sent.channel }) } catch { return { state: 'uncertain', error_code: 'receipt_not_recorded', outbox_ref: reservation.delivery_id } }
    return { state: 'sent', outbox_ref: reservation.delivery_id }
  }
}
