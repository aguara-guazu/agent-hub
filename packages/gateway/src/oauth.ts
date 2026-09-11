/**
 * Cliente OAuth 2.1 del hub para MCP servers HTTP protegidos.
 *
 * El SDK trae el flujo completo (descubrimiento RFC 9728/8414, registro dinámico de
 * cliente RFC 7591, PKCE, refresh). Acá vive lo que el SDK no decide:
 *
 * - DÓNDE viven las credenciales: `<oauthDir>/<server_id>.json` con permisos 0600,
 *   nunca en hub.db. El core (sondeo, botón «Conectar cuenta») y el gateway (llamadas)
 *   leen y refrescan el mismo archivo; la escritura es atómica.
 * - QUIÉN puede abrir el navegador. Modo interactivo (consola): registra el cliente si
 *   hace falta y entrega la URL de autorización. Modo pasivo (sondeo automático,
 *   gateway): usa y refresca los tokens guardados; si hace falta autorizar de nuevo no
 *   registra nada ni abre nada, falla con `OAuthAuthorizationRequired`.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

export const AUTH_NONE = 'none'
export const AUTH_OAUTH = 'oauth'
export const OAUTH_CLIENT_NAME = 'Agent Hub'
export const OAUTH_AUTH_REQUIRED_MESSAGE = 'requiere autorizar la cuenta: usá «Conectar cuenta» en Agent Hub'

/** Carpeta de credenciales OAuth dentro del directorio de estado. */
export function oauthDirFor(stateDir: string): string {
  return join(stateDir, 'oauth')
}

export interface OAuthRecord {
  version: 1
  server_url: string
  client_information?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  tokens_saved_at?: string
  code_verifier?: string
  state?: string
  updated_at: string
}

export class OAuthAuthorizationRequired extends Error {
  constructor(message = OAUTH_AUTH_REQUIRED_MESSAGE) {
    super(message)
    this.name = 'OAuthAuthorizationRequired'
  }
}

/** Reconoce «hay que autorizar de nuevo», también cuando el error viene envuelto. */
export function isAuthorizationRequired(error: unknown): boolean {
  if (error instanceof OAuthAuthorizationRequired || error instanceof UnauthorizedError) return true
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return /OAuthAuthorizationRequired|UnauthorizedError/.test(text)
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Un archivo JSON 0600 por server. */
export class OAuthStore {
  constructor(readonly dir: string) {}

  pathFor(serverId: string): string {
    if (!SAFE_ID.test(serverId)) throw new Error(`id de server inválido para el almacén OAuth: ${JSON.stringify(serverId)}`)
    return join(this.dir, `${serverId}.json`)
  }

  read(serverId: string): OAuthRecord | undefined {
    const path = this.pathFor(serverId)
    if (!existsSync(path)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as OAuthRecord
      return parsed && parsed.version === 1 ? parsed : undefined
    } catch {
      return undefined
    }
  }

  write(serverId: string, record: OAuthRecord): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const path = this.pathFor(serverId)
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...record, updated_at: new Date().toISOString() }, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  }

  delete(serverId: string): void {
    rmSync(this.pathFor(serverId), { force: true })
  }

  hasTokens(serverId: string): boolean {
    return Boolean(this.read(serverId)?.tokens?.access_token)
  }

  /** Hay un cliente OAuth (registrado dinámicamente o cargado a mano). */
  hasClient(serverId: string): boolean {
    return Boolean(this.read(serverId)?.client_information?.client_id)
  }

  /**
   * Cliente OAuth creado por la persona en el proveedor (para los que no admiten
   * RFC 7591). Un cliente nuevo invalida la cuenta autorizada con el anterior.
   */
  saveClientCredentials(serverId: string, serverUrl: string, info: { client_id: string; client_secret?: string }): void {
    const record = this.read(serverId) ?? { version: 1 as const, server_url: serverUrl, updated_at: '' }
    record.server_url = serverUrl
    record.client_information = info.client_secret ? { client_id: info.client_id, client_secret: info.client_secret } : { client_id: info.client_id }
    delete record.tokens
    delete record.tokens_saved_at
    delete record.code_verifier
    delete record.state
    this.write(serverId, record)
  }

  status(serverId: string): 'authorized' | 'required' {
    return this.hasTokens(serverId) ? 'authorized' : 'required'
  }
}

export interface FileOAuthProviderOptions {
  store: OAuthStore
  serverId: string
  serverUrl: string
  /** URL de retorno que verá el navegador; tiene que ser la del core en loopback. */
  redirectUrl: string
  /** Interactivo: puede registrar el cliente y producir la URL de autorización. */
  interactive: boolean
  clientName?: string
}

export class FileOAuthProvider implements OAuthClientProvider {
  private readonly store: OAuthStore
  private readonly serverId: string
  private readonly serverUrl: string
  private readonly redirect: string
  private readonly interactive: boolean
  private readonly clientName: string
  /** URL a abrir en el navegador; sólo la produce el modo interactivo. */
  authorizationUrl: URL | undefined
  /** Sólo en modo interactivo: sin este método el SDK no intenta el registro dinámico. */
  saveClientInformation?: (info: OAuthClientInformationMixed) => void

  constructor(options: FileOAuthProviderOptions) {
    this.store = options.store
    this.serverId = options.serverId
    this.serverUrl = options.serverUrl
    this.redirect = options.redirectUrl
    this.interactive = options.interactive
    this.clientName = options.clientName ?? OAUTH_CLIENT_NAME
    if (options.interactive) {
      this.saveClientInformation = (info) => this.update((record) => { record.client_information = info })
    }
  }

  get redirectUrl(): string {
    return this.redirect
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  state(): string {
    if (!this.interactive) throw new OAuthAuthorizationRequired()
    const value = randomBytes(24).toString('base64url')
    this.update((record) => { record.state = value })
    return value
  }

  /** El `state` del flujo pendiente, para casar la vuelta del navegador. */
  pendingState(): string | undefined {
    return this.record().state
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.record().client_information
  }

  tokens(): OAuthTokens | undefined {
    return this.record().tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    this.update((record) => {
      record.tokens = tokens
      record.tokens_saved_at = new Date().toISOString()
      delete record.code_verifier
      delete record.state
    })
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.interactive) throw new OAuthAuthorizationRequired()
    this.authorizationUrl = authorizationUrl
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.update((record) => { record.code_verifier = codeVerifier })
  }

  codeVerifier(): string {
    const value = this.record().code_verifier
    if (!value) throw new Error('no hay una autorización pendiente para este server')
    return value
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') {
      this.store.delete(this.serverId)
      return
    }
    this.update((record) => {
      if (scope === 'client') delete record.client_information
      if (scope === 'tokens') { delete record.tokens; delete record.tokens_saved_at }
      if (scope === 'verifier') { delete record.code_verifier; delete record.state }
    })
  }

  private record(): OAuthRecord {
    return this.store.read(this.serverId) ?? { version: 1, server_url: this.serverUrl, updated_at: '' }
  }

  private update(mutate: (record: OAuthRecord) => void): void {
    const record = this.record()
    record.server_url = this.serverUrl
    mutate(record)
    this.store.write(this.serverId, record)
  }
}
