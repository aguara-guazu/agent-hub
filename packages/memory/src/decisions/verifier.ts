import { normalizeCode } from './codes.js'
import type { ParsedReply } from './contract.js'

/**
 * Verificador determinista de respuestas. Funciones puras: ningún modelo participa y nada se infiere.
 * La gramática es cerrada; fuera de ella, la respuesta se descarta y se pide un comando limpio por el mismo canal.
 */

const CODE_TOKEN = '([A-Za-z0-9]{4}[-\\s]?[A-Za-z0-9]{4})'
const SELECTION = '((?:\\d{1,3}(?:\\s*-\\s*\\d{1,3})?)(?:\\s*[,\\s]\\s*\\d{1,3}(?:\\s*-\\s*\\d{1,3})?)*)'
const MAX_SELECTED = 50
const DECLINE = /^(no|hoy no|no gracias|rechazar todo)$/i
const APPROVE = new RegExp(`^(?:aprobar|aprueba)\\s+${CODE_TOKEN}\\s+(?:${SELECTION}|(todo|todos|ok))$`, 'i')
const APPROVE_ALL = new RegExp(`^${CODE_TOKEN}\\s+(?:ok|si|sí)$`, 'i')
const REJECT = new RegExp(`^(?:rechazar|rechaza)\\s+${CODE_TOKEN}\\s+(?:${SELECTION}|(todo|todos))$`, 'i')
const REVISE = new RegExp(`^${CODE_TOKEN}\\s+(\\d{1,3})\\s*=\\s*(\\d{1,3}(?:[.,]\\d{1,2})?)$`, 'i')

function ordinals(raw: string): number[] | null {
  const found = new Set<number>()
  for (const part of raw.split(/\s*,\s*|\s+/).filter(Boolean)) {
    const range = /^(\d{1,3})\s*-\s*(\d{1,3})$/.exec(part)
    const [from, to] = range ? [Number(range[1]), Number(range[2])] : [Number(part), Number(part)]
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to - from >= MAX_SELECTED) return null
    for (let n = from; n <= to; n++) found.add(n)
    if (found.size > MAX_SELECTED) return null
  }
  return found.size ? [...found].sort((a, b) => a - b) : null
}

/** Interpreta UNA línea de texto nuevo. Nunca acepta «sí»/«ok» sin código para aprobar. */
export function parseReply(text: string): ParsedReply {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length === 0) return { kind: 'unrecognized', reason: 'empty' }
  if (lines.length > 1) return { kind: 'unrecognized', reason: 'ambiguous_text' }
  const line = lines[0]!.replace(/[.!\s]+$/, '').replace(/\s+/g, ' ')
  if (DECLINE.test(line)) return { kind: 'reject', code: null, items: 'all' }
  const approve = APPROVE.exec(line)
  if (approve) {
    const code = normalizeCode(approve[1]!)
    if (!code) return { kind: 'unrecognized', reason: 'no_command' }
    if (approve[3]) return { kind: 'approve', code, items: 'all' }
    const items = ordinals(approve[2]!)
    return items ? { kind: 'approve', code, items } : { kind: 'unrecognized', reason: 'bad_selection' }
  }
  const all = APPROVE_ALL.exec(line)
  if (all) {
    const code = normalizeCode(all[1]!)
    return code ? { kind: 'approve', code, items: 'all' } : { kind: 'unrecognized', reason: 'no_command' }
  }
  const reject = REJECT.exec(line)
  if (reject) {
    const code = normalizeCode(reject[1]!)
    if (!code) return { kind: 'unrecognized', reason: 'no_command' }
    if (reject[3]) return { kind: 'reject', code, items: 'all' }
    const items = ordinals(reject[2]!)
    return items ? { kind: 'reject', code, items } : { kind: 'unrecognized', reason: 'bad_selection' }
  }
  const revise = REVISE.exec(line)
  if (revise) {
    const code = normalizeCode(revise[1]!)
    return code ? { kind: 'revise', code, ordinal: Number(revise[2]), value: revise[3]!.replace(',', '.') } : { kind: 'unrecognized', reason: 'no_command' }
  }
  if (/^(aprobar|aprueba|rechazar|rechaza)\b/i.test(line)) return { kind: 'unrecognized', reason: 'missing_code' }
  return { kind: 'unrecognized', reason: 'no_command' }
}

const QUOTE_START = [
  /^>/,
  /^(on|el)\s.{3,300}\s(wrote|escribi[óo]):?$/i,
  /^(wrote|escribi[óo]):?$/i,
  /^-{2,}\s*(original message|mensaje original|forwarded message|mensaje reenviado)/i,
  /^_{5,}$/,
  /^(from|de):\s.+/i,
  /^begin forwarded message/i,
]
const SIGNATURE = /^(--\s?$|enviado desde|sent from|obtener outlook|get outlook)/i

/**
 * Texto nuevo de una respuesta en texto plano: lo anterior a la primera cita, sin firma.
 * Devuelve null si no se puede separar con certeza (cita sin marca reconocible, varias líneas o primera línea citada).
 */
export function extractNewText(raw: string): string | null {
  const lines = raw.split(/\r?\n/)
  const cut = lines.findIndex(line => QUOTE_START.some(pattern => pattern.test(line.trim())))
  const head = (cut === -1 ? lines : lines.slice(0, cut)).map(line => line.trim())
  const signature = head.findIndex(line => SIGNATURE.test(line))
  const body = (signature === -1 ? head : head.slice(0, signature)).filter(Boolean)
  return body.length === 1 ? body[0]! : null
}

export interface GmailEvidence {
  id: string
  threadId: string
  labelIds: readonly string[]
  /** Direcciones del encabezado From, ya separadas. Más de una invalida la respuesta. */
  from: readonly string[]
  inReplyTo: readonly string[]
  references: readonly string[]
  autoSubmitted?: string | null
  hasAttachments: boolean
  bodyText: string
}
export interface GmailBindingView { account: string; verifiedAliases?: readonly string[]; threadId: string | null; correlations: readonly string[]; hubNativeIds: readonly string[] }

export type RejectReason = 'not_sent' | 'from' | 'thread' | 'not_reply' | 'hub_message' | 'automatic' | 'attachments' | 'ambiguous_text' | 'bot' | 'channel' | 'user' | 'team' | 'edited' | 'not_in_thread' | 'binding_incomplete'
export type Verification = { ok: true; parsed: ParsedReply } | { ok: false; reason: RejectReason }

/**
 * SENT sobre ESE mensaje, From de la cuenta fijada (alias solo si ya verificado, sin normalizar plus-addressing ni puntos),
 * mismo hilo Y relación In-Reply-To/References con un Message-ID del outbox, y texto nuevo inequívoco.
 */
export function verifyGmailReply(evidence: GmailEvidence, binding: GmailBindingView): Verification {
  if (!binding.threadId) return { ok: false, reason: 'binding_incomplete' }
  if (binding.hubNativeIds.includes(evidence.id)) return { ok: false, reason: 'hub_message' }
  if (!evidence.labelIds.includes('SENT') || evidence.labelIds.includes('DRAFT')) return { ok: false, reason: 'not_sent' }
  const allowed = new Set([binding.account, ...(binding.verifiedAliases ?? [])].map(address => address.toLowerCase()))
  if (evidence.from.length !== 1 || !allowed.has(evidence.from[0]!.toLowerCase())) return { ok: false, reason: 'from' }
  if (evidence.threadId !== binding.threadId) return { ok: false, reason: 'thread' }
  const links = new Set([...evidence.inReplyTo, ...evidence.references].map(id => id.trim().replace(/^<|>$/g, '')))
  if (!binding.correlations.some(id => links.has(id.trim().replace(/^<|>$/g, '')))) return { ok: false, reason: 'not_reply' }
  const auto = evidence.autoSubmitted?.trim().toLowerCase()
  if (auto && auto !== 'no') return { ok: false, reason: 'automatic' }
  if (evidence.hasAttachments) return { ok: false, reason: 'attachments' }
  const text = extractNewText(evidence.bodyText)
  if (text === null) return { ok: false, reason: 'ambiguous_text' }
  return { ok: true, parsed: parseReply(text) }
}

export interface SlackEvidence {
  channel: string
  ts: string
  thread_ts?: string
  user?: string
  team?: string
  bot_id?: string
  app_id?: string
  subtype?: string
  hidden?: boolean
  edited?: unknown
  text: string
}
export interface SlackBindingView { channel: string | null; team: string | null; userId: string | null; deliveryTs: string | null; hubTs: readonly string[] }

/** DM fijado, mismo usuario y equipo, respuesta en el hilo del mensaje de entrega, sin bot, app, edición, oculto ni subtipo de sistema. */
export function verifySlackReply(evidence: SlackEvidence, binding: SlackBindingView): Verification {
  if (!binding.channel || !binding.userId || !binding.team || !binding.deliveryTs) return { ok: false, reason: 'binding_incomplete' }
  if (binding.hubTs.includes(evidence.ts)) return { ok: false, reason: 'hub_message' }
  if (evidence.bot_id || evidence.app_id) return { ok: false, reason: 'bot' }
  if (evidence.subtype || evidence.hidden) return { ok: false, reason: 'bot' }
  if (evidence.edited) return { ok: false, reason: 'edited' }
  if (evidence.channel !== binding.channel) return { ok: false, reason: 'channel' }
  if (evidence.user !== binding.userId) return { ok: false, reason: 'user' }
  if (evidence.team !== binding.team) return { ok: false, reason: 'team' }
  if (evidence.thread_ts !== binding.deliveryTs || evidence.ts === binding.deliveryTs) return { ok: false, reason: 'not_in_thread' }
  return { ok: true, parsed: parseReply(evidence.text) }
}
