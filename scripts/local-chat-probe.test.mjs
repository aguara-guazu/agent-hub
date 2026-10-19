/* global fetch, AbortSignal */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

test('isolated broker: identity, recipient isolation, receipts, revision and lifecycle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agenthub-chat-contract-'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./local-chat-probe.mjs', import.meta.url)), 'broker', root], { stdio: 'pipe' })
  let errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  const exited = once(child, 'exit')
  t.after(async () => { child.kill('SIGTERM'); await exited; await rm(root, { recursive: true, force: true }) })
  let config
  for (let attempt = 0; attempt < 100 && !config; attempt++) {
    try { config = JSON.parse(await readFile(join(root, 'connection.json'), 'utf8')) } catch { await delay(30) }
  }
  assert.ok(config, errors || 'broker did not start')
  const call = async (path, body, expected = 200, auth = config.token) => {
    const response = await fetch(config.url + path, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
    const result = await response.json()
    assert.equal(response.status, expected, JSON.stringify(result))
    return result
  }
  await call('/status', {}, 401, 'wrong-token')
  const c1 = { client: 'claude', binding: 'one', nativeId: 'native-one', cwd: root }
  const c2 = { client: 'claude', binding: 'two', nativeId: 'native-two', cwd: root }
  const a = await call('/register', c1), b = await call('/register', c2)
  assert.notEqual(a.id, b.id)
  assert.equal((await call('/register', c1)).id, a.id)
  await call('/register', { ...c1, nativeId: 'hijacked' }, 400)
  await call('/tool', { ...c1, client: 'codex', name: 'identity' }, 400)
  await call('/tool', { ...c1, name: 'send', args: { to: a.id, text: 'self' } }, 400)
  await call('/tool', { ...c1, name: 'send', args: { to: 'missing', text: 'unknown' } }, 400)
  const waiting = call('/wait', c2)
  const message = await call('/tool', { ...c1, name: 'send', args: { to: b.id, text: 'review revision 0' } })
  assert.deepEqual((await waiting).pending, [message.id])
  assert.deepEqual((await call('/tool', { ...c1, name: 'inbox' })).items, [])
  assert.equal((await call('/tool', { ...c2, name: 'inbox' })).items[0].id, message.id)
  assert.deepEqual((await call('/tool', { ...c2, name: 'inbox' })).items, [])
  const code = 'export function add(a,b) { return a+b; }'
  assert.equal((await call('/tool', { ...c1, name: 'fixture_write', args: { code, expected_revision: 0 } })).revision, 1)
  await call('/tool', { ...c2, name: 'fixture_write', args: { code: 'stale', expected_revision: 0 } }, 400)
  await call('/lifecycle', { ...c1, event: 'SessionEnd' })
  await call('/heartbeat', c1)
  let state = await call('/status', {})
  assert.equal(state.sessions.find(s => s.id === a.id).online, false)
  assert.equal(state.sessions.find(s => s.id === a.id).status, 'closed')
  assert.equal((await call('/register', c1)).id, a.id)
  state = await call('/status', {})
  assert.equal(state.sessions.find(s => s.id === a.id).online, true)
  assert.equal(state.sessions.find(s => s.id === a.id).status, 'starting')
})
