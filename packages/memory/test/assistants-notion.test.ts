import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryDatabase } from '../src/database.js'
import { MemoryAI } from '../src/ai.js'
import { Vault, defaultAI } from '../src/config.js'
import { MemoryOperations } from '../src/operations.js'
import { MemoryStore } from '../src/store.js'
import { normalizeJiraIssue } from '../src/projects/tasks.js'
import { Resident } from '../src/assistants/runtime.js'
import { contractSignals, withContractContext } from '../src/assistants/notion-contracts.js'
import { readNotionContracts, type NotionRead } from '../src/assistants/notion-reader.js'
import { notionId, type Signal, type ProjectContract } from '../src/assistants/contracts.js'

const now = new Date('2026-11-27T12:00:00Z')
const source = 'collection://' + randomUUID(),
  types = 'collection://' + randomUUID(),
  clients = 'collection://' + randomUUID()
const link = (id: string) => 'https://www.notion.so/' + id.replaceAll('-', '')
const ia = link(randomUUID()),
  dev = link(randomUUID()),
  acme = link(randomUUID()),
  other = link(randomUUID()),
  page = link(randomUUID())
const dateField = (name: string) => ({ name, type: 'date' })
const columns = {
  [source]: [
    { name: 'Contrato', type: 'title' },
    { name: 'Tipo', type: 'relation', dataSourceUrl: types },
    { name: 'Proyecto', type: 'relation', dataSourceUrl: clients },
    ...['Launch Date', 'End Date', 'Extension', 'Cierre'].map(dateField),
  ],
  [types]: [{ name: 'Name', type: 'title' }],
  [clients]: [{ name: 'Name', type: 'title' }],
}
const settings = { database: source, areas: ['IA'], area_property: 'Tipo' }
let dir: string, db: MemoryDatabase, store: MemoryStore, remote: DatabaseSync, hub: Resident, project: string, second: string
let enabled: boolean, unavailable: boolean
const read = vi.fn<NotionRead>()
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'resident-notion-'))
  db = new MemoryDatabase(join(dir, 'memory.sqlite'))
  await db.migrate()
  store = new MemoryStore(db, dir)
  project = (await store.create({ kind: 'project', title: 'Acme' })).id
  second = (await store.create({ kind: 'project', title: 'Otra' })).id
  remote = new DatabaseSync(':memory:')
  for (const [name, fields] of Object.entries(columns)) {
    const sqlFields = fields.map((f) => '"' + (f.type === 'date' ? 'date:' + f.name + ':start' : f.name) + '" TEXT')
    remote.exec('CREATE TABLE "' + name + '" (url TEXT PRIMARY KEY,' + sqlFields.join(',') + ')')
  }
  for (const [url, name] of [
    [ia, 'IA'],
    [dev, 'Desarrollo'],
  ])
    remote.prepare('INSERT INTO "' + types + '" VALUES (?,?)').run(url!, name!)
  for (const [url, name] of [
    [acme, 'Acme'],
    [other, 'Sin vínculo'],
  ])
    remote.prepare('INSERT INTO "' + clients + '" VALUES (?,?)').run(url!, name!)
  const insert = remote.prepare('INSERT INTO "' + source + '" VALUES (?,?,?,?,?,?,?,?)')
  insert.run(page, 'Servicio del área', JSON.stringify([ia]), JSON.stringify([acme]), '2026-11-01', '2026-11-30', '2026-12-03', null)
  insert.run(
    link(randomUUID()),
    'Otro servicio',
    JSON.stringify([dev]),
    JSON.stringify([acme]),
    '2026-11-20',
    '2026-12-01',
    null,
    null,
  )
  insert.run(link(randomUUID()), 'Otro cliente', JSON.stringify([ia]), JSON.stringify([other]), '2026-11-20', '2026-12-01', null, null)
  enabled = true
  unavailable = false
  read.mockReset().mockImplementation(async (tool, args) => {
    if (unavailable) throw Error('Acceso a Notion interrumpido')
    if (tool === 'fetch') {
      const id = String(args.id),
        fields = columns[id]!
      return {
        text:
          '<data-source url="{{' +
          id +
          '}}">\n<data-source-state>\n' +
          JSON.stringify({ schema: Object.fromEntries(fields.map((f) => [f.name, f])) }) +
          '\n</data-source-state>\n</data-source>',
      }
    }
    const data = args.data as { query: string; params: string[] }
    return { results: remote.prepare(data.query).all(...data.params), has_more: false }
  })
  hub = new Resident(
    db,
    {
      run: async () => {
        throw Error('Modelo inactivo')
      },
    },
    async () => [],
    async () => {
      throw Error('Sin Slack')
    },
    (module) => (module === 'mcp' ? enabled : module !== 'agents'),
    () => now,
    async () => [],
    undefined,
    undefined,
    undefined,
    undefined,
    read,
  )
  await hub.settings(project)
  await hub.settings(second)
  const policy = await hub.policy()
  await hub.setPolicy({ ...policy.config, notion_contracts: settings }, policy.version)
})
afterEach(async () => {
  await hub.stop()
  await db.close()
  remote.close()
  await rm(dir, { recursive: true, force: true })
})

it('carga sólo el servicio y proyecto vinculados, contrasta fechas y respeta la pausa y reactivación de MCP', async () => {
  await hub.scanNow()
  const snapshot = (await store.detail(project)).entity.data.notion_contracts
  expect(snapshot.items).toEqual([
    expect.objectContaining({ id: notionId(page), areas: ['IA'], end: '2026-11-30', extension: '2026-12-03' }),
  ])
  expect((await store.detail(second)).entity.data.notion_contracts).toBeUndefined()
  const [notice] = await hub.inbox(project, 'attention')
  expect(notice).toMatchObject({
    kind: 'contract',
    source: { due_at: '2026-12-03' },
    evidence: expect.arrayContaining([expect.objectContaining({ url: page })]),
  })
  expect((await hub.notices())[0]?.entries[0]?.source).toBe('Notion')
  const before = read.mock.calls.length
  enabled = false
  await hub.scan(project)
  expect(read).toHaveBeenCalledTimes(before)
  expect(await hub.inbox(project, 'attention')).toHaveLength(0)
  expect(await hub.notices()).toHaveLength(0)
  expect((await store.detail(project)).entity.title).toBe('Acme')
  enabled = true
  await hub.scan(project)
  expect((await hub.inbox(project, 'attention')).map((x) => x.id)).toEqual([notice!.id])
  await hub.attention.dismiss([notice!.id])
  await hub.scan(project)
  expect(await hub.inbox(project, 'attention')).toHaveLength(0)
})

it('conserva la última lectura ante errores y reconcilia las prórrogas y los retiros confirmados', async () => {
  await hub.scan(project)
  unavailable = true
  await hub.scan(project)
  expect((await store.detail(project)).entity.data.notion_contracts.status).toBe('unavailable')
  expect(await hub.inbox(project, 'attention')).toHaveLength(0)
  expect(await hub.notices()).toHaveLength(0)
  unavailable = false
  remote.prepare('UPDATE "' + source + '" SET "date:Extension:start"=? WHERE url=?').run('2027-02-01', page)
  await hub.scan(project)
  expect((await store.detail(project)).entity.data.notion_contracts.items[0].extension).toBe('2027-02-01')
  expect(await hub.inbox(project, 'attention')).toHaveLength(0)
  remote.prepare('DELETE FROM "' + source + '" WHERE url=?').run(page)
  await hub.scan(project)
  expect((await store.detail(project)).entity.data.notion_contracts).toBeUndefined()
})

it('acepta varias áreas y un vínculo explícito cuando el nombre del cliente difiere', async () => {
  const policy = await hub.policy()
  await hub.setPolicy({ ...policy.config, notion_contracts: { ...settings, areas: ['IA', 'Desarrollo'] } }, policy.version)
  const p = await hub.settings(second)
  await hub.save(second, { ...p.config, notion_project: other }, p.version)
  await hub.scanNow()
  expect((await store.detail(second)).entity.data.notion_contracts.items.map((c: ProjectContract) => c.title)).toEqual([
    'Otro cliente',
  ])
  expect((await store.detail(project)).entity.data.notion_contracts.items).toHaveLength(2)
  await expect(readNotionContracts(read, { ...settings, areas: ['Ausente'] }, new AbortController().signal)).rejects.toThrow('áreas')
})

it('lee las vistas completas por cursor cuando el plan de Notion carece de cupo SQL', async () => {
  const views = new Map(Object.keys(columns).map((id) => [id, 'view://' + randomUUID()]))
  const parents = new Map(Object.keys(columns).map((id) => [id, link(randomUUID())]))
  const query = vi.fn<NotionRead>(async (tool, args) => {
    if (tool === 'fetch') {
      const id = String(args.id)
      const client = remote
        .prepare('SELECT url, Name FROM "' + clients + '"')
        .all()
        .find((row) => notionId(String(row.url)) === notionId(id))
      if (client)
        return {
          url: client.url,
          title: client.Name,
          metadata: { type: 'page' },
          text: '<parent-data-source url="' + clients + '" name="Clientes"/>',
        }
      const collection = columns[id] ? id : [...parents].find(([, url]) => url === id)![0]
      const schema = Object.fromEntries(columns[collection]!.map((f) => [f.name, f]))
      let text =
        '<data-source url="{{' +
        collection +
        '}}"><data-source-state>' +
        JSON.stringify({ schema }) +
        '</data-source-state></data-source>'
      if (id !== collection) {
        const view = { type: 'table', dataSourceUrl: '{{' + collection + '}}' }
        text += '<view url="{{view://' + randomUUID() + '}}">' + JSON.stringify({ ...view, simpleFilters: [{}] }) + '</view>'
        text += '<view url="{{' + views.get(collection) + '}}">' + JSON.stringify(view) + '</view>'
      }
      return { text, url: parents.get(collection), metadata: { type: id === collection ? 'data_source' : 'database' } }
    }
    const data = args.data as { mode: string; view_url: string; start_cursor?: string }
    if (data.mode !== 'view') throw Error('Cupo SQL agotado')
    const sourceId = [...views].find(([, url]) => url === data.view_url)![0]
    if (sourceId === clients) throw Error('La vista de proyectos supera el límite de menciones de Notion')
    const all = remote.prepare('SELECT * FROM "' + sourceId + '" ORDER BY url').all()
    const offset = Number(data.start_cursor || 0)
    return { results: all.slice(offset, offset + 1), has_more: offset + 1 < all.length, next_cursor: String(offset + 1) }
  })
  const result = await readNotionContracts(query, settings, new AbortController().signal)
  expect(result).toHaveLength(2)
  expect(result.every((r) => r.areas.join() === 'IA')).toBe(true)
  expect(result.find((r) => r.url === page)).toMatchObject({
    extension: '2026-12-03',
    projects: [{ id: notionId(acme), name: 'Acme' }],
  })
})

it('ubica reuniones y avances respecto de la prórroga y distingue un cierre registrado', async () => {
  const [c] = (await readNotionContracts(read, settings, new AbortController().signal)).filter((r) => r.id === notionId(page))
  const s: Signal = {
    kind: 'meeting',
    key: 'm',
    at: '2026-12-05',
    score: 5,
    title: 'Revisión',
    text: 'Avance',
    url: '',
    reasons: [],
    fingerprint: 'm',
    source: { calendar_day: '2026-12-05' },
  }
  expect(withContractContext(s, [c!], '2026-11-27', true).reasons.join(' ')).toContain('después del fin')
  expect(
    withContractContext({ ...s, kind: 'jira', source: { due_at: '2026-12-01' } }, [c!], '2026-11-27', false).evidence?.[0],
  ).toMatchObject({ url: page, remote: false })
  expect(contractSignals([{ ...c!, closed: '2026-11-26' }], '2026-11-27', true)).toHaveLength(0)
})

it('revisa el contrato, la reunión y el avance personal de Jira en una microtarea y expone las fechas en la línea de tiempo', async () => {
  const meeting = await store.ingest({
    kind: 'event',
    external_id: 'review-acme',
    title: 'Revisión de avance',
    text: 'Seguimiento',
    occurred_at: '2026-11-30T12:00:00Z',
    project_ids: [project],
  })
  const p = await hub.settings(project)
  const done = normalizeJiraIssue(
    { key: 'ACM-7', summary: 'Entrega terminada', status: 'Done', status_category: 'done', assignee_account_id: 'mine' },
    'https://example.atlassian.net',
  )!
  hub.contracts.recordProgress(project, { ...p.config, jira_owner: 'mine' }, [
    { ...done, remote: true },
    { ...done, key: 'ACM-8', assignee_account_id: 'other', remote: true },
  ])
  const signal = new AbortController().signal
  const model = vi.spyOn(hub.model, 'run').mockImplementation(async (_role, _project, _profile, _instructions, input: any, schema) => {
    expect(input.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: page }),
        expect.objectContaining({ id: 'calendar/' + meeting.entity_id }),
        expect.objectContaining({ id: 'jira/https://example.atlassian.net/ACM-7' }),
      ]),
    )
    expect(input.evidence.map((e: { id: string }) => e.id)).not.toContain('jira/https://example.atlassian.net/ACM-8')
    return schema.parse({
      summary: 'Revisión con contrato y calendario',
      criteria: [],
      missing: [],
      citations: input.evidence.map((e: { id: string }) => e.id),
      delegate: [],
    })
  })
  const job = await hub.work.enqueue(
    project,
    p.config,
    p.version,
    { key: 'manual/test', objective: 'Evaluar el avance', role: 'pm' },
    signal,
  )
  await hub.work.next(project, p.config, p.version, signal)
  expect(model).toHaveBeenCalledOnce()
  expect((await db.query('SELECT state FROM assistant_work WHERE id=$1', [job.id]))[0]?.state).toBe('done')
  const ops = new MemoryOperations(store, new MemoryAI(async () => defaultAI, new Vault(dir)))
  const timeline = await ops.call('timeline', { project_id: project, limit: 10, offset: 0 })
  expect(timeline.contracts.items[0]).toMatchObject({ url: page, extension: '2026-12-03' })
  expect(timeline.items.map((e: { id: string }) => e.id)).toContain(meeting.entity_id)
})
