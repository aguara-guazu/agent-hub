import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { syncGoogle, importGoogleDocument } from '../src/connectors/google.js'
import { syncNotion } from '../src/connectors/notion.js'
import { syncSlack } from '../src/connectors/slack.js'
import { syncJira } from '../src/connectors/jira.js'
import type { Connector, ConnectorContext } from '../src/connectors/types.js'
import { ProviderHttp, ProviderError } from '../src/connectors/http.js'

function fixture(provider: Connector['provider'], config: Record<string, any>, respond: (url: URL, body: any) => unknown) {
  const imported: any[] = [], checkpoints: any[] = [], requests: string[] = []
  const http = new ProviderHttp(async (input, options) => {
    const url = new URL(String(input)); requests.push(url.toString())
    const result = respond(url, options?.body ? JSON.parse(String(options.body)) : null)
    return result instanceof Response ? result : new Response(JSON.stringify(result))
  })
  const connector: Connector = { id: randomUUID(), provider, name: 'Fixture', config, project_ids: [], cursor: {}, enabled: true, interval_minutes: 30 }
  const ctx = { store: { ingest: async (input: any) => { imported.push(input); return { entity_id: randomUUID(), version_id: randomUUID() } }, db: { query: vi.fn(async () => []) }, enqueue: vi.fn(), link: vi.fn() },
    vault: { read: () => ({ token: 'fixture-token', email: 'user@example.com' }) }, google: { token: async () => 'fixture-access' },
    http, signal: new AbortController().signal, progress: async () => {}, checkpoint: async (c: unknown) => { checkpoints.push(c) },
  } as unknown as ConnectorContext
  return { connector, ctx, imported, checkpoints, requests }
}
describe('conectores con respuestas representativas de las APIs', () => {
  it('Calendar limita todas las páginas a una ventana finita y distingue recurrencias', async () => {
    const f = fixture('google', { meet_enabled: false, calendars: ['primary'], since: '2026-01-01T00:00:00Z' }, url => {
      if (url.searchParams.has('pageToken')) return { items: [{ id: 'instance-2', summary: 'Cliente', recurringEventId: 'series', originalStartTime: { dateTime: '2026-09-12T13:00:00Z' }, start: { dateTime: '2026-09-12T14:00:00Z' } }], nextSyncToken: 'next-sync' }
      return { items: [{ id: 'instance-1', summary: 'Cliente', start: { dateTime: '2026-09-11T13:00:00Z' }, attendees: [{ email: 'guest@example.com', responseStatus: 'accepted' }] }], nextPageToken: 'page2' }
    })
    await syncGoogle(f.connector, f.ctx)
    expect(f.imported).toHaveLength(2)
    expect(f.imported[0].kind).toBe('event')
    expect(f.imported[0].participants).toBeUndefined()
    expect(f.imported[1].metadata.original_start.dateTime).toBe('2026-09-12T13:00:00Z')
    const urls = f.requests.map(value => new URL(value))
    const until = urls[0]!.searchParams.get('timeMax')
    expect(Date.parse(until!)).not.toBeNaN()
    for (const url of urls) {
      expect(url.searchParams.get('timeMin')).toBe('2026-01-01T00:00:00Z')
      expect(url.searchParams.get('timeMax')).toBe(until)
      expect(url.searchParams.has('syncToken')).toBe(false)
    }
    expect(f.checkpoints).toEqual([{ 'calendar_window:primary': { from: '2026-01-01T00:00:00Z', to: until } }])
  })
  it('Calendar revisita recurrencias que entran en la ventana sin depender de cambios remotos ni cursores antiguos', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-12T12:00:00Z'))
      const f = fixture('google', { meet_enabled: false, since: '2026-09-01T00:00:00Z' }, url => {
        expect(url.searchParams.has('syncToken')).toBe(false)
        const reached = Date.parse(url.searchParams.get('timeMax')!) > Date.parse('2026-09-12T13:00:00Z')
        return { items: reached ? [{ id: 'recurrence', summary: 'Reunión diaria', start: { dateTime: '2026-09-12T13:00:00Z' } }] : [], nextSyncToken: 'unused' }
      })
      f.connector.cursor = { 'calendar:primary': 'legacy-token' }
      await syncGoogle(f.connector, f.ctx)
      expect(f.imported).toHaveLength(0)
      f.connector.cursor = f.checkpoints[0]
      vi.setSystemTime(new Date('2026-09-12T14:00:00Z'))
      await syncGoogle(f.connector, f.ctx)
      expect(f.imported).toHaveLength(1)
      expect(f.checkpoints[1]['calendar:primary']).toBeUndefined()
      expect(f.ctx.store.db.query).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
  it('Docs recorre tabs hijas y tablas preservando índices de los bloques', async () => {
    const f = fixture('google', {}, () => ({ title: 'Documento', tabs: [{ tabProperties: { tabId: 'tab1' }, documentTab: { body: { content: [{ startIndex: 1, paragraph: { elements: [{ textRun: { content: 'Primer bloque' } }] } }] } }, childTabs: [{ tabProperties: { tabId: 'child' }, documentTab: { body: { content: [{ table: { tableRows: [{ tableCells: [{ content: [{ startIndex: 5, paragraph: { elements: [{ textRun: { content: 'Celda' } }] } }] }] }] } }] } } }] }] }))
    await importGoogleDocument(f.connector, f.ctx, 'document')
    expect(f.imported[0].fragments.map((p: any) => p.text)).toEqual(['Primer bloque', 'Celda'])
    expect(f.imported[0].fragments[1].metadata.tab).toBe('child')
  })
  it('Meet importa intervenciones paginadas, identidad estable y documento de la conferencia', async () => {
    const f = fixture('google', { calendar_enabled: false }, url => {
      if (url.pathname === '/v2/conferenceRecords') return { conferenceRecords: [{ name: 'conferenceRecords/c1', space: 'spaces/s1', startTime: '2026-09-12T13:00:00Z' }] }
      if (url.pathname.endsWith('/participants')) return { participants: [{ name: 'conferenceRecords/c1/participants/p1', signedinUser: { user: 'users/123', displayName: 'Ana' } }] }
      if (url.pathname.endsWith('/transcripts')) return { transcripts: [{ name: 'conferenceRecords/c1/transcripts/t1', state: 'FILE_GENERATED', docsDestination: { document: 'doc1' } }] }
      if (url.pathname.endsWith('/entries')) return url.searchParams.has('pageToken')
        ? { transcriptEntries: [{ name: 'entry2', participant: 'conferenceRecords/c1/participants/p1', text: 'Segundo comentario', startTime: '2026-09-12T13:03:00Z' }] }
        : { transcriptEntries: [{ name: 'entry1', participant: 'conferenceRecords/c1/participants/p1', text: 'Primer comentario', startTime: '2026-09-12T13:02:00Z' }], nextPageToken: 'second' }
      if (url.pathname === '/v2/spaces/s1') return { meetingCode: 'abc-defg-hij' }
      if (url.hostname === 'people.googleapis.com') return { emailAddresses: [{ value: 'ana@example.com', metadata: { primary: true } }] }
      throw new Error(`Petición inesperada: ${url.pathname}`)
    })
    await syncGoogle(f.connector, f.ctx)
    expect(f.imported).toHaveLength(1)
    expect(f.imported[0].kind).toBe('meeting')
    expect(f.imported[0].participants[0].external_id).toBe('users/123')
    expect(f.imported[0].participants[0].email).toBe('ana@example.com')
    expect(f.imported[0].fragments.map((p: any) => p.speaker)).toEqual(['users/123','users/123'])
    expect(f.imported[0].fragments[1].start_time).toBe('2026-09-12T13:03:00Z')
    expect(f.ctx.store.enqueue).toHaveBeenCalledWith('google_document', expect.objectContaining({ document_id: 'doc1' }), expect.any(String))
  })
  it('Notion pagina hijos y recorre bloques anidados', async () => {
    const f = fixture('notion', { page_ids: ['page'] }, url => {
      if (url.pathname.endsWith('/pages/page')) return { id: 'page', properties: { title: { type: 'title', title: [{ plain_text: 'Notas' }] } } }
      if (url.pathname.includes('/blocks/nested/')) return { results: [{ id: 'child', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Hijo' }] } }], has_more: false }
      if (url.searchParams.has('start_cursor')) return { results: [{ id: 'last', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Último' }] } }], has_more: false }
      return { results: [{ id: 'nested', type: 'paragraph', has_children: true, paragraph: { rich_text: [{ plain_text: 'Padre' }] } }], has_more: true, next_cursor: 'next' }
    })
    await syncNotion(f.connector, f.ctx)
    expect(f.imported[0].fragments.map((p: any) => p.text)).toEqual(['Padre','Hijo','Último'])
  })
  it('Slack conserva hilo, autor, timestamps exactos y todas las páginas de respuestas', async () => {
    const f = fixture('slack', { channel_ids: ['C1'] }, url => {
      if (url.pathname.endsWith('conversations.history')) return { ok: true, messages: [{ ts: '1700000000.000001', text: 'Pregunta', user: 'U1', reply_count: 2 }] }
      if (url.pathname.endsWith('conversations.replies')) return url.searchParams.has('cursor') ? { ok: true, messages: [{ ts: '1700000002.000003', text: 'Última respuesta', user: 'U1' }] }
        : { ok: true, messages: [{ ts: '1700000000.000001', text: 'Pregunta', user: 'U1' }, { ts: '1700000001.000002', text: 'Respuesta', user: 'U2' }], response_metadata: { next_cursor: 'next' } }
      if (url.pathname.endsWith('users.info')) return { ok: true, user: { id: url.searchParams.get('user'), real_name: 'Persona', profile: { email: 'person@example.com' } } }
      return { ok: true, permalink: 'https://example.slack.com/archives/C1/p1700000000000001' }
    })
    await syncSlack(f.connector, f.ctx)
    expect(f.imported[0].fragments).toHaveLength(3)
    expect(f.imported[0].fragments[2].metadata.slack_ts).toBe('1700000002.000003')
    expect(f.imported[0].participants).toHaveLength(2)
  })
  it('Jira usa búsqueda JQL actual y pagina comentarios', async () => {
    const f = fixture('jira', { site_url: 'https://example.atlassian.net', jql: 'project=POC' }, (url, body) => {
      if (url.pathname.endsWith('/search/jql')) { expect(body.fields).toContain('status'); return { issues: [{ id: '1', key: 'POC-1', fields: { summary: 'Prueba', status: { name: 'En curso' }, description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Descripción' }] }] } } }], isLast: true } }
      const index = Number(url.searchParams.get('startAt'))
      return { total: 2, comments: [{ id: String(index), author: { accountId: 'user', displayName: 'Ana' }, body: { type: 'text', text: `Comentario ${index}` } }] }
    })
    await syncJira(f.connector, f.ctx)
    expect(f.imported[0].fragments).toHaveLength(3)
    expect(f.imported[0].metadata.status).toBe('En curso')
  })
  it('respeta Retry-After y no repite secretos del proveedor en errores', async () => {
    const http = new ProviderHttp(async () => new Response('secret-from-provider', { status: 429, headers: { 'Retry-After': '120' } }))
    try { await http.json('https://example.com', { Authorization: 'private' }); expect.fail() }
    catch (error) { expect(error).toBeInstanceOf(ProviderError); expect((error as ProviderError).retryAfter).toBe(120); expect(String(error)).not.toContain('secret') }
  })
})
