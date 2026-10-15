/* global window, document, fetch */
import { createRequire } from 'node:module'
const { _electron: electron } = createRequire(new URL('../frontend/package.json', import.meta.url))('playwright')
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { URL, fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import assert from 'node:assert/strict'

// Run against the installed/unpacked executable, with a fresh profile and no model downloads or external accounts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = await mkdtemp(join(tmpdir(), 'Agent Hub prueba Pérez #%20 '))
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
    console.log(`Desktop smoke ${attempt + 1}: renderer, session and memory ready; ${process.platform}/${process.arch}`)
    await app.close(); app = undefined
  }
} finally {
  if (app) await app.close().catch(() => {})
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
