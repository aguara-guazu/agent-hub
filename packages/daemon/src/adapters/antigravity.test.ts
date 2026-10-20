import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { PolicySnapshot } from '@agenthub/shared'
import { AntigravityAdapter } from './antigravity.js'
import { GeminiCliAdapter } from './gemini_cli.js'
import { applyChanges, canonicalDigest, Manifest, manifestKey, region } from './atomic.js'
import { gatewayEndpoint } from './base.js'
import { DaemonApp, detectClis, normalizeToolName } from '../app.js'
import { loadConfig } from '../config.js'
import { planMemoryHooks } from './memory-hooks.js'

let home: string
const adapter = new AntigravityAdapter()
const endpoint = gatewayEndpoint({ command: '/app with spaces/node', args: ['/app/cli.js', 'gateway', '--agent', 'a', '--state-dir', '/data Pérez/#%20'] })
const snapshot = { cli_kind: 'antigravity', servers: [{ tools: [{ name: 'finish_notes' }] }], skills: [
  { id: 's', slug: 'memory', display_name: 'Memory', description: 'Memory instructions', body: 'Remember.', version: 1, content_hash: 'h' },
] } as PolicySnapshot
function json(path: string) { return JSON.parse(readFileSync(path, 'utf8')) }
function write(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)) }
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'antigravity Pérez #%20-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

it('detecta Antigravity sin confundirlo con Gemini CLI, incluso después de materializar skills', () => {
  mkdirSync(join(home, '.gemini'), { recursive: true })
  expect(detectClis(home).found).toEqual([])
  mkdirSync(join(home, '.gemini/antigravity-ide'))
  expect(detectClis(home).found.map(c => c.cliKind)).toEqual(['antigravity'])
  applyChanges(adapter.plan(snapshot, endpoint, home))
  expect(detectClis(home).found.map(c => c.cliKind)).toEqual(['antigravity'])
  write(join(home, '.gemini/settings.json'), {})
  expect(detectClis(home).found.map(c => c.cliKind)).toEqual(['gemini_cli', 'antigravity'])
})

it('conserva configuración personal, soporta stdio/HTTP e informa modificaciones ajenas', () => {
  const path = adapter.configPath(home)
  const personal = { command: 'personal' }
  write(path, { mcpServers: { personal }, preference: true })
  const [changes, drift] = adapter.planDetailed(snapshot, endpoint, home)
  expect(drift).toEqual([])
  expect(applyChanges(changes).drift).toEqual([])
  expect(json(path)).toEqual({ preference: true, mcpServers: { personal, hub: { command: endpoint.command, args: endpoint.args } } })
  expect(adapter.plan(snapshot, endpoint, home)).toEqual([])
  expect(adapter.serverEntry(gatewayEndpoint({ transport: 'http', url: 'http://localhost/mcp', headers: { Authorization: 'Bearer local' } })))
    .toEqual({ serverUrl: 'http://localhost/mcp', headers: { Authorization: 'Bearer local' } })
  const edited = json(path); edited.mcpServers.hub.command = 'my-edit'; write(path, edited)
  expect(adapter.planDetailed(snapshot, endpoint, home)[1]).toHaveLength(1)
  expect(adapter.readDrift(home).items).toHaveLength(1)
  expect(json(path).mcpServers.hub.command).toBe('my-edit')
})

it('mantiene conectadas configuraciones antiguas sin mover ni borrar sus preferencias', () => {
  const legacy = join(home, '.gemini/antigravity/mcp_config.json')
  write(legacy, { mcpServers: { mine: { command: 'mine' } } })
  applyChanges(adapter.plan(snapshot, endpoint, home))
  expect(json(legacy).mcpServers.mine).toEqual({ command: 'mine' })
  expect(json(legacy).mcpServers.hub).toEqual(json(adapter.configPath(home)).mcpServers.hub)
  expect(existsSync(join(home, '.gemini/antigravity/skills/memory/SKILL.md'))).toBe(true)
  // Migrating the MCP file must not strand managed skills in a still-readable legacy root.
  rmSync(legacy)
  applyChanges(adapter.plan({ ...snapshot, skills: [] }, endpoint, home))
  expect(existsSync(join(home, '.gemini/antigravity/skills/memory'))).toBe(false)
})

it('apaga skills de todas las variantes sin afectar Gemini ni skills personales', () => {
  const gemini = new GeminiCliAdapter()
  applyChanges(gemini.plan({ ...snapshot, cli_kind: 'gemini_cli' }, endpoint, home))
  applyChanges(adapter.plan(snapshot, endpoint, home))
  for (const root of adapter.skillsRoots(home)) {
    expect(readFileSync(join(root, 'memory/SKILL.md'), 'utf8')).toContain('Remember.')
    write(join(root, 'personal/SKILL.md'), 'mine')
  }
  applyChanges(adapter.plan({ ...snapshot, skills: [] }, endpoint, home))
  for (const root of adapter.skillsRoots(home)) {
    expect(existsSync(join(root, 'memory'))).toBe(false)
    expect(existsSync(join(root, 'personal/SKILL.md'))).toBe(true)
  }
  expect(readFileSync(join(home, '.gemini/skills/memory/SKILL.md'), 'utf8')).toContain('Remember.')
  expect(normalizeToolName('mcp_hub_memory_context')).toBe('memory_context')
})

it('instala hooks con esquema nativo, preserva otros hooks y respeta ediciones y desactivación', () => {
  const path = join(home, '.gemini/config/hooks.json')
  const personal = { Stop: [{ command: 'echo personal' }] }
  write(path, { personal })
  expect(applyChanges(planMemoryHooks(snapshot, endpoint, home)[0]).drift).toEqual([])
  const current = json(path), hooks = current['agenthub-memory']
  expect(current.personal).toEqual(personal)
  expect(hooks.PreToolUse[0].matcher).toBe('^mcp_hub_.*')
  expect(hooks.Stop[0].type).toBe('command')
  const command = hooks.Stop[0].command as string
  const encoded = /-EncodedCommand\s+(\S+)/.exec(command)?.[1]
  const decoded = encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : command
  expect(decoded).toContain('--hook-event')
  expect(decoded).toContain('Stop')
  expect(planMemoryHooks(snapshot, endpoint, home)[0]).toEqual([])
  hooks.Stop[0].command += ' user edit'; write(path, current)
  expect(planMemoryHooks(snapshot, endpoint, home)[1]).toHaveLength(1)
  hooks.Stop[0].command = command; write(path, current)
  applyChanges(planMemoryHooks({ ...snapshot, servers: [] }, endpoint, home)[0])
  expect(json(path)).toEqual({ personal, 'agenthub-memory': { enabled: false } })
})

const windowsEndpoint = (id: string) => gatewayEndpoint({
  command: 'C:\\Program Files\\Agent Hub\\Agent Hub.exe',
  args: ['C:\\Program Files\\Agent Hub\\resources\\app\\desktop\\dist\\entry.js',
    '--agenthub-headless', 'gateway', '--agent', id, '--state-dir', 'C:\\Users\\Pérez\\AppData\\Roaming\\Agent Hub'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
})
const mcpRegion = region('json_value', ['mcpServers', 'hub'])

it('repara una copia exacta de Gemini registrado y conserva Blender, preferencias y respaldo', () => {
  const target = windowsEndpoint('antigravity-id'), gemini = windowsEndpoint('gemini-id')
  const path = adapter.configPath(home)
  const original = { mcpServers: { hub: adapter.serverEntry(gemini), blender: { command: 'uvx', args: ['blender-mcp'] } }, theme: 'dark' }
  write(path, original)
  const [changes, drift] = adapter.planDetailed(snapshot, target, home, { geminiEndpoints: [gemini] })
  expect(drift).toEqual([])
  expect(Manifest.load(home).digestFor(path, mcpRegion)).toBeNull()
  const result = applyChanges(changes)
  expect(result.drift).toEqual([])
  expect(json(path)).toEqual({ ...original, mcpServers: { ...original.mcpServers, hub: adapter.serverEntry(target) } })
  expect(json(result.backups[path]!)).toEqual(original)
  const manifest = Manifest.load(home)
  expect(manifest.files[manifestKey(path, mcpRegion)]).toBe(canonicalDigest(adapter.serverEntry(target)))
  expect(adapter.readDrift(home).items).toEqual([])
  expect(adapter.planDetailed(snapshot, target, home, { geminiEndpoints: [gemini] })).toEqual([[], []])
})

it('registra una entrada correcta sin reescribirla y permite la próxima actualización del gateway', () => {
  const path = adapter.configPath(home), original = JSON.stringify({ mcpServers: { hub: adapter.serverEntry(endpoint) } }, null, 4)
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, original)
  const changes = adapter.plan(snapshot, endpoint, home)
  expect(changes.find(change => change.path === path)?.action).toBe('adopt')
  expect(applyChanges(changes).adopted).toContain(path)
  expect(readFileSync(path, 'utf8')).toBe(original)
  expect(Manifest.load(home).digestFor(path, mcpRegion)).toBe(canonicalDigest(adapter.serverEntry(endpoint)))
  const upgraded = gatewayEndpoint({ ...endpoint, command: '/updated/node' })
  expect(applyChanges(adapter.plan(snapshot, upgraded, home)).drift).toEqual([])
  expect(json(path).mcpServers.hub.command).toBe('/updated/node')
})

it.each(['unknown-agent', 'custom-command', 'extra-option', 'custom-env', 'managed-edit'])(
  'mantiene protección de contenido ajeno: %s', variant => {
    const target = windowsEndpoint('antigravity-id'), gemini = windowsEndpoint('gemini-id')
    const path = adapter.configPath(home)
    if (variant === 'managed-edit') applyChanges(adapter.plan(snapshot, target, home))
    const copied = adapter.serverEntry(gemini)
    if (variant === 'unknown-agent') copied.args = windowsEndpoint('unregistered').args
    if (variant === 'custom-command') copied.command = 'custom-command.exe'
    if (variant === 'extra-option') copied.disabled = true
    if (variant === 'custom-env') copied.env = { ...gemini.env, PERSONAL: 'keep' }
    write(path, { mcpServers: { hub: copied } })
    const before = readFileSync(path, 'utf8')
    const [changes, drift] = adapter.planDetailed(snapshot, target, home, { geminiEndpoints: [gemini] })
    expect(drift).toHaveLength(1)
    expect(changes.some(change => change.path === path)).toBe(false)
    applyChanges(changes)
    expect(readFileSync(path, 'utf8')).toBe(before)
  },
)

it.each(['repair', 'adopt'])('detecta cambios concurrentes antes de %s', action => {
  const target = windowsEndpoint('antigravity-id'), gemini = windowsEndpoint('gemini-id')
  const path = adapter.configPath(home)
  write(path, { mcpServers: { hub: adapter.serverEntry(action === 'repair' ? gemini : target) } })
  const [changes] = adapter.planDetailed(snapshot, target, home, { geminiEndpoints: [gemini] })
  const edited = { mcpServers: { hub: { command: 'personal.exe' } } }
  write(path, edited)
  const result = applyChanges(changes)
  expect(result.skipped).toContain(path)
  expect(result.drift).toHaveLength(1)
  expect(json(path)).toEqual(edited)
  expect(Manifest.load(home).digestFor(path, mcpRegion)).toBeNull()
})

it('el daemon obtiene candidatos de su registro de Gemini; plan no escribe y apply registra el hash', async () => {
  const app = new DaemonApp(loadConfig({ home, stateDir: join(home, 'state'), local: true }))
  app.state.saveAgents([{ id: 'gemini', cli_kind: 'gemini_cli' }, { id: 'antigravity', cli_kind: 'antigravity' }])
  app.state.saveSnapshot({ ...snapshot, agent_instance_id: 'antigravity', snapshot_hash: 'test' })
  const gemini = app.endpointFor(app.cachedAgents().find(agent => agent.id === 'gemini')!)
  const target = app.endpointFor(app.cachedAgents().find(agent => agent.id === 'antigravity')!)
  const path = adapter.configPath(home)
  write(path, { mcpServers: { hub: adapter.serverEntry(gemini), blender: { command: 'blender' } } })
  const before = readFileSync(path, 'utf8')
  const report = await app.syncOnce({ apply: false })
  const pass = report.agents.find(agent => agent.agent.id === 'antigravity')!
  expect(pass.drift).toEqual([])
  expect(readFileSync(path, 'utf8')).toBe(before)
  // Apply only the MCP plan here: hook writes are planned separately after MCP edits.
  const change = pass.changes.find(change => change.path === path)!
  expect(applyChanges([change]).drift).toEqual([])
  expect(json(path).mcpServers.hub).toEqual(adapter.serverEntry(target))
  expect(json(path).mcpServers.blender).toEqual({ command: 'blender' })
  expect(Manifest.load(home).digestFor(path, mcpRegion)).not.toBeNull()
})
