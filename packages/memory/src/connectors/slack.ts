import { check, MemoryError, type ImportInput } from '../contracts.js'
import type { Connector, ConnectorContext } from './types.js'

export async function syncSlack(connector: Connector, ctx: ConnectorContext): Promise<void> {
  const credentials = ctx.vault.read(connector.id)
  check(credentials?.token, 'Configurá un token de Slack con lectura de los canales e hilos seleccionados', 409)
  const channels: string[] = connector.config.channel_ids ?? []
  check(channels.length > 0, 'Seleccioná al menos un canal de Slack', 409)
  const headers = { Authorization: `Bearer ${credentials.token}` }
  async function call(method: string, params: Record<string, string>) {
    const result = await ctx.http.json(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, headers)
    if (!result.ok && result.error === 'thread_not_found') throw new MemoryError(404, 'El hilo ya no está disponible')
    if (!result.ok) throw new MemoryError(409, `Slack no pudo leer ${method}: ${['missing_scope', 'not_in_channel', 'invalid_auth', 'token_revoked', 'channel_not_found'].includes(result.error) ? result.error : 'revisá permisos y límites de la cuenta'}`)
    return result
  }
  const users = new Map<string, any>()
  async function participant(userId: string): Promise<ImportInput['participants'][number]> {
    if (!users.has(userId)) {
      try { users.set(userId, (await call('users.info', { user: userId })).user ?? {}) }
      catch { users.set(userId, {}) }
    }
    const user = users.get(userId)
    return { external_id: userId, name: user.profile?.real_name ?? user.real_name ?? user.name ?? userId,
      ...(user.profile?.email ? { email: user.profile.email } : {}), identity_verified: Boolean(user.id) }
  }
  const cursor = { ...connector.cursor }, started = String(Date.now() / 1000)
  let imported = 0
  for (const channel of channels) {
    // Recent history discovers roots. Revisit every previously imported root, including roots that had no replies.
    const since = connector.config.since ? Date.parse(connector.config.since) / 1000 : Date.now() / 1000 - 30 * 86400
    const oldest = String(Math.max(since, Number(cursor[channel] ?? since) - 7 * 86400))
    const roots = new Map<string, any>()
    let next = ''
    const seen = new Set<string>()
    do {
      const page = await call('conversations.history', { channel, oldest, latest: started, inclusive: 'true', limit: '100', ...(next ? { cursor: next } : {}) })
      for (const message of page.messages ?? []) if (message.ts) roots.set(message.ts, message)
      next = page.response_metadata?.next_cursor ?? ''
      check(!next || !seen.has(next), 'Slack repitió un cursor')
      seen.add(next)
    } while (next)
    const previous = await ctx.store.db.query(`SELECT e.data->>'thread_ts' AS ts FROM entities e JOIN sources s ON s.entity_id=e.id
      WHERE s.connector_id=$1 AND e.data->>'channel'=$2`, [connector.id, channel])
    for (const row of previous) if (row.ts && !roots.has(row.ts)) roots.set(row.ts, { ts: row.ts, reply_count: 1 })
    for (const root of roots.values()) {
      ctx.signal.throwIfAborted()
      const messages = new Map<string, any>()
      if (root.text) messages.set(root.ts, root)
      if (root.reply_count) {
        let nextReply = ''
        const seenReplies = new Set<string>()
        do {
          let page: any
          try { page = await call('conversations.replies', { channel, ts: root.ts, limit: '100', ...(nextReply ? { cursor: nextReply } : {}) }) }
          catch (error) {
            if (!(error instanceof MemoryError && error.statusCode === 404)) throw error
            await ctx.store.db.query("UPDATE sources SET status='inaccessible' WHERE provider='slack' AND account=$1 AND external_id=$2", [connector.id, `${channel}:${root.ts}`])
            messages.clear(); break
          }
          for (const message of page.messages ?? []) if (message.ts) messages.set(message.ts, message)
          nextReply = page.response_metadata?.next_cursor ?? ''
          check(!nextReply || !seenReplies.has(nextReply), 'Slack repitió un cursor de hilo')
          seenReplies.add(nextReply)
        } while (nextReply)
      }
      const fragments: ImportInput['fragments'] = [], participants: ImportInput['participants'] = []
      for (const message of [...messages.values()].sort((a, b) => a.ts.localeCompare(b.ts))) {
        if (!message.text?.trim()) continue
        const speaker = message.user ?? message.bot_id
        if (speaker && !participants.some(p => p.external_id === speaker)) participants.push(await participant(speaker))
        fragments.push({ text: message.text, external_id: message.ts, ...(speaker ? { speaker } : {}), start_time: new Date(Number(message.ts) * 1000).toISOString(), metadata: { channel, thread_ts: root.ts, slack_ts: message.ts, edited: message.edited ?? null } })
      }
      if (!fragments.length) continue
      const permalink = await call('chat.getPermalink', { conversation_id: channel, message_ts: root.ts })
      await ctx.store.ingest({ provider: 'slack', account: connector.id, connector_id: connector.id, external_id: `${channel}:${root.ts}`,
        kind: 'message', title: fragments[0]!.text.slice(0, 150), ...(permalink.permalink ? { url: permalink.permalink } : {}), occurred_at: new Date(Number(root.ts) * 1000).toISOString(),
        participants, fragments, project_ids: connector.project_ids, metadata: { channel, thread_ts: root.ts, has_replies: messages.size > 1 }, original: [...messages.values()] }, 'connector:slack')
      imported++
      await ctx.progress({ imported, channel, coverage: 'Canales elegidos; historial reciente y todos los hilos ya importados' })
    }
    cursor[channel] = started
    await ctx.checkpoint(cursor)
  }
}
