import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDatabase } from '../src/database.js'
import { migrations } from '../src/migrations.js'
import { exportMemory, readBackup, restoreMemory } from '../src/backup.js'
import { MemoryStore } from '../src/store.js'
import { ScheduleStore } from '../src/schedule-store.js'

let dir: string, db: MemoryDatabase
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'hub-incidents-migration-')); db = new MemoryDatabase(join(dir, 'memory.sqlite')) })
afterEach(async () => { await db.close(); await rm(dir, { recursive: true, force: true }) })

const insert = (id: string, cause: string, action: string) => db.query(`INSERT INTO process_incidents(id,subject_kind,subject_id,generation,cause,action,observed_at) VALUES($1,'fleet_member',$2,'g1',$3,$4,'2026-10-29T00:00:00.000Z')`, [id, id, cause, action])

it('la reconstrucción conserva las filas anteriores y sus índices y admite las causas y acciones de cuota', async () => {
  const rebuild = migrations.findIndex(sql => sql.includes('process_incidents_previous'))
  for (const sql of migrations.slice(0, rebuild)) await db.execute(sql)
  await insert('old', 'hub_restart', 'terminated')
  await expect(insert('rejected', 'quota_exhausted', 'resumed')).rejects.toThrow()
  for (const sql of migrations.slice(rebuild)) await db.execute(sql)
  expect((await db.query('SELECT id,cause,action FROM process_incidents'))).toEqual([{ id: 'old', cause: 'hub_restart', action: 'terminated' }])
  for (const [id, cause, action] of [['a', 'quota_exhausted', 'none'], ['b', 'quota_resume', 'resumed'], ['c', 'quota_resume', 'resume_unsupported'], ['d', 'quota_resume', 'resume_failed']] as const) await insert(id, cause, action)
  await expect(insert('e', 'quota_restored', 'none')).rejects.toThrow()
  await expect(insert('f', 'hub_restart', 'quota_restored')).rejects.toThrow()
  const indexes = (await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='process_incidents'")).map(row => row.name)
  expect(indexes).toEqual(expect.arrayContaining(['process_incidents_subject', 'process_incidents_project']))
  expect(await db.query("SELECT name FROM sqlite_master WHERE name='process_incidents_previous'")).toEqual([])
})

it('un intento de reanudación por miembro y generación: el índice único impide el segundo', async () => {
  await db.migrate()
  const incidents = new ScheduleStore(db)
  const attempt = { subject_kind: 'fleet_member' as const, subject_id: 'm1', generation: 'g1', cause: 'quota_resume' as const, action: 'resumed' as const }
  await incidents.addIncident(attempt); await incidents.addIncident(attempt); await incidents.addIncident({ ...attempt, generation: 'g2' })
  expect((await db.query("SELECT generation FROM process_incidents WHERE cause='quota_resume' ORDER BY generation")).map(row => row.generation)).toEqual(['g1', 'g2'])
})

it('los incidentes de cuota sobreviven al respaldo y la restauración', async () => {
  await db.migrate()
  const store = new MemoryStore(db, dir), incidents = new ScheduleStore(db)
  await incidents.addIncident({ subject_kind: 'fleet_member', subject_id: 'm1', generation: 'g1', cause: 'quota_exhausted', action: 'none', detail: { evidence: 'protocol+quota_observation' } })
  const backup = JSON.parse(await readBackup(store, (await exportMemory(store)).id))
  const target = join(dir, 'restored'), restored = new MemoryDatabase(join(target, 'memory.sqlite')); await restored.migrate()
  try { await restoreMemory(new MemoryStore(restored, target), backup) } finally { await restored.close() }
  const check = new MemoryDatabase(join(target, 'memory.sqlite'))
  try { expect((await check.query("SELECT cause,action,detail FROM process_incidents"))).toMatchObject([{ cause: 'quota_exhausted', action: 'none', detail: { evidence: 'protocol+quota_observation' } }]) } finally { await check.close() }
})

it('chat_sessions registra cuándo se observó el modelo por última vez', async () => {
  await db.migrate()
  const columns = (await db.query<{ name: string }>("SELECT name FROM pragma_table_info('chat_sessions')")).map(row => row.name)
  expect(columns).toEqual(expect.arrayContaining(['model', 'model_observed_at']))
})
