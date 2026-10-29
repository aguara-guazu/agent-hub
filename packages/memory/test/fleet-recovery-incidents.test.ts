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
