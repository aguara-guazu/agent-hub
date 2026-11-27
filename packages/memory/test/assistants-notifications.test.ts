import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { normalizeJiraIssue } from '../src/projects/tasks.js'
import { NotificationQueue, briefEmailReminders } from '../src/assistants/notifications.js'
import { profile, portfolioPolicy } from '../src/assistants/contracts.js'
import { setProjectArchive } from '../src/projects/archive.js'

let dir: string, db: MemoryDatabase, store: MemoryStore, q: NotificationQueue, at: Date, a: string, b: string
const desktop = randomUUID(),
  cli = randomUUID()
const clock = () => at
async function project(title: string) {
  const p = await store.create({ kind: 'project', title })
  await db.query('INSERT INTO assistant_profiles(project_id,config) VALUES($1,$2)', [
    p.id,
    profile.parse({ active: true, timezone: 'UTC', start: '00:00', end: '23:59', jira_owner: 'owner' }),
  ])
  return p.id
}
async function advanceWithJiraChecks(date: Date) {
  at = date
  await db.query("UPDATE assistant_source_cursors SET scanned_at=$1 WHERE source_key='jira/verified'", [date.toISOString()])
}
async function issue(projectId: string, score: number, key: string) {
  const id = randomUUID(),
    now = at.toISOString()
  await db.query(`INSERT INTO assistant_source_cursors(project_id,source_key,scanned_at) VALUES($1,'jira/verified',$2)
    ON CONFLICT(project_id,source_key) DO UPDATE SET scanned_at=excluded.scanned_at`, [projectId, now])
  await db.query(
    "INSERT INTO assistant_cases(id,project_id,source_key,kind,title,score,reason,state,source,fingerprint,notify_after,updated_at) VALUES($1,$2,$1,'jira',$3,$4,'Bloquea la entrega','open',$5,'v1',$6,$6)",
    [id, projectId, key, score, { url: 'https://example.atlassian.net/browse/' + key, issue_key: key, jira_verification: 'verified', assignee_account_id: 'owner' }, now],
  )
  return id
}
async function event(title: string, start: string, end: string, projectId?: string, extra: Record<string, unknown> = {}) {
  await store.ingest({
    kind: 'event',
    title,
    external_id: title,
    occurred_at: start,
    project_ids: projectId ? [projectId] : [],
    metadata: { scheduled_start: { dateTime: start }, scheduled_end: { dateTime: end }, ...extra },
  })
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-avisos-'))
  db = new MemoryDatabase(join(dir, 'memory.sqlite'))
  await db.migrate()
  store = new MemoryStore(db, dir)
  at = new Date('2026-11-26T10:00:00Z')
  await db.query('INSERT INTO assistant_portfolio_policy VALUES(1,$1)', [
    { version: 1, config: portfolioPolicy.parse({ timezone: 'UTC' }) },
  ])
  q = new NotificationQueue(db, clock, () => true)
  a = await project('Atlas')
  b = await project('Delta')
})
afterEach(async () => {
  await db.close()
  await rm(dir, { force: true, recursive: true })
})
it('agrupa proyectos, prioriza por reunión próxima y coordina dos consumidores antes de presentar', async () => {
  const near = await issue(a, 6, 'ATL-9'),
    other = await issue(b, 7, 'DEL-2')
  await event('Revisión Atlas', '2026-11-26T10:25:00Z', '2026-11-26T11:00:00Z', a)
  const attempts = await Promise.all([q.next(desktop), q.next(cli)])
  const notices = attempts.flat()
  expect(notices).toHaveLength(1)
  const n = notices[0]!
  expect(n.entries.map((e) => e.id)).toEqual([near, other])
  expect(n.body).toContain('Jira')
  expect(n.entries[0]?.reason).toContain('Bloquea')
  expect(n.entries[0]?.calendar).toContain('Revisión Atlas')
  await q.seen(n.id, n.revision, n.delivery_id)
  await q.seen(n.id, n.revision, n.delivery_id)
  await issue(b, 7, 'DEL-3')
  expect(await q.next(desktop)).toEqual([])
})
it('retiene los normales en una reunión independiente, permite alta severidad y descarta un asunto resuelto durante la espera', async () => {
  await event('Equipo', '2026-11-26T09:30:00Z', '2026-11-26T10:40:00Z')
  const normal = await issue(a, 7, 'ATL-3')
  const urgent = await issue(b, 9, 'DEL-1')
  const [n] = await q.next(desktop)
  expect(n?.entries.map((e) => e.id)).toEqual([urgent])
  await q.seen(n!.id, n!.revision, n!.delivery_id)
  await db.query("UPDATE assistant_cases SET state='handled' WHERE id=$1", [normal])
  await advanceWithJiraChecks(new Date('2026-11-26T10:41:00Z'))
  const later = await q.next(desktop)
  expect(later.flatMap((n) => n.entries.map((e) => e.id))).not.toContain(normal)
})
it('espacia los reavisos, mantiene el cupo por asunto entre reinicios y lo reinicia al día local siguiente', async () => {
  const id = await issue(a, 8, 'ATL-4')
  const present = async () => {
    const [n] = await q.next(desktop)
    expect(n?.entries[0]?.id).toBe(id)
    await q.seen(n!.id, n!.revision, n!.delivery_id)
  }
  await present()
  for (const [minutes, eligible] of [
    [29, false],
    [30, true],
    [89, false],
    [90, true],
    [300, false],
  ] as const) {
    await advanceWithJiraChecks(new Date(Date.parse('2026-11-26T10:00:00Z') + minutes * 60000))
    q = new NotificationQueue(db, clock, () => true)
    if (eligible) await present()
    else expect(await q.next(desktop)).toEqual([])
  }
  expect(await briefEmailReminders(db, at)).toContain('ATL-4')
  await advanceWithJiraChecks(new Date('2026-11-27T10:00:00Z'))
  await present()
  await setProjectArchive(store, a, { state: 'archived', version: 0 })
  expect(await briefEmailReminders(db, at)).not.toContain('ATL-4')
})

it('usa la agenda conectada aunque sea una reunión de Meet aún sin importar, conserva la lectura tras reiniciar y reconoce una cancelación', async () => {
  const { calendarAvailability } = await import('../src/connectors/calendar-window.js')
  const connector = randomUUID()
  await db.query("INSERT INTO connectors(id,provider,name,config,project_ids,enabled) VALUES($1,'google','Prueba',$2,'[]',1)", [
    connector,
    { calendars: ['primary'] },
  ])
  const google = { token: async () => 'prueba' } as never
  let online = true,
    cancelled = false
  const external = async () => {
    if (!online) throw Error('sin red')
    const start = { dateTime: '2026-11-26T09:58:00Z' },
      end = { dateTime: '2026-11-26T10:35:00Z' }
    return Response.json({
      items: [
        {
          id: 'meet',
          summary: 'Revisión Atlas',
          start,
          end,
          status: cancelled ? 'cancelled' : 'confirmed',
          hangoutLink: 'https://meet.google.com/abc-defg-hij',
        },
        { id: 'libre', start, end, transparency: 'transparent' },
        { id: 'rechazada', start, end, attendees: [{ self: true, responseStatus: 'declined' }] },
        { id: 'todo-el-dia', start: { date: '2026-11-26' }, end: { date: '2026-11-27' } },
      ],
    })
  }
  const live = () => new NotificationQueue(db, clock, () => true, calendarAvailability(db, google, external))
  await issue(a, 7, 'ATL-33')
  expect(await live().next(desktop)).toEqual([])
  online = false
  expect((await live().agenda()).busy).toBe(true)
  online = true
  cancelled = true
  expect((await live().next(desktop))[0]?.entries[0]?.title).toBe('ATL-33')
})

it('permite silenciar incluso severidad 10 y conserva el cupo tras revisiones del asunto', async () => {
  await db.query(
    "UPDATE assistant_portfolio_policy SET value=json_set(value,'$.config.notifications.interrupt_severity',NULL,'$.config.notifications.daily_limit',1)",
  )
  await event('Reunión personal', '2026-11-26T09:00:00Z', '2026-11-26T10:05:00Z')
  const id = await issue(a, 10, 'ATL-17')
  expect(await q.next(desktop)).toEqual([])
  await advanceWithJiraChecks(new Date('2026-11-26T10:06:00Z'))
  const [n] = await q.next(desktop)
  await q.seen(n!.id, n!.revision, n!.delivery_id)
  await db.query("UPDATE assistant_cases SET revision=revision+1,title='Cambio en ATL-17' WHERE id=$1", [id])
  await advanceWithJiraChecks(new Date('2026-11-26T17:00:00Z'))
  expect(await q.next(cli)).toEqual([])
  expect(await briefEmailReminders(db, at)).toContain('Cambio en ATL-17')
  await db.query("UPDATE assistant_cases SET state='handled' WHERE id=$1", [id])
  expect(await briefEmailReminders(db, at)).toBe('')
})

it('prioriza el hilo de Slack que pide una respuesta por un ticket bloqueado del mismo cliente', async () => {
  const stale = await issue(a, 6, 'Consulta del cliente A')
  const unrelated = await issue(b, 7, 'Consulta del cliente B')
  for (const id of [stale, unrelated]) {
    await db.query("UPDATE assistant_cases SET kind='slack',source=$2 WHERE id=$1", [
      id,
      { channel_name: 'cliente', question: true, at: at.toISOString(), text: '¿Podés responder por ATL-31?' },
    ])
  }
  await db.query(
    "INSERT INTO tasks(id,project_id,kind,title,status,external_key,created_by,updated_by) VALUES($1,$2,'jira','Entrega','blocked','ATL-31','test','test')",
    [randomUUID(), a],
  )
  expect((await q.next())[0]?.entries.map(e => e.id)).toEqual([unrelated, stale])
  const live = await issue(a, 2, 'ATL-31')
  await db.query("UPDATE assistant_cases SET source=json_set(source,'$.status','blocked') WHERE id=$1", [live])
  const [notice] = await q.next(desktop)
  expect(notice?.entries.map((e) => e.id)).toEqual([stale, unrelated])
  expect(notice?.entries[0]).toMatchObject({ source: 'Slack · cliente', reason: expect.stringMatching(/ATL-31.*bloqueada/) })
  expect(notice?.entries[1]?.reason).not.toContain('ATL-31')
})

it('explica y distingue un ticket crítico que vence hoy y descarta eventos que figuran como libres', async () => {
  const { projectSignals } = await import('../src/assistants/signals.js')
  await event('Reserva libre', '2026-11-26T10:25:00Z', '2026-11-26T11:00:00Z', a, { transparency: 'transparent' })
  const tickets = [['ATL-32', 'Highest'], ['ATL-34', 'Low']].map(([key, priority]) => ({
    ...normalizeJiraIssue({ key, summary:'Entrega', status:'To Do', duedate:'2026-11-26', priority }, 'https://atlas.atlassian.net')!, remote: true,
  }))
  const signals = await projectSignals(db, a, profile.parse({ timezone: 'UTC', jira_assignee_scope: 'project' }), at, tickets)
  const critical = signals.find((s) => s.title.includes('ATL-32'))!,
    low = signals.find((s) => s.title.includes('ATL-34'))!
  expect(critical.score).toBeGreaterThan(low.score)
  expect(critical.reasons.join(' ')).toMatch(/Vence hoy.*Highest/)
  expect(signals.some((s) => s.title === 'Reserva libre')).toBe(false)
})

it('alarga la pausa tras una tanda numerosa y permite desactivar esa adaptación', async () => {
  for (let index = 0; index < 8; index++) await issue(a, 7, 'ATL-' + (40 + index))
  const [batch] = await q.next(desktop)
  expect(batch?.entries).toHaveLength(8)
  await q.seen(batch!.id, batch!.revision, batch!.delivery_id)
  await db.query("UPDATE assistant_cases SET state='handled' WHERE project_id=$1", [a])
  await issue(b, 7, 'DEL-91')
  await advanceWithJiraChecks(new Date('2026-11-26T10:15:00Z'))
  expect(await q.next(cli)).toEqual([])
  await advanceWithJiraChecks(new Date('2026-11-26T10:30:00Z'))
  const [second] = await q.next(cli)
  expect(second?.entries[0]?.title).toBe('DEL-91')
  await q.seen(second!.id, second!.revision, second!.delivery_id)
  await db.query("UPDATE assistant_portfolio_policy SET value=json_set(value,'$.config.notifications.adaptive_cooldown',json('false'))")
  await issue(a, 7, 'ATL-92')
  await advanceWithJiraChecks(new Date('2026-11-26T10:45:00Z'))
  expect((await q.next(desktop))[0]?.entries[0]?.title).toBe('ATL-92')
})

it('espera una lectura vigente de Jira antes de repetir un aviso o mostrarlo en el detalle', async () => {
  await issue(a, 8, 'ATL-22')
  const [notice] = await q.next(desktop)
  at = new Date(+at + 16 * 60_000)
  expect(await q.next(desktop)).toEqual([])
  expect(await q.detail(notice!.delivery_id)).toEqual({entries: []})
})
