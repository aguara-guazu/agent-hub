import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AutoUpdater } from './updater.js'

it('consulta CIM una sola vez mientras siga vivo un puente y vuelve a enumerar antes de instalar', async () => {
  const run = vi.fn().mockResolvedValueOnce({ stdout: JSON.stringify([process.pid]) })
    .mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({ stdout: '' })
  const updater = new AutoUpdater({ currentVersion: '1.0.0', platform: 'win32', arch: 'x64', execPath: 'Agent Hub.exe',
    env: {}, bundleId: 'test', enabled: true, exists: () => true, run })
  expect(await updater.bridgesAtRisk()).toBe(1)
  expect(await updater.bridgesAtRisk()).toBe(1)
  expect(run).toHaveBeenCalledTimes(1)
  const probe = vi.spyOn(process, 'kill').mockImplementationOnce(() => { throw Object.assign(new Error(), { code: 'ESRCH' }) })
  try { expect(await updater.bridgesAtRisk()).toBe(0) } finally { probe.mockRestore() }
  expect(run).toHaveBeenCalledTimes(2)
  expect(await updater.bridgesAtRisk()).toBe(Infinity)
})

it.skipIf(process.platform !== 'win32')('detecta un gateway real de esta instalación hasta que sale', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'Agent Hub bridges-'))
  const execPath = join(directory, 'Agent Hub.exe')
  const script = join(directory, 'client.cjs')
  const updater = new AutoUpdater({ currentVersion: '1.0.0', platform: 'win32', arch: 'x64', execPath,
    env: {}, bundleId: 'test', enabled: true, exists: () => true })
  try {
    copyFileSync(process.execPath, execPath)
    writeFileSync(script, 'process.stdin.resume()')
    const child = spawn(execPath, [script, '--agenthub-headless', 'gateway'], { stdio: ['pipe', 'ignore', 'ignore'] })
    const closed = once(child, 'close')
    try {
      await once(child, 'spawn')
      expect(await updater.bridgesAtRisk()).toBe(1)
      expect(await updater.bridgesAtRisk()).toBe(1)
    } finally { child.stdin.end(); await closed }
    expect(await updater.bridgesAtRisk()).toBe(0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 30000)
