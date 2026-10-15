import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { PolicySnapshot } from '@agenthub/shared'
import { AntigravityAdapter } from './antigravity.js'
import { GeminiCliAdapter } from './gemini_cli.js'
import { applyChanges } from './atomic.js'
import { gatewayEndpoint } from './base.js'
import { detectClis, normalizeToolName } from '../app.js'
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
