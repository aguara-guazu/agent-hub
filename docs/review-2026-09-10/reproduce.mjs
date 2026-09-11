// Run after npm run build: node docs/review-2026-09-10/reproduce.mjs
// Requires the user's local Escalidrau at :3580. Uses a disposable hub and HOME tree.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import toml from '@iarna/toml'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { DaemonApp, detectClis } from '../../packages/daemon/dist/app.js'
import { loadConfig } from '../../packages/daemon/dist/config.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const scratch = mkdtempSync(join(tmpdir(), 'agenthub-review-'))
const home = join(scratch, 'home')
const state = join(scratch, 'state')
const children = []
const clients = []
const evidence = { date: new Date().toISOString(), checks: [] }
function record(check, result) {
  evidence.checks.push({ check, ...result })
  console.log(JSON.stringify({ check, ...result }))
}
async function stop(child) {
  const signal = value => {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, value)
      else child.kill(value)
    } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  if (child.exitCode !== null || child.signalCode !== null) { signal('SIGTERM'); return }
  const exited = once(child, 'exit')
  signal('SIGTERM')
  if (!await Promise.race([exited.then(() => true), delay(2000).then(() => false)])) {
    signal('SIGKILL')
    await exited
  }
}
function launch(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: scratch, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(child)
  // Drain diagnostics but do not log potential credentials or private configuration.
  child.stderr.on('data', () => {})
  return child
}
async function gateway(entry) {
  const client = new Client({ name: 'agenthub-review', version: '1.0.0' })
  clients.push(client)
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, stderr: 'pipe' }))
  return client
}
async function codexRpc(entry) {
  const child = launch('codex', ['app-server', '-c', `mcp_servers.hub.command=${JSON.stringify(entry.command)}`,
    '-c', `mcp_servers.hub.args=${JSON.stringify(entry.args)}`])
  const pending = new Map()
  let seq = 0
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
    }
  })
  const notify = (method, params) => child.stdin.write(JSON.stringify({ method, params }) + '\n')
  const request = async (method, params) => {
    const id = ++seq
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    const timeout = AbortSignal.timeout(30_000)
    return Promise.race([response, new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error(`timeout: ${method}`)), { once: true }))])
  }
  await request('initialize', { clientInfo: { name: 'agenthub_review', version: '1.0.0' }, capabilities: { experimentalApi: true } })
  notify('initialized', {})
  return { request, child }
}

try {
  for (const dir of ['.claude', '.codex', '.kiro']) mkdirSync(join(home, dir), { recursive: true })
  mkdirSync(state, { recursive: true })
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const bootstrap = 'review-bootstrap-' + 'x'.repeat(32)
  const core = launch(process.execPath, [join(root, 'packages/core/dist/server.js')], {
    ...process.env, AGENTHUB_HUB_HOST: '127.0.0.1', AGENTHUB_HUB_PORT: String(port),
    AGENTHUB_LOCAL_MODE: '1', AGENTHUB_DATABASE_PATH: join(state, 'hub.db'),
    AGENTHUB_JWT_SECRET: 'review-jwt-' + 'y'.repeat(32), AGENTHUB_DESKTOP_BOOTSTRAP_TOKEN: bootstrap,
  })
  core.stdout.on('data', () => {})
  let ready = false
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(base + '/health')).ok) { ready = true; break } } catch { /* starting */ }
    await delay(50)
  }
  if (!ready) throw new Error('Review core did not start')
  const session = await fetch(base + '/api/auth/desktop-session', { method: 'POST', headers: { Authorization: `Bearer ${bootstrap}` } }).then(r => r.json())
  async function api(path, method = 'GET', body) {
    const response = await fetch(base + '/api' + path, { method, headers: { Authorization: `Bearer ${session.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`)
    return response.status === 204 ? null : response.json()
  }
  const daemon = new DaemonApp(loadConfig({ home, stateDir: state, controlPlaneUrl: base, local: true }), { maxAttempts: 1 })
  await daemon.enrollLocal(bootstrap, 'disposable-review')
  const server = await api('/catalog/servers', 'POST', { slug: 'review-escalidrau', display_name: 'Review Escalidrau', transport: 'http', url: 'http://127.0.0.1:3580/mcp', requires_host_access: true })
  const probed = await api(`/catalog/servers/${server.id}/probe`, 'POST')
  record('real_upstream_probe', { tools: probed.tools?.length, status: probed.probe_status })
  await api(`/catalog/servers/${server.id}/approve`, 'POST')
  const skill = await api('/catalog/skills', 'POST', { slug: 'hub-review-marker', display_name: 'Review marker', description: 'Harmless review fixture', body: 'Use only to verify Agent Hub skill synchronization.' })
  await daemon.syncOnce({ apply: true, wait: 0 })
  const agents = daemon.cachedAgents()
  const entries = {
    claude_code: JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.hub,
    codex_cli: toml.parse(readFileSync(join(home, '.codex/config.toml'), 'utf8')).mcp_servers.hub,
    kiro: JSON.parse(readFileSync(join(home, '.kiro/settings/mcp.json'), 'utf8')).mcpServers.hub,
  }
  const opened = {}
  let toolName
  for (const [kind, entry] of Object.entries(entries)) {
    const client = await gateway(entry)
    opened[kind] = client
    const tools = (await client.listTools()).tools
    toolName = tools.find(t => t.name.endsWith('_get_canvas_style'))?.name
    if (!toolName) throw new Error('Read-only Escalidrau tool missing')
    const result = await client.callTool({ name: toolName, arguments: {} })
    record('gateway_initial_read', { cli: kind, tools: tools.length, isError: result.isError ?? false })
  }
  let codex
  let threadId
  try {
    codex = await codexRpc(entries.codex_cli)
    const thread = await codex.request('thread/start', { cwd: scratch, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' })
    threadId = thread.thread.id
    const listed = await codex.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' })
    const hub = listed.data.find(s => s.name === 'hub')
    const result = await codex.request('mcpServer/tool/call', { threadId, server: 'hub', tool: toolName, arguments: {} })
    record('codex_real_tool_call', { tools: Object.keys(hub?.tools ?? {}).length, isError: result.isError ?? false, contentTypes: result.content?.map(c => c.type) })
  } catch (error) { record('codex_real_tool_call', { error: error.message }) }
  // Wait until all watchers have started; test successive atomic replacements in the same sessions.
  await delay(1000)
  for (const stateValue of ['off', 'on', 'off']) {
    await api('/policy/rules', 'PUT', { scope: 'user', resource_type: 'mcp_server', resource_id: server.id, state: stateValue })
    await daemon.syncOnce({ apply: true, wait: 0 })
    await delay(1500)
    for (const [kind, client] of Object.entries(opened)) {
      const agent = agents.find(a => a.cliKind === kind)
      const snapshot = daemon.state.loadSnapshot(agent.id)
      const result = await client.callTool({ name: toolName, arguments: {} })
      record('same_session_toggle', { cli: kind, state: stateValue, diskServers: snapshot.servers.length, isError: result.isError ?? false })
    }
    if (codex && threadId) {
      try {
        const result = await codex.request('mcpServer/tool/call', { threadId, server: 'hub', tool: toolName, arguments: {} })
        record('codex_same_thread_toggle', { state: stateValue, isError: result.isError ?? false })
      } catch (error) { record('codex_same_thread_toggle', { state: stateValue, error: error.message }) }
    }
  }
  const fresh = await gateway(entries.codex_cli)
  record('fresh_session_off', { tools: (await fresh.listTools()).tools.length, isError: (await fresh.callTool({ name: toolName, arguments: {} })).isError ?? false })
  // Prime the watch with a non-revoking update, then revoke: can stale policy allow execution?
  await api('/policy/rules', 'PUT', { scope: 'user', resource_type: 'mcp_server', resource_id: server.id, state: 'on' })
  await daemon.syncOnce({ apply: true, wait: 0 })
  const primed = await gateway(entries.codex_cli)
  await primed.listTools()
  await delay(1000)
  await api(`/catalog/skills/${skill.id}`, 'PATCH', { body: 'Updated harmless review fixture.' })
  await daemon.syncOnce({ apply: true, wait: 0 })
  await delay(1500)
  await api('/policy/rules', 'PUT', { scope: 'user', resource_type: 'mcp_server', resource_id: server.id, state: 'off' })
  await daemon.syncOnce({ apply: true, wait: 0 })
  await delay(1500)
  const afterRevoke = await primed.callTool({ name: toolName, arguments: {} })
  record('revocation_after_prior_snapshot_update', { diskServers: daemon.state.loadSnapshot(agents.find(a => a.cliKind === 'codex_cli').id).servers.length, isError: afterRevoke.isError ?? false, returnedUpstreamStyle: afterRevoke.content?.some(c => c.type === 'text' && c.text.includes('presets')) })
  const codexAgent = agents.find(a => a.cliKind === 'codex_cli')
  await api('/policy/rules', 'PUT', { scope: 'client', scope_id: codexAgent.id, resource_type: 'skill', resource_id: skill.id, state: 'off' })
  // One direct Codex pass exposes whether its cleanup deletes another client's backing file.
  const { adapterFor, applyChanges } = await import('../../packages/daemon/dist/adapters/index.js')
  const codexSnapshot = await api(`/policy/snapshot/${codexAgent.id}`)
  applyChanges(adapterFor('codex_cli').plan(codexSnapshot, daemon.endpointFor(codexAgent), home))
  record('skill_off_in_codex_only', { claudeStillEnabled: true, claudeReadable: existsSync(join(home, '.claude/skills/hub-review-marker/SKILL.md')), canonicalExists: existsSync(join(home, '.agenthub/skills/hub-review-marker/SKILL.md')) })
  // A CLI installed after enrollment is detected, but sync never registers it.
  mkdirSync(join(home, '.gemini'), { recursive: true })
  await daemon.syncOnce({ apply: true, wait: 0 })
  record('new_cli_after_enrollment', { detected: detectClis(home).found.map(a => a.cliKind), registered: daemon.cachedAgents().map(a => a.cliKind), configWritten: existsSync(join(home, '.gemini/settings.json')) })
} catch (error) {
  record('harness_error', { error: error.message })
  process.exitCode = 1
} finally {
  for (const client of clients) await client.close().catch(() => {})
  for (const child of children.reverse()) await stop(child)
  rmSync(scratch, { recursive: true, force: true })
  writeFileSync(join(root, 'docs/review-2026-09-10/verification.json'), JSON.stringify(evidence, null, 2) + '\n')
}
