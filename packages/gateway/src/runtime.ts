/**
 * Runtimes de upstream y pool de conexiones.
 *
 * Un *runtime* sabe poner en pie un MCP server; una *conexion* es ese server ya vivo
 * hablando MCP. El gateway solo conoce estas abstracciones y los tipos `ToolDef` /
 * `CallResult`.
 *
 * IMPLEMENTACIONES
 * - stdio: proceso hijo por `StdioClientTransport` del SDK.
 * - http:  MCP server remoto por `StreamableHTTPClientTransport`.
 *
 * INVARIANTES DEL POOL
 * 1. Una conexion viva por (agent_instance_id, server_slug): dos agentes que usan el
 *    mismo server del catalogo NO comparten proceso.
 * 2. La conexion se reusa entre llamadas; se descarta cuando el snapshot deja de
 *    traer el server, cuando cambia su `fingerprint` o cuando se cae.
 * 3. Aislamiento de fallos: `listTools` nunca propaga el fallo de un upstream.
 * 4. Un upstream que no conecta entra en cooldown y no se reintenta enseguida.
 */

import { spawnSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { canonicalJson, sha256, type Transport as SnapshotTransport } from '@agenthub/shared'
import { SecretResolver, defaultResolver } from './secrets.js'
import { AUTH_NONE, AUTH_OAUTH, FileOAuthProvider, OAUTH_AUTH_REQUIRED_MESSAGE, OAuthStore, isAuthorizationRequired } from './oauth.js'

export const TRANSPORT_STDIO = 'stdio'
export const TRANSPORT_HTTP = 'http'

export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
export const DEFAULT_FAILURE_COOLDOWN_MS = 30_000

export const CLIENT_NAME = 'agenthub'
export const CLIENT_VERSION = '0.2.0'

export class UpstreamError extends Error {
  readonly slug: string
  readonly reason: string
  constructor(slug: string, reason: string) {
    super(`[${slug}] ${reason}`)
    this.name = 'UpstreamError'
    this.slug = slug
    this.reason = reason
  }
}

export class UpstreamConnectError extends UpstreamError {
  constructor(slug: string, reason: string) {
    super(slug, reason)
    this.name = 'UpstreamConnectError'
  }
}

export class UpstreamCallError extends UpstreamError {
  constructor(slug: string, reason: string) {
    super(slug, reason)
    this.name = 'UpstreamCallError'
  }
}

export interface ToolDef {
  name: string
  title: string
  description: string
  input_schema: Record<string, unknown>
  output_schema?: Record<string, unknown>
}

export interface CallResult {
  content: Array<Record<string, unknown>>
  is_error: boolean
  structured_content?: Record<string, unknown>
}

export function resultText(result: CallResult): string {
  return result.content
    .filter((block) => block['type'] === 'text')
    .map((block) => String(block['text'] ?? ''))
    .join('\n')
    .trim()
}

/** Datos de conexion de un MCP server, tal como vienen en el snapshot. */
export interface UpstreamSpecInput {
  /** Id del server en el catálogo; nombra el archivo de credenciales OAuth. */
  id?: string
  slug: string
  transport: SnapshotTransport | string
  /** `none` (por defecto) u `oauth`. */
  auth?: string
  command?: string
  args?: readonly string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  secret_refs?: Record<string, string>
  requires_host_access?: boolean
  container_image?: string
  allow_hosts?: readonly string[]
  allow_ports?: readonly number[]
  read_mounts?: readonly string[]
  write_mounts?: readonly string[]
}

export class UpstreamSpec {
  readonly id: string
  readonly slug: string
  readonly transport: string
  readonly auth: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly secretRefs: Readonly<Record<string, string>>
  readonly requiresHostAccess: boolean

  constructor(input: UpstreamSpecInput) {
    this.id = String(input.id ?? '')
    this.slug = String(input.slug)
    this.transport = String(input.transport)
    this.auth = String(input.auth ?? AUTH_NONE)
    this.command = String(input.command ?? '')
    this.args = (input.args ?? []).map(String)
    this.env = Object.fromEntries(Object.entries(input.env ?? {}).map(([k, v]) => [String(k), String(v)]))
    this.cwd = String(input.cwd ?? '')
    this.url = String(input.url ?? '')
    this.headers = Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [String(k), String(v)]))
    this.secretRefs = Object.fromEntries(Object.entries(input.secret_refs ?? {}).map(([k, v]) => [String(k), String(v)]))
    this.requiresHostAccess = Boolean(input.requires_host_access ?? false)
  }

  static fromSnapshot(payload: UpstreamSpecInput): UpstreamSpec {
    return new UpstreamSpec(payload)
  }

  /**
   * Hash estable de todo lo que afecta a la conexion. Incluye los VALORES de env y
   * headers a proposito: si rota un secreto literal, la conexion vieja quedo obsoleta.
   * De `secret_refs` entran las REFERENCIAS, no los valores. No se puede revertir, asi
   * que se puede loguear sin filtrar nada.
   */
  fingerprint(): string {
    const payload = {
      slug: this.slug,
      transport: this.transport,
      auth: this.auth,
      command: this.command,
      args: [...this.args],
      env: this.env,
      cwd: this.cwd,
      url: this.url,
      headers: this.headers,
      secret_refs: this.secretRefs,
      requires_host_access: this.requiresHostAccess,
    }
    return sha256(canonicalJson(payload))
  }
}

/** Un MCP server vivo con el que ya se hizo el handshake. */
export interface UpstreamConnection {
  listTools(): Promise<ToolDef[]>
  callTool(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<CallResult>
  close(): Promise<void>
  readonly isAlive: boolean
}

interface ToolShape {
  name: string
  title?: string | null
  description?: string | null
  inputSchema?: Record<string, unknown> | null
  outputSchema?: Record<string, unknown> | null
}

interface CallShape {
  content?: Array<Record<string, unknown>> | null
  isError?: boolean | null
  structuredContent?: Record<string, unknown> | null
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const detail = err.message.trim()
    return detail ? `${err.name}: ${detail}` : err.name
  }
  return String(err)
}

/** Conexion basada en un `Client` del SDK sobre un `Transport` cualquiera. */
export class ClientConnection implements UpstreamConnection {
  private readonly slug: string
  private readonly client: Client
  private readonly requestTimeoutMs: number
  private alive = true

  constructor(slug: string, client: Client, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.slug = slug
    this.client = client
    this.requestTimeoutMs = requestTimeoutMs
  }

  get isAlive(): boolean {
    return this.alive
  }

  async listTools(): Promise<ToolDef[]> {
    try {
      const result = await this.client.listTools(undefined, { timeout: this.requestTimeoutMs })
      const tools = (result.tools ?? []) as ToolShape[]
      return tools.map((tool) => ({
        name: tool.name,
        title: tool.title ?? '',
        description: tool.description ?? '',
        input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
        ...(tool.outputSchema ? { output_schema: tool.outputSchema } : {}),
      }))
    } catch (err) {
      this.alive = false
      throw new UpstreamCallError(this.slug, `tools/list fallo: ${describe(err)}`)
    }
  }

  async callTool(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<CallResult> {
    let result: CallShape
    try {
      result = (await this.client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }, undefined, {
        timeout: this.requestTimeoutMs,
      })) as CallShape
    } catch (err) {
      this.alive = false
      throw new UpstreamCallError(this.slug, `la herramienta ${name} fallo: ${describe(err)}`)
    }
    return {
      content: (result.content ?? []) as Array<Record<string, unknown>>,
      is_error: Boolean(result.isError),
      ...(result.structuredContent ? { structured_content: result.structuredContent } : {}),
    }
  }

  async close(): Promise<void> {
    this.alive = false
    try {
      await this.client.close()
    } catch {
      // Cerrar es best effort: un upstream que ya murio no puede tumbar al gateway.
    }
  }
}

/** Fabrica de conexiones: sabe poner en pie un upstream de cierta clase. */
export interface Runtime {
  connect(spec: UpstreamSpec): Promise<UpstreamConnection>
}

async function connectClient(slug: string, transport: Transport, timeoutMs: number): Promise<ClientConnection> {
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION })
  const timer = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`el MCP server no completo el handshake en ${timeoutMs} ms`)), timeoutMs).unref?.()
  })
  try {
    await Promise.race([client.connect(transport), timer])
  } catch (err) {
    try {
      await client.close()
    } catch {
      // best effort
    }
    throw new UpstreamConnectError(slug, `no se pudo conectar: ${describe(err)}`)
  }
  return new ClientConnection(slug, client, DEFAULT_REQUEST_TIMEOUT_MS)
}

/** Proceso hijo stdio en la maquina de la persona. */
export class HostProcessRuntime implements Runtime {
  private readonly resolver: SecretResolver
  private readonly connectTimeoutMs: number

  constructor(options: { resolver?: SecretResolver; connectTimeoutMs?: number } = {}) {
    this.resolver = options.resolver ?? defaultResolver()
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  }

  async connect(spec: UpstreamSpec): Promise<UpstreamConnection> {
    if (!spec.command) {
      throw new UpstreamConnectError(spec.slug, 'el server stdio no declara comando')
    }
    let secretEnv: Record<string, string>
    try {
      secretEnv = this.resolver.resolveEnv({ ...spec.secretRefs })
    } catch (err) {
      throw new UpstreamConnectError(spec.slug, describe(err))
    }
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v
    }
    Object.assign(env, spec.env, secretEnv)
    const transport = new StdioClientTransport({
      command: spec.command,
      args: [...spec.args],
      env,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      stderr: 'ignore',
    })
    return connectClient(spec.slug, transport, this.connectTimeoutMs)
  }
}

/** MCP server remoto por Streamable HTTP. */
export class RemoteHttpRuntime implements Runtime {
  private readonly resolver: SecretResolver
  private readonly connectTimeoutMs: number
  private readonly oauthStore: OAuthStore | undefined
  private readonly redirectUrl: string

  constructor(options: { resolver?: SecretResolver; connectTimeoutMs?: number; oauthStore?: OAuthStore; redirectUrl?: string } = {}) {
    this.resolver = options.resolver ?? defaultResolver()
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.oauthStore = options.oauthStore
    this.redirectUrl = options.redirectUrl ?? 'http://127.0.0.1:8765/api/oauth/callback'
  }

  async connect(spec: UpstreamSpec): Promise<UpstreamConnection> {
    if (!spec.url) {
      throw new UpstreamConnectError(spec.slug, 'el server http no declara url')
    }
    let secretHeaders: Record<string, string>
    try {
      secretHeaders = this.resolver.resolveHeaders({ ...spec.secretRefs })
    } catch (err) {
      throw new UpstreamConnectError(spec.slug, describe(err))
    }
    const headers = { ...spec.headers, ...secretHeaders }
    let url: URL
    try {
      url = new URL(spec.url)
    } catch {
      throw new UpstreamConnectError(spec.slug, `la url del server no es valida`)
    }
    // OAuth: modo pasivo. Usa y refresca los tokens que guardó la consola; si hay que
    // autorizar de nuevo, no registra clientes ni abre navegadores: lo dice y corta.
    let authProvider: FileOAuthProvider | undefined
    if (spec.auth === AUTH_OAUTH) {
      if (!this.oauthStore) {
        throw new UpstreamConnectError(spec.slug, 'este gateway no tiene almacén OAuth configurado (AGENTHUB_OAUTH_DIR)')
      }
      const serverId = spec.id || spec.slug
      if (!this.oauthStore.hasTokens(serverId)) throw new UpstreamConnectError(spec.slug, OAUTH_AUTH_REQUIRED_MESSAGE)
      authProvider = new FileOAuthProvider({ store: this.oauthStore, serverId, serverUrl: spec.url, redirectUrl: this.redirectUrl, interactive: false })
    }
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
      ...(authProvider ? { authProvider } : {}),
    })
    try {
      return await connectClient(spec.slug, transport as Transport, this.connectTimeoutMs)
    } catch (err) {
      if (authProvider && isAuthorizationRequired(err)) throw new UpstreamConnectError(spec.slug, OAUTH_AUTH_REQUIRED_MESSAGE)
      throw err
    }
  }
}

/** Que runtime le tocaria a una spec, y por que. */
export interface RuntimeChoice {
  slug: string
  transport: string
  runtime: string
  isolated: boolean
  reason: string
}

interface Entry {
  connection: UpstreamConnection
  fingerprint: string
}

interface Failure {
  message: string
  at: number
  fingerprint: string
}

export interface PoolListing {
  tools: Record<string, ToolDef[]>
  errors: Record<string, string>
}

function isContainerEngineAvailable(): boolean {
  for (const engine of ['podman', 'docker']) {
    const res = spawnSync(engine, ['--version'], { encoding: 'utf-8' })
    if (res.status === 0) return true
  }
  return false
}

/** Mantiene vivas las conexiones a los upstreams de cada agente. */
export class ConnectionPool {
  private readonly runtimes: Record<string, Runtime>
  private readonly failureCooldownMs: number
  private readonly clock: () => number
  private readonly entries = new Map<string, Entry>()
  private readonly failures = new Map<string, Failure>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly choices = new Map<string, RuntimeChoice>()
  private readonly containerEngine: boolean

  constructor(
    runtimes?: Record<string, Runtime>,
    options: { failureCooldownMs?: number; clock?: () => number; detectContainers?: boolean; oauthStore?: OAuthStore } = {},
  ) {
    this.runtimes = runtimes ?? {
      [TRANSPORT_STDIO]: new HostProcessRuntime(),
      [TRANSPORT_HTTP]: new RemoteHttpRuntime(options.oauthStore ? { oauthStore: options.oauthStore } : {}),
    }
    this.failureCooldownMs = options.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS
    this.clock = options.clock ?? (() => Date.now())
    this.containerEngine = options.detectContainers ? isContainerEngineAvailable() : false
  }

  private key(agentId: string, slug: string): string {
    return `${agentId}\u0000${slug}`
  }

  connectedSlugs(agentId: string): string[] {
    const prefix = `${agentId}\u0000`
    return [...this.entries.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .sort()
  }

  /** Que runtime atendio a cada server, con el motivo. Para `status` y `why`. */
  runtimeChoices(agentId = ''): RuntimeChoice[] {
    const items: RuntimeChoice[] = []
    for (const [k, choice] of this.choices) {
      if (!agentId || k.startsWith(`${agentId}\u0000`)) items.push(choice)
    }
    return items.sort((a, b) => a.slug.localeCompare(b.slug))
  }

  /** Elige runtime para la spec y deja registrado el motivo. No conecta nada. */
  selectRuntime(spec: UpstreamSpec): RuntimeChoice {
    return this.select(spec).choice
  }

  private select(spec: UpstreamSpec): { runtime: Runtime | undefined; choice: RuntimeChoice } {
    if (spec.transport !== TRANSPORT_STDIO) {
      const runtime = this.runtimes[spec.transport]
      const name = spec.transport === TRANSPORT_HTTP ? 'remote_http' : spec.transport
      const reason =
        runtime !== undefined
          ? 'el server ya corre fuera de esta maquina'
          : `transporte '${spec.transport}' sin runtime disponible`
      return { runtime, choice: { slug: spec.slug, transport: spec.transport, runtime: name, isolated: false, reason } }
    }
    const host = this.runtimes[TRANSPORT_STDIO]
    if (!this.containerEngine) {
      return {
        runtime: host,
        choice: {
          slug: spec.slug,
          transport: spec.transport,
          runtime: 'host_process',
          isolated: false,
          reason: 'no hay runtime de contenedores en esta maquina',
        },
      }
    }
    if (spec.requiresHostAccess) {
      return {
        runtime: host,
        choice: {
          slug: spec.slug,
          transport: spec.transport,
          runtime: 'host_process',
          isolated: false,
          reason: 'excepcion declarada: el catalogo dice que este server necesita el filesystem del host',
        },
      }
    }
    // Sin ToolHive en esta etapa TS, el aislamiento se registra pero se sirve por host.
    return {
      runtime: host,
      choice: {
        slug: spec.slug,
        transport: spec.transport,
        runtime: 'host_process',
        isolated: false,
        reason: 'aislamiento en contenedor no implementado en esta etapa; corre sin aislar',
      },
    }
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    this.locks.set(key, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }

  /** Devuelve la conexion viva del upstream, conectando si hace falta. */
  async get(agentId: string, spec: UpstreamSpec): Promise<UpstreamConnection> {
    const key = this.key(agentId, spec.slug)
    const fingerprint = spec.fingerprint()
    return this.withLock(key, async () => {
      const entry = this.entries.get(key)
      if (entry !== undefined) {
        if (entry.fingerprint === fingerprint && entry.connection.isAlive) return entry.connection
        this.entries.delete(key)
        await closeQuietly(entry.connection)
      }
      const failure = this.failures.get(key)
      if (failure !== undefined && failure.fingerprint === fingerprint && this.clock() - failure.at < this.failureCooldownMs) {
        throw new UpstreamConnectError(spec.slug, `upstream en espera tras un fallo: ${failure.message}`)
      }
      const { runtime, choice } = this.select(spec)
      this.choices.set(key, choice)
      if (runtime === undefined) {
        const message = `transporte '${spec.transport}' sin runtime disponible`
        this.failures.set(key, { message, at: this.clock(), fingerprint })
        throw new UpstreamConnectError(spec.slug, message)
      }
      let connection: UpstreamConnection
      try {
        connection = await runtime.connect(spec)
      } catch (err) {
        const message = err instanceof UpstreamError ? err.reason : `no se pudo conectar: ${describe(err)}`
        this.failures.set(key, { message, at: this.clock(), fingerprint })
        if (err instanceof UpstreamError) throw err
        throw new UpstreamConnectError(spec.slug, message)
      }
      this.failures.delete(key)
      this.entries.set(key, { connection, fingerprint })
      return connection
    })
  }

  /** Lista las herramientas de todos los upstreams, aislando los que fallan. */
  async listTools(agentId: string, specs: readonly UpstreamSpec[]): Promise<PoolListing> {
    const tools: Record<string, ToolDef[]> = {}
    const errors: Record<string, string> = {}
    await Promise.all(
      specs.map(async (spec) => {
        try {
          const connection = await this.get(agentId, spec)
          tools[spec.slug] = await connection.listTools()
        } catch (err) {
          await this.evict(agentId, spec.slug)
          errors[spec.slug] = err instanceof UpstreamError ? err.reason : describe(err)
        }
      }),
    )
    return { tools, errors }
  }

  /**
   * Llama una herramienta del upstream. No reintenta: una herramienta puede tener
   * efectos y un reintento a ciegas la ejecutaria dos veces. Si la llamada rompe la
   * conexion, se descarta para que la siguiente reconecte.
   */
  async callTool(agentId: string, spec: UpstreamSpec, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<CallResult> {
    const connection = await this.get(agentId, spec)
    try {
      return await connection.callTool(name, args, meta)
    } catch (err) {
      await this.evict(agentId, spec.slug)
      if (err instanceof UpstreamError) throw err
      throw new UpstreamCallError(spec.slug, `la herramienta ${name} fallo: ${describe(err)}`)
    }
  }

  /** Cierra lo que el snapshot nuevo ya no trae o redefinio. Devuelve los slugs cerrados. */
  async reconcile(agentId: string, specs: readonly UpstreamSpec[]): Promise<string[]> {
    const wanted = new Map(specs.map((spec) => [spec.slug, spec.fingerprint()]))
    const prefix = `${agentId}\u0000`
    const stale: string[] = []
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue
      const slug = key.slice(prefix.length)
      if (wanted.get(slug) !== entry.fingerprint) stale.push(slug)
    }
    for (const slug of stale) await this.evict(agentId, slug)
    for (const key of [...this.failures.keys()]) {
      if (key.startsWith(prefix) && !wanted.has(key.slice(prefix.length))) this.failures.delete(key)
    }
    for (const key of [...this.choices.keys()]) {
      if (key.startsWith(prefix) && !wanted.has(key.slice(prefix.length))) this.choices.delete(key)
    }
    return stale.sort()
  }

  async closeAgent(agentId: string): Promise<void> {
    for (const slug of this.connectedSlugs(agentId)) await this.evict(agentId, slug)
  }

  async close(): Promise<void> {
    for (const key of [...this.entries.keys()]) {
      const entry = this.entries.get(key)
      this.entries.delete(key)
      if (entry !== undefined) await closeQuietly(entry.connection)
    }
    this.failures.clear()
    this.choices.clear()
  }

  private async evict(agentId: string, slug: string): Promise<void> {
    const key = this.key(agentId, slug)
    const entry = await this.withLock(key, async () => {
      const found = this.entries.get(key)
      this.entries.delete(key)
      return found
    })
    if (entry !== undefined) await closeQuietly(entry.connection)
  }
}

async function closeQuietly(connection: UpstreamConnection): Promise<void> {
  try {
    await connection.close()
  } catch {
    // best effort
  }
}
