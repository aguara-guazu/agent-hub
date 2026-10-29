import { GMAIL_SCOPE, type GoogleAuth } from '../google-auth.js'
import type { DecisionStore } from './store.js'
import type { DecisionService } from './service.js'
import { verifyGmailReply, type GmailBindingView, type GmailEvidence, type RejectReason } from './verifier.js'
import { referencedMessageIds } from './exclusions.js'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const TIMEOUT_MS = 30_000

export interface ReplyPollResult {
  inspected: number
  consumed: number
  /** Motivos de rechazo por mensaje; nunca incluye contenido. */
  rejected: Partial<Record<RejectReason | 'authority_unavailable' | 'fetch_failed', number>>
}

const addresses = (value: string | undefined): string[] => [...(value ?? '').matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map(match => match[0].toLowerCase())

function textOf(part: any): string {
  const found: string[] = []
  const visit = (node: any) => {
    if (String(node?.mimeType ?? '').toLowerCase() === 'text/plain' && !node.filename && typeof node.body?.data === 'string') found.push(Buffer.from(node.body.data, 'base64url').toString('utf8'))
    for (const child of node?.parts ?? []) visit(child)
  }
  visit(part)
  return found.join('\n')
}

function hasAttachments(part: any): boolean {
  return Boolean(part?.filename) || Boolean(part?.body?.attachmentId) || (part?.parts ?? []).some(hasAttachments)
}

/** Arma la evidencia que consume el verificador a partir de un mensaje de Gmail (`format=full`). Sin heurísticas: lo que falta queda vacío y el verificador rechaza. */
export function gmailEvidence(message: any): GmailEvidence {
  const headers: Array<{ name?: string; value?: string }> = message.payload?.headers ?? []
  const header = (name: string) => headers.find(candidate => String(candidate.name).toLowerCase() === name)?.value
  return { id: String(message.id ?? ''), threadId: String(message.threadId ?? ''), labelIds: message.labelIds ?? [], from: addresses(header('from')),
    inReplyTo: referencedMessageIds(header('in-reply-to')), references: referencedMessageIds(header('references')), autoSubmitted: header('auto-submitted') ?? null,
    hasAttachments: hasAttachments(message.payload), bodyText: textOf(message.payload) }
}

/**
 * Lee el hilo de cada solicitud con binding de Gmail activo y entrega las respuestas verificadas al servicio de decisiones.
 * Cada mensaje pasa por el verificador determinista (SENT, From fijado, mismo hilo, relación con el Message-ID del outbox, texto nuevo inequívoco)
 * y luego por la compuerta de autoridad. El cuerpo se lee de la API para verificar y nunca se guarda ni se registra; no pasa por la ingesta.
 */
export async function pollGmailReplies(deps: { store: DecisionStore; service: DecisionService; google: GoogleAuth; connectorId: string; fetcher?: typeof fetch }): Promise<ReplyPollResult> {
  const { store, service, google, connectorId } = deps
  const fetcher = deps.fetcher ?? fetch
  const result: ReplyPollResult = { inspected: 0, consumed: 0, rejected: {} }
  const reject = (reason: keyof ReplyPollResult['rejected']) => { result.rejected[reason] = (result.rejected[reason] ?? 0) + 1 }
  if (!google.granted(connectorId, GMAIL_SCOPE)) return result
  const bindings = store.openBindings('gmail')
  if (!bindings.length) return result
  const token = await google.token(connectorId)
  for (const open of bindings) {
    const view = store.bindingsOf(open.request_id).find(binding => binding.id === open.binding_id)
    if (!view?.conversation) { reject('binding_incomplete'); continue }
    const binding: GmailBindingView = { account: open.account, threadId: view.conversation, correlations: view.correlations, hubNativeIds: view.native_ids }
    let thread: any
    try {
      const response = await fetcher(`${API}/threads/${encodeURIComponent(view.conversation)}?format=full`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!response.ok) { reject('fetch_failed'); continue }
      thread = await response.json()
    } catch { reject('fetch_failed'); continue }
    for (const message of thread.messages ?? []) {
      result.inspected++
      const verdict = verifyGmailReply(gmailEvidence(message), binding)
      if (!verdict.ok) { reject(verdict.reason); continue }
      const outcome = await service.processReply({ integration: 'gmail', account: open.account, native_message_id: String(message.id), binding_id: open.binding_id, parsed: verdict.parsed })
      if (outcome.gated) { reject('authority_unavailable'); continue }
      if (outcome.value.outcome === 'approved' || outcome.value.outcome === 'rejected' || outcome.value.outcome === 'revision_requested') result.consumed++
    }
  }
  return result
}
