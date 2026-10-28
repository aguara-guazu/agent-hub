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
import { deleteEntity, exportMemory, readBackup, restoreMemory } from '../src/backup.js'

let dir: string, db: MemoryDatabase, store: MemoryStore, ops: MemoryOperations, projectId: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-schedule-'))
  db = new MemoryDatabase(join(dir, 'memory.sqlite')); await db.migrate()
  store = new MemoryStore(db, dir); ops = new MemoryOperations(store, new MemoryAI(async () => defaultAI, new Vault(dir)))
  projectId = (await ops.call('create_entity', { kind: 'project', title: 'Proyecto' })).id
})
afterEach(async () => { await db.close(); await rm(dir, { recursive: true, force: true }) })

const recurrence = JSON.stringify({ type: 'daily', time: '08:00' })
async function schedule(overrides: Record<string, unknown> = {}) {
  const row = { id: randomUUID(), scope: 'project', project_id: projectId, template: 'reminder', template_version: 1, kind: 'notice', title: 'Recordatorio',
    recurrence, delivery: '["hub_inbox"]', misfire: 'run_once', grace_minutes: 30, target_key: randomUUID(), state: 'active', created_by_kind: 'agent',
    created_by_agent: 'agent-1', created_by_session: 'native:x', next_run_at: '2026-10-29T11:00:00.000Z', ...overrides }
  const keys = Object.keys(row)
  await db.query(`INSERT INTO schedules(${keys.join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map(k => (row as any)[k]))
  return row.id as string
}
async function run(scheduleId: string, scheduledFor: string, state: string, phase = 'collect') {
  const id = randomUUID()
  await db.query('INSERT INTO schedule_runs(id,schedule_id,scheduled_for,schedule_revision,definition,trigger,state,phase) VALUES($1,$2,$3,1,$4,$5,$6,$7)',
    [id, scheduleId, scheduledFor, '{}', 'clock', state, phase])
  return id
}

it('exige proyecto solo en schedules de proyecto y autor solo para agentes', async () => {
  await expect(schedule({ scope: 'owner' })).rejects.toThrow()
  await expect(schedule({ scope: 'project', project_id: null })).rejects.toThrow()
  await expect(schedule({ created_by_agent: null })).rejects.toThrow()
  await schedule({ scope: 'owner', project_id: null, template: 'daily_brief', kind: 'synthesis', created_by_kind: 'human', created_by_agent: null, created_by_session: null })
})

it('admite un solo schedule vivo por objetivo y libera el objetivo al cancelar', async () => {
  await schedule({ target_key: 'objetivo' })
  await expect(schedule({ target_key: 'objetivo', state: 'paused' })).rejects.toThrow()
  await schedule({ target_key: 'objetivo', state: 'cancelled' })
  await db.query("UPDATE schedules SET state='cancelled' WHERE target_key='objetivo' AND state='active'")
  await schedule({ target_key: 'objetivo' })
})

it('no repite la ocurrencia de un schedule y solo acepta estados cerrados', async () => {
  const id = await schedule()
  await run(id, '2026-10-29T11:00:00.000Z', 'pending')
  await expect(run(id, '2026-10-29T11:00:00.000Z', 'pending')).rejects.toThrow()
  await expect(run(id, '2026-10-30T11:00:00.000Z', 'colgado')).rejects.toThrow()
})

it('borrar el proyecto elimina schedules, ocurrencias y artefactos y conserva la restricción humana', async () => {
  const id = await schedule(), runId = await run(id, '2026-10-29T11:00:00.000Z', 'succeeded', 'done')
  await db.query("INSERT INTO schedule_artifacts(id,run_id,kind,title,body_md) VALUES($1,$2,'notice','t','b')", [randomUUID(), runId])
  await db.query("INSERT INTO schedule_deliveries(id,run_id,target,state) VALUES($1,$2,'hub_inbox','sent')", [randomUUID(), runId])
  const taskId = randomUUID()
  await db.query("INSERT INTO tasks(id,project_id,kind,title,status,created_by,updated_by,assignee_account_id) VALUES($1,$2,'pending','t','todo','x','x','acc')", [taskId, projectId])
  await db.query("INSERT INTO hour_estimates(id,run_id,project_id,task_id,estimated_seconds,state) VALUES($1,$2,$3,$4,1800,'proposed')", [randomUUID(), runId, projectId, taskId])
  await db.query("INSERT INTO project_status_snapshots(id,project_id,version,as_of,freshness) VALUES($1,$2,1,'2026-10-28T10:00:00.000Z','current')", [randomUUID(), projectId])
  const constraintId = randomUUID()
  await db.query("INSERT INTO schedule_constraints(id,subject,project_id,template,scope,target_key,schedule_id,created_by_user) VALUES($1,'project',$2,'reminder','target','k',$3,'owner')", [constraintId, projectId, id])
  await deleteEntity(store, projectId)
  for (const table of ['schedules', 'schedule_runs', 'schedule_artifacts', 'schedule_deliveries', 'hour_estimates', 'project_status_snapshots']) expect(await db.query(`SELECT 1 FROM ${table}`)).toEqual([])
  expect((await db.query('SELECT schedule_id FROM schedule_constraints WHERE id=$1', [constraintId]))[0]).toEqual({ schedule_id: null })
})

it('rechaza una restricción humana duplicada vigente y permite recrearla tras levantarla', async () => {
  const insert = (id: string) => db.query("INSERT INTO schedule_constraints(id,subject,project_id,template,scope,created_by_user) VALUES($1,'project',$2,'daily_close','template_project','owner')", [id, projectId])
  const first = randomUUID()
  await insert(first)
  await expect(insert(randomUUID())).rejects.toThrow()
  await db.query("UPDATE schedule_constraints SET lifted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=$1", [first])
  await insert(randomUUID())
})

it('restaura sin autoridad: pausa schedules, interrumpe runs, anula procesos y conserva incertidumbre y restricciones', async () => {
  const live = await schedule({ target_key: 'vivo' }), done = await schedule({ target_key: 'terminado', state: 'completed', next_run_at: null })
  const running = await run(live, '2026-10-29T11:00:00.000Z', 'running', 'synthesize'), deferred = await run(live, '2026-10-30T11:00:00.000Z', 'deferred', 'synthesize')
  const uncertain = await run(done, '2026-10-28T11:00:00.000Z', 'uncertain', 'deliver')
  await db.query(`INSERT INTO schedule_run_attempts(run_id,generation,phase,profile,boot_id,host_pid,host_started,cli_pid,cli_started,state,deadline_at)
    VALUES($1,1,'synthesize','synthesis','boot',10,'inicio',11,'inicio',$2,'2026-10-29T12:00:00.000Z'),($3,1,'synthesize','synthesis','boot',20,'inicio',21,'inicio','exited','2026-10-29T12:00:00.000Z')`, [running, 'running', uncertain])
  await db.query("INSERT INTO schedule_deliveries(id,run_id,target,state) VALUES($1,$2,'gmail_self','sending'),($3,$4,'slack_self','uncertain')", [randomUUID(), running, randomUUID(), uncertain])
  for (const [ordinal, state] of [[1, 'proposed'], [2, 'approved'], [3, 'dispatching'], [4, 'uncertain'], [5, 'succeeded']] as const)
    await db.query("INSERT INTO schedule_item_states(run_id,ordinal,kind,state) VALUES($1,$2,'jira_worklog',$3)", [uncertain, ordinal, state])
  await db.query("INSERT INTO schedule_constraints(id,subject,project_id,template,scope,created_by_user) VALUES($1,'project',$2,'reminder','template_project','owner')", [randomUUID(), projectId])
  await db.query("INSERT INTO project_automation(project_id,enabled,coordinator_session_id,updated_by_user) VALUES($1,1,'native:coordinador','owner')", [projectId])
  await db.query("INSERT INTO liveness_incidents(id,dedupe_key,session_id,kind,episode,status,opened_at,last_observed_at) VALUES($1,'d','native:s','possible_stall','e','open','2026-10-28T10:00:00.000Z','2026-10-28T10:00:00.000Z')", [randomUUID()])
  await db.query("INSERT INTO progress_checkpoints(checkpoint_id,session_id,pending_since,status) VALUES($1,'native:s','2026-10-28T10:00:00.000Z','open')", [randomUUID()])

  const backup = JSON.parse(await readBackup(store, (await exportMemory(store)).id))
  expect(Object.keys(backup.tables)).toEqual(expect.arrayContaining(['schedules', 'schedule_runs', 'schedule_run_attempts', 'schedule_item_states', 'decision_exclusions', 'push_candidates', 'project_status_snapshots', 'hour_estimates']))
  const target = join(dir, 'restored'), restored = new MemoryDatabase(join(target, 'memory.sqlite')); await restored.migrate()
  try {
    await restoreMemory(new MemoryStore(restored, target), backup)
    const one = async (sql: string, params: unknown[] = []) => (await restored.query(sql, params))[0]
    expect(await one('SELECT state,paused_by,next_run_at FROM schedules WHERE id=$1', [live])).toEqual({ state: 'paused', paused_by: 'system', next_run_at: null })
    expect((await one('SELECT state FROM schedules WHERE id=$1', [done])).state).toBe('completed')
    expect(await one('SELECT state,error_code FROM schedule_runs WHERE id=$1', [running])).toEqual({ state: 'interrupted', error_code: 'hub_restart' })
    expect((await one('SELECT state FROM schedule_runs WHERE id=$1', [deferred])).state).toBe('interrupted')
    expect((await one('SELECT state FROM schedule_runs WHERE id=$1', [uncertain])).state).toBe('uncertain')
    expect(await one('SELECT state,boot_id,host_pid,cli_pid,cli_started FROM schedule_run_attempts WHERE run_id=$1', [running]))
      .toEqual({ state: 'orphan_unverified', boot_id: null, host_pid: null, cli_pid: null, cli_started: null })
    expect(await one('SELECT state,host_pid FROM schedule_run_attempts WHERE run_id=$1', [uncertain])).toEqual({ state: 'exited', host_pid: null })
    expect((await one("SELECT state FROM schedule_deliveries WHERE target='gmail_self'")).state).toBe('uncertain')
    expect((await restored.query('SELECT ordinal,state FROM schedule_item_states ORDER BY ordinal')).map(r => r.state)).toEqual(['unverifiable', 'unverifiable', 'uncertain', 'uncertain', 'succeeded'])
    expect((await restored.query('SELECT 1 FROM schedule_constraints WHERE lifted_at IS NULL')).length).toBe(1)
    expect(await one('SELECT enabled,coordinator_session_id FROM project_automation')).toEqual({ enabled: 0, coordinator_session_id: null })
    expect(await one('SELECT status,resolution FROM liveness_incidents')).toEqual({ status: 'resolved', resolution: 'restored' })
    expect(await one('SELECT status,closed_reason FROM progress_checkpoints')).toEqual({ status: 'closed', closed_reason: 'restored' })
    expect(await restored.query('PRAGMA foreign_key_check')).toEqual([])
  } finally { await restored.close() }
})
