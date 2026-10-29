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
import type { AgentContext } from '../src/agents.js'

let dir: string, db: MemoryDatabase, ops: MemoryOperations
const key = randomUUID()
const agent = (cwd: string): AgentContext => ({ agent_id: 'capture-client', session_id: `native:${'c'.repeat(64)}`, cli_kind: 'claude_code', client: 'Claude Code', cwd })
const send = (event: string, extra: Record<string, unknown> = {}, cwd = dir, at = new Date().toISOString()) =>
  ops.chat.lifecycle(agent(cwd), { session_key: key, native_id: 'native-session', event, at, ...extra })
const row = async () => (await db.query('SELECT * FROM chat_sessions WHERE agent_id=$1', ['capture-client']))[0]!
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-capture-')); db = new MemoryDatabase(join(dir, 'memory.sqlite')); await db.migrate()
  ops = new MemoryOperations(new MemoryStore(db, dir), new MemoryAI(async () => defaultAI, new Vault(dir)))
})
afterEach(async () => { await db.close(); await rm(dir, { recursive: true, force: true }) })

it('records model, directory and source reported by the native hook, with the origin of the ID', async () => {
  await send('SessionStart', { model: 'claude-sonnet-5-5', source: 'startup' })
  expect(await row()).toMatchObject({ model: 'claude-sonnet-5-5', start_source: 'startup', native_cwd: dir, surface: 'interactive',
    id_captured_by: 'hook', resumable: 1, native_id: 'native-session' })
  expect((await row()).id_captured_at).toEqual(expect.stringMatching(/^\d{4}-/))
  expect((await row()).adapter_version).toBeNull()
})

it('never erases a known value with an absent one', async () => {
  await send('SessionStart', { model: 'claude-sonnet-5-5', source: 'startup' })
  const captured = (await row()).id_captured_at
  await send('Stop')
  await send('UserPromptSubmit')
  expect(await row()).toMatchObject({ model: 'claude-sonnet-5-5', start_source: 'startup', native_cwd: dir, id_captured_at: captured })
})

it('updates the model when a later event reports another one and keeps the first source outside SessionStart', async () => {
  await send('SessionStart', { model: 'model-a', source: 'startup' })
  await send('UserPromptSubmit', { model: 'model-b', source: 'resume' })
  expect(await row()).toMatchObject({ model: 'model-b', start_source: 'startup' })
  await send('SessionStart', { source: 'resume' })
  expect((await row()).start_source).toBe('resume')
})

it('keeps the first directory and replaces it only when a new SessionStart reports another', async () => {
  await send('SessionStart', {}, dir)
  await send('Stop', {}, join(dir, 'elsewhere'))
  expect((await row()).native_cwd).toBe(dir)
  await send('SessionStart', {}, join(dir, 'moved'))
  expect((await row()).native_cwd).toBe(join(dir, 'moved'))
})

it('does not capture from heartbeats or watches', async () => {
  await send('SessionStart')
  await db.query('UPDATE chat_sessions SET model=NULL,native_cwd=NULL')
  await send('Heartbeat', { model: 'ignored' }, join(dir, 'x'))
  await send('Watch', { model: 'ignored' }, join(dir, 'x'))
  expect(await row()).toMatchObject({ model: null, native_cwd: null })
})

it('does not mark a session resumable before any hook captured its ID', async () => {
  const registered = await ops.chat.register(agent(dir), randomUUID())
  const created = (await db.query('SELECT resumable,id_captured_by,model FROM chat_sessions WHERE id=$1', [registered.session.id]))[0]!
  expect(created).toMatchObject({ resumable: 0, id_captured_by: null, model: null })
})

it('follows the model across a mid-session switch without touching the session state', async () => {
  await send('SessionStart', { model: 'model-a' })
  const started = await row()
  expect(started).toMatchObject({ model: 'model-a', state: 'idle' })
  expect(started.model_observed_at).toEqual(expect.stringMatching(/^\d{4}-/))
  const later = new Date(Date.now() + 5000).toISOString()
  await send('PostModelSwitch', { model: 'model-b' }, dir, later)
  expect(await row()).toMatchObject({ model: 'model-b', model_observed_at: later, state: 'idle', event_at: started.event_at })
  await send('PostModelSwitch', { model: 'stale' }, dir, new Date(Date.now() - 60_000).toISOString())
  expect((await row()).model).toBe('model-b')
  await send('PostModelSwitch', {}, dir, new Date(Date.now() + 9000).toISOString())
  expect((await row()).model).toBe('model-b')
})

it('ignores a model switch reported by an unknown or closed session', async () => {
  await send('PostModelSwitch', { model: 'model-x' })
  expect(await db.query('SELECT 1 FROM chat_sessions WHERE agent_id=$1', ['capture-client'])).toHaveLength(1)
  expect((await row()).model).toBeNull()
  await send('SessionStart', { model: 'model-a' })
  await send('SessionEnd')
  await send('PostModelSwitch', { model: 'model-y' }, dir, new Date(Date.now() + 5000).toISOString())
  expect((await row()).model).toBe('model-a')
})
