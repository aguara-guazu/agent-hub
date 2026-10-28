import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryOperations, memoryTools } from '../src/operations.js'
import { MemoryAI } from '../src/ai.js'
import { Vault, defaultAI } from '../src/config.js'
import { ScheduleAdmin } from '../src/schedule-admin.js'
import { ScheduleStore, snapshotOf } from '../src/schedule-store.js'
import { isCollaborationTool } from '../src/collaboration.js'

let dir: string, db: MemoryDatabase, operations: MemoryOperations, store: ScheduleStore, projectId: string, stopped: string[]
const agent = { agent_id: 'agent-1', cli_kind: 'claude_code', client: 'test', session_id: 'native:agent-1', cwd: null }
const rejects = (promise: Promise<unknown>) => promise.then(() => 'ok', error => (error as { statusCode?: number; code?: string }).code ?? (error as { statusCode?: number }).statusCode)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-schedule-tools-'))
  db = new MemoryDatabase(join(dir, 'memory.sqlite')); await db.migrate()
  operations = new MemoryOperations(new MemoryStore(db, dir), new MemoryAI(async () => defaultAI, new Vault(dir)))
  projectId = (await operations.call('create_entity', { kind: 'project', title: 'Proyecto' })).id
  store = new ScheduleStore(db); stopped = []
  operations.schedules = new ScheduleAdmin({ store, db, automationsEnabled: () => true, stopRun: async id => { stopped.push(id) },
    deliveryAvailability: async () => ({ gmail_self: { available: false }, slack_self: { available: false } }) })
})
afterEach(async () => { await db.close(); await rm(dir, { recursive: true, force: true }) })

it('expone las nueve herramientas memory_schedule_* sin tratarlas como herramientas de colaboración', () => {
  const names = memoryTools.map(tool => tool.name).filter(name => name.startsWith('schedule_')).sort()
  expect(names).toEqual(['schedule_create', 'schedule_delete', 'schedule_get', 'schedule_list', 'schedule_pause', 'schedule_resume', 'schedule_run_now', 'schedule_runs', 'schedule_update'])
  expect(names.some(isCollaborationTool)).toBe(false)
})

it('crea, lista y lee por la operación del agente y rechaza al llamador sin identidad de agente', async () => {
  const created = await operations.call('schedule_create', { project_id: projectId, template: 'reminder', title: 'Revisar', params: { message: 'PRs' }, recurrence: { type: 'daily', time: '08:00' }, request_id: 'r1' }, 'mcp', agent)
  expect(created.schedule).toMatchObject({ template: 'reminder', state: 'active', delivery: ['hub_inbox', 'app_window'] })
  expect(created.announce).toContain('Revisar')
  expect((await operations.call('schedule_list', { created_by_me: true }, 'mcp', agent)).total).toBe(1)
  expect((await operations.call('schedule_get', { schedule_id: created.schedule.id }, 'mcp', agent)).schedule.id).toBe(created.schedule.id)
  expect(await rejects(operations.call('schedule_list', {}, 'mcp'))).toBe(403)
})

it('un parámetro desconocido se rechaza y team_health no se puede crear por herramienta', async () => {
  expect(await rejects(operations.call('schedule_create', { project_id: projectId, template: 'reminder', title: 'x', params: { message: 'a' }, recurrence: { type: 'daily', time: '08:00' }, request_id: 'r', extra: 1 }, 'mcp', agent))).toBeTruthy()
  expect(await rejects(operations.call('schedule_create', { project_id: projectId, template: 'team_health', title: 'x', recurrence: { type: 'daily', time: '08:00' }, request_id: 'r' }, 'mcp', agent))).toBeTruthy()
})

it('eliminar un proyecto cancela sus schedules antes de la cascada', async () => {
  const created = await operations.call('schedule_create', { project_id: projectId, template: 'reminder', title: 'Revisar', params: { message: 'PRs' }, recurrence: { type: 'daily', time: '08:00' }, request_id: 'r1' }, 'mcp', agent)
  await operations.call('delete_entity', { id: projectId })
  expect(stopped).toEqual([created.schedule.id])
  expect(await store.schedule(created.schedule.id)).toBeUndefined()
})

it('un ítem incierto o en despacho bloquea el borrado del proyecto', async () => {
  const created = await operations.call('schedule_create', { project_id: projectId, template: 'reminder', title: 'Revisar', params: { message: 'PRs' }, recurrence: { type: 'daily', time: '08:00' }, request_id: 'r1' }, 'mcp', agent)
  const schedule = (await store.schedule(created.schedule.id))!
  const runId = (await store.insertRun({ schedule_id: schedule.id, scheduled_for: '2026-10-28T08:00:00.000Z', schedule_revision: 1, definition: snapshotOf(schedule), trigger: 'clock', state: 'succeeded' }))!
  await store.set({ run_id: runId, ordinal: 1, kind: 'jira_worklog', state: 'uncertain' })
  expect(await rejects(operations.call('delete_entity', { id: projectId }))).toBe('project_has_inflight_actions')
  expect((await store.schedule(schedule.id))!.state).toBe('active')
})

it('memory_context informa los incidentes de procesos interrumpidos y las entregas sin leer del proyecto', async () => {
  await db.query("UPDATE entities SET data=json_set(data,'$.folders',json('[\"/tmp/proyecto-x\"]')) WHERE id=$1", [projectId])
  await store.addIncident({ subject_kind: 'schedule_run', subject_id: 'run-1', generation: 1, project_id: projectId, cause: 'hub_restart', action: 'terminated' })
  const context = await operations.call('context', { path: '/tmp/proyecto-x' }, 'mcp', agent)
  expect(context.scheduler.interrupted_processes).toMatchObject([{ cause: 'hub_restart', action: 'terminated' }])
})
