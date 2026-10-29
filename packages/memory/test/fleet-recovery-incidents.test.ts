import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDatabase } from '../src/database.js'
import { SqlRecoveryIncidentLog } from '../src/fleet-recovery.js'

let dir: string, db: MemoryDatabase, log: SqlRecoveryIncidentLog
const base = { member_id: 'member-1', team_id: 'team-1', session_id: null, generation: 'gen-1', detail: { evidence: 'protocol', pool_key: 'pool-a' } }
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-recovery-incidents-')); db = new MemoryDatabase(join(dir, 'memory.sqlite')); await db.migrate()
  // The shared migration adds these values to the CHECK lists; the table is rebuilt the same way so the log is exercised against them.
  await db.query('DROP TABLE process_incidents')
  await db.query(`CREATE TABLE process_incidents (
    id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL CHECK(subject_kind IN ('schedule_run','fleet_member')), subject_id TEXT NOT NULL, generation TEXT,
    schedule_id TEXT, run_id TEXT, team_id TEXT, member_id TEXT, session_id TEXT, project_id TEXT,
    cause TEXT NOT NULL CHECK(cause IN ('hub_restart','deadline_exceeded','automations_off','collaboration_off','cancelled','spawn_failed','process_exited','quota_exhausted','quota_resume')),
    action TEXT NOT NULL CHECK(action IN ('terminated','already_exited','unverified_left_running','termination_unknown','none','resumed','resume_unsupported','resume_failed')),
    pid INTEGER, process_started TEXT, boot_id TEXT, observed_at TIMESTAMP NOT NULL, detail JSON NOT NULL DEFAULT '{}')`)
  await db.query("CREATE UNIQUE INDEX process_incidents_subject ON process_incidents(subject_kind,subject_id,COALESCE(generation,''),cause)")
  log = new SqlRecoveryIncidentLog(db)
})
afterEach(async () => { await db.close(); await rm(dir, { recursive: true, force: true }) })
const rows = () => db.query('SELECT cause,action,generation,detail FROM process_incidents ORDER BY cause,generation')

it('grants one claim per member, generation and cause', async () => {
  expect(await log.claim({ ...base, cause: 'quota_resume' })).toBe(true)
  expect(await log.claim({ ...base, cause: 'quota_resume' })).toBe(false)
  expect(await log.claim({ ...base, cause: 'quota_exhausted' })).toBe(true)
  expect(await log.claim({ ...base, generation: 'gen-2', cause: 'quota_resume' })).toBe(true)
  expect(await log.claim({ ...base, member_id: 'member-2', cause: 'quota_resume' })).toBe(true)
  expect(await rows()).toHaveLength(4)
})

it('settles only the resume attempt of that generation and merges its detail', async () => {
  await log.claim({ ...base, cause: 'quota_exhausted' })
  await log.claim({ ...base, cause: 'quota_resume' })
  await log.claim({ ...base, generation: 'gen-2', cause: 'quota_resume' })
  await log.settle({ member_id: 'member-1', generation: 'gen-1', action: 'resume_unsupported', detail: { reason: 'exclusive_resume_unverified' } })
  const settled = await rows()
  expect(settled.map(row => [row.cause, row.generation, row.action])).toEqual([['quota_exhausted', 'gen-1', 'none'], ['quota_resume', 'gen-1', 'resume_unsupported'], ['quota_resume', 'gen-2', 'none']])
  expect(settled[1]!.detail).toMatchObject({ evidence: 'protocol', pool_key: 'pool-a', reason: 'exclusive_resume_unverified' })
})
