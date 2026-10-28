import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryExclusionSink, isExcludedAny, referencedMessageIds } from '../src/decisions/exclusions.js'
import { syncGmail } from '../src/connectors/gmail.js'
import { syncSlack } from '../src/connectors/slack.js'
import { ProviderHttp } from '../src/connectors/http.js'
import type { Connector, ConnectorContext } from '../src/connectors/types.js'

const MAILBOX = 'me@example.com'
const b64 = (text: string) => Buffer.from(text).toString('base64url')

describe('gate de exclusión de mensajes de control en la ingesta', () => {
  let db: MemoryDatabase, directory: string, sink: MemoryExclusionSink
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memory-exclusions-'))
    db = new MemoryDatabase(join(directory, 'memory.sqlite')); await db.migrate()
    sink = new MemoryExclusionSink(db)
    await sink.add([
      { integration: 'gmail', account: 'Me@Example.com', kind: 'rfc_message_id', native_id: '<hub-fixed@agent-hub.invalid>' },
      { integration: 'gmail', account: 'Me@Example.com', kind: 'thread', native_id: 'th-control' },
      { integration: 'gmail', account: 'Me@Example.com', kind: 'message', native_id: 'm-excluded' },
      { integration: 'slack', account: 'T1:U1', kind: 'conversation', native_id: 'D123' },
    ])
    await sink.add([{ integration: 'gmail', account: MAILBOX, kind: 'thread', native_id: 'th-control' }])
  })
  afterAll(async () => { await db?.close(); if (directory) await rm(directory, { recursive: true, force: true }) })

  it('consulta por integración, cuenta (sin distinguir mayúsculas) y tipo de referencia', async () => {
    expect(await isExcludedAny(db, 'gmail', MAILBOX, [{ kind: 'thread', native_id: 'th-control' }])).toBe(true)
    expect(await isExcludedAny(db, 'gmail', MAILBOX, [{ kind: 'message', native_id: 'th-control' }])).toBe(false)
    expect(await isExcludedAny(db, 'gmail', 'otra@example.com', [{ kind: 'thread', native_id: 'th-control' }])).toBe(false)
    expect(await isExcludedAny(db, 'slack', null, [{ kind: 'conversation', native_id: 'D123' }])).toBe(true)
    expect(await isExcludedAny(db, 'gmail', null, [{ kind: 'conversation', native_id: 'D123' }])).toBe(false)
    expect(await isExcludedAny(db, 'gmail', MAILBOX, [])).toBe(false)
    expect((await db.query('SELECT 1 FROM decision_exclusions WHERE integration = $1 AND kind = $2 AND native_id = $3', ['gmail', 'thread', 'th-control']))).toHaveLength(1)
  })

  it('extrae los identificadores RFC de In-Reply-To y References', () => {
    expect(referencedMessageIds('<a@x>', '<b@x> <c@x>', undefined)).toEqual(['<a@x>', '<b@x>', '<c@x>'])
    expect(referencedMessageIds('sin ids')).toEqual([])
  })

  function fixture(provider: Connector['provider'], config: Record<string, any>, respond: (url: URL) => unknown) {
    const imported: any[] = [], requests: string[] = []
    const http = new ProviderHttp(async input => { const url = new URL(String(input)); requests.push(url.toString()); return new Response(JSON.stringify(respond(url))) })
    const connector: Connector = { id: randomUUID(), provider, name: 'Fixture', config, project_ids: [], cursor: {}, enabled: true, interval_minutes: 30 }
    const ctx = { store: { ingest: async (input: any) => { imported.push(input); return { entity_id: randomUUID(), version_id: randomUUID() } }, db, enqueue: async () => {}, link: async () => {} },
      vault: { read: () => ({ token: 'fixture-token' }) }, google: { token: async () => 'fixture-access', granted: () => true },
      http, signal: new AbortController().signal, progress: async () => {}, checkpoint: async () => {} } as unknown as ConnectorContext
    return { connector, ctx, imported, requests }
  }
  const mail = (id: string, thread: string, headers: Array<[string, string]> = []) => ({ id, threadId: thread, labelIds: ['INBOX'], internalDate: '1760000000000',
    payload: { mimeType: 'text/plain', body: { data: b64('hola') }, headers: [['From', 'Ana <ana@example.com>'], ['To', MAILBOX], ['Subject', 'Asunto'], ['Message-ID', `<${id}@x>`], ...headers].map(([name, value]) => ({ name, value })) } })

  it('Gmail no ingiere el mensaje de control, su hilo, sus respuestas ni lo marcado con la cabecera propia, y no lee lo excluido por id', async () => {
    const messages: Record<string, unknown> = {
      'm-ok': mail('m-ok', 'th-ok'),
      'm-header': mail('m-header', 'th-other', [['X-Agent-Hub-Control', '1']]),
      'm-thread': mail('m-thread', 'th-control'),
      'm-reply': mail('m-reply', 'th-reply', [['In-Reply-To', '<hub-fixed@agent-hub.invalid>']]),
      'm-quote': mail('m-quote', 'th-quote', [['References', '<z@x> <hub-fixed@agent-hub.invalid>']]),
    }
    const f = fixture('google', {}, url => {
      if (url.pathname.endsWith('/profile')) return { emailAddress: MAILBOX, historyId: '10' }
      if (url.pathname.endsWith('/messages')) return { messages: [...Object.keys(messages), 'm-excluded'].map(id => ({ id })) }
      const id = decodeURIComponent(url.pathname.split('/').pop()!)
      return messages[id] ?? { error: 'not found' }
    })
    await syncGmail(f.connector, f.ctx)
    expect(f.imported.map(input => input.external_id)).toEqual(['gmail:m-ok'])
    expect(f.requests.some(request => request.includes('m-excluded'))).toBe(false)
    expect(f.requests.some(request => request.includes('attachments'))).toBe(false)
  })

  it('Slack no lee la conversación excluida, ni su historial ni sus hilos, y sí las demás', async () => {
    const f = fixture('slack', { channel_ids: ['D123', 'C1'] }, url => url.pathname.endsWith('conversations.history') ? { ok: true, messages: [] } : { ok: true })
    await syncSlack(f.connector, f.ctx)
    expect(f.requests.some(request => request.includes('channel=D123'))).toBe(false)
    expect(f.requests.some(request => request.includes('channel=C1'))).toBe(true)
  })

  it('si la consulta falla, la ingesta se detiene en lugar de importar sin clasificar', async () => {
    const f = fixture('google', {}, url => url.pathname.endsWith('/profile') ? { emailAddress: MAILBOX, historyId: '10' } : { messages: [{ id: 'm-ok' }] })
    const broken = { ...f.ctx, store: { ...f.ctx.store, db: { query: async (sql: string, params?: unknown[]) => { if (sql.includes('decision_exclusions')) throw new Error('db down'); return db.query(sql, params) } } } } as unknown as ConnectorContext
    await expect(syncGmail(f.connector, broken)).rejects.toThrow('db down')
    expect(f.imported).toEqual([])
  })
})
