import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryOperations } from '../src/operations.js'
import { MemoryAI } from '../src/ai.js'
import { Vault, defaultAI } from '../src/config.js'
import { ScheduleStore, snapshotOf, targetKey, type NewSchedule } from '../src/schedule-store.js'
import { ScheduleRuntime, type ProcessControl, type Synthesizer } from '../src/schedule-runtime.js'
import { registerScheduleTemplate } from '../src/schedule-templates.js'
import type { ScheduleTemplateDefinition } from '../src/schedule-contract.js'

let dir: string, db: MemoryDatabase, memory: MemoryStore, store: ScheduleStore, projectId: string, now: Date, enabled: boolean, runtime: ScheduleRuntime
let synth: ReturnType<typeof vi.fn>, engine: { cli: string | null; model: string } | null, usage: { status: string; pools: any[] }, zone: string, processes: ProcessControl
let prepared: any[]
const at = (value: string) => new Date(value)

const build = (extra: Partial<ConstructorParameters<typeof ScheduleRuntime>[0]> = {}) => new ScheduleRuntime({ store, db, memory, automation: { enabled: () => enabled, effects: { deliveries: undefined as never, actions: undefined as never,
  decisions: { prepareDecision: async input => { prepared.push(input); return { decision_request_ref: 'ref-1' } } } } }, usage: { forCli: async () => usage as any },
synthesizer: { engine: async () => engine, run: (input: any) => synth(input) } as Synthesizer, now: () => now, zone: () => zone, tickMs: 3_600_000, processes, ...extra })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-schedule-runtime-'))
  db = new MemoryDatabase(join(dir, 'memory.sqlite')); await db.migrate()
  memory = new MemoryStore(db, dir)
  projectId = (await new MemoryOperations(memory, new MemoryAI(async () => defaultAI, new Vault(dir))).call('create_entity', { kind: 'project', title: 'Proyecto' })).id
  store = new ScheduleStore(db); now = at('2026-10-28T08:00:30.000Z'); enabled = true; zone = 'UTC'; prepared = []
  engine = { cli: 'claude_code', model: 'modelo-x' }; usage = { status: 'available', pools: [] }
  synth = vi.fn(async () => ({ value: { summary: 'Todo en orden' }, usage: { model: 'modelo-x', input_tokens: 10, output_tokens: 5 } }))
  processes = { inspect: async () => null, signal: () => undefined }
  runtime = build()
})
afterEach(async () => { await runtime.close(); await db.close(); await rm(dir, { recursive: true, force: true }) })

const schedule = (overrides: Partial<NewSchedule> = {}) => store.insertSchedule({ id: randomUUID(), scope: 'project', project_id: projectId, template: 'reminder', template_version: 1, kind: 'notice', title: 'Aviso', instructions: '',
  params: { message: 'hola' }, recurrence: { type: 'daily', time: '08:00' }, delivery: ['hub_inbox', 'app_window'], misfire: 'run_once', grace_minutes: 120, grace_policy: 'minutes', grace_until: null,
  target_key: targetKey(randomUUID()), next_run_at: '2026-10-28T08:00:00.000Z', expires_at: null, created_by_kind: 'agent', created_by_agent: 'a', created_by_session: 'native:a', origin: {}, ...overrides })
const run = async () => { await runtime.start(); await runtime.idle(); await runtime.tick(); await runtime.idle() }
const runsOf = async (id: string) => (await store.listRuns({ schedule_id: id, limit: 50, offset: 0 })).items

it('dispara la ocurrencia vencida una sola vez, la entrega a la bandeja y a la app y avanza el reloj', async () => {
  const s = await schedule()
  await run(); await runtime.tick(); await runtime.idle()
  const runs = await runsOf(s.id)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ state: 'succeeded', trigger: 'clock', artifact_kind: 'notice', title: 'Aviso' })
  expect((await store.artifactOfRun(String(runs[0]!.id)))!.body_md).toBe('hola')
  expect((await store.deliveriesOf(String(runs[0]!.id))).map(d => [d.target, d.state]).sort()).toEqual([['app_window', 'sent'], ['hub_inbox', 'sent']])
  expect((await store.schedule(s.id))!.next_run_at).toBe('2026-10-29T08:00:00.000Z')
})

it('una ocurrencia perdida dentro de la gracia corre una vez como misfire y fuera de la gracia queda omitida', async () => {
  const inside = await schedule(); now = at('2026-10-28T09:30:00.000Z')
  await run()
  expect(await runsOf(inside.id)).toMatchObject([{ state: 'succeeded', trigger: 'misfire' }])
  const outside = await schedule({ target_key: targetKey('b') }); now = at('2026-10-28T12:00:00.000Z')
  await runtime.tick(); await runtime.idle()
  expect(await runsOf(outside.id)).toMatchObject([{ state: 'skipped', skip_reason: 'misfire_out_of_grace' }])
})

it('tras una ausencia larga coalesce en la última ocurrencia sin recorrer el hueco', async () => {
  const s = await schedule({ next_run_at: '2026-10-20T08:00:00.000Z', grace_policy: 'until_next' }); now = at('2026-10-28T09:00:00.000Z')
  await run()
  const runs = await runsOf(s.id)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ scheduled_for: '2026-10-28T08:00:00.000Z', trigger: 'misfire' })
})

it('el brief perdido queda superseded si la siguiente ocurrencia está a menos de 120 minutos', async () => {
  const s = await schedule({ grace_policy: 'until_next', next_run_at: '2026-10-28T08:00:00.000Z' }); now = at('2026-10-29T06:30:00.000Z')
  await run()
  expect(await runsOf(s.id)).toMatchObject([{ state: 'skipped', skip_reason: 'superseded' }])
})

it('una ocurrencia nueva con otra viva queda omitida por overlap', async () => {
  const s = await schedule()
  await store.insertRun({ schedule_id: s.id, scheduled_for: '2026-10-27T08:00:00.000Z', schedule_revision: 1, definition: snapshotOf(s), trigger: 'clock', state: 'running' })
  await runtime.start(); await runtime.idle()
  expect((await runsOf(s.id)).map(r => [r.scheduled_for, r.state, r.skip_reason])).toContainEqual(['2026-10-28T08:00:00.000Z', 'skipped', 'overlap'])
})

it('una ejecución única completa el schedule solo cuando su ocurrencia termina', async () => {
  const s = await schedule({ recurrence: { type: 'once', at: '2026-10-28T08:00:00.000Z' } })
  await run()
  expect((await store.schedule(s.id))).toMatchObject({ state: 'completed', next_run_at: null })
})

it('la síntesis recibe solo las secciones visibles para el modelo y su resultado llega al artefacto', async () => {
  const template: ScheduleTemplateDefinition<unknown> = { id: 'project_status', version: 1, kind: 'synthesis', scope: 'project', params: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never, identity: () => ({}),
    min_interval_minutes: 60, max_live_per_project: 1, max_runtime_ms: 60_000, allowed_targets: ['hub_inbox'], misfire: 'run_once', grace_minutes: 60, grace_policy: 'minutes', admission_note: '',
    collect: async () => ({ project_ids: [projectId], remote_allowed: true, char_count: 10, sections: [{ id: 'visible', title: 'V', data: { a: 1 }, sources: [], model_visible: true }, { id: 'hidden', title: 'H', data: { secret: 'x' }, sources: [], model_visible: false }] }),
    synthesize: { system: 'resumí', output: { type: 'object' }, max_input_chars: 10_000 }, render: (ctx, _pkg, synthesis, meta) => ({ kind: 'status', title: ctx.title, body_md: `${(synthesis as { summary: string }).summary}|${meta?.model}`, items: [], snapshot_refs: [] }) }
  registerScheduleTemplate(template)
  const s = await schedule({ template: 'project_status', kind: 'synthesis', params: {}, delivery: ['hub_inbox'] })
  await run()
  const input = synth.mock.calls[0]![0]
  expect(JSON.stringify(input.content)).toContain('visible'); expect(JSON.stringify(input.content)).not.toContain('secret')
  const [r] = await runsOf(s.id)
  expect((await store.artifactOfRun(String(r!.id)))!.body_md).toBe('Todo en orden|modelo-x')
  const attempts = await store.attemptsOf(String(r!.id))
  expect(attempts).toMatchObject([{ profile: 'synthesis', cli: 'claude_code', state: 'exited' }])
})

const synthesisSchedule = (overrides: Partial<NewSchedule> = {}) => schedule({ template: 'custom_synthesis', kind: 'synthesis', params: { topic: 'estado' }, delivery: ['hub_inbox'], ...overrides })

it('una cuota agotada difiere el run hasta el reinicio de la ventana sin lanzar el modelo y despierta si se libera antes', async () => {
  usage = { status: 'exhausted', pools: [{ pool_id: 'p', binding_ids: ['b'], status: 'exhausted', observation: { windows: [{ id: '5h', resets_at: '2026-10-28T13:00:00.000Z' }], source: { adapter: 'native' } } }] }
  const s = await synthesisSchedule()
  await run()
  const [r] = await runsOf(s.id)
  expect(r).toMatchObject({ state: 'deferred', deferred_reason: 'quota', next_attempt_at: '2026-10-28T13:00:00.000Z' })
  expect(synth).not.toHaveBeenCalled(); expect(await store.attemptsOf(String(r!.id))).toHaveLength(0)
  usage = { status: 'available', pools: [] }
  await runtime.tick(); await runtime.idle()
  expect((await runsOf(s.id))[0]).toMatchObject({ state: 'succeeded' })
  expect(synth).toHaveBeenCalledTimes(1)
})

it('un límite informado por la CLI difiere con espera creciente y no consume intentos', async () => {
  synth.mockRejectedValue(Object.assign(new Error('limite'), { code: 'quota_exhausted' }))
  const s = await synthesisSchedule()
  await run()
  expect((await runsOf(s.id))[0]).toMatchObject({ state: 'deferred', next_attempt_at: '2026-10-28T08:30:30.000Z' })
  now = at('2026-10-28T08:31:00.000Z'); await runtime.tick(); await runtime.idle()
  expect((await runsOf(s.id))[0]).toMatchObject({ state: 'deferred', next_attempt_at: '2026-10-28T09:31:00.000Z' })
})

it('el proyecto sin procesamiento remoto produce el artefacto determinista sin llamar al modelo', async () => {
  await db.query("UPDATE entities SET data=json_set(data,'$.remote_processing',json('false')) WHERE id=$1", [projectId])
  const s = await synthesisSchedule()
  await run()
  const [r] = await runsOf(s.id)
  expect(synth).not.toHaveBeenCalled()
  expect(r).toMatchObject({ state: 'succeeded' })
  expect((await store.phasesOf(String(r!.id))).find(p => p.phase === 'synthesize')).toMatchObject({ state: 'skipped' })
})

it('un fallo de síntesis se reintenta con otra generación y al segundo falla con código cerrado', async () => {
  synth.mockRejectedValue(new Error('boom'))
  const s = await synthesisSchedule()
  await run(); await runtime.tick(); await runtime.idle()
  const [r] = await runsOf(s.id)
  expect(r).toMatchObject({ state: 'failed', error_code: 'synthesis_failed' })
  expect(synth).toHaveBeenCalledTimes(2)
})

it('apagar las automatizaciones omite lo pendiente y aborta lo que corre, con incidente', async () => {
  let release!: () => void
  synth.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason)); release = () => undefined }))
  const running = await synthesisSchedule()
  await runtime.start()
  for (let i = 0; i < 50 && !synth.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 20))
  const pending = await schedule({ target_key: targetKey('p') })
  enabled = false
  await runtime.tick(); await runtime.idle(); release()
  expect((await runsOf(running.id))[0]).toMatchObject({ state: 'skipped', skip_reason: 'automations_off' })
  expect((await store.incidents({ schedule_id: running.id })).map(i => i.cause)).toContain('automations_off')
  expect(await runsOf(pending.id)).toEqual([])
})

it('al apagar el interruptor revoca las solicitudes de decisión antes de cancelar y registra la cantidad', async () => {
  const calls: string[] = []
  runtime = build({ automation: { enabled: () => enabled, effects: { deliveries: undefined as never, actions: undefined as never, decisions: { prepareDecision: async () => ({ decision_request_ref: 'r' }), revokeAll: async () => { calls.push('revoke'); return 3 } } } } })
  const s = await schedule(); enabled = false
  await runtime.start(); await runtime.idle(); await runtime.tick(); await runtime.idle()
  expect(calls).toEqual(['revoke'])
  expect((await store.eventsAfter(0)).find(event => event.type === 'decisions.revoked')?.payload).toMatchObject({ count: 3, cause: 'automations_off' })
  expect(await runsOf(s.id)).toEqual([])
})

it('un periódico que no termina no impide lanzar un run vencido ni se solapa consigo mismo', async () => {
  let started = 0, release!: () => void
  runtime.addPeriodic('colgada', () => new Promise<void>(resolve => { started++; release = resolve }), 0)
  const s = await schedule()
  await runtime.start()
  for (let i = 0; i < 100 && !(await runsOf(s.id)).some(r => r.state === 'succeeded'); i++) await new Promise(resolve => setTimeout(resolve, 20))
  expect((await runsOf(s.id))[0]).toMatchObject({ state: 'succeeded' })
  await runtime.tick()
  expect(started).toBe(1)
  release(); await new Promise(resolve => setTimeout(resolve, 10))
  await runtime.tick()
  expect(started).toBe(2); release()
})

it('el cierre no espera sin tope a un periódico colgado', async () => {
  runtime = build({ closeWaitMs: 50 })
  runtime.addPeriodic('colgada', () => new Promise<void>(() => undefined), 0)
  await runtime.start()
  const started = Date.now()
  await runtime.close()
  expect(Date.now() - started).toBeLessThan(2_000)
})

it('una tarea periódica corre una vez por ventana y su fallo no detiene el reloj', async () => {
  let calls = 0
  runtime.addPeriodic('lenta', async () => { calls++; throw new Error('falla') }, 60_000)
  await run(); await runtime.tick()
  expect(calls).toBe(1)
  now = at('2026-10-28T08:01:30.000Z'); await runtime.tick(); await runtime.idle()
  expect(calls).toBe(2)
})

it('tras un reinicio termina el proceso propio, registra el incidente y deja el run para reintentar', async () => {
  const s = await schedule({ template: 'custom_synthesis', kind: 'synthesis', params: { topic: 'estado' } })
  const runId = (await store.insertRun({ schedule_id: s.id, scheduled_for: '2026-10-28T08:00:00.000Z', schedule_revision: 1, definition: snapshotOf(s), trigger: 'clock', state: 'running' }))!
  await store.claimRun(runId, 0).catch(() => undefined); await db.query("UPDATE schedule_runs SET state='running',generation=1 WHERE id=$1", [runId])
  await store.startAttempt({ run_id: runId, generation: 1, phase: 'synthesize', profile: 'synthesis', boot_id: 'anterior', deadline_at: '2026-10-28T08:05:00.000Z' })
  await store.setAttempt(runId, 1, { state: 'running', host_pid: 100, host_started: 'H', cli_pid: 101, cli_started: 'C' })
  const alive = new Set([100, 101]), signals: string[] = []
  processes = { inspect: async pid => alive.has(pid) ? { started: pid === 100 ? 'H' : 'C' } : null, signal: (pid, signal, group) => { signals.push(`${pid}:${signal}:${group}`); alive.delete(pid) } }
  runtime = build({ processes }); await runtime.reconcileOrphans()
  expect(signals).toContain('101:SIGTERM:true')
  expect((await store.attemptsOf(runId))[0]).toMatchObject({ state: 'orphan_terminated' })
  expect((await store.incidents({ run_id: runId }))[0]).toMatchObject({ cause: 'hub_restart', action: 'terminated' })
  expect((await store.run(runId))!.state).toBe('interrupted')
})

const fleetMember = async (id: string, ordinal: number, runtime: object | null) => {
  await db.query(`INSERT INTO chat_team_members(id,team_id,ordinal,worktree_name,cli,model,role,task,prompt,state,runtime) VALUES($1,'plan',$2,$1,'claude_code','m','r','t','p','launched',$3)`, [id, ordinal, runtime ? JSON.stringify(runtime) : null])
}
const fleetPlan = async () => {
  await db.execute('PRAGMA foreign_keys=OFF')
  await db.query(`INSERT INTO chat_team_plans(id,master_channel_id,root_thread_id,created_by,objective,parent,base_revision,plan,digest,state) VALUES('plan','c','t','s','o','{}','r','{}','d','launched')`)
}

it('al arrancar concilia cada miembro de flota con su identidad persistida: termina el proceso propio, registra la salida y no repite', async () => {
  await fleetPlan()
  await fleetMember('vivo', 1, { state: 'busy', generation: 'g1', pid: 500, process_started: 'INICIO' })
  await fleetMember('muerto', 2, { state: 'failed', generation: 'g1', pid: 501, process_started: 'INICIO' })
  await fleetMember('reusado', 3, { state: 'idle', generation: 'g1', pid: 502, process_started: 'INICIO' })
  await fleetMember('sin-identidad', 4, { state: 'busy', generation: 'g1' })
  await fleetMember('detenido', 5, { state: 'stopped', generation: 'g1', pid: 503, process_started: 'INICIO' })
  const alive = new Map<number, string>([[500, 'INICIO'], [502, 'OTRO']]), signals: string[] = []
  processes = { inspect: async pid => alive.has(pid) ? { started: alive.get(pid)! } : null, signal: (pid, signal, group) => { signals.push(`${pid}:${signal}:${group}`); alive.delete(pid) } }
  runtime = build({ processes }); await runtime.reconcileOrphans()
  const byMember = Object.fromEntries((await db.query('SELECT subject_id,generation,cause,action FROM process_incidents ORDER BY subject_id')).map(row => [row.subject_id, row]))
  expect(byMember.vivo).toMatchObject({ generation: 'g1', cause: 'hub_restart', action: 'terminated' })
  expect(byMember.muerto).toMatchObject({ action: 'already_exited' })
  expect(byMember.reusado).toMatchObject({ action: 'unverified_left_running' })
  expect(byMember['sin-identidad']).toMatchObject({ action: 'none' })
  expect(byMember.detenido).toBeUndefined()
  expect(signals).toEqual(['500:SIGTERM:true'])
  alive.set(500, 'INICIO'); await runtime.reconcileOrphans()
  expect(signals).toEqual(['500:SIGTERM:true'])
  expect(await db.query("SELECT id FROM process_incidents WHERE subject_id='vivo'")).toHaveLength(1)
})

it('un inicio de proceso en otro formato no coincide: no se señala y queda sin verificar', async () => {
  await fleetPlan()
  await fleetMember('antiguo', 1, { state: 'busy', generation: 'g1', pid: 600, process_started: 'Wed Oct 28 18:00:00 2026' })
  processes = { inspect: async () => ({ started: 'mié 28 oct 18:00:00 2026' }), signal: () => { throw new Error('no debe señalar') } }
  runtime = build({ processes }); await runtime.reconcileOrphans()
  expect((await db.query("SELECT action FROM process_incidents"))).toEqual([{ action: 'unverified_left_running' }])
})

it('un proceso que no se puede verificar queda sin terminar y su run no se reemplaza', async () => {
  const s = await schedule()
  const runId = (await store.insertRun({ schedule_id: s.id, scheduled_for: '2026-10-28T08:00:00.000Z', schedule_revision: 1, definition: snapshotOf(s), trigger: 'clock', state: 'running' }))!
  await store.startAttempt({ run_id: runId, generation: 0, phase: 'synthesize', profile: 'synthesis', boot_id: 'anterior', deadline_at: '2026-10-28T08:05:00.000Z' })
  await store.setAttempt(runId, 0, { state: 'running', cli_pid: 7, cli_started: 'ORIGINAL' })
  processes = { inspect: async () => ({ started: 'OTRO' }), signal: () => { throw new Error('no debe señalar') } }
  runtime = build({ processes }); await runtime.reconcileOrphans()
  expect((await store.attemptsOf(runId))[0]).toMatchObject({ state: 'orphan_unverified' })
  expect((await store.incidents({ run_id: runId }))[0]).toMatchObject({ action: 'unverified_left_running' })
  expect((await store.run(runId))).toMatchObject({ state: 'failed', error_code: 'hub_restart' })
})

const closeTemplate = (): ScheduleTemplateDefinition<unknown> => ({ id: 'daily_close', version: 1, kind: 'notice', scope: 'owner', params: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never, identity: () => ({}),
  min_interval_minutes: 5, max_live_per_project: 1, max_runtime_ms: 10_000, allowed_targets: ['hub_inbox'], misfire: 'run_once', grace_minutes: 60, grace_policy: 'minutes', admission_note: '',
  collect: async () => ({ project_ids: [projectId], remote_allowed: true, char_count: 1, sections: [] }),
  render: ctx => ({ kind: 'close', title: ctx.title, body_md: 'cierre', items: [{ ordinal: 1, kind: 'jira_worklog', project_id: projectId, summary: 'Cargar 2h' }], snapshot_refs: [], proposed_effects: [{ ordinal: 1, effect: { kind: 'jira_worklog', seconds: 7200 } }] }) })

it('los efectos validados se persisten con el artefacto, se pasan una vez a la decisión y se limpian al guardar la referencia', async () => {
  registerScheduleTemplate(closeTemplate())
  const s = await schedule({ template: 'daily_close', scope: 'owner', project_id: null, delivery: ['hub_inbox'] })
  await run()
  const [r] = await runsOf(s.id)
  expect(prepared).toHaveLength(1)
  expect(prepared[0]).toMatchObject({ run_id: r!.id, items: [{ ordinal: 1, effect: { kind: 'jira_worklog', seconds: 7200 } }] })
  expect(await store.pendingEffects(String(r!.id))).toMatchObject({ effects: [], decision_request_ref: 'ref-1' })
  expect(r).toMatchObject({ state: 'succeeded' })
})

it('una negativa estable del módulo de decisiones termina el run sin reintentarlo ni entregarlo', async () => {
  registerScheduleTemplate(closeTemplate())
  let calls = 0
  runtime = build({ automation: { enabled: () => enabled, effects: { deliveries: undefined as never, actions: undefined as never, decisions: { prepareDecision: async () => { calls++; throw Object.assign(new Error('sin autoridad'), { name: 'DecisionAuthorityUnavailable' }) } } } } })
  const s = await schedule({ template: 'daily_close', scope: 'owner', project_id: null, delivery: ['hub_inbox'] })
  await run(); await runtime.tick(); await runtime.idle()
  const [r] = await runsOf(s.id)
  expect(r).toMatchObject({ state: 'failed', error_code: 'hub_restart' })
  expect(calls).toBe(1)
  expect(await store.deliveriesOf(String(r!.id))).toEqual([])
})

it('la clave de operación de cada ítem del artefacto llega a la solicitud de decisión', async () => {
  const template = closeTemplate()
  template.render = ctx => ({ kind: 'close', title: ctx.title, body_md: 'cierre', snapshot_refs: [],
    items: [{ ordinal: 1, kind: 'info', project_id: projectId, summary: 'nota' }, { ordinal: 2, kind: 'jira_worklog', project_id: projectId, summary: 'Cargar 2h', operation_key: 'jira_worklog:site:ABC-1:2026-10-28T08:00:00Z' }],
    proposed_effects: [{ ordinal: 2, effect: { kind: 'jira_worklog', seconds: 7200 } }] })
  registerScheduleTemplate(template)
  const s = await schedule({ template: 'daily_close', scope: 'owner', project_id: null, delivery: ['hub_inbox'] })
  await run()
  expect(prepared[0].items).toMatchObject([{ ordinal: 1, effect: undefined }, { ordinal: 2, operation_key: 'jira_worklog:site:ABC-1:2026-10-28T08:00:00Z', effect: { seconds: 7200 } }])
  expect((await runsOf(s.id))[0]).toMatchObject({ state: 'succeeded' })
})

it('un artefacto restaurado sin autoridad no crea una solicitud nueva ni se entrega', async () => {
  registerScheduleTemplate(closeTemplate())
  const s = await schedule({ template: 'daily_close', scope: 'owner', project_id: null, delivery: ['hub_inbox'] })
  const runId = (await store.insertRun({ schedule_id: s.id, scheduled_for: '2026-10-28T08:00:00.000Z', schedule_revision: 1, definition: snapshotOf(s), trigger: 'clock', state: 'running' }))!
  const artifactId = randomUUID()
  await store.insertArtifact({ id: artifactId, run_id: runId, kind: 'close', title: 't', body_md: 'b', items: [{ ordinal: 1, kind: 'jira_worklog', project_id: projectId, summary: 's' }], snapshot_refs: [], effects: [{ ordinal: 1, effect: {} }] })
  await db.query("UPDATE schedule_artifacts SET authority='unavailable'"); await db.query("UPDATE schedule_runs SET artifact_id=$2,phase='persist',generation=1 WHERE id=$1", [runId, artifactId])
  await runtime.start(); await runtime.idle(); await runtime.tick(); await runtime.idle()
  expect(prepared).toHaveLength(0)
  expect(await store.run(runId)).toMatchObject({ state: 'failed', error_code: 'hub_restart' })
  expect(await store.deliveriesOf(runId)).toEqual([])
})

it('un cambio de zona horaria del sistema recalcula la próxima ejecución diaria', async () => {
  const s = await schedule({ next_run_at: '2026-10-29T08:00:00.000Z' })
  await runtime.tick(); await runtime.idle()
  zone = 'America/Argentina/Buenos_Aires'; now = at('2026-10-28T09:00:00.000Z')
  await runtime.tick(); await runtime.idle()
  expect((await store.schedule(s.id))!.next_run_at).toBe('2026-10-28T11:00:00.000Z')
})
