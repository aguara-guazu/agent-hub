import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it, afterEach, vi } from 'vitest'
import { secretFilePath, childEnv, renameRetry, killTree } from './platform.js'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

afterEach(() => vi.unstubAllEnvs())
it('convierte rutas Windows y POSIX una sola vez, incluidos espacios, Unicode y porcentajes', () => {
  expect(secretFilePath('/C:/Users/Ana%20P%C3%A9rez/secret%2520%23.txt', true)).toBe('C:\\Users\\Ana Pérez\\secret%20#.txt')
  expect(secretFilePath('/tmp/secret%2520%23.txt', false)).toBe('/tmp/secret%20#.txt')
})
it.each(['server/share', '//server/share', '/\\server/share', '/tmp/%00', '/tmp/%2fsecret', '/tmp/%zz'])('rechaza referencias inválidas o remotas: %s', raw => {
  expect(() => secretFilePath(raw, true)).toThrow()
  expect(() => secretFilePath(raw, false)).toThrow()
})
it('no hereda secretos internos y aplica las sustituciones de entorno', () => {
  vi.stubEnv('AGENTHUB_JWT_SECRET', 'private')
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
  vi.stubEnv('HUB_TEST_DELETE', 'remove')
  const env = childEnv({ HUB_TEST_DELETE: undefined, HUB_TEST_VALUE: 'ok' })
  expect(env.AGENTHUB_JWT_SECRET).toBeUndefined()
  expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  expect(env.HUB_TEST_DELETE).toBeUndefined()
  expect(env.HUB_TEST_VALUE).toBe('ok')
})
it('reemplaza un archivo existente sin dejar la versión anterior', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rename-test-'))
  try {
    const from = join(dir, 'temp'), to = join(dir, 'target')
    await writeFile(from, 'new'); await writeFile(to, 'old')
    await renameRetry(from, to)
    expect(await readFile(to, 'utf8')).toBe('new')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it.runIf(process.platform === 'win32')('termina el proceso y su descendiente en Windows', async () => {
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log(nested.pid); setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let nested = 0
  try {
    const [data] = await once(child.stdout!, 'data')
    nested = Number(String(data).trim())
    expect(nested).toBeGreaterThan(0)
    const exited = once(child, 'exit')
    killTree(child)
    await exited
    await vi.waitFor(() => expect(() => process.kill(nested, 0)).toThrow(), { timeout: 3000 })
  } finally {
    if (child.exitCode === null && child.signalCode === null) killTree(child)
    if (nested) try { process.kill(nested) } catch { /* already gone */ }
  }
}, 15_000)
