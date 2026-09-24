/**
 * Entrypoint headless por stdio: `agenthub gateway --agent <id>`.
 *
 * El CLI lanza este proceso como hijo y le habla por stdin/stdout. No abre ningun
 * puerto ni toma el lock de instancia de Electron. Lee el snapshot vigente del agente
 * de un archivo en disco (que escribe el daemon), lo observa para reaccionar a los
 * cambios del panel sin reiniciar, y reporta cada invocacion al control plane si hay
 * URL y token en el entorno.
 *
 * Variables de entorno:
 *   AGENTHUB_GATEWAY_SNAPSHOT   ruta al snapshot del agente (obligatoria)
 *   AGENTHUB_GATEWAY_AGENT      id del agent_instance (obligatoria; tambien --agent)
 *   AGENTHUBD_URL               control plane para el reporte de auditoria (opcional)
 *   AGENTHUB_GATEWAY_TOKEN      token del daemon para el reporte (opcional)
 *   AGENTHUB_OAUTH_DIR          carpeta con las credenciales OAuth de los servers (opcional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { httpReporter } from './audit.js'
import { DiskPolicyStore, SnapshotView } from './policy.js'
import { ConnectionPool } from './runtime.js'
import { OAuthStore } from './oauth.js'
import { GatewayServer, type ToolCallReporter } from './server.js'
import { dirname, join } from 'node:path'
import { MemoryOutbox, integrationDirectory } from './memory-outbox.js'

export interface HeadlessOptions {
  agentInstanceId: string
  snapshotPath: string
  controlPlaneUrl?: string
  token?: string
  detectContainers?: boolean
  oauthDir?: string
}

function parseArgs(argv: readonly string[]): { agent?: string; snapshot?: string } {
  const out: { agent?: string; snapshot?: string } = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--agent') {
      const next = argv[++i]
      if (next !== undefined) out.agent = next
    } else if (arg?.startsWith('--agent=')) {
      out.agent = arg.slice('--agent='.length)
    } else if (arg === '--snapshot') {
      const next = argv[++i]
      if (next !== undefined) out.snapshot = next
    } else if (arg?.startsWith('--snapshot=')) {
      out.snapshot = arg.slice('--snapshot='.length)
    }
  }
  return out
}

export function resolveOptions(argv: readonly string[], env: NodeJS.ProcessEnv): HeadlessOptions {
  const parsed = parseArgs(argv)
  const agentInstanceId = parsed.agent ?? env['AGENTHUB_GATEWAY_AGENT'] ?? ''
  const snapshotPath = parsed.snapshot ?? env['AGENTHUB_GATEWAY_SNAPSHOT'] ?? ''
  if (!agentInstanceId) throw new Error('falta el id del agente: pase --agent <id> o AGENTHUB_GATEWAY_AGENT')
  if (!snapshotPath) throw new Error('falta la ruta del snapshot: AGENTHUB_GATEWAY_SNAPSHOT')
  const url = env['AGENTHUBD_URL']
  const token = env['AGENTHUB_GATEWAY_TOKEN']
  const oauthDir = env['AGENTHUB_OAUTH_DIR']
  return {
    agentInstanceId,
    snapshotPath,
    detectContainers: true,
    ...(url ? { controlPlaneUrl: url } : {}),
    ...(token ? { token } : {}),
    ...(oauthDir ? { oauthDir } : {}),
  }
}

/** Construye el gateway headless (store en disco + pool + servidor), sin conectarlo aun. */
export function buildHeadlessGateway(options: HeadlessOptions): { gateway: GatewayServer; store: DiskPolicyStore; pool: ConnectionPool } {
  const store = new DiskPolicyStore(options.agentInstanceId, options.snapshotPath)
  store.watch()
  const pool = new ConnectionPool(undefined, {
    detectContainers: options.detectContainers ?? true,
    ...(options.oauthDir ? { oauthStore: new OAuthStore(options.oauthDir) } : {}),
  })
  let reporter: ToolCallReporter | undefined
  const api = options.controlPlaneUrl?.replace(/\/+$/, '').replace(/\/api$/, '') + '/api'
  const headers = { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' }
  if (options.controlPlaneUrl && options.token) {
    reporter = httpReporter({ baseUrl: api, token: options.token, timeoutMs: 1000 })
  }
  // Local HTTP is the authority for a call: a saved OFF applies before daemon polling.
  const refreshPolicy = options.controlPlaneUrl && options.token ? async (): Promise<void> => {
    try {
      const response = await fetch(`${api}/policy/snapshot/${encodeURIComponent(options.agentInstanceId)}`, {
        headers, signal: AbortSignal.timeout(1500),
      })
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        store.replace(SnapshotView.empty(options.agentInstanceId))
      } else if (response.ok) {
        store.apply(await response.json() as Record<string, unknown>)
      }
    } catch { /* offline: retain the last valid local policy */ }
  } : undefined
  const onListed = reporter ? (hash: string): void => {
    void fetch(`${api}/sync/report`, { method: 'POST', headers,
      body: JSON.stringify({ agent_id: options.agentInstanceId, listed_hash: hash, connected: true }),
      signal: AbortSignal.timeout(1000),
    }).catch(() => undefined)
  } : undefined
  const gateway = new GatewayServer(options.agentInstanceId, store, pool, {
    outbox: new MemoryOutbox(integrationDirectory(join(dirname(options.snapshotPath), '..'), options.agentInstanceId)),
    ...(reporter ? { reporter } : {}),
    ...(refreshPolicy ? { refreshPolicy } : {}),
    ...(onListed ? { onListed } : {}),
  })
  return { gateway, store, pool }
}

/** Arranca el gateway headless por stdio y lo mantiene vivo hasta que el CLI corte. */
export async function runHeadless(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const options = resolveOptions(argv, env)
  const { gateway, store, pool } = buildHeadlessGateway(options)
  const transport = new StdioServerTransport()
  let closed = false
  let resolveClosed!: () => void
  const done = new Promise<void>((resolve) => { resolveClosed = resolve })
  const shutdown = async (): Promise<void> => {
    if (closed) return
    closed = true
    store.stopWatching()
    await gateway.close()
    await pool.close()
    resolveClosed()
  }
  transport.onclose = () => { void shutdown() }
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
  process.stdin.once('end', () => { void shutdown() })
  process.stdin.once('close', () => { void shutdown() })
  await gateway.connect(transport)
  await done
}
