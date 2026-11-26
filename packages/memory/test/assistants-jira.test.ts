import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { Resident } from '../src/assistants/runtime.js'
import { inspectThread } from '../src/assistants/slack.js'
import { profile, type Evidence, type Watch } from '../src/assistants/contracts.js'
import type { JiraTaskReader } from '../src/projects/tasks.js'

const site = 'https://client.atlassian.net'
const now = new Date('2026-11-25T12:00:00Z')
const issue = (key: string, status = 'To Do', category = 'new') => ({
  key,
  fields: {
    summary: 'Entrega Acme',
    description: 'Preparar la entrega piloto',
    status: { name: status, statusCategory: { key: category } },
    duedate: '2026-11-24',
    updated: '2026-11-20T11:00:00Z',
    project: { key: key.split('-')[0] },
  },
})
let dir: string, db: MemoryDatabase, store: MemoryStore, project: string, resident: Resident
let issues: ReturnType<typeof issue>[], fail: boolean, mcp: boolean, requiresAgreement: boolean, memory: Evidence[], order: string[]
const reader = vi.fn<JiraTaskReader>()
const watch: Watch = { connector_id: randomUUID(), team: 'TACME', channel: 'CACME', owner: 'UOWNER', colleagues: [] }
const root = ((+now - 700_000) / 1000).toFixed(6)
const slack = (text: string) => inspectThread(watch, root, [{ ts: root, user: 'UCLIENT', text }])
let thread = slack('')
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-jira-verify-'))
  db = new MemoryDatabase(join(dir, 'memory.sqlite'))
  await db.migrate()
  store = new MemoryStore(db, dir)
  project = (await store.create({ kind: 'project', title: 'Implementación', data: { jira_project_key: 'NIN', jira_site_url: site } })).id
  issues = []
  fail = false
  mcp = true
  requiresAgreement = false
  memory = []
  order = []
  thread = slack('<@UOWNER> ¿Sigue abierto NIN-87?')
  reader.mockReset().mockImplementation(async (request, page) => {
    order.push('jira')
    await page(
      issues.filter((i) => !request.issueKeys?.length || request.issueKeys.includes(i.key)),
      site,
    )
    if (fail) throw Error('Sin permiso para leer la siguiente página')
  })
  resident = new Resident(
    db,
    {
      run: async (_r, _p, _c, _prompt, input: any, schema) => {
        order.push('model')
        return schema.parse({
          relevant: true,
          status:
            input.evidence.length && (!requiresAgreement || input.evidence.some((e: Evidence) => e.id === 'agreement'))
              ? 'supported'
              : 'missing',
          explanation: 'Estado verificado',
          draft: 'Revisamos la entrega.',
          citations: input.evidence.map((e: Evidence) => e.id),
          urgency: 7,
        })
      },
    },
    async (_p, _text, exclude) => {
      order.push('memory')
      expect(exclude?.jira).toBe(true)
      return memory
    },
    async () => ({ roots: async () => [root], thread: async () => thread, send: async () => root }),
    (id) => id !== 'agents' && (id !== 'mcp' || mcp),
    () => now,
    undefined,
    undefined,
    undefined,
    reader,
  )
  await resident.save(project, profile.parse({ active: true, timezone: 'UTC' }), 0)
})
afterEach(async () => {
  await resident.stop()
  await db.close()
  await rm(dir, { recursive: true, force: true })
})

it('reconcilia el conjunto completo de Jira y conserva el historial local de un ticket ausente y de una tarea manual', async () => {
  const task = randomUUID(),
    manual = randomUUID()
  await db.query(
    "INSERT INTO tasks(id,project_id,kind,title,status,external_key,external_site,created_by,updated_by) VALUES($1,$2,'jira','Entrega antigua','todo','NIN-87',$3,'test','test')",
    [task, project, site],
  )
  await db.query(
    "INSERT INTO tasks(id,project_id,kind,title,status,created_by,updated_by) VALUES($1,$2,'pending','Manual','todo','test','test')",
    [manual, project],
  )
  issues = [issue('NIN-87'), issue('NIN-90')]
  await resident.scan(project)
  expect((await resident.inbox(project, 'attention')).map((c) => c.title)).toEqual(
    expect.arrayContaining([expect.stringContaining('NIN-87'), expect.stringContaining('NIN-90')]),
  )
  issues = [issue('NIN-90', 'Finalizado', 'done')]
  await resident.scan(project)
  expect(await resident.inbox(project, 'attention')).toEqual([])
  expect((await resident.inbox(project, 'history')).map((c) => c.reason)).toEqual(
    expect.arrayContaining([expect.stringMatching(/visible/i), expect.stringContaining('Finalizado')]),
  )
  expect(await db.query('SELECT id FROM tasks WHERE id IN ($1,$2)', [task, manual])).toHaveLength(2)
  expect(reader.mock.calls.every(([query]) => query.key === 'NIN' && query.site === site && !query.updatedMinutes)).toBe(true)
  issues = [issue('NIN-87')]
  await resident.scan(project)
  expect((await resident.inbox(project, 'attention'))[0]?.source_key).toBe('jira/' + task)
})

it('una lectura parcial o un módulo apagado no genera avisos, no da por eliminado el ticket y permite reconfirmarlo', async () => {
  issues = [issue('NIN-87')]
  await resident.scan(project)
  expect((await resident.notices())[0]?.entries[0]?.kind).toBe('jira')
  issues = []
  fail = true
  await resident.scan(project)
  expect((await resident.settings(project)).last_error).toMatch(/Jira/i)
  expect(await resident.notices()).toEqual([])
  expect((await resident.inbox(project))[0]?.reason).toMatch(/no se pudo|sin confirmar/i)
  expect((await resident.inbox(project))[0]?.reason).not.toMatch(/eliminad|venci[oó]/i)
  fail = false
  issues = [issue('NIN-87')]
  mcp = false
  reader.mockClear()
  await resident.scan(project)
  expect(reader).not.toHaveBeenCalled()
  expect(await resident.notices()).toEqual([])
  await store.ingest({
    kind: 'event',
    title: 'Revisión de entrega',
    external_id: 'calendar-demo',
    text: 'Revisión',
    project_ids: [project],
    occurred_at: new Date(+now + 15 * 60_000).toISOString(),
  })
  await resident.scan(project)
  expect((await resident.notices())[0]?.entries.map((entry) => entry.kind)).toEqual(['meeting'])
  mcp = true
  await resident.scan(project)
  expect((await resident.notices())[0]?.entries.map((entry) => entry.kind)).toEqual(expect.arrayContaining(['jira', 'meeting']))
})

it('resuelve un asunto anterior sin issue_key desde su URL y diferencia ausencia visible de fallo', async () => {
  const legacy = {
    kind: 'jira' as const,
    source_key: 'jira/' + randomUUID(),
    source: { url: site + '/browse/NIN-87' },
    title: 'NIN-87 · Entrega',
  }
  issues = [issue('NIN-87', 'Done', 'done')]
  const read = () => resident.liveEvidence(project, legacy, '¿Todavía existe?', resident.signal(project))
  expect(await read()).toMatchObject({ status: 'verified', evidence: [{ text: expect.stringContaining('Done') }] })
  expect(reader.mock.calls[0]?.[0]).toMatchObject({ key: 'NIN', site, issueKeys: ['NIN-87'] })
  issues = []
  expect(await read()).toMatchObject({ status: 'not_visible', evidence: [] })
  fail = true
  expect(await read()).toMatchObject({ status: 'unavailable', evidence: [] })
})

it('Slack consulta primero a Jira, usa memoria ante falta de evidencia y revalida antes de enviar', async () => {
  await db.query("INSERT INTO connectors(id,provider,name,config,project_ids,enabled) VALUES($1,'slack','Slack',$2,$3,1)", [
    watch.connector_id,
    { channel_ids: [watch.channel] },
    [project],
  ])
  const config = profile.parse({ active: true, timezone: 'UTC', slack: [watch] })
  await resident.save(project, config, 1)
  issues = [issue('NIN-87')]
  const observe = () => resident.attention.observe(project, config, 2, thread.signal!, resident.signal(project), thread)
  const item = await observe()
  expect(order).toEqual(['jira', 'model'])
  expect(item?.evidence[0]?.url).toBe(site + '/browse/NIN-87')
  issues = []
  order = []
  await expect(resident.attention.approve(item!.id, item!.revision, config, 2, resident.signal(project))).rejects.toThrow(/cambi[oó]/i)
  expect(order[0]).toBe('jira')
  order = []
  memory = [
    { id: 'agreement', title: 'Acuerdo', text: 'Consentimiento del cliente', url: '/#/memory', at: now.toISOString(), remote: true },
  ]
  await observe()
  expect(order).toEqual(['jira', 'memory', 'model'])
})

it('acota un potencial cliente sin clave Jira por la empresa asociada y el sitio, sin mezclar tickets de otro proyecto local', async () => {
  const company = await store.create({ kind: 'company', title: 'Acme' })
  await db.query("UPDATE entities SET data=json_remove(json_set(data,'$.company_id',$2),'$.jira_project_key') WHERE id=$1", [
    project,
    company.id,
  ])
  await store.create({ kind: 'project', title: 'Otro contrato', data: { jira_project_key: 'ZZ', jira_site_url: site } })
  issues = [issue('CRM-3'), issue('ZZ-5')]
  const row = { kind: 'slack' as const, source: {}, source_key: 'slack/1', title: '¿Qué novedades hay del cliente?' }
  const answer = await resident.liveEvidence(project, row, '¿Cómo va la entrega?', resident.signal(project))
  expect(reader.mock.calls[0]?.[0]).toMatchObject({ key: null, site, company: 'Acme' })
  expect(answer.evidence.map((e) => e.url)).toEqual([site + '/browse/CRM-3'])
})

it('respeta la privacidad de la clave exacta también en búsquedas vacías sin bloquear por otra nota privada del proyecto', async () => {
  const row = { kind: 'jira' as const, source_key: 'jira/legacy', source: { url: site + '/browse/NIN-87' }, title: 'NIN-87' }
  const read = () => resident.liveEvidence(project, row, 'Estado', resident.signal(project))
  await store.create({
    kind: 'note',
    title: 'Otra nota',
    data: { text: 'Entrevista privada', remote_processing: false },
    project_ids: [project],
  })
  issues = [issue('NIN-87', 'Cerrado', 'done')]
  expect(await read()).toMatchObject({ remote: true, resolved: true, evidence: [{ remote: true }] })
  await store.ingest({
    kind: 'issue',
    title: 'NIN-87',
    external_id: 'NIN-87',
    text: 'Entrega',
    url: site + '/browse/NIN-87',
    project_ids: [project],
    metadata: { key: 'NIN-87', remote_processing: false },
  })
  expect(await read()).toMatchObject({ remote: false, evidence: [{ remote: false }] })
  issues = []
  expect(await read()).toMatchObject({ remote: false, status: 'not_visible' })
  fail = true
  expect(await read()).toMatchObject({ remote: false, status: 'unavailable' })
})

it('un asunto legado no genera avisos ni se presenta como vigente antes de la primera verificación completa', async () => {
  const id = randomUUID()
  await db.query(
    `INSERT INTO assistant_cases(id,project_id,source_key,kind,title,score,reason,state,source,fingerprint,notify_after,updated_at)
    VALUES($1,$2,$3,'jira','NIN-87 · Entrega',10,'Venció ayer','open',$4,'old',$5,$5)`,
    [id, project, 'jira/' + randomUUID(), { url: site + '/browse/NIN-87' }, now.toISOString()],
  )
  expect(await resident.inbox(project, 'attention')).toEqual([])
  expect(await resident.inboxTotals(project, 'attention')).toEqual({ total: 0, urgent: 0, important: 0 })
  expect(await resident.attention.get(id)).toMatchObject({ score: 0, evidence: [], reason: expect.stringMatching(/confirmar/i) })
  expect(await resident.notices()).toEqual([])
})

it('un ticket descartado que desapareció de la última revisión no se reactiva por restaurar la selección', async () => {
  issues = [issue('NIN-87')]
  await resident.scan(project)
  const [item] = await resident.inbox(project, 'attention')
  await resident.attention.dismiss([item!.id])
  issues = []
  await resident.scan(project)
  expect(await resident.attention.restore([item!.id])).toEqual([])
  expect(await resident.notices()).toEqual([])
})

it('completa una lectura de Jira con memoria sólo si la evidencia inicial resulta insuficiente para el borrador', async () => {
  await db.query("INSERT INTO connectors(id,provider,name,config,project_ids,enabled) VALUES($1,'slack','Slack',$2,$3,1)", [
    watch.connector_id,
    { channel_ids: [watch.channel] },
    [project],
  ])
  const config = profile.parse({ active: true, timezone: 'UTC', slack: [watch] })
  await resident.save(project, config, 1)
  issues = [issue('NIN-87')]
  requiresAgreement = true
  memory = [{ id: 'agreement', title: 'Acuerdo', text: 'Fecha acordada con Acme', url: '/#/memory', at: now.toISOString(), remote: true }]
  const observed = await resident.attention.observe(project, config, 2, thread.signal!, resident.signal(project), thread)
  expect(order).toEqual(['jira', 'model', 'memory', 'model'])
  expect(observed?.draft).toBeTruthy()
  order = []
  await resident.attention.approve(observed!.id, observed!.revision, config, 2, resident.signal(project))
  expect(order).toEqual(['jira', 'memory'])
})

it('una revisión manual coincidente con el reloj comprueba Jira aunque el ciclo automático conserve su intervalo', async () => {
  issues = [issue('NIN-87')]
  await resident.scan(project)
  issues = []
  reader.mockClear()
  const automatic = resident.scan(project, false)
  await Promise.all([automatic, resident.scan(project), resident.scan(project)])
  expect(reader).toHaveBeenCalledTimes(1)
  expect(await resident.inbox(project, 'attention')).toEqual([])
})
