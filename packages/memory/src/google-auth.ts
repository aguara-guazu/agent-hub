import { createHash, randomBytes } from 'node:crypto'
import { Vault } from './config.js'
import { check, MemoryError } from './contracts.js'

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/meetings.space.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/directory.readonly',
]
export class GoogleAuth {
  private pending = new Map<string, { connector: string; verifier: string; expires: number }>()
  private refreshes = new Map<string, Promise<string>>()
  constructor(private vault: Vault, readonly redirectUrl: string, private fetcher: typeof fetch = fetch) {}
  start(connector: string): string {
    const credentials = this.vault.read('google-client')
    check(credentials?.client_id, 'Configurá el client ID de una aplicación OAuth de escritorio de Google', 409)
    for (const [key, value] of this.pending) if (value.expires < Date.now()) this.pending.delete(key)
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url')
    this.pending.set(state, { connector, verifier, expires: Date.now() + 600_000 })
    const params = new URLSearchParams({ client_id: credentials.client_id, redirect_uri: this.redirectUrl,
      response_type: 'code', scope: GOOGLE_SCOPES.join(' '), state, access_type: 'offline', prompt: 'consent',
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') })
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
  }
  async finish(state: string, code: string): Promise<string> {
    const pending = this.pending.get(state)
    this.pending.delete(state)
    check(pending && pending.expires > Date.now(), 'La autorización venció o no corresponde a este hub', 400)
    const credentials = this.vault.read('google-client')!
    const tokens = await this.exchange({ client_id: credentials.client_id, ...(credentials.client_secret ? { client_secret: credentials.client_secret } : {}),
      code, code_verifier: pending.verifier, redirect_uri: this.redirectUrl, grant_type: 'authorization_code' })
    this.vault.save(pending.connector, { ...tokens, expires_at: Date.now() + Number(tokens.expires_in ?? 3600) * 1000 })
    return pending.connector
  }
  async token(connector: string): Promise<string> {
    const tokens = this.vault.read(connector)
    check(tokens?.access_token, 'Conectá la cuenta de Google para sincronizar', 409)
    if (Number(tokens.expires_at) > Date.now() + 60_000) return tokens.access_token as string
    if (!this.refreshes.has(connector)) {
      const promise = this.refresh(connector).finally(() => this.refreshes.delete(connector))
      this.refreshes.set(connector, promise)
    }
    return this.refreshes.get(connector)!
  }
  private async refresh(connector: string): Promise<string> {
    const credentials = this.vault.read('google-client'), tokens = this.vault.read(connector)
    check(credentials?.client_id && tokens?.refresh_token, 'Volvé a conectar Google para renovar el acceso', 409)
    const fresh = await this.exchange({ client_id: credentials.client_id, ...(credentials.client_secret ? { client_secret: credentials.client_secret } : {}),
      refresh_token: tokens.refresh_token, grant_type: 'refresh_token' })
    this.vault.save(connector, { ...tokens, ...fresh, expires_at: Date.now() + Number(fresh.expires_in ?? 3600) * 1000 })
    return fresh.access_token as string
  }
  private async exchange(params: Record<string, string>): Promise<Record<string, any>> {
    const response = await this.fetcher('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams(params), signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new MemoryError(409, 'Google no pudo autorizar o renovar la cuenta; revisá el cliente OAuth y reconectá')
    const result = await response.json() as Record<string, any>
    check(typeof result.access_token === 'string', 'Google no devolvió un token de acceso', 502)
    return result
  }
}
