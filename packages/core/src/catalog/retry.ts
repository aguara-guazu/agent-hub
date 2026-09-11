/**
 * Reintento automático del sondeo.
 *
 * Que un MCP server no conecte (el proceso todavía no arrancó, la URL no responde)
 * no es un estado final: mientras el server esté habilitado y configurado se vuelve a
 * sondear cada `intervalMs` hasta que conecte. Apagado por su dueño o sin comando/URL
 * no se toca: apagar algo también apaga sus reintentos, y sin configuración no hay
 * nada que intentar.
 *
 * El planificador no importa Fastify ni Electron; `probe` es inyectable para las
 * pruebas y `tick()` se puede invocar a mano sin esperar al temporizador.
 */
import type { OAuthStore } from '@agenthub/gateway'
import { probeServer, type ProbeResult } from './probe.js'
import { applyProbeResult } from './reconcile.js'
import type { Store } from '../store.js'
import type { McpServerRow } from '../types.js'

export const DEFAULT_PROBE_RETRY_MS = 30_000

export interface ProbeRetryDeps {
  store: Store
  /** Sondeo real por defecto; inyectable para probar sin levantar procesos. */
  probe?: (server: McpServerRow) => Promise<ProbeResult>
  /** Se llama con el `user_id` del server cada vez que un reintento cambió el catálogo. */
  onChange?: (userId: string) => void
  intervalMs?: number
  log?: (line: string) => void
  /** Credenciales OAuth: un server `oauth` sin cuenta autorizada no se reintenta. */
  oauthStore?: OAuthStore
  redirectUrl?: string
}

/** Un server tiene con qué conectarse: comando (stdio) o URL (http). */
export function isConfigured(server: McpServerRow): boolean {
  if (server.transport === 'stdio') return server.command.trim() !== ''
  if (server.transport === 'http') return server.url.trim() !== ''
  return false
}

/** Habilitado para su dueño: no hay una regla de usuario que lo apague. */
export function isEnabledForOwner(store: Store, server: McpServerRow): boolean {
  const rule = store.findRule(server.user_id, null, 'mcp_server', server.id)
  return !rule || rule.state !== 'off'
}

/** Un server `oauth` sólo se sondea con una cuenta autorizada; sin ella no hay nada que reintentar. */
export function hasCredentials(server: McpServerRow, oauthStore?: OAuthStore): boolean {
  if (server.auth !== 'oauth') return true
  return oauthStore?.hasTokens(server.id) ?? false
}

/** Falló el último sondeo, está configurado, tiene credenciales y su dueño no lo apagó. */
export function needsRetry(store: Store, server: McpServerRow, oauthStore?: OAuthStore): boolean {
  return server.last_probe_error !== '' && isConfigured(server) && hasCredentials(server, oauthStore) && isEnabledForOwner(store, server)
}

export class ProbeRetryScheduler {
  private timer: NodeJS.Timeout | null = null
  private readonly inFlight = new Set<string>()
  private readonly store: Store
  private readonly probe: (server: McpServerRow) => Promise<ProbeResult>
  private readonly onChange: (userId: string) => void
  private readonly log: (line: string) => void
  private readonly oauthStore: OAuthStore | undefined
  readonly intervalMs: number

  constructor(deps: ProbeRetryDeps) {
    this.store = deps.store
    this.oauthStore = deps.oauthStore
    const probeOptions = { ...(deps.oauthStore ? { oauthStore: deps.oauthStore } : {}), ...(deps.redirectUrl ? { redirectUrl: deps.redirectUrl } : {}) }
    this.probe = deps.probe ?? ((server) => probeServer(server, undefined, probeOptions))
    this.onChange = deps.onChange ?? (() => undefined)
    this.log = deps.log ?? (() => undefined)
    this.intervalMs = deps.intervalMs ?? DEFAULT_PROBE_RETRY_MS
  }

  get running(): boolean {
    return this.timer !== null
  }

  start(): void {
    if (this.timer || this.intervalMs <= 0) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    // El temporizador no debe mantener vivo al proceso cuando el core se apaga.
    this.timer.unref()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** Servers que se reintentarían en el próximo ciclo. */
  pending(): McpServerRow[] {
    return this.store.allServers().filter((server) => !this.inFlight.has(server.id) && needsRetry(this.store, server, this.oauthStore))
  }

  /** Reintenta todos los pendientes en paralelo y devuelve los ids que sondeó. */
  async tick(): Promise<string[]> {
    const batch = this.pending()
    await Promise.all(batch.map((server) => this.retry(server)))
    return batch.map((server) => server.id)
  }

  private async retry(server: McpServerRow): Promise<void> {
    this.inFlight.add(server.id)
    try {
      const result = await this.probe(server)
      // Mientras sondeábamos el dueño pudo borrar o apagar el server: no se resucita.
      const fresh = this.store.server(server.id)
      if (!fresh || !isEnabledForOwner(this.store, fresh)) return
      applyProbeResult(this.store, fresh, result)
      this.onChange(fresh.user_id)
      this.log(result.ok
        ? `[probe-retry] ${fresh.slug}: conectó, ${result.tools.length} herramientas`
        : `[probe-retry] ${fresh.slug}: sigue sin conectar (${result.error})`)
    } catch (error) {
      // `probeServer` nunca lanza; esto cubre un `probe` inyectado o un fallo del store.
      this.log(`[probe-retry] ${server.slug}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.inFlight.delete(server.id)
    }
  }
}
