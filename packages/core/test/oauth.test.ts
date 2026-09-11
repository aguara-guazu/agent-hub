/**
 * Flujo OAuth completo contra un servidor de autorización y un MCP server falsos en
 * loopback: descubrimiento, registro dinámico, URL de autorización, vuelta del
 * navegador al callback del core, canje del código, sondeo con el token y estado en la
 * API. Ningún token sale por la API; queda en un archivo 0600.
 */
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureLocalOwner } from '../src/local.js'
import { createAccessToken } from '../src/security.js'
import { authHeader, makeApp, type TestHarness } from './helpers.js'

interface Fixture { server: Server; base: string; registrations: number; tokenRequests: string[]; tokenAuthHeaders: string[] }

async function startFixture(options: { registration?: boolean } = {}): Promise<Fixture> {
  const registration = options.registration ?? true
  const fixture: Fixture = { server: undefined as unknown as Server, base: '', registrations: 0, tokenRequests: [], tokenAuthHeaders: [] }
  fixture.server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', fixture.base)
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body))
    let raw = ''
    for await (const part of request) raw += part

    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(200, { resource: `${fixture.base}/mcp`, authorization_servers: [fixture.base] })
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: fixture.base,
        authorization_endpoint: `${fixture.base}/authorize`,
        token_endpoint: `${fixture.base}/token`,
        ...(registration ? { registration_endpoint: `${fixture.base}/register` } : {}),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: registration ? ['none'] : ['client_secret_basic'],
      })
    }
    if (url.pathname === '/register' && request.method === 'POST') {
      fixture.registrations += 1
      const metadata = JSON.parse(raw) as Record<string, unknown>
      return json(201, { ...metadata, client_id: 'cid-fixture', client_id_issued_at: 1 })
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      const form = new URLSearchParams(raw)
      fixture.tokenRequests.push(form.get('grant_type') ?? '')
      fixture.tokenAuthHeaders.push(String(request.headers.authorization ?? ''))
      if (form.get('grant_type') === 'authorization_code' && form.get('code') === 'codigo-ok' && form.get('code_verifier')) {
        return json(200, { access_token: 'tok-fixture', token_type: 'bearer', expires_in: 3600, refresh_token: 'ref-fixture' })
      }
      return json(400, { error: 'invalid_grant', error_description: 'código inválido' })
    }
    if (url.pathname === '/mcp') {
      if (request.headers.authorization !== 'Bearer tok-fixture') {
        return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Bearer resource_metadata="${fixture.base}/.well-known/oauth-protected-resource/mcp"` })
      }
      if (request.method !== 'POST') return response.writeHead(405).end()
      const message = JSON.parse(raw) as { id?: number; method: string; params?: { protocolVersion?: string } }
      if (message.id === undefined) return response.writeHead(202).end()
      const result = message.method === 'initialize'
        ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: [{ name: 'read_fixture', inputSchema: { type: 'object' } }] }
      return json(200, { jsonrpc: '2.0', id: message.id, result })
    }
    response.writeHead(404).end()
  }).listen(0, '127.0.0.1')
  await once(fixture.server, 'listening')
  const address = fixture.server.address() as { port: number }
  fixture.base = `http://127.0.0.1:${address.port}`
  return fixture
}

let app: TestHarness
let token: string
let fixture: Fixture
const REDIRECT = 'http://127.0.0.1:8765/api/oauth/callback'

beforeEach(async () => {
  app = makeApp({ oauthRedirectUrl: REDIRECT })
  // `oauthDir` sale de la ruta de la base: queda dentro del directorio descartable.
  const owner = ensureLocalOwner(app.store)
  token = await createAccessToken(app.settings, owner.id)
  fixture = await startFixture()
})
afterEach(async () => {
  fixture.server.closeAllConnections()
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
  app.cleanup()
})

async function createServerEntry(): Promise<Record<string, any>> {
  const created = await app.fastify.inject({
    method: 'POST', url: '/api/catalog/servers', headers: authHeader(token),
    payload: { slug: 'fixture', display_name: 'Fixture', transport: 'http', url: `${fixture.base}/mcp`, auth: 'oauth' },
  })
  expect(created.statusCode, created.body).toBe(201)
  return created.json()
}

describe('OAuth en el hub', () => {
  it('autoriza una cuenta de punta a punta y deja el token fuera de la API', async () => {
    const server = await createServerEntry()
    expect(server.auth).toBe('oauth')
    expect(server.oauth_status).toBe('required')

    // Sin cuenta, el sondeo no toca la red: pide autorizar y el reintento automático lo saltea.
    const probed = await app.fastify.inject({ method: 'POST', url: `/api/catalog/servers/${server.id}/probe`, headers: authHeader(token) })
    expect(probed.json().last_probe_error).toMatch(/autorizar/)
    expect(fixture.registrations).toBe(0)
    expect(app.probeRetry.pending()).toEqual([])

    const start = await app.fastify.inject({ method: 'POST', url: `/api/catalog/servers/${server.id}/oauth/start`, headers: authHeader(token) })
    expect(start.statusCode, start.body).toBe(200)
    expect(start.json().status).toBe('redirect')
    const authorization = new URL(start.json().authorization_url)
    expect(authorization.origin + authorization.pathname).toBe(`${fixture.base}/authorize`)
    expect(authorization.searchParams.get('client_id')).toBe('cid-fixture')
    expect(authorization.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('resource')).toBe(`${fixture.base}/mcp`)
    const state = authorization.searchParams.get('state')
    expect(state).toBeTruthy()
    expect(fixture.registrations).toBe(1)

    // El navegador vuelve al core con el código: se canjea, se sondea y se descubren tools.
    const callback = await app.fastify.inject({ method: 'GET', url: `/api/oauth/callback?code=codigo-ok&state=${encodeURIComponent(state!)}` })
    expect(callback.statusCode, callback.body).toBe(200)
    expect(callback.headers['content-type']).toContain('text/html')
    expect(callback.body).toContain('Cuenta conectada')
    expect(callback.body).toContain('1 herramientas')
    expect(fixture.tokenRequests).toEqual(['authorization_code'])

    const listed = await app.fastify.inject({ method: 'GET', url: '/api/catalog/servers', headers: authHeader(token) })
    const fresh = listed.json()[0]
    expect(fresh.oauth_status).toBe('authorized')
    expect(fresh.last_probe_error).toBe('')
    expect(fresh.tools.map((t: { name: string }) => t.name)).toEqual(['read_fixture'])
    expect(JSON.stringify(fresh)).not.toContain('tok-fixture')

    // El token quedó en un archivo 0600 dentro de la carpeta OAuth, no en la base.
    const files = readdirSync(app.settings.oauthDir)
    expect(files).toEqual([`${server.id}.json`])
    expect(statSync(join(app.settings.oauthDir, files[0]!)).mode & 0o777).toBe(0o600)

    // El mismo `state` no sirve dos veces.
    const replay = await app.fastify.inject({ method: 'GET', url: `/api/oauth/callback?code=codigo-ok&state=${encodeURIComponent(state!)}` })
    expect(replay.statusCode).toBe(400)

    // Desconectar borra la cuenta y vuelve a pedir autorización.
    const logout = await app.fastify.inject({ method: 'POST', url: `/api/catalog/servers/${server.id}/oauth/logout`, headers: authHeader(token) })
    expect(logout.json().oauth_status).toBe('required')
    expect(logout.json().last_probe_error).toMatch(/autorizar/)
    expect(existsSync(join(app.settings.oauthDir, `${server.id}.json`))).toBe(false)
  })

  it('una vuelta con error del proveedor o con state desconocido no autoriza nada', async () => {
    const server = await createServerEntry()
    const unknown = await app.fastify.inject({ method: 'GET', url: '/api/oauth/callback?code=x&state=inventado' })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.body).toContain('desconocida')

    const start = await app.fastify.inject({ method: 'POST', url: `/api/catalog/servers/${server.id}/oauth/start`, headers: authHeader(token) })
    const state = new URL(start.json().authorization_url).searchParams.get('state')!
    const denied = await app.fastify.inject({ method: 'GET', url: `/api/oauth/callback?error=access_denied&error_description=la+persona+cancelo&state=${encodeURIComponent(state)}` })
    expect(denied.statusCode).toBe(400)
    expect(denied.body).toContain('la persona cancelo')
    const listed = await app.fastify.inject({ method: 'GET', url: '/api/catalog/servers', headers: authHeader(token) })
    expect(listed.json()[0].oauth_status).toBe('required')
    expect(listed.json()[0].last_probe_error).toContain('rechazada')
  })

  it('un código inválido deja el error visible y sin cuenta', async () => {
    const server = await createServerEntry()
    const start = await app.fastify.inject({ method: 'POST', url: `/api/catalog/servers/${server.id}/oauth/start`, headers: authHeader(token) })
    const state = new URL(start.json().authorization_url).searchParams.get('state')!
    const bad = await app.fastify.inject({ method: 'GET', url: `/api/oauth/callback?code=malo&state=${encodeURIComponent(state)}` })
    expect(bad.statusCode).toBe(502)
    const listed = await app.fastify.inject({ method: 'GET', url: '/api/catalog/servers', headers: authHeader(token) })
    expect(listed.json()[0].oauth_status).toBe('required')
    expect(listed.json()[0].last_probe_error).toContain('canjear')
  })

  it('sin registro dinámico, un cliente cargado a mano completa el flujo con su secreto', async () => {
    fixture.server.closeAllConnections()
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
    fixture = await startFixture({ registration: false })
    const server = await createServerEntry()
    expect(server.oauth_client_configured).toBe(false)

    const blocked = await app.fastify.inject({ method: 'POST', url: `/api/catalog/servers/${server.id}/oauth/start`, headers: authHeader(token) })
    expect(blocked.statusCode).toBe(502)
    expect(blocked.json().detail).toContain('dynamic client registration')

    const saved = await app.fastify.inject({ method: 'POST', url: `/api/catalog/servers/${server.id}/oauth/client`, headers: authHeader(token), payload: { client_id: 'manual-id', client_secret: 'manual-secret' } })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json().oauth_client_configured).toBe(true)
    expect(saved.body).not.toContain('manual-secret')

    const start = await app.fastify.inject({ method: 'POST', url: `/api/catalog/servers/${server.id}/oauth/start`, headers: authHeader(token) })
    expect(start.statusCode, start.body).toBe(200)
    const authorization = new URL(start.json().authorization_url)
    expect(authorization.searchParams.get('client_id')).toBe('manual-id')
    expect(fixture.registrations).toBe(0)

    const state = authorization.searchParams.get('state')!
    const callback = await app.fastify.inject({ method: 'GET', url: `/api/oauth/callback?code=codigo-ok&state=${encodeURIComponent(state)}` })
    expect(callback.statusCode, callback.body).toBe(200)
    // El secreto viajó al servidor de autorización como HTTP Basic, no al MCP server ni a la API.
    expect(fixture.tokenAuthHeaders[0]).toMatch(/^Basic /)
    expect(Buffer.from(fixture.tokenAuthHeaders[0]!.slice(6), 'base64').toString()).toBe('manual-id:manual-secret')
    const listed = await app.fastify.inject({ method: 'GET', url: '/api/catalog/servers', headers: authHeader(token) })
    expect(listed.json()[0].oauth_status).toBe('authorized')

    const settings = await app.fastify.inject({ method: 'GET', url: '/api/oauth/settings', headers: authHeader(token) })
    expect(settings.json()).toEqual({ redirect_url: REDIRECT })
  })

  it('valida el campo auth y borra la cuenta al dejar de usar OAuth o al eliminar el server', async () => {
    const invalid = await app.fastify.inject({
      method: 'POST', url: '/api/catalog/servers', headers: authHeader(token),
      payload: { slug: 'a', display_name: 'A', transport: 'http', url: 'http://x/mcp', auth: 'basic' },
    })
    expect(invalid.statusCode).toBe(422)
    const stdioOauth = await app.fastify.inject({
      method: 'POST', url: '/api/catalog/servers', headers: authHeader(token),
      payload: { slug: 'b', display_name: 'B', transport: 'stdio', command: 'node', auth: 'oauth' },
    })
    expect(stdioOauth.statusCode).toBe(422)

    const server = await createServerEntry()
    const start = await app.fastify.inject({ method: 'POST', url: `/api/catalog/servers/${server.id}/oauth/start`, headers: authHeader(token) })
    const state = new URL(start.json().authorization_url).searchParams.get('state')!
    await app.fastify.inject({ method: 'GET', url: `/api/oauth/callback?code=codigo-ok&state=${encodeURIComponent(state)}` })
    expect(existsSync(join(app.settings.oauthDir, `${server.id}.json`))).toBe(true)

    const patched = await app.fastify.inject({ method: 'PATCH', url: `/api/catalog/servers/${server.id}`, headers: authHeader(token), payload: { auth: 'none' } })
    expect(patched.json().auth).toBe('none')
    expect(patched.json().oauth_status).toBe('none')
    expect(existsSync(join(app.settings.oauthDir, `${server.id}.json`))).toBe(false)
  })
})
