/* global window, document, fetch */
import { createRequire } from 'node:module'
const { _electron: electron } = createRequire(new URL('../frontend/package.json', import.meta.url))('playwright')
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { URL, fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { exec } from 'node:child_process'
import assert from 'node:assert/strict'

// Run against the installed/unpacked executable, with a fresh profile and no model downloads or external accounts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = await mkdtemp(join(tmpdir(), 'Agent Hub prueba Pérez #%20 '))
await mkdir(join(directory, 'home/.gemini/antigravity'), { recursive: true })
const server = createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const env = { ...process.env, AGENTHUB_DESKTOP_STATE_DIR: join(directory, 'state'), AGENTHUBD_HOME_DIR: join(directory, 'home'),
  AGENTHUB_HUB_PORT: String(port), AGENTHUB_NO_AUTO_UPDATE: '1', AGENTHUB_STARTER_CATALOG: '0', AGENTHUB_MEMORY_WORKER: '0' }
delete env.ELECTRON_RUN_AS_NODE
let app
try {
  for (let attempt = 0; attempt < 2; attempt++) {
    app = await electron.launch({ ...(process.argv[2] ? { executablePath: resolve(process.argv[2]), args: [] } : { args: [root] }), env, timeout: 60_000 })
    const page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    // También se ejecuta en Windows CI: evita que el atajo quede restringido a macOS.
    // En Wayland confirma la solicitud; la autorización final depende del portal.
    assert.equal(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+H')), true,
      'Global shortcut Ctrl+Alt+H must be registered')
    const result = await page.evaluate(async () => {
      const api = window.agentHub
      const token = await api.getSession()
      const status = await api.getCoreStatus()
      const response = await fetch(`${status.apiBaseUrl}/api/memory/status`, { headers: { Authorization: `Bearer ${token}` } })
      return { status, http: response.status, memory: await response.json(), text: document.body.innerText }
    })
    assert.equal(result.status.state, 'running')
    assert.equal(result.http, 200)
    assert.equal(result.memory.ready, true)
    assert.ok(result.text.trim(), 'Renderer must load')
    await page.waitForFunction(async () => {
      const api = window.agentHub, token = await api.getSession(), status = await api.getCoreStatus()
      const response = await fetch(`${status.apiBaseUrl}/api/local/overview`, { headers: { Authorization: `Bearer ${token}` } })
      const { clients } = await response.json()
      return clients.length === 1 && clients[0].cli_kind === 'antigravity' && clients[0].synchronized
    }, undefined, { timeout: 30_000 })
    const mcp = JSON.parse(await readFile(join(directory, 'home/.gemini/config/mcp_config.json'), 'utf8'))
    assert.ok(mcp.mcpServers.hub.command, 'Packaged gateway command must be configured')
    const hooks = JSON.parse(await readFile(join(directory, 'home/.gemini/config/hooks.json'), 'utf8'))['agenthub-memory']
    const hookOutput = await new Promise((resolve, reject) => {
      const child = exec(hooks.PreToolUse[0].hooks[0].command, { env, windowsHide: true, timeout: 15_000 },
        (error, stdout) => error ? reject(error) : resolve(stdout))
      child.stdin.end(JSON.stringify({ conversationId: `smoke-${attempt}`, workspacePaths: [directory],
        toolCall: { name: 'mcp_hub_memory_context', args: {} } }))
    })
    assert.deepEqual(JSON.parse(hookOutput), { decision: 'allow' }, 'Native hook must run from the installed executable')
    for (const variant of ['config', 'antigravity-cli']) {
      assert.match(await readFile(join(directory, 'home/.gemini', variant, 'skills/memory/SKILL.md'), 'utf8'), /name:/)
    }
    await page.evaluate(() => { window.location.hash = '/clients' })
    await page.getByRole('heading', { name: 'Antigravity', exact: true, level: 2 }).waitFor()
    const quotas = page.getByRole('region', { name: 'Cuotas de uso', exact: true })
    await quotas.getByRole('heading', { name: 'Antigravity', exact: true, level: 3 }).waitFor()
    await quotas.getByText('Sin consulta compatible', { exact: true }).waitFor()
    console.log(`Desktop smoke ${attempt + 1}: global shortcut, renderer, session, memory and Antigravity integration ready; ${process.platform}/${process.arch}`)
    await app.close(); app = undefined
  }
} finally {
  if (app) await app.close().catch(() => {})
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
