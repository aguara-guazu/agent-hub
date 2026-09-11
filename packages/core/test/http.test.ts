import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeApp, authHeader, type TestHarness } from './helpers.js'
import { hashPassword } from '../src/security.js'
import type { User } from '../src/types.js'

let app: TestHarness

/** Crea una organización con un owner que sí tiene contraseña local, y devuelve el JWT. */
async function loginAs(email: string, role: 'owner' | 'admin' | 'member' = 'owner'): Promise<{ user: User; token: string }> {
  const org = app.store.organizationBySlug('craftech') ?? app.store.insertOrganization('craftech', 'Craftech')
  const hash = await hashPassword('secreta')
  const user = app.store.insertUser({ organization_id: org.id, email, full_name: 'X', password_hash: hash, org_role: role })
  const res = await app.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'secreta' } })
  expect(res.statusCode).toBe(200)
  return { user, token: res.json().access_token }
}

beforeEach(() => {
  app = makeApp()
})

afterEach(() => {
  app.cleanup()
})

describe('auth', () => {
  it('login devuelve JWT + user; /auth/me lo resuelve', async () => {
    const { token } = await loginAs('owner@craftech.io')
    const me = await app.fastify.inject({ method: 'GET', url: '/api/auth/me', headers: authHeader(token) })
    expect(me.statusCode).toBe(200)
    expect(me.json().email).toBe('owner@craftech.io')
    expect(me.json().organization).toBe('Craftech')
  })

  it('credenciales inválidas dan 401 con un único mensaje', async () => {
    await loginAs('owner@craftech.io')
    const res = await app.fastify.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@craftech.io', password: 'mala' } })
    expect(res.statusCode).toBe(401)
  })

  it('sin Authorization, /auth/me da 401', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/api/auth/me' })
    expect(res.statusCode).toBe(401)
  })
})

describe('catalog: alcance personal', () => {
  it('crear un server ya es tenerlo, y aparece en la lista', async () => {
    const { token } = await loginAs('owner@craftech.io')
    const create = await app.fastify.inject({
      method: 'POST',
      url: '/api/catalog/servers',
      headers: authHeader(token),
      payload: { slug: 'ops', display_name: 'Ops', transport: 'stdio', command: 'node', args: ['-m', 'x'] },
    })
    expect(create.statusCode).toBe(201)
    const list = await app.fastify.inject({ method: 'GET', url: '/api/catalog/servers', headers: authHeader(token) })
    expect(list.json()).toHaveLength(1)
  })

  it('el server de otra persona responde 404, no 403', async () => {
    const owner = await loginAs('owner@craftech.io')
    const other = await loginAs('other@craftech.io', 'member')
    const create = await app.fastify.inject({
      method: 'POST',
      url: '/api/catalog/servers',
      headers: authHeader(owner.token),
      payload: { slug: 'ops', display_name: 'Ops', transport: 'stdio', command: 'node' },
    })
    const serverId = create.json().id
    const res = await app.fastify.inject({ method: 'PATCH', url: `/api/catalog/servers/${serverId}`, headers: authHeader(other.token), payload: { description: 'ajena' } })
    expect(res.statusCode).toBe(404)
  })

  it('rechaza un secreto pegado en secret_refs sin repetir el valor', async () => {
    const { token } = await loginAs('owner@craftech.io')
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/catalog/servers',
      headers: authHeader(token),
      payload: { slug: 'gh', display_name: 'GitHub', transport: 'http', url: 'http://x', secret_refs: { GITHUB_TOKEN: 'ghp_supersecreto' } },
    })
    expect(res.statusCode).toBe(422)
    expect(res.body).not.toContain('ghp_supersecreto')
  })
})

describe('policy: escritura de reglas', () => {
  it('rechaza campos desconocidos con 422 (cliente viejo que manda locked)', async () => {
    const { token, user } = await loginAs('owner@craftech.io')
    const create = await app.fastify.inject({ method: 'POST', url: '/api/catalog/servers', headers: authHeader(token), payload: { slug: 'ops', display_name: 'Ops', transport: 'stdio', command: 'node' } })
    const serverId = create.json().id
    const res = await app.fastify.inject({
      method: 'PUT',
      url: '/api/policy/rules',
      headers: authHeader(token),
      payload: { scope: 'user', resource_type: 'mcp_server', resource_id: serverId, state: 'off', locked: true },
    })
    expect(res.statusCode).toBe(422)
    void user
  })

  it('escribir la política de otra persona da 403', async () => {
    const owner = await loginAs('owner@craftech.io')
    const other = await loginAs('other@craftech.io', 'member')
    const create = await app.fastify.inject({ method: 'POST', url: '/api/catalog/servers', headers: authHeader(owner.token), payload: { slug: 'ops', display_name: 'Ops', transport: 'stdio', command: 'node' } })
    const serverId = create.json().id
    // other intenta apagar el server del owner: 404 (recurso ajeno) por _resource_slug.
    const res = await app.fastify.inject({
      method: 'PUT',
      url: '/api/policy/rules',
      headers: authHeader(other.token),
      payload: { scope: 'user', resource_type: 'mcp_server', resource_id: serverId, state: 'off' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('separación de principales', () => {
  it('un JWT no sirve para /sync/bootstrap (exige token de daemon)', async () => {
    const { token } = await loginAs('owner@craftech.io')
    const res = await app.fastify.inject({ method: 'GET', url: '/api/sync/bootstrap', headers: authHeader(token) })
    expect(res.statusCode).toBe(401)
  })

  it('el token de daemon no es un JWT y autentica /sync', async () => {
    const { token } = await loginAs('owner@craftech.io')
    const enroll = await app.fastify.inject({ method: 'POST', url: '/api/machines/enroll', headers: authHeader(token), payload: { hostname: 'laptop', os: 'macos', daemon_version: '0.2.0' } })
    expect(enroll.statusCode).toBe(200)
    const daemonToken = enroll.json().token
    expect(daemonToken.startsWith('ahd_')).toBe(true)
    const boot = await app.fastify.inject({ method: 'GET', url: '/api/sync/bootstrap', headers: authHeader(daemonToken) })
    expect(boot.statusCode).toBe(200)
  })
})

describe('invariante del producto: apagar deniega en el snapshot vigente', () => {
  it('ON→OFF: la siguiente lectura del snapshot ya no trae la tool', async () => {
    const { token } = await loginAs('owner@craftech.io')
    // catálogo con una tool
    const create = await app.fastify.inject({ method: 'POST', url: '/api/catalog/servers', headers: authHeader(token), payload: { slug: 'ops', display_name: 'Ops', transport: 'stdio', command: 'node' } })
    const serverId = create.json().id
    // insertar una tool a mano (sin probe real)
    app.store.insertTool({ server_id: serverId, name: 'restart_service', exposed_name: 'ops_restart_service', title: '', description: 'destructiva', input_schema: {}, definition_hash: 'h' })
    const toolId = app.store.toolsOfServer(serverId)[0]!.id

    // enrolar máquina + registrar agente por el daemon
    const enroll = await app.fastify.inject({ method: 'POST', url: '/api/machines/enroll', headers: authHeader(token), payload: { hostname: 'laptop', os: 'macos', daemon_version: '0.2.0' } })
    const daemonToken = enroll.json().token
    const machineId = enroll.json().machine.id
    const reg = await app.fastify.inject({ method: 'POST', url: `/api/machines/${machineId}/agents`, headers: authHeader(daemonToken), payload: { agents: [{ cli_kind: 'codex_cli', cli_version: '1' }] } })
    const agentId = reg.json()[0].id

    // snapshot inicial: la tool está expuesta
    const before = await app.fastify.inject({ method: 'GET', url: `/api/sync/snapshot/${agentId}`, headers: authHeader(daemonToken) })
    expect(before.statusCode).toBe(200)
    expect(before.json().servers[0].tools).toHaveLength(1)
    const beforeHash = before.json().snapshot_hash

    // apagar la tool desde la consola
    const off = await app.fastify.inject({
      method: 'PUT',
      url: '/api/policy/rules',
      headers: authHeader(token),
      payload: { scope: 'client', scope_id: agentId, resource_type: 'mcp_tool', resource_id: toolId, state: 'off', reason: 'peligrosa' },
    })
    expect(off.statusCode).toBe(204)

    // la siguiente lectura del snapshot ya no la trae, y el hash cambió
    const after = await app.fastify.inject({ method: 'GET', url: `/api/sync/snapshot/${agentId}`, headers: authHeader(daemonToken) })
    expect(after.json().servers[0].tools).toHaveLength(0)
    expect(after.json().denied.some((d: { resource_id: string }) => d.resource_id === toolId)).toBe(true)
    expect(after.json().snapshot_hash).not.toBe(beforeHash)
  })

  it('snapshot condicional: known_hash igual devuelve 304', async () => {
    const { token } = await loginAs('owner@craftech.io')
    const enroll = await app.fastify.inject({ method: 'POST', url: '/api/machines/enroll', headers: authHeader(token), payload: { hostname: 'laptop', os: 'macos', daemon_version: '0.2.0' } })
    const daemonToken = enroll.json().token
    const machineId = enroll.json().machine.id
    const reg = await app.fastify.inject({ method: 'POST', url: `/api/machines/${machineId}/agents`, headers: authHeader(daemonToken), payload: { agents: [{ cli_kind: 'kiro' }] } })
    const agentId = reg.json()[0].id
    const first = await app.fastify.inject({ method: 'GET', url: `/api/sync/snapshot/${agentId}`, headers: authHeader(daemonToken) })
    const hash = first.json().snapshot_hash
    const again = await app.fastify.inject({ method: 'GET', url: `/api/sync/snapshot/${agentId}?known_hash=${hash}`, headers: authHeader(daemonToken) })
    expect(again.statusCode).toBe(304)
  })
})

describe('audit', () => {
  it('escribir una regla deja un evento en el ledger y verify da ok', async () => {
    const { token } = await loginAs('owner@craftech.io')
    const create = await app.fastify.inject({ method: 'POST', url: '/api/catalog/servers', headers: authHeader(token), payload: { slug: 'ops', display_name: 'Ops', transport: 'stdio', command: 'node' } })
    const serverId = create.json().id
    await app.fastify.inject({ method: 'PUT', url: '/api/policy/rules', headers: authHeader(token), payload: { scope: 'user', resource_type: 'mcp_server', resource_id: serverId, state: 'off' } })
    const events = await app.fastify.inject({ method: 'GET', url: '/api/audit/events', headers: authHeader(token) })
    expect(events.json().some((e: { action: string }) => e.action === 'policy.rule.set')).toBe(true)
    const verify = await app.fastify.inject({ method: 'GET', url: '/api/audit/verify', headers: authHeader(token) })
    expect(verify.json().ok).toBe(true)
  })
})
