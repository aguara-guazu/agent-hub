import { expect, it, vi } from 'vitest'
import { restartClient, type ClientDeps } from './clients.js'

it('cierra el proceso Claude por nombre en Windows y relanza el ejecutable sin shell', async () => {
  let running = true
  const run = vi.fn(async (command: string) => {
    if (command === 'powershell') { running = false; return { code: 0, stdout: '' } }
    return { code: 0, stdout: running ? 'Claude.exe' : '' }
  })
  const launch = vi.fn()
  const deps: ClientDeps = { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Test User\\AppData\\Local' }, run, launch,
    exists: path => path.endsWith('AnthropicClaude\\claude.exe'), sleep: async () => {} }
  expect((await restartClient('claude_desktop', deps)).ok).toBe(true)
  expect(run).toHaveBeenCalledWith('powershell', ['-NoProfile', '-Command', 'Get-Process -Name Claude -ErrorAction SilentlyContinue | ForEach-Object { $null = $_.CloseMainWindow() }'])
  expect(launch).toHaveBeenCalledWith('C:\\Users\\Test User\\AppData\\Local\\AnthropicClaude\\claude.exe', [])
})

it('no reinicia clientes no soportados ni afirma éxito cuando macOS no puede relanzar la app', async () => {
  const deps: ClientDeps = { platform: 'darwin', env: {}, run: vi.fn(async () => ({ code: 1, stdout: '' })), launch: vi.fn(), exists: () => false, sleep: async () => {} }
  expect((await restartClient('codex', deps)).ok).toBe(false)
  expect(deps.run).not.toHaveBeenCalled()
  expect((await restartClient('claude_desktop', deps)).ok).toBe(false)
  expect(deps.run).toHaveBeenCalledWith('open', ['-b', 'com.anthropic.claudefordesktop'])
})
