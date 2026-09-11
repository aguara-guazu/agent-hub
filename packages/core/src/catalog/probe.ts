/**
 * Sondeo real de un MCP server: `initialize` + `tools/list` contra el proceso o la URL
 * vivos. Espeja `backend/agenthub/modules/catalog/probe.py`.
 *
 * Invariantes:
 * 1. Timeout duro: ningún sondeo bloquea el request de la consola más allá del límite.
 * 2. Nunca deja procesos huérfanos: el transporte se cierra siempre en el `finally`.
 * 3. Nunca propaga excepciones: un server caído es un estado normal del catálogo y
 *    vuelve como `{ ok: false, error }`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerRow } from '../types.js'
import { AUTH_OAUTH, FileOAuthProvider, OAUTH_AUTH_REQUIRED_MESSAGE, defaultResolver, isAuthorizationRequired, type OAuthStore } from '@agenthub/gateway'

export const DEFAULT_TIMEOUT_MS = 10_000
/** Tope de páginas de `tools/list`: un server que pagina sin fin no cuelga el sondeo. */
const MAX_TOOL_PAGES = 20

export interface DiscoveredTool {
  name: string
  title: string
  description: string
  input_schema: Record<string, unknown>
}

export interface ProbeResult {
  ok: boolean
  tools: DiscoveredTool[]
  error: string
  server_name: string
  server_version: string
  /** El server usa OAuth y no hay cuenta autorizada (o la que había dejó de servir). */
  auth_required: boolean
}

export interface ProbeOptions {
  /** Credenciales OAuth guardadas por la consola; sin esto un server `oauth` no se sondea. */
  oauthStore?: OAuthStore
  redirectUrl?: string
}

function failure(error: string, authRequired = false): ProbeResult {
  return { ok: false, tools: [], error, server_name: '', server_version: '', auth_required: authRequired }
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(onTimeout)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function transportFor(server: McpServerRow, options: ProbeOptions): { transport: Transport } | { error: string; authRequired?: boolean } {
  if (server.transport === 'stdio') {
    if (!server.command.trim()) return { error: 'el server stdio no tiene comando configurado' }
    const params: {
      command: string
      args: string[]
      cwd?: string
      env?: Record<string, string>
      stderr: 'pipe'
    } = { command: server.command, args: [...server.args], stderr: 'pipe' }
    params.env = { ...server.env, ...defaultResolver().resolveEnv(server.secret_refs) }
    if (server.cwd) params.cwd = server.cwd
    const transport = new StdioClientTransport(params)
    transport.stderr?.on('data', () => undefined)
    return { transport }
  }
  if (server.transport === 'http') {
    if (!server.url.trim()) return { error: 'el server http no tiene URL configurada' }
    const headers = { ...server.headers, ...defaultResolver().resolveHeaders(server.secret_refs) }
    if (server.auth === AUTH_OAUTH) {
      // Modo pasivo: el sondeo usa la cuenta ya autorizada; autorizar es tarea de la consola.
      if (!options.oauthStore) return { error: 'no hay almacén OAuth configurado para este core' }
      if (!options.oauthStore.hasTokens(server.id)) return { error: OAUTH_AUTH_REQUIRED_MESSAGE, authRequired: true }
      const authProvider = new FileOAuthProvider({
        store: options.oauthStore,
        serverId: server.id,
        serverUrl: server.url,
        redirectUrl: options.redirectUrl ?? 'http://127.0.0.1:8765/api/oauth/callback',
        interactive: false,
      })
      return { transport: new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers }, authProvider }) as Transport }
    }
    return { transport: new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }) as Transport }
  }
  return { error: `transporte no soportado: ${server.transport || 'vacio'}` }
}

export async function probeServer(server: McpServerRow, timeoutMs = DEFAULT_TIMEOUT_MS, options: ProbeOptions = {}): Promise<ProbeResult> {
  const client = new Client({ name: 'agenthub-probe', version: '0.2.0' })
  try {
    const result = transportFor(server, options)
    if ('error' in result) return failure(result.error, result.authRequired ?? false)
    return await withTimeout(collect(client, result.transport), timeoutMs, `el sondeo supero el limite de ${(timeoutMs / 1000).toFixed(0)} segundos`)
  } catch (error) {
    if (server.auth === AUTH_OAUTH && isAuthorizationRequired(error)) return failure(OAUTH_AUTH_REQUIRED_MESSAGE, true)
    return failure(describe(server, error))
  } finally {
    try {
      await client.close()
    } catch {
      // cerrar un cliente que nunca conectó no es un error del sondeo
    }
  }
}

async function collect(client: Client, transport: Transport): Promise<ProbeResult> {
  await client.connect(transport)
  const info = client.getServerVersion()
  const discovered: DiscoveredTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const result = await client.listTools(cursor ? { cursor } : undefined)
    for (const tool of result.tools) {
      discovered.push({
        name: tool.name,
        title: tool.title ?? '',
        description: tool.description ?? '',
        input_schema: (tool.inputSchema ?? {}) as Record<string, unknown>,
      })
    }
    cursor = result.nextCursor
    if (!cursor) break
  }
  return {
    ok: true,
    tools: discovered,
    error: '',
    server_name: info?.name ?? '',
    server_version: info?.version ?? '',
    auth_required: false,
  }
}

function describe(server: McpServerRow, error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error).trim()
  const code = (error as { code?: string })?.code
  if (code === 'ENOENT') return `no se encontro el comando '${server.command}'`
  if (code === 'EACCES') return `sin permiso para ejecutar '${server.command}'`
  const name = error instanceof Error ? error.constructor.name : 'Error'
  return message ? `${name}: ${message}` : name
}
