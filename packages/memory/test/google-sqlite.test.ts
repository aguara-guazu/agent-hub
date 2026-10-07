import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { Vault } from '../src/config.js'
import { GoogleAuth } from '../src/google-auth.js'
import { ProviderHttp } from '../src/connectors/http.js'
import { syncGoogle, importGoogleDocument, repairGoogle } from '../src/connectors/google.js'
import type { Connector, ConnectorContext } from '../src/connectors/types.js'

describe('Google con SQLite real', () => {
  let directory: string, db: MemoryDatabase, store: MemoryStore, connector: Connector, ctx: ConnectorContext
  let cancelled = false
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'google-sqlite-'))
    db = new MemoryDatabase(join(directory, 'memory.sqlite')); await db.migrate(); store = new MemoryStore(db, directory)
    connector = { id: randomUUID(), provider: 'google', name: 'Google fixture', project_ids: [], config: {}, cursor: {}, enabled: true, interval_minutes: 30 }
    await db.query("INSERT INTO connectors(id,provider,name) VALUES($1,'google',$2)", [connector.id, connector.name])
    cancelled = false
    const vault = new Vault(directory)
    ctx = { store, vault, google: { token: async () => 'fixture' } as unknown as GoogleAuth,
      signal: new AbortController().signal, progress: async () => {}, checkpoint: async () => {},
      http: new ProviderHttp(async input => {
        const url = new URL(String(input))
        let result: unknown
        if (url.hostname === 'www.googleapis.com') result = { items: [{ id: 'event', status: cancelled ? 'cancelled' : 'confirmed', summary: 'Proyecto',
          start: { dateTime: '2026-09-12T10:00:00-03:00' }, conferenceData: { conferenceId: 'abc-defg-hij' } }] }
        else if (url.pathname === '/v2/conferenceRecords') result = { conferenceRecords: [{ name: 'conferenceRecords/c', space: 'spaces/s', startTime: '2026-09-12T13:00:00Z' }] }
        else if (url.pathname.endsWith('/participants')) result = { participants: [{ name: 'participant', signedinUser: { user: 'users/123', displayName: 'Ana' } }] }
        else if (url.pathname.endsWith('/transcripts')) result = { transcripts: [{ name: 'conferenceRecords/c/transcripts/t', state: 'FILE_GENERATED', docsDestination: { document: 'doc' } }] }
        else if (url.pathname.endsWith('/entries')) result = { transcriptEntries: [{ name: 'entry', participant: 'participant', text: 'Acuerdo del proyecto', startTime: '2026-09-12T13:01:00Z' }] }
        else if (url.pathname === '/v2/spaces/s') result = { meetingCode: 'abc-defg-hij' }
        else if (url.hostname === 'people.googleapis.com') result = { emailAddresses: [{ value: 'ana@example.com', metadata: { primary: true } }] }
        else if (url.hostname === 'docs.googleapis.com') result = { documentId: 'doc', title: 'Transcripción', body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Ana: Acuerdo del proyecto\n' } }] } }] } }
        else throw new Error(`Petición inesperada: ${url.pathname}`)
        return new Response(JSON.stringify(result))
      }) }
  })
  afterEach(async () => { await db.close(); await rm(directory, { recursive: true, force: true }) })

  it('sincroniza Calendar y Meet, importa Docs con el hablante existente y repara sin duplicar', async () => {
    await syncGoogle(connector, ctx)
    const [meeting] = await db.query("SELECT * FROM entities WHERE kind='meeting'")
    expect(meeting!.data.calendar_match).toBe('matched')
    expect(meeting!.title).toBe('Proyecto')
    const [person] = await db.query("SELECT * FROM entities WHERE kind='person'")
    expect(person!.data.email).toBe('ana@example.com')
    const doc = await importGoogleDocument(connector, ctx, 'doc')
    expect(doc).toBeDefined()
    expect(await db.query('SELECT speaker_id FROM fragments WHERE version_id=$1', [doc!.version_id])).toEqual([{ speaker_id: person!.id }])
    expect(await db.query("SELECT to_id FROM links WHERE from_id=$1 AND type='meeting_document'", [doc!.entity_id])).toEqual([{ to_id: meeting!.id }])
    await repairGoogle(connector, ctx)
    expect((await db.query('SELECT count(*) AS n FROM sources'))[0]!.n).toBe(3)
    expect((await db.query("SELECT count(*) AS n FROM entities WHERE kind='person'"))[0]!.n).toBe(1)
  })

  it('cancela solamente el evento y conserva la reunión y la transcripción', async () => {
    await syncGoogle(connector, ctx); await importGoogleDocument(connector, ctx, 'doc')
    cancelled = true
    await syncGoogle({ ...connector, config: { meet_enabled: false } }, ctx)
    expect((await db.query("SELECT data FROM entities WHERE kind='event'"))[0]!.data.status).toBe('cancelled')
    expect((await db.query("SELECT count(*) AS n FROM entities WHERE kind IN ('meeting','document')"))[0]!.n).toBe(2)
    expect((await db.query('SELECT count(*) AS n FROM fragments'))[0]!.n).toBe(3)
  })

  it('importa Docs sin reunión asociada', async () => {
    const doc = await importGoogleDocument(connector, ctx, 'unlinked')
    expect(doc!.fragments).toBe(1)
    expect(await db.query("SELECT id FROM links WHERE type='meeting_document'")).toEqual([])
  })
})
