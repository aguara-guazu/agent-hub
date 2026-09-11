/**
 * Gateway MCP: la unica entrada que ven los CLIs.
 *
 * DOS TIEMPOS DISTINTOS, Y ESA ES LA IDEA
 *
 * - `tools/list` se contesta con el snapshot cacheado. No descubre nada, no conecta
 *   con ningun upstream y no espera a la red: listar es instantaneo y funciona aunque
 *   todos los upstreams esten caidos o el control plane no conteste.
 * - `tools/call` vuelve a resolver la politica CONTRA EL SNAPSHOT VIGENTE en ese
 *   instante. Apagar una herramienta en el panel deniega la llamada siguiente aunque
 *   el CLI siga mostrandola en su lista vieja. Este es el invariante del producto.
 *
 * La denegacion se devuelve como `CallToolResult` con `isError`, no como excepcion de
 * protocolo, para que el modelo pueda leer el motivo y decirlo.
 *
 * Es HEADLESS y por STDIO: el CLI lanza `agenthub gateway --agent <id>` como proceso
 * hijo y le habla por tuberias. No hay ningun puerto abierto ni token en el archivo
 * de configuracion.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { PolicyStore } from './policy.js'
import { DECISION_ALLOW, DECISION_DENY, argsDigest, denialMessage, serverOffMessage, unknownToolMessage } from './policy.js'
import { ConnectionPool, UpstreamError, resultText } from './runtime.js'

export const SERVER_NAME = 'agenthub'
export const SERVER_VERSION = '0.2.0'

const MAX_SERVER_SLUG = 48
const MAX_TOOL_NAME = 128
const MAX_EXPOSED_NAME = 64

const INSTRUCTIONS =
  'Entrada unica a los MCP servers y skills habilitados por Agent Hub para este agente. ' +
  'La lista de herramientas la decide el hub: si una herramienta figura pero el hub la apago, ' +
  'la llamada devuelve un error explicando el motivo.'

/** Lo que se reporta al control plane de una invocacion. Nunca lleva los argumentos: solo su digest. */
export interface ToolCallRecord {
  agent_id: string
  server_slug: string
  tool_name: string
  exposed_name: string
  decision: string
  args_digest: string
  duration_ms: number
  denial_reason: string
  error: string
}

/** Quien recibe el reporte de una invocacion. Un fallo suyo jamas afecta al resultado. */
export type ToolCallReporter = (record: ToolCallRecord) => Promise<void>

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started))
}

/** El gateway de UN `agent_instance`. */
export class GatewayServer {
  private readonly agentInstanceId: string
  private readonly store: PolicyStore
  private readonly pool: ConnectionPool
  private readonly reporter: ToolCallReporter | undefined
  private readonly server: Server
  private readonly onListed: ((hash: string) => void) | undefined
  private readonly refreshPolicy: (() => Promise<void>) | undefined
  private lastListedHashValue = ''
  private connected = false

  constructor(
    agentInstanceId: string,
    store: PolicyStore,
    pool: ConnectionPool,
    options: { reporter?: ToolCallReporter; onListed?: (hash: string) => void; refreshPolicy?: () => Promise<void>; serverName?: string; version?: string } = {},
  ) {
    if (store.agentInstanceId !== agentInstanceId) {
      throw new Error('el store de politica es de otro agent_instance')
    }
    this.agentInstanceId = agentInstanceId
    this.store = store
    this.pool = pool
    this.reporter = options.reporter
    this.onListed = options.onListed
    this.refreshPolicy = options.refreshPolicy
    this.server = new Server(
      { name: options.serverName ?? SERVER_NAME, version: options.version ?? SERVER_VERSION },
      { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS },
    )
    this.server.setRequestHandler(ListToolsRequestSchema, async () => this.handleListTools())
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => this.handleCallTool(request))
    // Avisar `tools/list_changed` a la sesion abierta. Es un aviso, no una garantia:
    // solo Claude Code refresca en caliente. Para el resto la denegacion en call vale.
    store.subscribe(() => {
      if (this.connected) {
        void this.server.sendToolListChanged().catch(() => undefined)
      }
    })
  }

  get mcpServer(): Server {
    return this.server
  }

  /** Hash del snapshot que el CLI listo por ultima vez. */
  get lastListedHash(): string {
    return this.lastListedHashValue
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport)
    this.connected = true
  }

  async close(): Promise<void> {
    this.connected = false
    await this.server.close()
  }

  private async handleListTools(): Promise<ListToolsResult> {
    this.store.refresh()
    await this.refreshPolicy?.()
    const view = this.store.current
    this.lastListedHashValue = view.snapshotHash
    this.onListed?.(view.snapshotHash)
    return {
      tools: view.tools.map((tool) => ({
        name: tool.exposedName,
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema as { type: 'object'; [k: string]: unknown },
      })),
    }
  }

  private async handleCallTool(request: CallToolRequest): Promise<CallToolResult> {
    const started = performance.now()
    this.store.refresh()
    await this.refreshPolicy?.()
    // Se toma la vista UNA vez y se usa hasta el final: la llamada trabaja con una
    // politica coherente, y la siguiente ya ve la nueva.
    const view = this.store.current
    const name = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    const digest = argsDigest(args)

    const tool = view.tool(name)
    if (tool === undefined) {
      return this.deny(view, name, digest, started)
    }

    const spec = view.specFor(tool.serverSlug)
    if (spec === undefined) {
      const message = `El hub no tiene datos de conexion del server '${tool.serverSlug}', asi que no puede ejecutar '${name}'.`
      await this.report({
        agent_id: this.agentInstanceId,
        server_slug: tool.serverSlug,
        tool_name: tool.toolName,
        exposed_name: name,
        decision: DECISION_DENY,
        args_digest: digest,
        duration_ms: elapsedMs(started),
        denial_reason: message,
        error: '',
      })
      return errorResult(message)
    }

    try {
      const result = await this.pool.callTool(this.agentInstanceId, spec, tool.toolName, args)
      await this.report({
        agent_id: this.agentInstanceId,
        server_slug: tool.serverSlug,
        tool_name: tool.toolName,
        exposed_name: name,
        decision: DECISION_ALLOW,
        args_digest: digest,
        duration_ms: elapsedMs(started),
        denial_reason: '',
        error: result.is_error ? resultText(result) : '',
      })
      return {
        content: result.content as CallToolResult['content'],
        isError: result.is_error,
        ...(result.structured_content ? { structuredContent: result.structured_content } : {}),
      }
    } catch (err) {
      // El upstream fallo, pero la politica DIJO QUE SI: se reporta `allow` con el
      // error, porque para la auditoria lo que importa es que se autorizo.
      const reason = err instanceof UpstreamError ? err.reason : String(err)
      const message = `El hub autorizo '${name}' pero el MCP server no respondio: ${reason}`
      await this.report({
        agent_id: this.agentInstanceId,
        server_slug: tool.serverSlug,
        tool_name: tool.toolName,
        exposed_name: name,
        decision: DECISION_ALLOW,
        args_digest: digest,
        duration_ms: elapsedMs(started),
        denial_reason: '',
        error: reason,
      })
      return errorResult(message)
    }
  }

  /** Camino de denegacion: el corazon del producto. */
  private async deny(
    view: PolicyStore['current'],
    name: string,
    digest: string,
    started: number,
  ): Promise<CallToolResult> {
    let message: string
    let serverSlug = ''
    let toolName = ''
    const denied = view.denialFor(name)
    if (denied !== undefined) {
      message = denialMessage(denied)
      const slash = denied.slug.indexOf('/')
      if (slash >= 0) {
        serverSlug = denied.slug.slice(0, slash)
        toolName = denied.slug.slice(slash + 1)
      } else {
        serverSlug = denied.slug
      }
    } else {
      const off = view.deniedServerFor(name)
      message = off !== undefined ? serverOffMessage(name, off) : unknownToolMessage(name)
      serverSlug = off?.slug ?? ''
    }
    await this.report({
      agent_id: this.agentInstanceId,
      server_slug: serverSlug,
      tool_name: toolName,
      exposed_name: name,
      decision: DECISION_DENY,
      args_digest: digest,
      duration_ms: elapsedMs(started),
      denial_reason: message,
      error: '',
    })
    return errorResult(message)
  }

  private async report(record: ToolCallRecord): Promise<void> {
    if (this.reporter === undefined) return
    const trimmed: ToolCallRecord = {
      ...record,
      server_slug: record.server_slug.slice(0, MAX_SERVER_SLUG),
      tool_name: record.tool_name.slice(0, MAX_TOOL_NAME),
      exposed_name: record.exposed_name.slice(0, MAX_EXPOSED_NAME),
    }
    try {
      await this.reporter(trimmed)
    } catch {
      // Un fallo del reporte nunca puede afectar el resultado de la llamada.
    }
  }
}
