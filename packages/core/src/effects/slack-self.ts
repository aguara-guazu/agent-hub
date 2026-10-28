import { randomUUID } from 'node:crypto'
import { resultText, type CallResult } from '@agenthub/gateway'
import { renderDecisionFooter, type DecisionStore, type DeliveryReceipt } from '@agenthub/memory'
import { EffectToolDenied, type EffectToolResolver, type EffectTools } from './tools.js'

export type SlackSelfAvailability = { available: true; user_id: string } | { available: false; reason: 'not_connected' | 'identity_unverified' | 'identity_is_bot' | 'tool_off' }

const SEND = 'slack_send_message'
const PROFILE = 'slack_read_user_profile'
const USER_ID = /^U[A-Z0-9]{8,}$/
const TS = /\b\d{10}\.\d{6}\b/

function structured(result: CallResult): Record<string, any> | undefined {
  if (result.structured_content) return result.structured_content
  try { const parsed = JSON.parse(resultText(result)); return parsed && typeof parsed === 'object' ? parsed : undefined } catch { return undefined }
}

/**
 * Identidad humana del usuario conectado según el MCP de Slack del dueño. Devuelve `null` cuando la respuesta no permite acreditarla.
 * La forma exacta de la respuesta de `slack_read_user_profile` no está verificada contra un MCP real: ante cualquier duda, no hay identidad.
 */
export function parseSlackIdentity(result: CallResult): { user_id: string; is_bot: boolean; team: string | null } | null {
  if (result.is_error) return null
  const data = structured(result)
  const user = data?.['user'] ?? data?.['profile'] ?? data
  const candidate = user?.['user_id'] ?? user?.['id'] ?? data?.['user_id'] ?? (resultText(result).match(/\b(U[A-Z0-9]{8,})\b/)?.[1])
  if (typeof candidate !== 'string' || !USER_ID.test(candidate)) return null
  const bot = user?.['is_bot'] ?? data?.['is_bot'] ?? user?.['is_app_user'] ?? false
  const team = user?.['team_id'] ?? data?.['team_id']
  return { user_id: candidate, is_bot: bot === true, team: typeof team === 'string' ? team : null }
}

/** Marca de tiempo del mensaje enviado: campo `ts`/`message_ts`, o el permalink `/p<16 dígitos>`, o un `ts` literal. `null` si no hay. */
export function parseSlackTs(result: CallResult): string | null {
  if (result.is_error) return null
  const data = structured(result)
  for (const value of [data?.['ts'], data?.['message_ts'], data?.['message']?.['ts']]) if (typeof value === 'string' && TS.test(value)) return value
  const text = resultText(result)
  const permalink = text.match(/\/p(\d{16})\b/)
  if (permalink) return `${permalink[1]!.slice(0, 10)}.${permalink[1]!.slice(10)}`
  return text.match(TS)?.[0] ?? null
}

/**
 * Entrega de la solicitud de decisión como mensaje directo al propio usuario por el MCP de Slack del dueño, con la identidad `hub_effects`.
 * El destino es siempre el user ID acreditado por el mismo servidor; un servidor que devuelva identidad de bot o ninguna deja el canal no disponible.
 */
export class SlackSelfDelivery {
  constructor(private readonly options: { store: DecisionStore; tools: EffectToolResolver }) {}

  private server(): { tools: EffectTools } | 'not_connected' | 'ambiguous' {
    const candidates = this.options.tools.candidates([SEND, PROFILE])
    if (!candidates.length) return 'not_connected'
    if (candidates.length > 1) return 'ambiguous'
    return { tools: this.options.tools.forServer(candidates[0]!) }
  }

  async available(): Promise<SlackSelfAvailability> {
    const server = this.server()
    if (server === 'not_connected') return { available: false, reason: 'tool_off' }
    if (server === 'ambiguous') return { available: false, reason: 'identity_unverified' }
    let identity
    try { identity = parseSlackIdentity(await server.tools.call(PROFILE, {})) } catch (error) {
      return { available: false, reason: error instanceof EffectToolDenied ? 'tool_off' : 'not_connected' }
    }
    if (!identity) return { available: false, reason: 'identity_unverified' }
    return identity.is_bot ? { available: false, reason: 'identity_is_bot' } : { available: true, user_id: identity.user_id }
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
    const ts = parseSlackTs(result)
    if (!ts) {
      store.markDeliveryUncertain(reservation.delivery_id)
      return { state: 'uncertain', error_code: result.is_error ? 'tool_error' : 'receipt_unparsed', outbox_ref: reservation.delivery_id }
    }
    try { await store.recordNative(reservation.delivery_id, { native_id: ts, delivery_ref: ts }) } catch { return { state: 'uncertain', error_code: 'receipt_not_recorded', outbox_ref: reservation.delivery_id } }
    return { state: 'sent', outbox_ref: reservation.delivery_id }
  }
}
