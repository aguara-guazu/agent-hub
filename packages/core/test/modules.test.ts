import { computeSnapshot } from '../src/policy/resolver.js'
import { applyProbeResult, MEMORY_CATALOG_SERVER_SETTING } from '../src/catalog/reconcile.js'
import { memoryTools } from '@agenthub/memory'
import { appModules, operationModules } from '@agenthub/shared/modules'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { buildApp, type CoreApp } from '../src/app.js'
import { ensureLocalOwner } from '../src/local.js'
import { createAccessToken } from '../src/security.js'

let app: CoreApp, directory: string, headers: { authorization: string }
function open() {
  return buildApp({ settings: { localMode: true, starterCatalog: false, databasePath: join(directory, 'hub.db') } })
}
async function close() { await app.fastify.close(); app.db.close() }
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'hub-modules-'))
  vi.stubEnv('AGENTHUB_MEMORY_DIR', join(directory, 'memory'))
  vi.stubEnv('AGENTHUB_MEMORY_WORKER', '0')
  app = open()
  headers = { authorization: 'Bearer ' + await createAccessToken(app.settings, ensureLocalOwner(app.store).id) }
})
afterEach(async () => { await close(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs() })

it('persists one module across restart and reopens its original catalog', async () => {
  const url = '/api/modules/skills'
  const put = (enabled: boolean) => app.fastify.inject({ method: 'PUT', url, headers, payload: { enabled } })
  const get = (url: string) => app.fastify.inject({ method: 'GET', url, headers })
  expect((await app.fastify.inject({ method: 'PUT', url, payload: { enabled: false } })).statusCode).toBe(401)
  const before = (await get('/api/catalog/skills')).json()
  expect((await put(false)).statusCode).toBe(200)
  await close()
  app = open()
  expect((await get('/api/catalog/skills')).json()).toMatchObject({ code: 'module_disabled', module: 'skills' })
  expect((await get('/api/catalog/servers')).statusCode).toBe(200)
  expect((await put(true)).statusCode).toBe(200)
  expect((await get('/api/catalog/skills')).json()).toEqual(before)
})

it('gates multiplexed memory operations independently of the scheduler and the settings API', async () => {
  await app.fastify.inject({ method: 'PUT', url: '/api/modules/memory', headers, payload: { enabled: false } })
  const call = await app.fastify.inject({ method: 'POST', url: '/api/memory/call', headers, payload: { operation: 'list_entities', input: {} } })
  expect(call.json()).toMatchObject({ code: 'module_disabled' })
  expect((await app.fastify.inject({ method: 'GET', url: '/api/memory/schedules', headers })).statusCode).toBe(200)
  expect((await app.fastify.inject({ method: 'GET', url: '/api/modules', headers })).statusCode).toBe(200)
})

it('keeps legacy automation settings, rejects malformed switches and protects the owner controls', async () => {
  const update = (id: string, payload: object) => app.fastify.inject({ method: 'PUT', url: '/api/modules/' + id, headers, payload })
  expect((await update('other', { enabled: true })).statusCode).toBe(404)
  expect((await update('skills', { enabled: 'no' })).statusCode).toBe(422)
  expect((await update('memory', { enabled: false, extra: true })).statusCode).toBe(422)
  app.store.setSetting('automations_enabled', '0')
  expect((await app.fastify.inject({ method: 'GET', url: '/api/modules', headers })).json()).toMatchObject({ schedules: false, memory: true, agents: true })
  expect((await update('schedules', { enabled: true })).statusCode).toBe(200)
  expect((await app.fastify.inject({ method: 'GET', url: '/api/automations', headers })).json()).toMatchObject({ automations_enabled: true })
})

it('keeps policy and bundled tool definitions through an off, discovery and on cycle', async () => {
  const owner = ensureLocalOwner(app.store)
  const machine = app.store.insertMachine({ user_id: owner.id, hostname: 'test', os: 'test', daemon_version: 'test' })
  const agent = app.store.insertAgent({ machine_id: machine.id, cli_kind: 'codex_cli', cli_version: 'test', config_path: '' })
  const server = app.store.server(app.store.setting(MEMORY_CATALOG_SERVER_SETTING)!)!
  const catalog = app.store.toolsOfServer(server.id)
  const tools = () => computeSnapshot(app.store, agent.id).servers.find(s => s.id === server.id)!.tools.map(tool => tool.name)
  const toggle = (enabled: boolean) => app.fastify.inject({ method: 'PUT', url: '/api/modules/memory', headers, payload: { enabled } })
  expect(tools()).toContain('list_entities')
  await toggle(false)
  const visible = tools()
  expect(visible).toContain('schedule_list')
  expect(visible).not.toContain('list_entities')
  applyProbeResult(app.store, server, { ok: true, error: '', auth_required: false, server_name: 'memory', server_version: '1',
    tools: catalog.filter(tool => visible.includes(tool.name)) })
  await toggle(true)
  expect(tools()).toContain('list_entities')
})

it('assigns every bundled tool to a module or a shared system function', () => {
  const system = ['diagnostic_report', 'hub_stop_confirm', 'list_jobs', 'retry_job', 'cancel_job', 'processing_status']
  expect(memoryTools.map(tool => tool.name).filter(name => !operationModules(name).length).sort()).toEqual(system.sort())
})

it('keeps the shell reachable with every module off and restores a single module in isolation', async () => {
  const toggle = (id: string, enabled: boolean) => app.fastify.inject({ method: 'PUT', url: '/api/modules/' + id, headers, payload: { enabled } })
  for (const { id } of appModules) expect((await toggle(id, false)).statusCode).toBe(200)
  const state = await app.fastify.inject({ method: 'GET', url: '/api/modules', headers })
  expect(state.json()).toEqual({ ...Object.fromEntries(appModules.map(({ id }) => [id, false])), can_manage: true })
  const get = (url: string) => app.fastify.inject({ method: 'GET', url, headers })
  expect((await get('/api/auth/me')).statusCode).toBe(200)
  expect((await get('/api/memory/interhub/orphans')).json()).toMatchObject({ code: 'module_disabled' })
  expect((await app.fastify.inject({ method: 'GET', url: '/api/catalog/skills' })).statusCode).toBe(401)
  expect((await toggle('skills', true)).json()).toMatchObject({ skills: true, mcp: false, memory: false })
  expect((await get('/api/catalog/skills')).statusCode).toBe(200)
  await toggle('memory', true)
  expect((await get('/api/memory/projects/any/repositories/branches')).json()).toMatchObject({ code: 'module_disabled', module: 'schedules' })
})

it('desactiva y reactiva la consulta de proveedores de extracción conservando el catálogo MCP', async () => {
  const pkg = join(directory, 'node_modules', '@anthropic-ai', 'claude-code')
  mkdirSync(pkg, { recursive: true })
  const reply = { type: 'control_response', response: { subtype: 'success', request_id: 'models', response: { models: [{ value: 'fixture' }] } } }
  writeFileSync(join(pkg, 'cli.js'), `process.stdin.once('data', () => console.log(JSON.stringify(${JSON.stringify(reply)})))`)
  vi.stubEnv('PATH', directory + delimiter + process.env.PATH)
  for (const enabled of [true, false, true]) {
    await app.fastify.inject({ method: 'PUT', url: '/api/modules/memory', headers, payload: { enabled } })
    const response = await app.fastify.inject({ method: 'GET', url: '/api/memory/extraction-cli/claude_code', headers })
    expect(response.json()).toMatchObject(enabled ? { installed: true, models: [{ id: 'fixture' }] } : { code: 'module_disabled', module: 'memory' })
    expect((await app.fastify.inject({ method: 'GET', url: '/api/catalog/servers', headers })).statusCode).toBe(200)
  }
})
