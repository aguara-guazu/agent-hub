import { GMAIL_SEND_SCOPE, type GoogleAuth } from '../google-auth.js'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const TIMEOUT_MS = 30_000
const HEADER_VALUE = /^[^\r\n\0]{1,998}$/
const ADDRESS = /^[^\s<>()",;:\\]+@[^\s<>()",;:\\]+$/

export interface SelfMessage {
  /** RFC 5322 Message-ID propio, con corchetes angulares; se reserva en el outbox ANTES de enviar. */
  message_id: string
  subject: string
  text: string
  in_reply_to?: string
  references?: string[]
  /** Hilo de Gmail al que se agrega la respuesta (solo lo conoce el outbox, nunca un agente). */
  thread_id?: string
}

/**
 * `failed`: Google rechazó la solicitud y no aceptó ningún mensaje, o no hubo solicitud.
 * `uncertain`: la solicitud pudo llegar a Google sin que haya prueba de lo que ocurrió; nunca se reintenta sola.
 */
export type SelfSendOutcome =
  | { state: 'sent'; native_id: string; thread_id: string | null }
  | { state: 'failed'; reason: 'scope_missing' | 'auth' | 'account_mismatch' | 'invalid_message' | 'rejected' }
  | { state: 'uncertain'; reason: 'network' | 'server_error' | 'bad_response' }

function header(name: string, value: string): string {
  if (!HEADER_VALUE.test(value)) throw new RangeError(`encabezado inválido: ${name}`)
  return `${name}: ${value}`
}

/** El asunto va en palabras codificadas (RFC 2047) para no depender del juego de caracteres de la conexión. */
function encodedSubject(subject: string): string {
  return /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
}

/** Arma el mensaje RFC 5322. El destinatario y el remitente son siempre la cuenta recibida: no existe ningún otro parámetro de destino. */
export function composeSelfMessage(account: string, message: SelfMessage): string {
  if (!ADDRESS.test(account)) throw new RangeError('cuenta inválida')
  const lines = [
    header('From', account), header('To', account), header('Subject', encodedSubject(message.subject.replace(/[\r\n]+/g, ' '))), header('Message-ID', message.message_id),
    ...(message.in_reply_to ? [header('In-Reply-To', message.in_reply_to)] : []),
    ...(message.references?.length ? [header('References', message.references.join(' '))] : []),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', 'Auto-Submitted: auto-generated', 'X-Agent-Hub-Control: 1',
  ]
  const body = Buffer.from(message.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
  return `${lines.join('\r\n')}\r\n\r\n${body}`
}

/**
 * Envío a la PROPIA cuenta conectada. La dirección se lee del perfil de Gmail de ese mismo token en cada envío y, si el llamador fijó
 * una cuenta esperada, debe coincidir. No hay parámetro de destinatario, así que ni un agente ni un efecto aprobado pueden enviar a terceros.
 * Referencia de la API: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
 */
export class GmailSelfSender {
  constructor(private readonly google: GoogleAuth, private readonly fetcher: typeof fetch = fetch) {}

  private async authorized(connectorId: string): Promise<{ headers: Record<string, string> } | 'scope_missing' | 'auth'> {
    if (!this.google.granted(connectorId, GMAIL_SEND_SCOPE)) return 'scope_missing'
    try { return { headers: { authorization: `Bearer ${await this.google.token(connectorId)}` } } } catch { return 'auth' }
  }

  /** Dirección de la cuenta conectada según Gmail, o `null` si no se pudo comprobar. */
  async account(connectorId: string): Promise<string | null> {
    const auth = await this.authorized(connectorId)
    if (typeof auth === 'string') return null
    try {
      const response = await this.fetcher(`${API}/profile`, { headers: auth.headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!response.ok) return null
      const address = (await response.json() as { emailAddress?: unknown }).emailAddress
      return typeof address === 'string' && ADDRESS.test(address) ? address : null
    } catch { return null }
  }

  async send(connectorId: string, message: SelfMessage, expectedAccount?: string): Promise<SelfSendOutcome> {
    const auth = await this.authorized(connectorId)
    if (typeof auth === 'string') return { state: 'failed', reason: auth }
    const account = await this.account(connectorId)
    if (!account) return { state: 'failed', reason: 'auth' }
    if (expectedAccount !== undefined && account.toLowerCase() !== expectedAccount.toLowerCase()) return { state: 'failed', reason: 'account_mismatch' }
    let raw: string
    try { raw = Buffer.from(composeSelfMessage(account, message), 'utf8').toString('base64url') } catch { return { state: 'failed', reason: 'invalid_message' } }
    let response: Response
    try {
      response = await this.fetcher(`${API}/messages/send`, { method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ raw, ...(message.thread_id ? { threadId: message.thread_id } : {}) }), signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch { return { state: 'uncertain', reason: 'network' } }
    if (response.status >= 500 || response.status === 408) return { state: 'uncertain', reason: 'server_error' }
    if (!response.ok) return { state: 'failed', reason: response.status === 401 || response.status === 403 ? 'auth' : 'rejected' }
    try {
      const sent = await response.json() as { id?: unknown; threadId?: unknown }
      if (typeof sent.id !== 'string' || !sent.id) return { state: 'uncertain', reason: 'bad_response' }
      return { state: 'sent', native_id: sent.id, thread_id: typeof sent.threadId === 'string' ? sent.threadId : null }
    } catch { return { state: 'uncertain', reason: 'bad_response' } }
  }
}
