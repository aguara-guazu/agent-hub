/* global window, document, fetch */
import { createRequire } from 'node:module'
const { _electron: electron } = createRequire(new URL('../frontend/package.json', import.meta.url))('playwright')
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { URL, fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { exec } from 'node:child_process'
import { clearTimeout, setTimeout } from 'node:timers'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'

// A synchronized snapshot can precede the next catalog update and its hook/skill writes.
async function managedFile(path, ready) {
  const deadline = Date.now() + 30_000
  do {
    try {
      const text = await readFile(path, 'utf8')
      if (ready(text)) return text
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await delay(100)
  } while (Date.now() < deadline)
  throw new Error(`Managed client file did not become ready: ${path}`)
}

const started = Date.now()
const mark = step => console.log(`[smoke] +${((Date.now() - started) / 1000).toFixed(1)}s ${step}`)
const CLOSE_LIMIT_MS = 120_000

// A close that does not finish is diagnosed here instead of at the job timeout: tail of the app logs and its processes.
async function diagnoseStuckClose(logs) {
  for (const name of ['core.log', 'hub.log', 'daemon.log']) {
    const text = await readFile(join(logs, name), 'utf8').catch(error => `(${error.code ?? error.message})`)
    console.log(`----- ${name} (últimas 80 líneas) -----\n${text.split('\n').slice(-80).join('\n')}`)
  }
  const list = process.platform === 'win32' ? 'tasklist /V /FI "IMAGENAME eq Agent Hub.exe"' : 'ps -eo pid,ppid,etime,command | grep -i "agent hub" | grep -v grep'
  const processes = await new Promise(done => exec(list, { windowsHide: true, timeout: 15_000 }, (error, stdout) => done(stdout || String(error?.message ?? ''))))
  console.log(`----- procesos Agent Hub -----\n${processes}`)
}

async function closeWithin(app, logs, attempt) {
  mark(`close ${attempt + 1}: start`)
  let timer
  try {
    const stuck = new Promise(done => { timer = setTimeout(() => done('stuck'), CLOSE_LIMIT_MS) })
    const result = await Promise.race([app.close().then(() => 'closed', error => ({ error })), stuck])
    if (result === 'closed') { mark(`close ${attempt + 1}: done`); return }
    if (result === 'stuck') {
      await diagnoseStuckClose(logs)
      throw new Error(`Desktop close ${attempt + 1} did not finish within ${CLOSE_LIMIT_MS / 1000}s`)
    }
    throw result.error
  } catch (error) {
    // Neither a stuck nor a failed close may leave the test app running after the smoke.
    const child = app.process()
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// Run against the installed/unpacked executable, with a fresh profile and no model downloads or external accounts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = await mkdtemp(join(tmpdir(), 'Agent Hub prueba Pérez #%20 '))
await mkdir(join(directory, 'home/.gemini/antigravity'), { recursive: true })
// With no stored preference the renderer follows the system locale; pin the language of the asserted texts.
await mkdir(join(directory, 'state'), { recursive: true })
await writeFile(join(directory, 'state/language'), 'es')
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
    mark(`launch ${attempt + 1}: start`)
    app = await electron.launch({ ...(process.argv[2] ? { executablePath: resolve(process.argv[2]), args: [] } : { args: [root] }), env, timeout: 60_000 })
    const page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    mark(`launch ${attempt + 1}: window ready`)
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
    const mcp = JSON.parse(await managedFile(join(directory, 'home/.gemini/config/mcp_config.json'), text => Boolean(JSON.parse(text).mcpServers?.hub?.command)))
    assert.ok(mcp.mcpServers.hub.command, 'Packaged gateway command must be configured')
    const hooks = JSON.parse(await managedFile(join(directory, 'home/.gemini/config/hooks.json'), text => {
      const entry = JSON.parse(text)['agenthub-memory']
      return Boolean(entry?.PreToolUse?.[0]?.hooks?.[0]?.command && entry?.Stop?.[0]?.command)
    }))['agenthub-memory']
    const hookOutput = await new Promise((resolve, reject) => {
      const child = exec(hooks.PreToolUse[0].hooks[0].command, { env, windowsHide: true, timeout: 15_000 },
        (error, stdout) => error ? reject(error) : resolve(stdout))
      child.stdin.end(JSON.stringify({ conversationId: `smoke-${attempt}`, workspacePaths: [directory],
        toolCall: { name: 'mcp_hub_memory_context', args: {} } }))
    })
    assert.deepEqual(JSON.parse(hookOutput), { decision: 'allow' }, 'Native hook must run from the installed executable')
    for (const variant of ['config', 'antigravity-cli']) {
      assert.match(await managedFile(join(directory, 'home/.gemini', variant, 'skills/memory/SKILL.md'), text => /name:/.test(text)), /name:/)
    }
    await page.evaluate(() => { window.location.hash = '/clients' })
    // The row also holds the enable switch, so its title is the button that opens the client panel.
    await page.getByRole('button', { name: 'Antigravity', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Antigravity', exact: true })
    await panel.getByRole('heading', { name: 'Antigravity', exact: true, level: 2 }).waitFor()
    await panel.getByText('Sin confirmar', { exact: true }).waitFor()
    await panel.getByText('Abrí Antigravity CLI para recibir su uso; /usage actualiza la lectura.', { exact: true }).waitFor()
    console.log(`Desktop smoke ${attempt + 1}: global shortcut, renderer, session, memory and Antigravity integration ready; ${process.platform}/${process.arch}`)
    const closing = app; app = undefined
    await closeWithin(closing, join(directory, 'state/logs'), attempt)
  }
} finally {
  if (app) await app.close().catch(() => {})
  // CI uploads the app logs of this temporary profile as an artifact, also when the smoke fails.
  if (process.env.SMOKE_LOGS_DIR) await cp(join(directory, 'state/logs'), process.env.SMOKE_LOGS_DIR, { recursive: true }).catch(error => console.log(`[smoke] logs not copied: ${error.message}`))
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
