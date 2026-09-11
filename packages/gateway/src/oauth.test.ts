import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileOAuthProvider, OAUTH_AUTH_REQUIRED_MESSAGE, OAuthAuthorizationRequired, OAuthStore, isAuthorizationRequired } from './oauth.js'
import { RemoteHttpRuntime, UpstreamConnectError, UpstreamSpec } from './runtime.js'

let dir: string
let store: OAuthStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agenthub-oauth-'))
  store = new OAuthStore(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const tokens = { access_token: 'tok', token_type: 'bearer', refresh_token: 'ref', expires_in: 3600 }

describe('almacén OAuth', () => {
  it('guarda un JSON 0600 por server, atómico, y sabe si hay cuenta autorizada', () => {
    expect(store.hasTokens('srv-1')).toBe(false)
    store.write('srv-1', { version: 1, server_url: 'https://mcp.example.com/mcp', tokens, updated_at: '' })
    expect(statSync(store.pathFor('srv-1')).mode & 0o777).toBe(0o600)
    expect(store.read('srv-1')?.tokens?.access_token).toBe('tok')
    expect(store.hasTokens('srv-1')).toBe(true)
    expect(store.status('srv-1')).toBe('authorized')
    expect(readFileSync(store.pathFor('srv-1'), 'utf-8')).toContain('"updated_at"')
    store.delete('srv-1')
    expect(store.hasTokens('srv-1')).toBe(false)
  })

  it('un cliente cargado a mano reemplaza al anterior y descarta la cuenta autorizada', () => {
    store.write('srv-1', { version: 1, server_url: 'https://mcp.example.com/mcp', client_information: { client_id: 'dinamico' }, tokens, updated_at: '' })
    store.saveClientCredentials('srv-1', 'https://mcp.example.com/mcp', { client_id: 'manual', client_secret: 's3creto' })
    const record = store.read('srv-1')!
    expect(record.client_information).toEqual({ client_id: 'manual', client_secret: 's3creto' })
    expect(record.tokens).toBeUndefined()
    expect(store.hasClient('srv-1')).toBe(true)
    expect(store.hasTokens('srv-1')).toBe(false)
  })

  it('rechaza ids que podrían escapar de la carpeta', () => {
    expect(() => store.pathFor('../otro')).toThrow(/inválido/)
    expect(() => store.pathFor('')).toThrow(/inválido/)
  })
})

describe('proveedor OAuth sobre archivo', () => {
  const base = { store: undefined as unknown as OAuthStore, serverId: 'srv-1', serverUrl: 'https://mcp.example.com/mcp', redirectUrl: 'http://127.0.0.1:8765/api/oauth/callback' }

  it('en modo pasivo no registra clientes ni abre el navegador: pide autorizar', () => {
    const passive = new FileOAuthProvider({ ...base, store, interactive: false })
    expect(passive.saveClientInformation).toBeUndefined()
    expect(() => passive.redirectToAuthorization(new URL('https://as.example.com/authorize'))).toThrow(OAuthAuthorizationRequired)
    expect(() => passive.state()).toThrow(OAuthAuthorizationRequired)
  })

  it('en modo interactivo persiste cliente, state y verificador, y al guardar tokens limpia lo transitorio', () => {
    const provider = new FileOAuthProvider({ ...base, store, interactive: true })
    expect(provider.clientMetadata.redirect_uris).toEqual([base.redirectUrl])
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none')
    provider.saveClientInformation!({ client_id: 'cid-1' })
    const state = provider.state()
    provider.saveCodeVerifier('verificador')
    provider.redirectToAuthorization(new URL('https://as.example.com/authorize?state=' + state))
    expect(provider.authorizationUrl?.searchParams.get('state')).toBe(state)
    expect(provider.pendingState()).toBe(state)
    expect(provider.codeVerifier()).toBe('verificador')
    expect(provider.clientInformation()).toEqual({ client_id: 'cid-1' })

    provider.saveTokens(tokens)
    expect(provider.tokens()).toEqual(tokens)
    expect(provider.pendingState()).toBeUndefined()
    expect(() => provider.codeVerifier()).toThrow(/pendiente/)
    // El cliente registrado sobrevive a los tokens: sirve para refrescar.
    expect(provider.clientInformation()).toEqual({ client_id: 'cid-1' })

    provider.invalidateCredentials('tokens')
    expect(provider.tokens()).toBeUndefined()
    provider.invalidateCredentials('all')
    expect(store.read('srv-1')).toBeUndefined()
  })

  it('reconoce «hay que autorizar» aunque el error venga envuelto', () => {
    expect(isAuthorizationRequired(new OAuthAuthorizationRequired())).toBe(true)
    expect(isAuthorizationRequired(new Error('UnauthorizedError: token expirado'))).toBe(true)
    expect(isAuthorizationRequired(new Error('ECONNREFUSED'))).toBe(false)
  })
})

describe('runtime http con OAuth', () => {
  it('sin cuenta autorizada falla claro y sin tocar la red', async () => {
    const runtime = new RemoteHttpRuntime({ oauthStore: store })
    const spec = new UpstreamSpec({ id: 'srv-1', slug: 'notion', transport: 'http', url: 'http://127.0.0.1:1/mcp', auth: 'oauth' })
    await expect(runtime.connect(spec)).rejects.toMatchObject({ reason: OAUTH_AUTH_REQUIRED_MESSAGE } satisfies Partial<UpstreamConnectError>)
  })

  it('sin almacén configurado lo dice en vez de intentar sin token', async () => {
    const runtime = new RemoteHttpRuntime()
    const spec = new UpstreamSpec({ id: 'srv-1', slug: 'notion', transport: 'http', url: 'http://127.0.0.1:1/mcp', auth: 'oauth' })
    await expect(runtime.connect(spec)).rejects.toThrow(/AGENTHUB_OAUTH_DIR/)
  })

  it('el fingerprint cambia si el server pasa a OAuth', () => {
    const plain = new UpstreamSpec({ slug: 'x', transport: 'http', url: 'https://x/mcp' })
    const oauth = new UpstreamSpec({ slug: 'x', transport: 'http', url: 'https://x/mcp', auth: 'oauth' })
    expect(plain.auth).toBe('none')
    expect(plain.fingerprint()).not.toBe(oauth.fingerprint())
  })
})
