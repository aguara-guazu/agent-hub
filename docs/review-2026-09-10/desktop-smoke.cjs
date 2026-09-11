// Run from repository root after build:
// node_modules/.bin/electron docs/review-2026-09-10/desktop-smoke.cjs
// Exercises the compiled renderer in Electron against a disposable real core.
const { app, BrowserWindow } = require('electron')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { setTimeout: delay } = require('node:timers/promises')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-desktop-review-'))
app.setPath('userData', path.join(scratch, 'electron'))
const evidence = []
let core
let window
function record(check, values) { const entry = { check, ...values }; evidence.push(entry); console.log(JSON.stringify(entry)) }
async function until(check) {
  for (let n = 0; n < 150; n++) { if (await check()) return; await delay(100) }
  throw new Error('Timed out waiting for UI or core')
}
app.whenReady().then(async () => {
  const listener = net.createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const bootstrap = 'desktop-review-' + 'x'.repeat(32)
  core = spawn(process.execPath, [path.join(process.cwd(), 'packages/core/dist/server.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENTHUB_LOCAL_MODE: '1',
      AGENTHUB_HUB_HOST: '127.0.0.1', AGENTHUB_HUB_PORT: String(port),
      AGENTHUB_DATABASE_PATH: path.join(scratch, 'hub.db'),
      AGENTHUB_JWT_SECRET: 'desktop-jwt-' + 'y'.repeat(32),
      AGENTHUB_DESKTOP_BOOTSTRAP_TOKEN: bootstrap,
      AGENTHUB_CONSOLE_DIST: path.join(process.cwd(), 'frontend/dist') },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  await until(async () => { try { return (await fetch(base + '/health')).ok } catch { return false } })
  const session = await fetch(base + '/api/auth/desktop-session', { method: 'POST', headers: { Authorization: `Bearer ${bootstrap}` } }).then(r => r.json())
  const { windowOptions } = await import(path.join(process.cwd(), 'desktop/dist/window.js'))
  window = new BrowserWindow(windowOptions(path.join(process.cwd(), 'desktop/dist/preload.js'), ''))
  window.webContents.on('preload-error', (_event, _path, error) => record('preload_error', { message: error.message }))
  const evaluate = expression => window.webContents.executeJavaScript(expression)
  const click = async text => {
    const ok = await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!button) return false; button.click(); return true })()`)
    if (!ok) throw new Error('Button not found: ' + text)
    await delay(100)
  }
  const fill = async (id, value) => {
    await evaluate(`(() => {const e = document.getElementById(${JSON.stringify(id)}); const proto = e.tagName === 'SELECT' ? HTMLSelectElement.prototype : e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', {bubbles:true}));})()`)
    await delay(50)
  }
  const api = route => fetch(base + '/api' + route, { headers: { Authorization: `Bearer ${session.access_token}` } }).then(r => r.json())
  await window.loadURL(base + '?sso_token=' + encodeURIComponent(session.access_token))
  await until(() => evaluate(`[...document.querySelectorAll('a')].some(a => a.hash === '#/catalog')`))
  record('desktop_sso', { authenticated: true, bridge: await evaluate('typeof window.agentHub') })
  await evaluate('location.hash = "#/catalog"')
  await until(() => evaluate('document.body.textContent.includes("Nuevo MCP server")'))
  await click('Nuevo MCP server')
  await fill('server-slug', 'desktop-review')
  await fill('server-name', 'Escalidrau desktop review')
  await fill('server-transport', 'http')
  await fill('server-url', 'http://127.0.0.1:3580/mcp')
  await click('Crear server')
  await until(async () => (await api('/catalog/servers')).length === 1)
  record('desktop_create_server', { saved: true })
  record('catalog_actions', { buttons: await evaluate('[...document.querySelectorAll("button")].map(b=>({text:b.textContent.trim(),title:b.title,aria:b.getAttribute("aria-label")}))') })
  await click('Sondear')
  await until(async () => (await api('/catalog/servers'))[0]?.tools?.length === 21)
  record('desktop_probe_escalidrau', { tools: (await api('/catalog/servers'))[0].tools.length })
  await evaluate('location.hash = "#/skills"')
  await until(() => evaluate('document.body.textContent.includes("Nueva skill")'))
  await click('Nueva skill')
  await fill('skill-slug', 'desktop-review-skill')
  await fill('skill-name', 'Desktop review skill')
  await fill('skill-description', 'Harmless desktop review fixture')
  await fill('skill-body', 'Used only to verify the skill creation form.')
  await click('Crear skill')
  await until(async () => (await api('/catalog/skills')).length === 1)
  record('desktop_create_skill', { saved: true })
  for (const route of ['matrix', 'machines', 'users', 'audit']) {
    await evaluate(`location.hash = ${JSON.stringify('#/' + route)}`)
    await delay(500)
    record('desktop_route', { route, heading: await evaluate('document.querySelector("h1")?.textContent'), error: await evaluate('Boolean(document.querySelector(".error-state"))') })
  }
}).catch(error => {
  record('harness_error', { message: error.message })
  process.exitCode = 1
}).finally(async () => {
  if (window && !window.isDestroyed()) window.destroy()
  if (core && core.exitCode === null) {
    const exited = once(core, 'exit')
    core.kill('SIGTERM')
    if (!await Promise.race([exited.then(() => true), delay(2000).then(() => false)])) core.kill('SIGKILL')
    await exited
  }
  fs.writeFileSync(path.join(__dirname, 'desktop-evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  app.quit()
})
app.on('window-all-closed', () => {})
app.on('will-quit', () => fs.rmSync(scratch, { recursive: true, force: true }))
