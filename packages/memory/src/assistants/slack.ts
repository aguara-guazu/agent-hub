import { createHash } from 'node:crypto'
import type { Sql } from '../database.js'
import type { Vault } from '../config.js'
import { check, MemoryError } from '../contracts.js'
import { channelWithinProject } from './portfolio.js'
import { isExcludedAny } from '../decisions/exclusions.js'
import type { Signal, Watch } from './contracts.js'

const stamp = /^\d{9,16}\.\d{1,6}$/
interface Message {
  ts: string
  thread_ts?: string
  user?: string
  bot_id?: string
  subtype?: string
  text?: string
  client_msg_id?: string
  reply_count?: number
  edited?: { ts: string }
}
const cooldown = new Map<string, number>()
export const digest = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex')
export type SlackRead = { messages: Message[]; fingerprint: string; handled: boolean; signal: Signal | null }
export interface ChannelAccess {
  roots(since: number): Promise<string[]>
  thread(ts: string, refresh?: boolean): Promise<SlackRead>
  send(ts: string, text: string, requestId: string): Promise<string>
}

export function inspectThread(w: Watch, root: string, messages: Message[], assistantId?: string): SlackRead {
  const ordered = messages
    .filter((m) => stamp.test(m.ts) && (!m.thread_ts || m.thread_ts === root))
    .sort((a, b) => Number(a.ts) - Number(b.ts))
  const assistantReply = (m: Message) => !!assistantId && m.user === assistantId && !!m.client_msg_id
  const attended = (m: Message) => m.user === w.owner || w.colleagues.includes(m.user || '') || assistantReply(m)
  const visible = ordered.filter(
    (m) =>
      m.user && (!m.bot_id || assistantReply(m)) && m.text?.trim() && (!m.subtype || m.subtype === 'thread_broadcast' || assistantReply(m)),
  )
  const last = visible.at(-1)
  const fingerprint = digest(visible.map((m) => [m.ts, m.user, m.text, m.edited?.ts]))
  const handled = !!last && attended(last)
  if (!last || handled) return { messages: ordered, fingerprint, handled, signal: null }
  const pending = visible.slice(visible.map(attended).lastIndexOf(true) + 1)
  const marker = '<@' + w.owner + '>'
  const request = /[?¿]|\b(necesit|urgente|bloque|pendiente|revisi[oó]n|confirm|demo|reuni[oó]n|please|blocked|need|review|[A-Z]+-\d+)/iu
  const first = pending.find((m) => m.text!.includes(marker) || request.test(m.text!)) ?? pending[0]!
  const text = first === last ? last.text!.slice(0, 4000) : first.text!.slice(0, 2000) + '\n' + last.text!.slice(0, 2000)
  const mention = pending.some((m) => m.text!.includes(marker))
  const question = pending.some((m) => request.test(m.text!))
  const urgent = pending.some((m) => /\b(urgente|bloquead[oa]s?|ca[ií]d[oa]|incidente|outage|blocked)\b/iu.test(m.text!))
  const url = 'https://app.slack.com/archives/' + w.channel + '/p' + last.ts.replace('.', '')
  const reasons = [mention ? 'Te mencionaron en el canal' : 'Conversación del canal del cliente']
  if (urgent) reasons.push('El mensaje indica un bloqueo o incidente')
  const key = ['slack', w.team, w.channel, root].join('/')
  return {
    messages: ordered,
    fingerprint,
    handled,
    signal: {
      key,
      kind: 'slack',
      title: text.slice(0, 180),
      text,
      at: new Date(Number(first.ts) * 1000).toISOString(),
      url,
      score: Math.min(10, 3 + Number(mention) * 3 + Number(question) + Number(urgent) * 3),
      reasons,
      fingerprint,
      source: { root, ts: last.ts, channel: w.channel, team: w.team, connector_id: w.connector_id, owner: w.owner, mention, question, url },
    },
  }
}

/** Resolve the live connector again for every effect. A removed project, channel, credential or exclusion revokes delivery. */
export async function channelAccess(
  db: Sql,
  vault: Vault,
  project: string,
  w: Watch,
  enabled: () => boolean,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ChannelAccess> {
  async function token() {
    check(enabled() && !signal.aborted, 'La atención de Slack está pausada', 409)
    check(!(await isExcludedAny(db, 'slack', null, [{ kind: 'conversation', native_id: w.channel }])), 'Canal reservado', 403)
    check(
      await channelWithinProject(db, project, w.connector_id, w.channel, () =>
        readSlackName(vault, w.connector_id, w.channel, fetcher, signal),
      ),
      'El canal ya no pertenece a la conexión del proyecto',
      409,
    )
    const value = vault.read(w.connector_id)?.token
    check(typeof value === 'string' && value, 'Falta la cuenta de Slack', 409)
    return value
  }
  const credential = await token()
  async function api(method: string, args: Record<string, string>, write = false) {
    signal.throwIfAborted()
    const bucket = w.team + '/' + method
    check((cooldown.get(bucket) ?? 0) <= Date.now(), 'Slack pidió una pausa antes de la próxima lectura', 429)
    check(enabled(), 'La conexión está pausada', 409)
    const res = await fetcher('https://slack.com/api/' + method + (write ? '' : '?' + new URLSearchParams(args)), {
      method: write ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + credential, ...(write ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
      ...(write ? { body: JSON.stringify(args) } : {}),
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    })
    if (res.status === 429) {
      cooldown.set(bucket, Date.now() + Math.max(1, Number(res.headers.get('retry-after')) || 60) * 1000)
      if (write) throw new MemoryError(429, 'Slack rechazó el envío por límite de frecuencia', false, 'slack_rejected')
    }
    check(res.ok, 'Slack no está disponible (HTTP ' + res.status + ')', res.status === 429 ? 429 : 503)
    const data = (await res.json()) as {
      ok: boolean
      team_id?: string
      user_id?: string
      bot_id?: string
      channel?: { name?: string }
      error?: string
      messages?: Message[]
      has_more?: boolean
      response_metadata?: { next_cursor?: string }
      ts?: string
    }
    if (!data.ok)
      throw new MemoryError(
        data.error === 'thread_not_found' ? 404 : 409,
        'Slack no confirmó la operación (' + (data.error ?? '').replace(/[^\w]/g, '').slice(0, 50) + ')',
        false,
        write &&
        [
          'missing_scope',
          'not_authed',
          'invalid_auth',
          'token_revoked',
          'channel_not_found',
          'not_in_channel',
          'is_archived',
          'restricted_action',
        ].includes(data.error ?? '')
          ? 'slack_rejected'
          : undefined,
      )
    return data
  }
  const identity = await api('auth.test', {})
  check(identity.team_id === w.team && (identity.bot_id || identity.user_id === w.owner), 'La identidad de Slack cambió', 409)
  let recent: Message[] | undefined
  let name: string | undefined
  async function pages(method: string, args: Record<string, string>) {
    const messages: Message[] = [],
      cursors = new Set<string>()
    let cursor = ''
    do {
      const page = await api(method, { ...args, limit: '100', ...(cursor ? { cursor } : {}) })
      messages.push(...(page.messages ?? []))
      cursor = page.response_metadata?.next_cursor || ''
      check(!(page.has_more && !cursor) && !cursors.has(cursor) && cursors.size < 100, 'Lectura incompleta del canal de Slack', 503)
      cursors.add(cursor)
    } while (cursor)
    return messages
  }
  return {
    async roots(since) {
      recent = await pages('conversations.history', { channel: w.channel, oldest: String(since / 1000) })
      return [
        ...new Set(
          recent
            .filter((m) => !m.subtype || m.subtype === 'thread_broadcast')
            .map((m) => m.thread_ts || m.ts)
            .filter((ts) => stamp.test(ts)),
        ),
      ]
    },
    async thread(ts, refresh = false) {
      check(stamp.test(ts), 'Identificador de hilo inválido')
      const cached = recent?.find((m) => m.ts === ts && !m.reply_count)
      const messages = !refresh && cached ? [cached] : await pages('conversations.replies', { channel: w.channel, ts })
      const last = messages.at(-1)?.ts || ts
      const history = recent ?? (await pages('conversations.history', { channel: w.channel, oldest: last }))
      // A reply posted in the channel is attributable when it explicitly links this thread.
      const ref = '/archives/' + w.channel + '/p' + ts.replace('.', '')
      const references = history.filter(
        (m) =>
          Number(m.ts) > Number(last) &&
          !m.thread_ts &&
          (m.user === w.owner || w.colleagues.includes(m.user || '')) &&
          m.text?.includes(ref),
      )
      const read = inspectThread(w, ts, [...messages, ...references], identity.bot_id ? identity.user_id : undefined)
      if (read.signal) {
        name ??= (await api('conversations.info', { channel: w.channel }).catch(() => undefined))?.channel?.name || w.channel
        Object.assign(read.signal.source, { channel_name: name, sender: identity.user_id, as_bot: !!identity.bot_id })
        read.fingerprint = digest([read.fingerprint, identity.user_id, identity.bot_id])
        read.signal.fingerprint = read.fingerprint
      }
      return read
    },
    async send(ts, text, requestId) {
      check(stamp.test(ts) && credential === (await token()), 'La autorización del hilo cambió', 409)
      const result = await api(
        'chat.postMessage',
        { channel: w.channel, thread_ts: ts, text, client_msg_id: requestId, unfurl_links: 'false', unfurl_media: 'false' },
        true,
      )
      check(result.ts && stamp.test(result.ts), 'Slack no confirmó el mensaje', 502)
      return result.ts
    },
  }
}

/** A bot's own user ID is not evidence of who the local human is. */
export function connectedSlackIdentity(vault: Vault, fetcher: typeof fetch = fetch) {
  const cache = new Map<string, { credential: string; until: number; value: { team: string; owner: string } | null }>()
  return async (id: string) => {
    const token = vault.read(id)?.token
    if (typeof token !== 'string' || !token) return null
    const credential = digest(token),
      old = cache.get(id)
    if (old?.credential === credential && old.until > Date.now()) return old.value
    const response = await fetcher('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    })
    const data = response.ok ? ((await response.json()) as { ok?: boolean; bot_id?: string; user_id?: string; team_id?: string }) : null
    const value = data?.ok && !data.bot_id && data.team_id && data.user_id ? { team: data.team_id, owner: data.user_id } : null
    cache.set(id, { credential, value, until: Date.now() + (value ? 300000 : 60000) })
    return value
  }
}

export async function readSlackName(vault: Vault, id: string, channel: string, fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  const token = vault.read(id)?.token
  if (typeof token !== 'string' || !token) return null
  const res = await fetcher('https://slack.com/api/conversations.info?' + new URLSearchParams({ channel }), {
    headers: { Authorization: 'Bearer ' + token },
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
  })
  if (!res.ok) return null
  const data = (await res.json()) as { ok?: boolean; channel?: { name?: string } }
  return data.ok ? (data.channel?.name ?? null) : null
}
