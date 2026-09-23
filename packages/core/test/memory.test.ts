import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ConnectionPool, RemoteHttpRuntime, GatewayServer, PolicyStore } from '@agenthub/gateway'
import { buildApp, type CoreApp } from '../src/app.js'
import { ensureLocalOwner } from '../src/local.js'
import { computeSnapshot } from '../src/policy/resolver.js'
import { createAccessToken } from '../src/security.js'

describe.skipIf(!process.env.AGENTHUB_MEMORY_TEST_URL)('memoria HTTP y gateway MCP', () => {
  let app: CoreApp, directory: string, token: string, owner: ReturnType<typeof ensureLocalOwner>
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'memory-core-'))
    vi.stubEnv('AGENTHUB_MEMORY_DATABASE_URL', process.env.AGENTHUB_MEMORY_TEST_URL!)
    vi.stubEnv('AGENTHUB_MEMORY_DIR', join(directory, 'memory'))
    vi.stubEnv('AGENTHUB_MEMORY_WORKER', '0')
    app = buildApp({ settings: { localMode: true, starterCatalog: false, databasePath: join(directory, 'hub.db') } })
    owner = ensureLocalOwner(app.store)
    token = await createAccessToken(app.settings, owner.id)
  })
  afterEach(async () => { await app?.fastify.close(); app?.db.close(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs() })
  it('exige sesión local y no entrega credenciales al consultar configuración', async () => {
    const denied = await app.fastify.inject({ method: 'GET', url: '/api/memory/status' })
    expect(denied.statusCode).toBe(401)
    expect((await app.fastify.inject({ method: 'POST', url: '/api/memory/search', payload: { query: 'privado' } })).statusCode).toBe(401)
    expect((await app.fastify.inject({ method: 'GET', url: '/api/memory/opencode' })).statusCode).toBe(401)
    expect((await app.fastify.inject({ method: 'POST', url: '/api/memory/opencode/test', payload: { model: 'opencode/big-pickle' } })).statusCode).toBe(401)
    const saved = await app.fastify.inject({ method: 'PUT', url: '/api/memory/credentials/deepseek', headers: { authorization: `Bearer ${token}` }, payload: { api_key: 'private-mcp-key' } })
    expect(saved.statusCode).toBe(200)
    const status = await app.fastify.inject({ method: 'GET', url: '/api/memory/status', headers: { authorization: `Bearer ${token}` } })
    expect(status.json().ready).toBe(true); expect(status.json().deepseek_configured).toBe(true)
    expect(status.body).not.toContain('private-mcp-key')
    const invalid = await app.fastify.inject({ method: 'POST', url: '/api/memory/call', headers: { authorization: `Bearer ${token}` }, payload: { operation: 'create_entity', input: { kind: 'project', title: '' } } })
    expect(invalid.statusCode).toBe(422)
    const credentialDenied = await app.fastify.inject({ method: 'POST', url: '/api/memory/mcp', headers: { authorization: `Bearer ${token}` }, payload: {} })
    expect(credentialDenied.statusCode).toBe(401)
  })
  it('instala la skill de memoria de fábrica para todos los clientes, la actualiza con la app y respeta ediciones y borrados', async () => {
    const skills = await app.fastify.inject({ method: 'GET', url: '/api/catalog/skills', headers: { authorization: `Bearer ${token}` } })
    const skill = skills.json().find((s: any) => s.slug === 'memory')
    expect(skill).toBeTruthy()
    expect(skill.body).toContain('memory_search'); expect(skill.body).toContain('memory_review_duplicate'); expect(skill.body).not.toMatch(/^---/)
    const machine = app.store.insertMachine({ user_id: owner.id, hostname: 'skill-test', os: 'test', daemon_version: 'test' })
    const agent = app.store.insertAgent({ machine_id: machine.id, cli_kind: 'kiro', cli_version: 'test', config_path: '' })
    expect(computeSnapshot(app.store, agent.id).skills.map(s => s.slug).sort()).toEqual(['google-setup', 'memory'])
    // A newer app ships a different body: it replaces the untouched copy and bumps the version.
    app.store.updateSkill(skill.id, { body: 'cuerpo de una versión anterior', content_hash: 'hash-anterior' })
    app.store.setSetting('memory_skill_hash', 'hash-anterior')
    await app.fastify.close(); app.db.close()
    app = buildApp({ settings: { localMode: true, starterCatalog: false, databasePath: join(directory, 'hub.db') } })
    const updated = app.store.skill(skill.id)!
    expect(updated.version).toBe(2); expect(updated.body).toContain('memory_search')
    // A personal edit survives restarts, and a deletion is final.
    const edited = await app.fastify.inject({ method: 'PATCH', url: `/api/catalog/skills/${skill.id}`, headers: { authorization: `Bearer ${token}` }, payload: { body: 'Mis propias instrucciones' } })
    expect(edited.statusCode).toBe(200)
    await app.fastify.close(); app.db.close()
    app = buildApp({ settings: { localMode: true, starterCatalog: false, databasePath: join(directory, 'hub.db') } })
    expect(app.store.skill(skill.id)!.body).toBe('Mis propias instrucciones')
    await app.fastify.inject({ method: 'DELETE', url: `/api/catalog/skills/${skill.id}`, headers: { authorization: `Bearer ${token}` } })
    await app.fastify.close(); app.db.close()
    app = buildApp({ settings: { localMode: true, starterCatalog: false, databasePath: join(directory, 'hub.db') } })
    expect(app.store.skillsOfUser(owner.id).some(s => s.slug === 'memory')).toBe(false)
  })

  it('crea un proyecto por MCP real y apagar la tool bloquea la llamada siguiente en la misma sesión', async () => {
    const base = await app.fastify.listen({ host: '127.0.0.1', port: 0 })
    const server = app.store.serverBySlug(owner.id, 'memory')!
    app.store.updateServer(server.id, { url: `${base}/api/memory/mcp` })
    const machine = app.store.insertMachine({ user_id: owner.id, hostname: 'memory-test', os: 'test', daemon_version: 'test' })
    const agent = app.store.insertAgent({ machine_id: machine.id, cli_kind: 'claude_code', cli_version: 'test', config_path: '' })
    const policy = new PolicyStore(agent.id)
    policy.apply(computeSnapshot(app.store, agent.id))
    const pool = new ConnectionPool({ http: new RemoteHttpRuntime() })
    const gateway = new GatewayServer(agent.id, policy, pool)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'memory-test', version: '1' })
    try {
      await Promise.all([gateway.connect(serverTransport), client.connect(clientTransport)])
      const tools = (await client.listTools()).tools
      const createName = tools.find(t => t.name.endsWith('create_entity'))!.name
      const result = await client.callTool({ name: createName, arguments: { kind: 'project', title: 'Proyecto creado por MCP' } })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      const data = JSON.parse((result.content as { text: string }[])[0]!.text)
      expect(data.kind).toBe('project')
      const tool = app.store.toolsOfServer(server.id).find(t => t.name === 'create_entity')!
      const disabled = await app.fastify.inject({ method: 'PUT', url: '/api/policy/rules', headers: { authorization: `Bearer ${token}` }, payload: { scope: 'user', resource_type: 'mcp_tool', resource_id: tool.id, state: 'off' } })
      expect(disabled.statusCode).toBe(204)
      policy.apply(computeSnapshot(app.store, agent.id))
      const denied = await client.callTool({ name: createName, arguments: { kind: 'project', title: 'No debe crearse' } })
      expect(denied.isError).toBe(true)
      const list = await app.fastify.inject({ method: 'POST', url: '/api/memory/call', headers: { authorization: `Bearer ${token}` }, payload: { operation: 'list_entities', input: { kind: 'project', query: 'No debe crearse' } } })
      expect(list.json().total).toBe(0)
    } finally { await client.close(); await gateway.close(); await pool.close() }
  }, 20_000)
})
