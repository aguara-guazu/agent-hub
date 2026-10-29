import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryOperations } from '../src/operations.js'
import { MemoryAI } from '../src/ai.js'
import { Vault, defaultAI } from '../src/config.js'
import { ScheduleAdmin } from '../src/schedule-admin.js'
import { ScheduleStore, snapshotOf } from '../src/schedule-store.js'
import { randomUUID } from 'node:crypto'
import '../src/schedule-templates.js'

let dir: string, db: MemoryDatabase, store: ScheduleStore, admin: ScheduleAdmin, projectId: string, enabled: boolean, gmail: boolean, stopped: string[]
const NOW = new Date('2026-10-28T12:00:00.000Z')
const agent = (id = 'agent-1') => ({ kind: 'agent' as const, agent: { agent_id: id, cli_kind: 'claude_code', client: 'test', session_id: `native:${id}`, cwd: null } })
const human = { kind: 'human' as const, ref: 'owner' }
let counter = 0
const create = (overrides: Record<string, unknown> = {}, principal = agent()) => admin.create(principal, { project_id: projectId, template: 'reminder', title: 'Recordar', instructions: '', params: { message: 'Revisar PRs' },
  recurrence: { type: 'daily', time: '08:00' }, delivery: ['hub_inbox'], request_id: `r-${counter++}`, ...overrides } as any)
const code = async (promise: Promise<unknown>) => promise.then(() => 'ok', error => (error as { code?: string }).code)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-schedule-admin-'))
  db = new MemoryDatabase(join(dir, 'memory.sqlite')); await db.migrate()
  projectId = (await new MemoryOperations(new MemoryStore(db, dir), new MemoryAI(async () => defaultAI, new Vault(dir))).call('create_entity', { kind: 'project', title: 'Proyecto' })).id
  store = new ScheduleStore(db); enabled = true; gmail = false; stopped = []
  admin = new ScheduleAdmin({ store, db, automationsEnabled: () => enabled, now: () => NOW, zone: () => 'America/Argentina/Buenos_Aires',
    deliveryAvailability: async () => ({ gmail_self: { available: gmail, reason: 'not_connected' }, slack_self: { available: false, reason: 'not_connected' } }), stopRun: async id => { stopped.push(id) } })
})
afterEach(async () => { await db.close(); await rm(dir, { recursive: true, force: true }) })

it('crea un recordatorio con próxima ejecución en hora local y un anuncio fijo', async () => {
  const { schedule, announce } = await create()
  expect(schedule).toMatchObject({ state: 'active', kind: 'notice', template: 'reminder', revision: 1, timezone: 'America/Argentina/Buenos_Aires', next_run_at: '2026-10-29T11:00:00.000Z', next_run_local: '2026-10-29T08:00:00-03:00' })
  expect(announce).toContain('Programé «Recordar»')
  expect(schedule.delivery_allowed).toEqual(['hub_inbox', 'app_window', 'gmail_self', 'slack_self'])
})

it('es idempotente por agente y request_id', async () => {
  const first = await create({ request_id: 'same' }), again = await create({ request_id: 'same' })
  expect(again.schedule.id).toBe(first.schedule.id)
  expect((await store.listSchedules({ limit: 10, offset: 0 })).total).toBe(1)
})

it('un perfil de run no administra schedules y con automatizaciones apagadas se rechaza crear', async () => {
  const profile = { kind: 'agent' as const, agent: { ...agent().agent, cli_kind: 'hub_run_action' } }
  expect(await code(create({}, profile))).toBe('run_cannot_schedule')
  enabled = false
  expect(await code(create())).toBe('automations_disabled')
})

it('valida frecuencia mínima, ejecución única futura y destinos externos disponibles', async () => {
  expect(await code(create({ recurrence: { type: 'interval', minutes: 5 }, template: 'custom_synthesis', params: { topic: 'x' } }))).toBe('interval_too_short')
  expect(await code(create({ recurrence: { type: 'once', at: '2026-10-27T00:00:00.000Z' } }))).toBe('once_in_past')
  expect(await code(create({ recurrence: { type: 'once', at: '2028-10-27T00:00:00.000Z' } }))).toBe('once_too_far')
  expect(await code(create({ delivery: ['gmail_self'] }))).toBe('delivery_unavailable')
  gmail = true
  expect(await code(create({ delivery: ['gmail_self'] }))).toBe('ok')
})

it('rechaza un objetivo vivo duplicado, plantillas desconocidas y parámetros inválidos', async () => {
  await create()
  expect(await code(create())).toBe('duplicate_target')
  expect(await code(create({ template: 'team_health' }))).toBe('template_unknown')
  expect(await code(create({ params: { message: '' } }))).toBe('params_invalid')
  expect(await code(create({ project_id: '00000000-0000-4000-8000-000000000000' }))).toBe('project_not_found')
})

it('aplica el tope de vivos de la plantilla por proyecto', async () => {
  for (let i = 0; i < 10; i++) expect(await code(create({ params: { message: `m${i}` } }))).toBe('ok')
  expect(await code(create({ params: { message: 'otro' } }))).toBe('quota_template')
})

it('la cancelación humana con alcance persiste la restricción y bloquea recrear por objetivo o plantilla', async () => {
  const { schedule } = await create()
  await admin.cancel(human, schedule.id, 1, { scope: 'target', reason: 'no lo quiero' })
  expect(stopped).toEqual([schedule.id])
  expect(await code(create())).toBe('schedule_constrained')
  const other = await create({ params: { message: 'otro texto' } })
  await admin.cancel(human, other.schedule.id, 1, { scope: 'template_project' })
  expect(await code(create({ params: { message: 'cuarto' } }))).toBe('schedule_constrained')
})

it('la cancelación del agente no deja restricción y marca omitidas las ocurrencias vivas', async () => {
  const { schedule } = await create()
  const run = (await admin.runNow(agent(), schedule.id, 'run-1')).run_id
  await admin.cancel(agent(), schedule.id, 1)
  expect((await store.run(run))!).toMatchObject({ state: 'skipped', skip_reason: 'schedule_cancelled' })
  expect(await code(create())).toBe('ok')
})

it('pausa y reanuda; la pausa de una persona solo la levanta una persona', async () => {
  const { schedule } = await create()
  const paused = await admin.pause(human, schedule.id, 1)
  expect(paused.schedule).toMatchObject({ state: 'paused', paused_by: 'human', next_run_at: null, revision: 2 })
  expect(await code(admin.resume(agent(), schedule.id, 2))).toBe('paused_by_human')
  const resumed = await admin.resume(human, schedule.id, 2)
  expect(resumed.schedule).toMatchObject({ state: 'active', paused_by: null, next_run_at: '2026-10-29T11:00:00.000Z' })
})

it('actualiza con revisión esperada, recalcula la próxima ejecución y revalida la identidad al cambiar los parámetros', async () => {
  const { schedule } = await create()
  const updated = await admin.update(agent(), schedule.id, 1, { recurrence: { type: 'daily', time: '09:30' }, title: 'Nuevo' })
  expect(updated.schedule).toMatchObject({ title: 'Nuevo', revision: 2, next_run_at: '2026-10-28T12:30:00.000Z' })
  expect(await code(admin.update(agent(), schedule.id, 1, { title: 'viejo' }))).toBe('stale_revision')
  const other = await create({ params: { message: 'segundo' } })
  expect(await code(admin.update(agent(), other.schedule.id, 1, { params: { message: 'Revisar PRs' } }))).toBe('duplicate_target')
})

it('run_now crea una sola ocurrencia, es idempotente y rechaza si hay una en curso', async () => {
  const { schedule } = await create()
  const first = await admin.runNow(agent(), schedule.id, 'rn-1')
  expect((await admin.runNow(agent(), schedule.id, 'rn-1')).run_id).toBe(first.run_id)
  expect(await code(admin.runNow(agent(), schedule.id, 'rn-2'))).toBe('run_in_progress')
  expect((await store.run(first.run_id))).toMatchObject({ trigger: 'run_now', state: 'pending' })
})

it('lista con disponibilidad de entrega, lee el detalle y no expone efectos privados', async () => {
  const { schedule } = await create()
  const listing = await admin.list(agent(), { limit: 10, offset: 0 })
  expect(listing).toMatchObject({ total: 1, delivery_available: { gmail_self: { available: false } } })
  const detail = await admin.get(schedule.id, 5)
  expect(detail.schedule.id).toBe(schedule.id)
  expect(JSON.stringify(detail)).not.toContain('effects')
})

it('dos run_now simultáneos con distinto request_id crean una sola ocurrencia viva', async () => {
  const { schedule } = await create()
  const results = await Promise.all([admin.runNow(agent(), schedule.id, 'a'), admin.runNow(agent(), schedule.id, 'b')].map(promise => promise.then(() => 'ok', error => (error as { code?: string }).code)))
  expect(results.sort()).toEqual(['ok', 'run_in_progress'])
})

it('un campo que la persona cambió desde la app queda protegido frente a los agentes, que conservan el resto', async () => {
  const { schedule } = await create()
  const changed = await admin.update(human, schedule.id, 1, { recurrence: { type: 'daily', time: '10:00' } })
  expect(changed.schedule).toMatchObject({ revision: 2, human_override: ['recurrence'] })
  expect(await code(admin.update(agent(), schedule.id, 2, { recurrence: { type: 'daily', time: '07:00' } }))).toBe('human_override')
  expect((await store.schedule(schedule.id))!.recurrence).toEqual({ type: 'daily', time: '10:00' })
  const ok = await admin.update(agent(), schedule.id, 2, { title: 'Otro título', delivery: ['hub_inbox'] })
  expect(ok.schedule).toMatchObject({ title: 'Otro título', delivery: ['hub_inbox'], human_override: ['recurrence'] })
  const both = await admin.update(human, schedule.id, 3, { delivery: ['hub_inbox', 'app_window'] })
  expect(both.schedule.human_override).toEqual(['recurrence', 'delivery'])
  expect(await code(admin.update(agent(), schedule.id, 4, { delivery: ['hub_inbox'] }))).toBe('human_override')
  expect(await code(admin.cancel(agent(), schedule.id, 4))).toBe('ok')
})

const finishedRun = async (scheduleId: string, state: 'succeeded' | 'failed' = 'succeeded') => {
  const schedule = (await store.schedule(scheduleId))!
  return (await store.insertRun({ schedule_id: scheduleId, scheduled_for: new Date().toISOString(), schedule_revision: 1, definition: snapshotOf(schedule), trigger: 'clock', state }))!
}

it('la lista de runs trae las entregas y el resumen de la decisión de cada run sin consultar run por run', async () => {
  const { schedule } = await create()
  const withItems = await finishedRun(schedule.id)
  await store.insertArtifact({ id: randomUUID(), run_id: withItems, kind: 'close', title: 'Cierre', body_md: 'b', items: [{ ordinal: 1, kind: 'jira_worklog', project_id: projectId, summary: 'a' }], snapshot_refs: [], effects: [] })
  await db.query("INSERT INTO schedule_run_phases(run_id,phase,generation,state,receipt) VALUES($1,'persist',1,'done','{\"expires_at\":\"2026-10-30T20:00:00.000Z\"}')", [withItems])
  for (const [ordinal, state] of [[1, 'approved'], [2, 'proposed'], [3, 'rejected']] as const) await store.set({ run_id: withItems, ordinal, kind: 'jira_worklog', state })
  const delivery = await store.ensureDelivery(withItems, 'hub_inbox'); await store.setDelivery(delivery.id, { state: 'sent' })
  const empty = await finishedRun((await create({ params: { message: 'otro' } })).schedule.id)
  const list = await admin.runList({ limit: 10, offset: 0 })
  const byId = Object.fromEntries(list.items.map(row => [String(row.id), row]))
  expect(byId[withItems]).toMatchObject({ deliveries: [{ target: 'hub_inbox', state: 'sent' }], decision: { state: 'dispatching', expires_at: '2026-10-30T20:00:00.000Z', approved: 1, total: 3 } })
  expect(byId[empty]).toMatchObject({ deliveries: [], decision: { state: 'none', expires_at: null, approved: 0, total: 0 } })
})

it('el resumen de la decisión prioriza incierto, luego en despacho, pendiente, vencido y hecho', async () => {
  const { schedule } = await create()
  const cases: Array<[string[], string]> = [[['uncertain', 'proposed'], 'uncertain'], [['dispatching', 'proposed'], 'dispatching'], [['proposed', 'rejected'], 'pending'], [['expired', 'superseded'], 'expired'], [['succeeded', 'expired'], 'done']]
  const runs: string[] = []
  for (const [states] of cases) {
    const run = await finishedRun(schedule.id); runs.push(run)
    await db.query("UPDATE schedule_runs SET scheduled_for=$2 WHERE id=$1", [run, new Date(Date.now() - runs.length * 3_600_000).toISOString()])
    for (const [i, state] of states.entries()) await store.set({ run_id: run, ordinal: i + 1, kind: 'info', state: state as never })
  }
  const summaries = await store.decisionSummaries(runs)
  expect(runs.map(run => summaries.get(run)!.state)).toEqual(cases.map(([, expected]) => expected))
})

it('el detalle del run trae el proyecto y las partes de la estimación dentro de cada ítem', async () => {
  const { schedule } = await create()
  const run = await finishedRun(schedule.id), estimateId = randomUUID()
  await db.query(`INSERT INTO hour_estimates(id,project_id,estimated_seconds,basis,confidence,assumptions,state,method,model) VALUES($1,$2,7200,'tareas hermanas','medium','["sin bloqueos"]','proposed','model_judgment','m')`, [estimateId, projectId])
  await store.insertArtifact({ id: randomUUID(), run_id: run, kind: 'close', title: 'Cierre', body_md: 'b', snapshot_refs: [], effects: [],
    items: [{ ordinal: 1, kind: 'jira_worklog', project_id: projectId, summary: 'Cargar 2h', estimate_id: estimateId }, { ordinal: 2, kind: 'info', project_id: projectId, summary: 'nota' }] })
  const detail = await admin.runDetail(run)
  expect(detail.project_id).toBe(projectId)
  expect((detail.artifact!.items as any[])[0].estimate).toMatchObject({ estimated_seconds: 7200, basis: 'tareas hermanas', confidence: 'medium', assumptions: ['sin bloqueos'], label: 'estimación' })
  expect((detail.artifact!.items as any[])[1].estimate).toBeUndefined()
  expect(JSON.stringify(detail)).not.toContain('effects')
})
