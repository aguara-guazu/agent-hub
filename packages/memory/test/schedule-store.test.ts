import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryOperations } from '../src/operations.js'
import { MemoryAI } from '../src/ai.js'
import { Vault, defaultAI } from '../src/config.js'
import { ScheduleStore, targetKey, type NewSchedule } from '../src/schedule-store.js'

let dir: string, db: MemoryDatabase, store: ScheduleStore, projectId: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-schedule-store-'))
  db = new MemoryDatabase(join(dir, 'memory.sqlite')); await db.migrate()
  projectId = (await new MemoryOperations(new MemoryStore(db, dir), new MemoryAI(async () => defaultAI, new Vault(dir))).call('create_entity', { kind: 'project', title: 'Proyecto' })).id
  store = new ScheduleStore(db)
})
afterEach(async () => { await db.close(); await rm(dir, { recursive: true, force: true }) })

const definition = (id: string) => ({ template: 'reminder', template_version: 1, kind: 'notice', title: 't', instructions: '', params: {}, recurrence: { type: 'daily', time: '08:00' }, delivery: ['hub_inbox'],
  misfire: 'run_once', grace_minutes: 30, grace_policy: 'minutes', grace_until: null, expires_at: null, scope: 'project', project_id: projectId, schedule_id: id }) as any
const base = (overrides: Partial<NewSchedule> = {}): NewSchedule => ({ id: randomUUID(), scope: 'project', project_id: projectId, template: 'reminder', template_version: 1, kind: 'notice', title: 'Recordatorio', instructions: '',
  params: {}, recurrence: { type: 'daily', time: '08:00' }, delivery: ['hub_inbox'], misfire: 'run_once', grace_minutes: 30, grace_policy: 'minutes', grace_until: null, target_key: targetKey(randomUUID()),
  next_run_at: '2026-10-29T11:00:00.000Z', expires_at: null, created_by_kind: 'agent', created_by_agent: 'agent-1', created_by_session: 'native:x', origin: {}, ...overrides })

it('actualiza con control de revisión y devuelve undefined ante una revisión vieja', async () => {
  const created = await store.insertSchedule(base())
  const updated = await store.updateSchedule(created.id, 1, { title: 'Nuevo' })
  expect(updated).toMatchObject({ title: 'Nuevo', revision: 2 })
  expect(await store.updateSchedule(created.id, 1, { title: 'Viejo' })).toBeUndefined()
  expect((await store.schedule(created.id))!.title).toBe('Nuevo')
})

it('cuenta schedules vivos por agente, dueño y plantilla y ubica el objetivo vivo', async () => {
  const key = targetKey('a')
  await store.insertSchedule(base({ target_key: key }))
  await store.insertSchedule(base({ created_by_agent: 'agent-2', template: 'custom_synthesis' }))
  const gone = await store.insertSchedule(base()); await store.touchSchedule(gone.id, { state: 'cancelled' })
  expect(await store.liveCounts('agent-1', projectId, 'reminder')).toEqual({ agent: 1, owner: 2, project_template: 1 })
  expect((await store.liveByTarget(key))!.state).toBe('active')
  expect(await store.liveByTarget(targetKey('otro'))).toBeUndefined()
})

it('lista los schedules due y los vencidos', async () => {
  await store.insertSchedule(base({ next_run_at: '2026-10-29T11:00:00.000Z' }))
  await store.insertSchedule(base({ next_run_at: '2026-10-31T11:00:00.000Z', expires_at: '2026-10-30T00:00:00.000Z' }))
  expect((await store.dueSchedules('2026-10-29T12:00:00.000Z')).length).toBe(1)
  expect((await store.expiredSchedules('2026-10-30T12:00:00.000Z')).length).toBe(1)
})

it('la restricción humana por objetivo o por plantilla bloquea y se levanta', async () => {
  const key = targetKey('x')
  await store.addConstraint({ subject: 'project', project_id: projectId, template: 'reminder', scope: 'target', target_key: key, schedule_id: null, user: 'owner' })
  expect(await store.constraintFor(projectId, 'reminder', key)).toBeTruthy()
  expect(await store.constraintFor(projectId, 'reminder', targetKey('otro'))).toBeUndefined()
  const id = await store.addConstraint({ subject: 'project', project_id: projectId, template: 'reminder', scope: 'template_project', target_key: null, schedule_id: null, user: 'owner' })
  expect(await store.constraintFor(projectId, 'reminder', targetKey('otro'))).toBeTruthy()
  expect((await store.liftConstraint(id, 'owner'))!.id).toBe(id)
  expect(await store.liftConstraint(id, 'owner')).toBeUndefined()
  expect(await store.constraintFor(projectId, 'reminder', targetKey('otro'))).toBeUndefined()
})

it('los eventos son idempotentes por actor y request_id y el feed avanza por seq', async () => {
  const first = await store.addEvent({ type: 'schedule.created', actor_kind: 'agent', actor_ref: 'a', request_id: 'r1' })
  const replay = await store.addEvent({ type: 'schedule.created', actor_kind: 'agent', actor_ref: 'a', request_id: 'r1' })
  expect(replay).toMatchObject({ seq: first.seq, id: first.id, replayed: true })
  const second = await store.addEvent({ type: 'schedule.updated', actor_kind: 'human' })
  expect((await store.eventsAfter(first.seq)).map(e => e.seq)).toEqual([second.seq])
  expect(await store.maxSeq()).toBe(second.seq)
})

it('la ocurrencia es única, el reclamo avanza la generación y una generación vieja no mueve el run', async () => {
  const schedule = await store.insertSchedule(base()), when = '2026-10-29T11:00:00.000Z'
  const runId = (await store.insertRun({ schedule_id: schedule.id, scheduled_for: when, schedule_revision: 1, definition: definition(schedule.id), trigger: 'clock' }))!
  expect(await store.insertRun({ schedule_id: schedule.id, scheduled_for: when, schedule_revision: 1, definition: definition(schedule.id), trigger: 'clock' })).toBeNull()
  const claimed = await store.claimRun(runId, 0)
  expect(claimed).toMatchObject({ state: 'running', generation: 1 })
  expect(await store.claimRun(runId, 0)).toBeUndefined()
  expect(await store.setRun(runId, 0, { phase: 'persist' })).toBe(false)
  expect(await store.setRun(runId, 1, { phase: 'persist' })).toBe(true)
  expect((await store.run(runId))!.phase).toBe('persist')
  expect((await store.liveRunOf(schedule.id))!.id).toBe(runId)
})

it('el recibo done de una generación anterior sigue siendo el vigente', async () => {
  const schedule = await store.insertSchedule(base()), runId = (await store.insertRun({ schedule_id: schedule.id, scheduled_for: '2026-10-29T11:00:00.000Z', schedule_revision: 1, definition: definition(schedule.id), trigger: 'clock' }))!
  await store.recordPhase({ run_id: runId, phase: 'collect', generation: 1, state: 'done', receipt: { digest: 'a' } })
  await store.recordPhase({ run_id: runId, phase: 'collect', generation: 2, state: 'started' })
  expect(await store.currentPhase(runId, 'collect')).toMatchObject({ generation: 1, state: 'done', receipt: { digest: 'a' } })
})

it('solo los runs diferidos cuya hora llegó son ejecutables y la cancelación los marca omitidos', async () => {
  const schedule = await store.insertSchedule(base())
  const pending = (await store.insertRun({ schedule_id: schedule.id, scheduled_for: '2026-10-29T11:00:00.000Z', schedule_revision: 1, definition: definition(schedule.id), trigger: 'clock' }))!
  const deferred = (await store.insertRun({ schedule_id: schedule.id, scheduled_for: '2026-10-30T11:00:00.000Z', schedule_revision: 1, definition: definition(schedule.id), trigger: 'clock' }))!
  await store.claimRun(deferred, 0)
  await store.setRun(deferred, 1, { state: 'deferred', deferred_reason: 'quota', next_attempt_at: '2026-10-30T13:00:00.000Z' })
  expect((await store.runnable('2026-10-30T12:00:00.000Z')).map(r => r.id)).toEqual([pending])
  expect((await store.runnable('2026-10-30T13:00:00.000Z')).map(r => r.id).sort()).toEqual([pending, deferred].sort())
  expect(await store.cancelLiveRuns(schedule.id, 'schedule_cancelled')).toBe(2)
  expect((await store.run(pending))).toMatchObject({ state: 'skipped', skip_reason: 'schedule_cancelled' })
})

it('el artefacto guarda efectos privados que ninguna lectura devuelve y la autoridad se resuelve por run y ref', async () => {
  const schedule = await store.insertSchedule(base()), runId = (await store.insertRun({ schedule_id: schedule.id, scheduled_for: '2026-10-29T11:00:00.000Z', schedule_revision: 1, definition: definition(schedule.id), trigger: 'clock' }))!
  const artifactId = randomUUID()
  await store.insertArtifact({ id: artifactId, run_id: runId, kind: 'close', title: 't', body_md: 'b', items: [{ ordinal: 1 }], snapshot_refs: [], effects: [{ ordinal: 1, effect: { secret: 'x' } }] })
  expect(JSON.stringify(await store.artifactOfRun(runId))).not.toContain('secret')
  expect((await store.pendingEffects(runId))!.effects).toEqual([{ ordinal: 1, effect: { secret: 'x' } }])
  expect(await store.artifactAuthority({ run_id: runId })).toBe('live')
  await store.setDecisionRef(artifactId, 'ref-1')
  expect((await store.pendingEffects(runId))).toMatchObject({ effects: [], decision_request_ref: 'ref-1' })
  expect(await store.artifactAuthority({ run_id: runId, decision_request_ref: 'ref-1' })).toBe('live')
  expect(await store.artifactAuthority({ run_id: runId, decision_request_ref: 'otra' })).toBe('unknown')
  expect(await store.artifactAuthority({ run_id: randomUUID() })).toBe('unknown')
  await db.query("UPDATE schedule_artifacts SET authority='unavailable'")
  expect(await store.artifactAuthority({ run_id: runId })).toBe('unavailable')
  await store.setDecisionRef(artifactId, 'ref-2')
  expect((await store.artifactOfRun(runId))!.decision_request_ref).toBe('ref-1')
})

it('el estado público por ítem se actualiza y los bloqueantes cuentan solo dispatching e incierto', async () => {
  const schedule = await store.insertSchedule(base()), runId = (await store.insertRun({ schedule_id: schedule.id, scheduled_for: '2026-10-29T11:00:00.000Z', schedule_revision: 1, definition: definition(schedule.id), trigger: 'clock' }))!
  await store.set({ run_id: runId, ordinal: 1, kind: 'jira_worklog', state: 'proposed', effect_digest: 'd' })
  await store.set({ run_id: runId, ordinal: 1, kind: 'jira_worklog', state: 'approved' })
  expect((await store.itemStates(runId))[0]).toMatchObject({ state: 'approved', effect_digest: 'd' })
  expect(await store.blockingItems(projectId)).toBe(0)
  await store.set({ run_id: runId, ordinal: 2, kind: 'git_push', state: 'uncertain' })
  expect(await store.blockingItems(projectId)).toBe(1)
})

it('un incidente se registra una vez por sujeto, generación y causa', async () => {
  const incident = { subject_kind: 'schedule_run' as const, subject_id: 'run', generation: 1, project_id: projectId, cause: 'hub_restart' as const, action: 'terminated' as const }
  await store.addIncident(incident); await store.addIncident(incident)
  await store.addIncident({ ...incident, generation: 2 })
  expect((await store.incidents({ project_id: projectId })).length).toBe(2)
})

it('las entregas son únicas por run y destino y las no leídas salen por proyecto', async () => {
  const schedule = await store.insertSchedule(base()), runId = (await store.insertRun({ schedule_id: schedule.id, scheduled_for: '2026-10-29T11:00:00.000Z', schedule_revision: 1, definition: definition(schedule.id), trigger: 'clock' }))!
  await store.insertArtifact({ id: randomUUID(), run_id: runId, kind: 'notice', title: 'Aviso', body_md: 'b', items: [], snapshot_refs: [], effects: [] })
  const delivery = await store.ensureDelivery(runId, 'hub_inbox')
  expect((await store.ensureDelivery(runId, 'hub_inbox')).id).toBe(delivery.id)
  await store.setDelivery(delivery.id, { state: 'sent' })
  expect((await store.unreadDeliveries(projectId)).map(r => r.title)).toEqual(['Aviso'])
  await store.markDeliveriesRead(runId)
  expect(await store.unreadDeliveries(projectId)).toEqual([])
})
