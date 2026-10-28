import { createHash } from 'node:crypto'
import { z } from 'zod'
import { check, type ImportInput } from '../contracts.js'
import { fileMime, fileText } from '../attachments.js'
import { GMAIL_SCOPE } from '../google-auth.js'
import { CONTROL_HEADER, isExcludedAny, referencedMessageIds } from '../decisions/exclusions.js'
import { redactSecrets, SECRET_FILE } from '../secrets.js'
import { splitText } from '../transcript.js'
import { ProviderError } from './http.js'
import { GOOGLE_WINDOW_DAYS, type Connector, type ConnectorContext } from './types.js'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
/** Received and sent mail: everything except these system labels and Gmail's promotions and social tabs. */
const EXCLUDED_LABELS = ['SPAM', 'TRASH', 'DRAFT', 'CHAT', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL']
const LIST_QUERY = '-category:promotions -category:social'
const MAX_BODY = 200_000
const MAX_ATTACHMENT = 25_000_000
const TEXT_ATTACHMENT = /\.(txt|md|csv|tsv|json|log|ya?ml)$/i
const AUTOMATED_SENDER = /(^|[._-])(no-?reply|do-?not-?reply)([+._-]|@)|^(notifications?|mailer-daemon|postmaster|bounces?)([+._-]|@)/i

type Participant = ImportInput['participants'][number]
interface Address { name: string; email: string }
interface GmailState { mailbox?: string; history_id?: string; backfill?: { history_id: string; page_token?: string; since: string }; polled_at?: string }

/**
 * Imports mail as one `message` source per Gmail message (`gmail:<id>`), so a reply never re-versions the thread.
 * First run lists the last GOOGLE_WINDOW_DAYS (fixed when the listing starts, so a resumed listing keeps its range)
 * and stores the mailbox historyId taken before listing; later runs read `history.list` from it. A 404 there means
 * the history window expired and the listing restarts, skipping messages already stored.
 */
export async function syncGmail(connector: Connector, ctx: ConnectorContext): Promise<void> {
  check(ctx.google.granted(connector.id, GMAIL_SCOPE), 'Reconectá Google y autorizá la lectura de Gmail', 409)
  const headers = { Authorization: `Bearer ${await ctx.google.token(connector.id)}` }
  const state: GmailState = { ...(connector.cursor.gmail ?? {}) }
  const save = async () => { await ctx.checkpoint({ ...connector.cursor, gmail: state }) }
  const profile = async () => {
    const value = await ctx.http.json(`${API}/profile`, headers)
    state.mailbox = String(value.emailAddress ?? '').toLowerCase()
    return value
  }
  if (!state.mailbox) await profile()
  const mailbox = state.mailbox!
  let imported = 0
  if (state.history_id) {
    let pageToken = '', latest = state.history_id
    try {
      do {
        const url = new URL(`${API}/history`)
        url.searchParams.set('startHistoryId', state.history_id); url.searchParams.set('historyTypes', 'messageAdded'); url.searchParams.set('maxResults', '500')
        if (pageToken) url.searchParams.set('pageToken', pageToken)
        const page = await ctx.http.json(url.toString(), headers)
        // Draft autosaves add a message each time; their labels, when present, avoid fetching them.
        const ids = (page.history ?? []).flatMap((record: any) => (record.messagesAdded ?? [])
          .filter((added: any) => !(added.message?.labelIds ?? []).some((label: string) => EXCLUDED_LABELS.includes(label)))
          .map((added: any) => added.message?.id)).filter(Boolean)
        imported += await importNew(connector, ctx, headers, [...new Set<string>(ids)], mailbox)
        if (page.historyId) latest = String(page.historyId)
        pageToken = page.nextPageToken ?? ''
      } while (pageToken)
      state.history_id = latest
    } catch (error) {
      if (!(error instanceof ProviderError && error.httpStatus === 404)) throw error
      delete state.history_id
      await ctx.progress({ gmail_warning: 'Gmail ya no conserva el historial desde la última revisión; se vuelve a recorrer el buzón sin duplicar correos' })
    }
  }
  if (!state.history_id) {
    state.backfill ??= { history_id: String((await profile()).historyId), since: new Date(Date.now() - GOOGLE_WINDOW_DAYS * 86400_000).toISOString() }
    const backfill = state.backfill
    do {
      const page = await listMessages(ctx, headers, searchQuery(backfill.since), backfill.page_token)
      imported += await importNew(connector, ctx, headers, page.ids, mailbox)
      if (page.next) backfill.page_token = page.next
      else delete backfill.page_token
      await save()
      await ctx.progress({ stage: 'gmail_backfill', imported })
    } while (backfill.page_token)
    state.history_id = backfill.history_id
    delete state.backfill
  }
  state.polled_at = new Date().toISOString()
  await save()
  await ctx.progress({ stage: 'complete', imported })
}

/** Imports the messages of an older period on request; the incremental history cursor is not modified. */
export async function importGmailRange(connector: Connector, ctx: ConnectorContext, since: string, until: string): Promise<number> {
  const headers = { Authorization: `Bearer ${await ctx.google.token(connector.id)}` }
  const mailbox: string = connector.cursor.gmail?.mailbox ?? String((await ctx.http.json(`${API}/profile`, headers)).emailAddress ?? '').toLowerCase()
  let imported = 0, pageToken: string | undefined
  do {
    const page = await listMessages(ctx, headers, searchQuery(since, until), pageToken)
    imported += await importNew(connector, ctx, headers, page.ids, mailbox)
    pageToken = page.next
    await ctx.progress({ stage: 'gmail_range', gmail_imported: imported })
  } while (pageToken)
  return imported
}

/** `after:`/`before:` take epoch seconds, which avoids the mailbox time zone applied to calendar dates. */
const searchQuery = (since: string, until?: string) => [`after:${Math.floor(Date.parse(since) / 1000)}`,
  ...(until ? [`before:${Math.floor(Date.parse(until) / 1000)}`] : []), LIST_QUERY].join(' ')

async function listMessages(ctx: ConnectorContext, headers: Record<string, string>, query: string, pageToken?: string): Promise<{ ids: string[]; next?: string }> {
  const url = new URL(`${API}/messages`)
  url.searchParams.set('q', query); url.searchParams.set('maxResults', '500')
  if (pageToken) url.searchParams.set('pageToken', pageToken)
  const page = await ctx.http.json(url.toString(), headers)
  return { ids: (page.messages ?? []).map((m: any) => m.id).filter(Boolean), ...(page.nextPageToken ? { next: String(page.nextPageToken) } : {}) }
}

/** Gmail messages do not change content, so an already stored ID is never fetched again. */
async function importNew(connector: Connector, ctx: ConnectorContext, headers: Record<string, string>, ids: string[], mailbox: string): Promise<number> {
  const known = new Set((await ctx.store.db.query(`SELECT external_id FROM sources WHERE provider='google' AND account=$1
    AND external_id IN (SELECT value FROM json_each($2))`, [connector.id, ids.map(id => `gmail:${id}`)])).map(row => row.external_id as string))
  let imported = 0
  for (const id of ids) {
    ctx.signal.throwIfAborted()
    if (known.has(`gmail:${id}`)) continue
    if (await isExcludedAny(ctx.store.db, 'gmail', mailbox, [{ kind: 'message', native_id: id }])) { known.add(`gmail:${id}`); continue }
    if (await importMessage(connector, ctx, headers, id, mailbox)) imported++
    known.add(`gmail:${id}`)
  }
  return imported
}

/**
 * Mensajes de la solicitud de decisión y todo lo que cuelga de ellos (respuestas con el código, citas y reenvíos detectables por hilo o por referencias).
 * Se decide con la cabecera, antes de leer adjuntos, guardar el original o indexar nada. Un fallo de la consulta detiene la ingesta.
 */
async function isDecisionControl(ctx: ConnectorContext, mailbox: string, message: any, header: (name: string) => string | undefined): Promise<boolean> {
  if (header(CONTROL_HEADER) !== undefined) return true
  const refs = [{ kind: 'message' as const, native_id: String(message.id ?? '') }, ...(message.threadId ? [{ kind: 'thread' as const, native_id: String(message.threadId) }] : []),
    ...referencedMessageIds(header('Message-ID'), header('In-Reply-To'), header('References')).map(native_id => ({ kind: 'rfc_message_id' as const, native_id }))]
  return isExcludedAny(ctx.store.db, 'gmail', mailbox, refs)
}

async function importMessage(connector: Connector, ctx: ConnectorContext, headers: Record<string, string>, id: string, mailbox: string): Promise<boolean> {
  let message: any
  try { message = await ctx.http.json(`${API}/messages/${encodeURIComponent(id)}?format=full`, headers) }
  catch (error) { if (error instanceof ProviderError && error.httpStatus === 404) return false; throw error }
  const labels: string[] = message.labelIds ?? []
  if (labels.some(label => EXCLUDED_LABELS.includes(label))) return false
  const header = (name: string) => (message.payload?.headers ?? []).find((h: any) => String(h.name).toLowerCase() === name.toLowerCase())?.value as string | undefined
  if (await isDecisionControl(ctx, mailbox, message, header)) return false
  const from = addresses(header('From'))[0]
  const to = addresses(header('To')), cc = addresses(header('Cc'))
  const subject = (header('Subject') ?? '').trim().slice(0, 500) || '(sin asunto)'
  const occurredAt = new Date(Number(message.internalDate) || Date.parse(header('Date') ?? '') || Date.now()).toISOString()
  const automated = Boolean(header('List-Unsubscribe') || (header('Auto-Submitted') ?? 'no').toLowerCase() !== 'no'
    || /^(bulk|list|junk)$/i.test(header('Precedence') ?? '') || (from && AUTOMATED_SENDER.test(from.email)))
  const { text: plain, files } = await readParts(ctx, headers, id, message.payload ?? {})
  const body = redactSecrets(plain.slice(0, MAX_BODY))
  const listed = [...(automated ? [] : from ? [from] : []), ...to, ...cc], emails = [...new Set(listed.map(a => a.email))]
  // Display names in From/To/Cc are written by whoever sent the message: an address already stored keeps its person's
  // name and email provenance (Google People, manual) instead of being renamed or downgraded to `gmail_header`.
  const stored = new Map<string, StoredPerson>(emails.length ? (await ctx.store.db.query<StoredPerson & { email: string }>(`SELECT data->>'email' AS email,title,
    data->>'email_source' AS email_source,data->'email_candidates' AS "email_candidates:json" FROM entities WHERE kind='person' AND data->>'merged_into' IS NULL
    AND (data->>'email') IN (SELECT value FROM json_each($1))`, [emails])).map(row => [row.email, row]) : [])
  const people = new Map<string, Participant>()
  for (const address of listed) if (!people.has(address.email)) people.set(address.email, participant(address, stored.get(address.email)))
  const speaker = !automated && from ? `email:${from.email}` : undefined
  const line = (label: string, list: Address[]) => list.length ? `${label}: ${list.map(a => a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email).join(', ')}` : ''
  const summary = [line('De', from ? [from] : []), line('Para', to), line('CC', cc), `Asunto: ${subject}`,
    files.length ? `Adjuntos: ${files.map(f => f.filename).join(', ')}` : ''].filter(Boolean).join('\n')
  const fragments: ImportInput['fragments'] = [{ text: summary, external_id: `${id}:header`, ...(speaker ? { speaker } : {}), start_time: occurredAt, metadata: { format: 'gmail-header' } },
    ...splitText(body.text).map((part, index) => ({ text: part.text, external_id: `${id}:body:${index}`, ...(speaker ? { speaker } : {}), start_time: occurredAt, metadata: { format: 'gmail-body' } }))]
  const messageId = header('Message-ID')?.trim() ?? null, inReplyTo = header('In-Reply-To')?.trim() ?? null
  const attachments = files.map(({ data: _data, ...file }) => file)
  const result = await ctx.store.ingest({ provider: 'google', account: connector.id, connector_id: connector.id, external_id: `gmail:${id}`, kind: 'message',
    title: subject, url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#all/${encodeURIComponent(message.threadId ?? id)}`,
    occurred_at: occurredAt, participants: [...people.values()], fragments, project_ids: connector.project_ids,
    metadata: { channel: 'gmail', gmail_id: id, thread_id: message.threadId ?? null, message_id: messageId, in_reply_to: inReplyTo,
      from: from ?? null, to, cc, labels, automated, sent: labels.includes('SENT'), attachments, redacted_secrets: body.count },
    original: { format: 'gmail-message-v1', id, thread_id: message.threadId ?? null, labels, internal_date: message.internalDate ?? null,
      headers: { from: header('From') ?? null, to: header('To') ?? null, cc: header('Cc') ?? null, subject, date: header('Date') ?? null, message_id: messageId, in_reply_to: inReplyTo },
      body: body.text, attachments } }, 'connector:google')
  // Recipients do not speak in the message; they become participants through their identities.
  const recipients = await ctx.store.db.query(`SELECT DISTINCT person_id FROM identities WHERE provider='google' AND account=$1
    AND external_id IN (SELECT value FROM json_each($2))`, [connector.id, [...people.keys()].map(email => `email:${email}`)])
  for (const row of recipients) await ctx.store.link({ from_id: result.entity_id, to_id: row.person_id, type: 'participant' }, 'connector:google')
  // Messages arrive newest first during a listing: link in both directions so the order does not matter.
  const related = await ctx.store.db.query(`SELECT s.entity_id,e.data->>'message_id' AS message_id FROM sources s JOIN entities e ON e.id=s.entity_id
    WHERE s.provider='google' AND s.account=$1 AND s.external_id LIKE 'gmail:%' AND e.id<>$2
    AND ((e.data->>'message_id')=$3 OR (e.data->>'in_reply_to')=$4)`, [connector.id, result.entity_id, inReplyTo, messageId])
  for (const row of related) {
    const parent = row.message_id === inReplyTo
    await ctx.store.link({ from_id: parent ? result.entity_id : row.entity_id, to_id: parent ? row.entity_id : result.entity_id, type: 'reply_to' }, 'connector:google')
  }
  for (const file of files) if (file.data) {
    const stored = await importAttachment(connector, ctx, file as Required<typeof file>, subject, from, occurredAt)
    await ctx.store.link({ from_id: stored, to_id: result.entity_id, type: 'email_attachment' }, 'connector:google')
  }
  return true
}

interface MailFile { filename: string; mime_type: string; size: number; status: 'imported' | 'skipped_secret' | 'skipped_format' | 'skipped_size'; data?: Buffer }

/** Collects the readable body (text/plain preferred, HTML as fallback) and downloads PDF and plain-text attachments. */
async function readParts(ctx: ConnectorContext, headers: Record<string, string>, messageId: string, root: any): Promise<{ text: string; files: MailFile[] }> {
  const plain: string[] = [], html: string[] = [], files: MailFile[] = []
  const data = async (part: any): Promise<Buffer> => {
    if (typeof part.body?.data === 'string') return Buffer.from(part.body.data, 'base64url')
    if (!part.body?.attachmentId) return Buffer.alloc(0)
    const attachment = await ctx.http.json(`${API}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`, headers)
    return Buffer.from(String(attachment.data ?? ''), 'base64url')
  }
  const visit = async (part: any) => {
    ctx.signal.throwIfAborted()
    const mime = String(part.mimeType ?? '').toLowerCase(), filename = String(part.filename ?? '').trim()
    const header = (name: string) => (part.headers ?? []).find((h: any) => String(h.name).toLowerCase() === name)?.value as string | undefined
    // Inline images referenced by Content-ID are signature logos and embedded pictures, not attachments.
    if (filename && mime.startsWith('image/') && header('content-id') && !/^attachment/i.test(header('content-disposition') ?? '')) return
    if (filename) {
      const size = Number(part.body?.size ?? 0), base = { filename: filename.replace(/[/\\\x00-\x1f\x7f]/g, '_').slice(0, 255), mime_type: mime, size }
      if (SECRET_FILE.test(filename)) files.push({ ...base, status: 'skipped_secret' })
      else if (size > MAX_ATTACHMENT) files.push({ ...base, status: 'skipped_size' })
      else if (mime === 'application/pdf' || /\.pdf$/i.test(filename) || TEXT_ATTACHMENT.test(filename)) {
        const content = await data(part), detected = fileMime(content, filename)
        if (detected === 'application/pdf' || detected === 'text/plain') files.push({ ...base, mime_type: detected, size: content.length, status: 'imported', data: content })
        else files.push({ ...base, status: 'skipped_format' })
      } else files.push({ ...base, status: 'skipped_format' })
      return
    }
    if (mime === 'text/plain' || mime === 'text/html') {
      const charset = /charset="?([^";\s]+)/i.exec(header('content-type') ?? '')?.[1] ?? 'utf-8'
      const raw = await data(part)
      let text: string
      try { text = new TextDecoder(charset).decode(raw) } catch { text = raw.toString('utf8') }
      ;(mime === 'text/plain' ? plain : html).push(text)
    }
    for (const child of part.parts ?? []) await visit(child)
  }
  await visit(root)
  const text = tidyText(stripQuoted(plain.length ? plain.join('\n\n') : htmlToText(html.join('\n'))))
  return { text: text.trim(), files }
}

async function importAttachment(connector: Connector, ctx: ConnectorContext, file: Required<MailFile>, subject: string, from: Address | undefined, occurredAt: string): Promise<string> {
  let content = file.data, redacted = 0
  if (file.mime_type === 'text/plain') {
    const clean = redactSecrets(fileText(content, file.filename) ?? content.toString('utf8'))
    content = Buffer.from(clean.text, 'utf8'); redacted = clean.count
  }
  const sha256 = createHash('sha256').update(content).digest('hex')
  const attachment = { filename: file.filename, mime_type: file.mime_type, size: content.length, sha256 }
  const context = `${file.filename}\nAdjunto del correo «${subject}»${from ? ` de ${from.name || from.email}` : ''}`
  const result = await ctx.store.ingest({ provider: 'google', account: connector.id, connector_id: connector.id, external_id: `gmail:attachment:${sha256}`,
    kind: 'document', title: file.filename, occurred_at: occurredAt, project_ids: connector.project_ids,
    fragments: [{ text: context, metadata: { attachment, annotation: true } },
      ...(file.mime_type === 'text/plain' ? splitText(content.toString('utf8')).map(part => ({ ...part, metadata: { attachment, annotation: false, source_text: true } })) : [])],
    // Text later extracted from the PDF goes through the same redaction (see processMedia).
    metadata: { attachment, channel: 'gmail', redact_secrets: true, redacted_secrets: redacted },
    original: { format: 'agenthub-file-v1', ...attachment, data_base64: content.toString('base64') } }, 'connector:google')
  return result.entity_id
}

type StoredPerson = { title: string; email_source: string | null; email_candidates: unknown }
function participant(address: Address, stored?: StoredPerson): Participant {
  const candidates = Array.isArray(stored?.email_candidates) ? stored.email_candidates.filter((c): c is string => z.email().safeParse(c).success).slice(0, 30) : undefined
  return { external_id: `email:${address.email}`, name: stored?.title || address.name || address.email, email: address.email, identity_verified: true,
    email_source: stored?.email_source || 'gmail_header', ...(candidates ? { email_candidates: candidates } : {}) }
}

/** Parses an RFC 5322 address list as Gmail returns it (already decoded): `"Apellido, Nombre" <a@b.com>, c@d.com`. */
export function addresses(value?: string): Address[] {
  if (!value) return []
  const out: Address[] = [], items: string[] = []
  let current = '', quoted = false, angle = false
  for (const char of value) {
    if (char === '"') quoted = !quoted
    else if (char === '<' && !quoted) angle = true
    else if (char === '>' && !quoted) angle = false
    if (char === ',' && !quoted && !angle) { items.push(current); current = '' } else current += char
  }
  items.push(current)
  for (const item of items) {
    const match = /^(.*)<([^>]+)>\s*$/.exec(item.trim())
    const email = (match ? match[2]! : item).trim().toLowerCase()
    if (!z.email().safeParse(email).success) continue
    const name = (match ? match[1]! : '').trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1').trim().slice(0, 300)
    if (!out.some(a => a.email === email)) out.push({ name, email })
  }
  return out
}

/** Cuts the quoted history of a reply: `On … wrote:` / `El … escribió:` (also split over two lines), Outlook headers and `>` lines. Forwarded content is kept. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n'), kept: string[] = []
  const attribution = /^\s*(on|el)\s.+\s(wrote|escribió)\s*:\s*$/i
  for (const [index, line] of lines.entries()) {
    const next = lines[index + 1] ?? ''
    if (attribution.test(line) || attribution.test(`${line} ${next.trim()}`)) break
    if (/^\s*-{2,}\s*(original message|mensaje original)\s*-{2,}\s*$/i.test(line)) break
    if (/^\s*(from|de):\s.+$/i.test(line) && lines.slice(index + 1, index + 5).some(l => /^\s*(sent|enviado|date|fecha):\s/i.test(l))) break
    if (/^\s*>/.test(line)) continue
    kept.push(line)
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n')
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", laquo: '«', raquo: '»', ndash: '–', mdash: '—', hellip: '…', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü', iexcl: '¡', iquest: '¿' }
/** Converts an HTML body to text: drops head, style, script and Gmail quote blocks, keeps block boundaries as line breaks. */
export function htmlToText(html: string): string {
  let value = html.replace(/<(head|style|script)\b[\s\S]*?<\/\1>/gi, '')
  const quote = value.search(/<div[^>]+class="?[^">]*gmail_quote/i)
  if (quote >= 0) value = value.slice(0, quote)
  let previous = ''
  while (previous !== value) { previous = value; value = value.replace(/<blockquote\b[^>]*>(?:(?!<blockquote\b)[\s\S])*?<\/blockquote>/gi, '') }
  return tidyText(value.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol)>/gi, '\n').replace(/<li\b[^>]*>/gi, '- ').replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (match, entity: string) => {
      if (entity[0] !== '#') return ENTITIES[entity] ?? match
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }))
}

/** Format characters newsletters repeat in the inbox preheader (soft hyphen, CGJ U+034F, zero-width, word joiner, BOM):
 *  they carry no text and the tokenizer spends one to three tokens on each. */
const INVISIBLE = /\u034f|[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g
/** Drops invisible characters, folds runs of Unicode spaces (NBSP, figure space U+2007, thin spaces) into one space and collapses blank lines. */
export function tidyText(text: string): string {
  return text.replace(INVISIBLE, '').split('\n').map(line => line.replace(/[ \t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g, ' ').trim())
    .join('\n').replace(/\n{3,}/g, '\n\n')
}
