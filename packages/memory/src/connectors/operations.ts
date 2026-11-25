import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { MemoryError, check, parse, id, connectorInput, instant } from '../contracts.js'
import { MemoryStore, canonical, validateProjects } from "../store.js"
import { GMAIL_SCOPE, GMAIL_SEND_SCOPE, googleScopes, type GoogleAuth } from './google-auth.js'
import type { Vault } from '../config.js'
import { GOOGLE_SETUP_APIS, GOOGLE_SETUP_SCOPES, ensureGoogleSource, readGoogleClientFile } from './google-setup.js'

export const connectionReadOperations = [
  'list_connectors', 'google_setup_status',
] as const satisfies readonly (keyof typeof connectionDefinitions)[]

export const connectionDefinitions = {
  list_connectors: ['Configured sources, coverage, errors; no credentials.', z.object({}).strict()],
  save_connector: ['Set source scope. Credentials go in the hub UI.', connectorInput.extend({ id: id.optional() })],
  sync_connector: ['Sync an enabled connector. Google always covers the last 90 days (Calendar, Gmail) plus new items. since (optional until, default now) also imports that older Calendar/Gmail period from a Google source; use only when the person asks for data older than 90 days.',
    z.object({ id, since: z.union([instant, z.iso.date()]).optional(), until: z.union([instant, z.iso.date()]).optional() }).strict().refine(v => !v.until || v.since, 'until requiere since')],
  sync_sources: ['Pull new content from all active sources (Meet transcripts, documents, conversations, issues); processed in background.', z.object({}).strict()],
  repair_google: ['Refresh emails by Google identity; recover speakers of stored documents.', z.object({ id }).strict()],
  google_setup_status: ['Diagnose Google setup: OAuth client, redirect URL, required APIs/scopes, connected Google sources. No credentials.', z.object({}).strict()],
  import_google_client: ['Load the Google desktop OAuth client JSON from Google Cloud (absolute local path). Secret kept in a private file, never returned. With no Google source, creates one (Calendar, Meet, Gmail) and returns authorization_url for the browser (10-minute expiry); on consent it activates and syncs.', z.object({ path: z.string().min(1).max(4000) }).strict()],
  connect_google: ['Browser URL to authorize a Google source; expires in 10 minutes. The token then stays on this computer.', z.object({ id }).strict()],
} satisfies Record<string, [string, z.ZodType]>

export class ConnectionOperations {
  constructor(private store: MemoryStore, private google?: GoogleAuth, private vault?: Vault) {}
  async call(operation: string, input: any, raw: unknown) {
    const store = this.store, db = store.db
    switch (operation) {
      case 'sync_sources': {
        const rows = await db.query('SELECT id,name,provider,config FROM connectors WHERE enabled=true ORDER BY created_at')
        // A sync waiting out a backoff is brought forward: the person explicitly asked to look for new content now.
        await db.query("UPDATE jobs SET available_at=now(),updated_at=now() WHERE kind IN ('sync','gmail') AND state IN ('queued','waiting') AND available_at>now()")
        for (const connector of rows) {
          await store.enqueue('sync', { connector_id: connector.id }, `sync:${connector.id}`)
          await this.enqueueGmail(connector)
        }
        return { queued: rows.length, connectors: rows.map(({ config: _config, ...connector }) => connector) }
      }
      case 'list_connectors': {
        // `mailbox` is the address Gmail reported for the account on a sync; until then there is none to show and nothing is inferred.
        const rows = await db.query("SELECT id,provider,name,config,project_ids,enabled,interval_minutes,last_success_at,last_error,created_at,json_extract(cursor,'$.gmail.mailbox') AS mailbox FROM connectors ORDER BY created_at")
        return rows.map(({ mailbox, ...row }) => {
          if (row.provider !== 'google') return row
          const account = { account_email: typeof mailbox === 'string' && mailbox ? mailbox : null }
          if (!this.google) return { ...row, ...account }
          return { ...row, ...account, ...(row.config.gmail_enabled !== false ? { gmail_authorized: this.google.granted(row.id, GMAIL_SCOPE) } : {}),
            ...(row.config.gmail_send_enabled === true ? { gmail_send_authorized: this.google.granted(row.id, GMAIL_SEND_SCOPE) } : {}) }
        })
      }
      case 'save_connector': {
        const sent = (raw ?? {}) as Record<string, unknown>
        const current = input.id ? (await db.query('SELECT provider,name,config,project_ids,enabled,interval_minutes FROM connectors WHERE id=$1', [input.id]))[0] : undefined
        if (input.id) check(current && current.provider === input.provider, 'Conector inexistente o proveedor distinto', 404)
        // Omitted fields keep the stored value on update; zod defaults only apply when creating.
        const keep = (key: 'config' | 'project_ids' | 'enabled' | 'interval_minutes') => current && sent[key] === undefined ? current[key] : input[key]
        const config = { ...keep('config') } as Record<string, unknown>
        const projectIds = keep('project_ids') as string[], enabled = keep('enabled') as boolean, intervalMinutes = keep('interval_minutes') as number
        // Google covers a fixed 90-day window; an older `since` from previous versions is dropped, and older periods use sync_connector.
        if (input.provider === 'google') delete config.since
        this.validateConnectorConfig(input.provider, config)
        await validateProjects(db, projectIds)
        const connectorId = input.id ?? randomUUID()
        const sameConfig = !!current && canonical(current.config) === canonical(config)
        return (await db.query(`INSERT INTO connectors(id,provider,name,config,project_ids,enabled,interval_minutes) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,config=excluded.config,project_ids=excluded.project_ids,enabled=excluded.enabled,
          interval_minutes=excluded.interval_minutes,cursor=CASE WHEN $8 THEN connectors.cursor ELSE '{}' END,updated_at=now() RETURNING *`,
          [connectorId, input.provider, input.name, JSON.stringify(config), projectIds, enabled, intervalMinutes, sameConfig]))[0]
      }
      case 'sync_connector':
      case 'repair_google': {
        const connector = (await db.query('SELECT id,enabled,provider,config FROM connectors WHERE id=$1', [input.id]))[0]
        check(connector, 'Conector inexistente', 404); check(connector.enabled, 'Activá el conector antes de sincronizar', 409)
        if (operation === 'repair_google') {
          check(connector.provider === 'google', 'Esta reparación requiere una fuente Google')
          return store.enqueue('google_repair', { connector_id: input.id }, `google-repair:${input.id}`)
        }
        if (input.since) {
          check(connector.provider === 'google', 'La sincronización de un período sólo está disponible para fuentes Google')
          const bound = (value: string) => value.length === 10 ? `${value}T00:00:00Z` : value
          const since = bound(input.since), until = input.until ? bound(input.until) : new Date().toISOString()
          check(Date.parse(since) < Date.parse(until), 'La fecha de inicio debe ser anterior al final del período')
          return store.enqueue('sync', { connector_id: input.id, since, until }, `sync-range:${input.id}:${since}:${until}`)
        }
        await this.enqueueGmail(connector)
        return store.enqueue('sync', { connector_id: input.id }, `sync:${input.id}`)
      }
      case 'google_setup_status': {
        const { google, vault } = this.googleSetup()
        const client = vault.read('google-client')
        const connectors = await db.query("SELECT id,name,enabled,config,project_ids,last_success_at,last_error FROM connectors WHERE provider='google' ORDER BY created_at")
        return { client_configured: Boolean(client?.client_id), client_id: client?.client_id ?? null, client_has_secret: Boolean(client?.client_secret),
          redirect_url: google.redirectUrl, apis: GOOGLE_SETUP_APIS, scopes: GOOGLE_SETUP_SCOPES,
          connectors: connectors.map(row => ({ ...row, connected: Boolean(vault.read(row.id)?.refresh_token),
            ...(row.config.gmail_enabled !== false ? { gmail_authorized: google.granted(row.id, GMAIL_SCOPE) } : {}),
            ...(row.config.gmail_send_enabled === true ? { gmail_send_authorized: google.granted(row.id, GMAIL_SEND_SCOPE) } : {}) })) }
      }
      case 'import_google_client': {
        const { vault } = this.googleSetup()
        const client = readGoogleClientFile(input.path)
        vault.save('google-client', { client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}) })
        const source = await ensureGoogleSource(store)
        return { configured: true, client_type: client.type, client_id: client.client_id, project_id: client.project_id ?? null,
          connector_id: source.id, authorization_url: this.googleSetup().google.start(source.id, googleScopes(source.config)), expires_in_seconds: 600 }
      }
      case 'connect_google': {
        const { google } = this.googleSetup()
        const connector = (await db.query("SELECT id,config FROM connectors WHERE id=$1 AND provider='google'", [input.id]))[0]
        check(connector, 'Conector de Google inexistente', 404)
        return { authorization_url: google.start(input.id, googleScopes(connector.config)), expires_in_seconds: 600 }
      }
      default: throw new MemoryError(404, 'Operación de conexión inexistente')
    }
  }

  private async enqueueGmail(connector: Record<string, any>) {
    if (connector.provider === 'google' && connector.config.gmail_enabled !== false && this.google?.granted(connector.id, GMAIL_SCOPE))
      await this.store.enqueue('gmail', { connector_id: connector.id }, `gmail:${connector.id}`)
  }

  private googleSetup(): { google: GoogleAuth; vault: Vault } {
    check(this.google && this.vault, 'La configuración de Google no está disponible en este contexto', 503)
    return { google: this.google, vault: this.vault }
  }

  private validateConnectorConfig(provider: string, config: Record<string, unknown>) {
    const keys: Record<string, string[]> = { google: ['calendars', 'calendar_enabled', 'meet_enabled', 'gmail_enabled', 'gmail_send_enabled', 'document_ids', 'folder_ids'], notion: ['page_ids'], slack: ['channel_ids', 'since'], jira: ['site_url', 'jql'] }
    check(Object.keys(config).every(key => keys[provider]?.includes(key)), 'Configuración desconocida. Las credenciales se guardan por separado')
    for (const key of ['calendars', 'document_ids', 'folder_ids', 'page_ids', 'channel_ids']) if (key in config) parse(z.array(z.string().min(1).max(500)).max(100), config[key])
    if (config.since) parse(instant, config.since)
    for (const key of ['calendar_enabled', 'meet_enabled', 'gmail_enabled', 'gmail_send_enabled']) if (key in config) parse(z.boolean(), config[key])
    check(!(config.gmail_send_enabled === true && config.gmail_enabled === false), 'El envío por Gmail requiere mantener activada la lectura de Gmail: las respuestas se leen desde ahí')
    if (provider === 'jira') {
      const url = new URL(String(config.site_url ?? ''))
      check(url.protocol === 'https:' && url.hostname.endsWith('.atlassian.net') && !url.username && !url.password, 'Se requiere un sitio de Jira Cloud')
      parse(z.string().min(1).max(4000), config.jql)
    }
  }
}
