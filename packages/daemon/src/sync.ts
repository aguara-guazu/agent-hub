/**
 * Cliente del control plane y modo degradado.
 *
 * Tres decisiones sostienen el módulo:
 *
 * 1. MODO DEGRADADO, no apagón. Si el control plane no contesta, el daemon sigue
 *    sirviendo el último snapshot en disco. Nunca abre lo que estaba cerrado.
 * 2. El 304 es la regla. `GET /sync/snapshot/{id}` se pide siempre con `known_hash`
 *    y con `wait` (long poll).
 * 3. Reintento con backoff exponencial y jitter completo, para dispersar la manada
 *    de daemons que reintentan al mismo tiempo cuando el control plane vuelve.
 *
 * Lo que este módulo NUNCA hace: mandar los argumentos de una invocación. De una
 * llamada viaja su digest (`args_digest`), calculado en el gateway.
 */

import type { AccountSkillsReport } from './adapters/claude_desktop.js'
import type { ExternalSkill, ExternalSkillsOutcome } from './external_skills.js'
import type { DaemonState } from './state.js'

export const DEFAULT_MAX_ATTEMPTS = 5
export const DEFAULT_BACKOFF_BASE = 1.0
export const DEFAULT_BACKOFF_FACTOR = 2.0
export const DEFAULT_BACKOFF_MAX = 60.0

export const DEFAULT_REPORT_QUEUE = 512

export const SOURCE_CONTROL_PLANE = 'control_plane'
export const SOURCE_NOT_MODIFIED = 'not_modified'
export const SOURCE_DISK = 'disk'
export const SOURCE_MISSING = 'missing'

/** Reporte de una invocación al control plane. Viaja el digest, nunca los argumentos. */
export interface ToolCallRecord {
  agent_id: string
  server_slug: string
  tool_name: string
  exposed_name: string
  decision: string
  denial_reason: string
  args_digest: string
  duration_ms: number
  error: string
}

export class ControlPlaneError extends Error {
  readonly status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ControlPlaneError'
    this.status = status
  }
}

/** 401 o 403: el token no sirve. Reintentar no lo va a arreglar. */
export class AuthError extends ControlPlaneError {
  constructor(message: string, status = 0) {
    super(message, status)
    this.name = 'AuthError'
  }
}

/** 404: el recurso no existe para este token (o es de otra máquina). */
export class NotFoundError extends ControlPlaneError {
  constructor(message: string, status = 0) {
    super(message, status)
    this.name = 'NotFoundError'
  }
}

/** Red caída, timeout o 5xx. Es el único fallo que se reintenta. */
export class TransientError extends ControlPlaneError {
  constructor(message: string, status = 0) {
    super(message, status)
    this.name = 'TransientError'
  }
}

export type Rng = (min: number, max: number) => number

/** Espera exponencial con jitter completo (`uniform(0, tope)`). */
export class Backoff {
  constructor(
    readonly base = DEFAULT_BACKOFF_BASE,
    readonly factor = DEFAULT_BACKOFF_FACTOR,
    readonly maximum = DEFAULT_BACKOFF_MAX,
    readonly rng: Rng = (min, max) => min + Math.random() * (max - min),
  ) {}

  /** Segundos a esperar antes del intento número `attempt` (1 es el primero). */
  delay(attempt: number): number {
    const ceiling = Math.min(this.maximum, this.base * this.factor ** Math.max(0, attempt - 1))
    return this.rng(0, ceiling)
  }
}

export type Sleeper = (seconds: number) => Promise<void>

const defaultSleep: Sleeper = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000))

/** Transporte HTTP mínimo, para inyectar un doble en las pruebas. */
export type Fetcher = (url: string, init: FetchInit) => Promise<FetchResponse>

export interface FetchInit {
  method: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export interface FetchResponse {
  status: number
  text(): Promise<string>
  json(): Promise<unknown>
}

const NOT_MODIFIED = 304
const UNAUTHORIZED = 401
const FORBIDDEN = 403
const NOT_FOUND = 404

interface SyncClientOptions {
  fetcher?: Fetcher
  timeout?: number
  maxAttempts?: number
  backoff?: Backoff
  sleep?: Sleeper
}

/** Habla con el control plane con el token opaco de la máquina. No toca el disco. */
export class SyncClient {
  private readonly apiBaseUrl: string
  private readonly token: string
  private readonly fetcher: Fetcher
  private readonly timeout: number
  private readonly maxAttempts: number
  private readonly backoff: Backoff
  private readonly sleep: Sleeper

  constructor(apiBase: string, token: string, options: SyncClientOptions = {}) {
    this.apiBaseUrl = apiBase.replace(/\/+$/, '')
    this.token = token
    this.fetcher = options.fetcher ?? defaultFetcher
    this.timeout = options.timeout ?? 40
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    this.backoff = options.backoff ?? new Backoff()
    this.sleep = options.sleep ?? defaultSleep
  }

  get apiBase(): string {
    return this.apiBaseUrl
  }

  private headers(): Record<string, string> {
    // El token no se loguea nunca: solo viaja en este encabezado.
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/json' }
  }

  private async request(
    method: string,
    path: string,
    opts: { params?: Record<string, string | number>; json?: unknown; timeout?: number; retry?: boolean } = {},
  ): Promise<FetchResponse> {
    const query = opts.params
      ? '?' + new URLSearchParams(Object.entries(opts.params).map(([k, v]) => [k, String(v)])).toString()
      : ''
    const url = `${this.apiBaseUrl}${path}${query}`
    const attempts = opts.retry === false ? 1 : this.maxAttempts
    let last: ControlPlaneError | null = null

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController()
      const timeoutMs = (opts.timeout ?? this.timeout) * 1000
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: FetchResponse
      try {
        const headers = this.headers()
        const init: FetchInit = { method, headers, signal: controller.signal }
        if (opts.json !== undefined) {
          headers['Content-Type'] = 'application/json'
          init.body = JSON.stringify(opts.json)
        }
        response = await this.fetcher(url, init)
      } catch (exc) {
        last = new TransientError(`no se pudo contactar al control plane: ${short(exc)}`)
        clearTimeout(timer)
        if (attempt < attempts) await this.sleep(this.backoff.delay(attempt))
        continue
      }
      clearTimeout(timer)

      if (response.status >= 500) {
        last = new TransientError(`el control plane respondió ${response.status}`, response.status)
      } else {
        await raiseForClientError(response)
        return response
      }
      if (attempt < attempts) await this.sleep(this.backoff.delay(attempt))
    }
    throw last ?? new TransientError('el control plane no contestó')
  }

  /** `GET /sync/bootstrap`: quién soy y qué agentes manejo. */
  async bootstrap(): Promise<Record<string, unknown>> {
    return asDict(await this.request('GET', '/sync/bootstrap'))
  }

  /** `POST /machines/{id}/agents`: declara los CLIs detectados en la máquina. */
  async registerAgents(machineId: string, agents: ReadonlyArray<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
    const response = await this.request('POST', `/machines/${machineId}/agents`, {
      json: { agents: agents.map((a) => ({ ...a })) },
    })
    const payload = await response.json()
    return Array.isArray(payload) ? payload.map((item) => ({ ...(item as Record<string, unknown>) })) : []
  }

  /** `GET /sync/snapshot/{id}`. Devuelve `null` cuando el hash no cambió (304). */
  async fetchSnapshot(
    agentId: string,
    opts: { knownHash?: string; wait?: number } = {},
  ): Promise<Record<string, unknown> | null> {
    const params: Record<string, string | number> = {}
    if (opts.knownHash) params['known_hash'] = opts.knownHash
    const wait = opts.wait ?? 0
    if (wait) params['wait'] = wait
    const response = await this.request('GET', `/sync/snapshot/${agentId}`, {
      params,
      timeout: this.timeout + wait,
    })
    if (response.status === NOT_MODIFIED) return null
    return asDict(response)
  }

  /** `POST /sync/report`. Cada campo omitido significa 'sin novedades'. */
  async report(
    agentId: string,
    fields: {
      listedHash?: string
      connected?: boolean
      driftDetected?: boolean
      driftDetail?: string
      syncedHash?: string
      accountSkills?: AccountSkillsReport
    } = {},
  ): Promise<void> {
    const body: Record<string, unknown> = { agent_id: agentId }
    if (fields.listedHash !== undefined) body['listed_hash'] = fields.listedHash
    if (fields.connected !== undefined) body['connected'] = fields.connected
    if (fields.driftDetected !== undefined) body['drift_detected'] = fields.driftDetected
    if (fields.driftDetail !== undefined) body['drift_detail'] = fields.driftDetail
    if (fields.syncedHash !== undefined) body['synced_hash'] = fields.syncedHash
    if (fields.accountSkills !== undefined) body['account_skills'] = fields.accountSkills
    await this.request('POST', '/sync/report', { json: body })
  }

  /** `PUT /sync/external-skills`: foto completa de la biblioteca de skills de la máquina. */
  async putExternalSkills(skills: readonly ExternalSkill[]): Promise<ExternalSkillsOutcome> {
    const response = await this.request('PUT', '/sync/external-skills', { json: { skills } })
    const data = await asDict(response)
    const names = (value: unknown): string[] => (Array.isArray(value) ? value.map((item) => String(item)) : [])
    const skipped = Array.isArray(data['skipped'])
      ? (data['skipped'] as Array<Record<string, unknown>>).map((item) => ({ slug: String(item['slug'] ?? ''), reason: String(item['reason'] ?? '') }))
      : []
    return { created: names(data['created']), updated: names(data['updated']), removed: names(data['removed']), skipped }
  }

  /** `POST /sync/tool-call`. Viaja el digest de los argumentos, nunca los argumentos. */
  async reportToolCall(record: ToolCallRecord): Promise<void> {
    await this.request('POST', '/sync/tool-call', { json: record, retry: false })
  }

  /** `GET /policy/explain`: por qué un recurso está o no disponible. */
  async explain(agentId: string, resourceType: string, resourceId: string): Promise<Record<string, unknown>> {
    const response = await this.request('GET', '/policy/explain', {
      params: { agent_id: agentId, resource_type: resourceType, resource_id: resourceId },
      retry: false,
    })
    return asDict(response)
  }
}

/** De dónde salió el snapshot con el que se está trabajando. */
export interface SyncOutcome {
  agentId: string
  source: string
  snapshot: Record<string, unknown> | null
  error: string
}

export function outcomeDegraded(outcome: SyncOutcome): boolean {
  return outcome.source === SOURCE_DISK || outcome.source === SOURCE_MISSING
}

export function outcomeChanged(outcome: SyncOutcome): boolean {
  return outcome.source === SOURCE_CONTROL_PLANE
}

export function describeOutcome(outcome: SyncOutcome): string {
  switch (outcome.source) {
    case SOURCE_CONTROL_PLANE:
      return 'snapshot nuevo del control plane'
    case SOURCE_NOT_MODIFIED:
      return 'sin cambios (304)'
    case SOURCE_DISK:
      return `modo degradado: se sirve el snapshot en disco (${outcome.error})`
    default:
      return `sin snapshot: el control plane no contesta y no hay copia local (${outcome.error})`
  }
}

/** Trae snapshots y los persiste, degradando al disco cuando hace falta. */
export class SnapshotSync {
  private readonly client: SyncClient
  private readonly state: DaemonState
  private readonly pollSeconds: number
  private readonly backoff: Backoff
  private readonly sleep: Sleeper
  private readonly degraded = new Map<string, string>()

  constructor(
    client: SyncClient,
    state: DaemonState,
    options: { pollSeconds?: number; backoff?: Backoff; sleep?: Sleeper } = {},
  ) {
    this.client = client
    this.state = state
    this.pollSeconds = options.pollSeconds ?? 25
    this.backoff = options.backoff ?? new Backoff()
    this.sleep = options.sleep ?? defaultSleep
  }

  /** Agentes que hoy se sirven desde disco, con el motivo. */
  get degradedAgents(): Record<string, string> {
    return Object.fromEntries(this.degraded)
  }

  /** Una vuelta de sincronización de un agente. Nunca lanza por un fallo del hub. */
  async refresh(agentId: string, opts: { wait?: number } = {}): Promise<SyncOutcome> {
    const known = this.state.knownHash(agentId)
    let payload: Record<string, unknown> | null
    try {
      payload = await this.client.fetchSnapshot(agentId, {
        knownHash: known,
        wait: opts.wait ?? this.pollSeconds,
      })
    } catch (exc) {
      if (exc instanceof ControlPlaneError) return this.degrade(agentId, exc.message)
      throw exc
    }

    this.degraded.delete(agentId)
    if (payload === null) {
      return { agentId, source: SOURCE_NOT_MODIFIED, snapshot: this.state.loadSnapshot(agentId), error: '' }
    }
    // Se persiste antes de devolverlo: si el daemon muere en el medio, la próxima
    // corrida arranca del snapshot nuevo y no de uno que ya quedó viejo.
    this.state.saveSnapshot(payload)
    return { agentId, source: SOURCE_CONTROL_PLANE, snapshot: payload, error: '' }
  }

  private degrade(agentId: string, reason: string): SyncOutcome {
    this.degraded.set(agentId, reason)
    const cached = this.state.loadSnapshot(agentId)
    if (cached === null) return { agentId, source: SOURCE_MISSING, snapshot: null, error: reason }
    return { agentId, source: SOURCE_DISK, snapshot: cached, error: reason }
  }

  /** Bucle de sincronización de un agente hasta que se pida parar. */
  async watch(
    agentId: string,
    onSnapshot: (outcome: SyncOutcome) => Promise<void>,
    opts: { stop?: { aborted: boolean }; maxCycles?: number } = {},
  ): Promise<void> {
    const maxCycles = opts.maxCycles ?? 0
    let cycles = 0
    let failures = 0
    while (opts.stop === undefined || !opts.stop.aborted) {
      const outcome = await this.refresh(agentId)
      await onSnapshot(outcome)
      if (outcomeDegraded(outcome)) {
        failures += 1
        await this.sleep(this.backoff.delay(failures))
      } else {
        failures = 0
      }
      cycles += 1
      if (maxCycles && cycles >= maxCycles) return
    }
  }
}

/**
 * Reporta invocaciones al control plane sin hacer esperar al CLI. Encola y sigue; si
 * la cola se llena se descarta el reporte más viejo.
 */
export class ToolCallForwarder {
  private readonly client: SyncClient
  private readonly maxQueue: number
  private readonly queue: ToolCallRecord[] = []
  private draining = false
  private closed = false
  dropped = 0

  constructor(client: SyncClient, maxQueue: number = DEFAULT_REPORT_QUEUE) {
    this.client = client
    this.maxQueue = maxQueue
  }

  /** Firma del reporter que consume el gateway. Vuelve enseguida. */
  async enqueue(record: ToolCallRecord): Promise<void> {
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift()
      this.dropped += 1
    }
    this.queue.push(record)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const record = this.queue.shift()!
        try {
          await this.client.reportToolCall(record)
        } catch {
          // Un fallo de reporte es de mejor esfuerzo: no frena la herramienta.
        }
      }
    } finally {
      this.draining = false
    }
  }

  /** Intenta vaciar la cola. */
  async close(drainTimeout = 5): Promise<void> {
    if (this.closed) return
    this.closed = true
    const deadline = Date.now() + drainTimeout * 1000
    while ((this.queue.length > 0 || this.draining) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}

export function clientFromCredentials(
  credentials: { token: string },
  apiBase: string,
  options: SyncClientOptions = {},
): SyncClient {
  return new SyncClient(apiBase, credentials.token, options)
}

/**
 * Enrola la máquina y devuelve `{machine, token}`. Son dos pedidos: `POST
 * /auth/login` con las credenciales de la persona para obtener el JWT de consola, y
 * `POST /machines/enroll` con ese JWT. El JWT se usa en memoria y se descarta; lo
 * único que se guarda en disco es el token opaco de máquina.
 */
export async function enrollMachine(
  apiBase: string,
  args: { email: string; password: string; hostname: string; osName?: string; daemonVersion?: string },
  options: { fetcher?: Fetcher; timeout?: number } = {},
): Promise<{ machine: Record<string, unknown>; token: string }> {
  const fetcher = options.fetcher ?? defaultFetcher
  const timeout = options.timeout ?? 30
  const base = apiBase.replace(/\/+$/, '')

  const login = await fetcher(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: args.email, password: args.password }),
  })
  if (login.status === UNAUTHORIZED) throw new AuthError('el correo o la contraseña no son válidos', 401)
  await raiseForClientError(login)
  if (login.status >= 500) throw new TransientError(`el control plane respondió ${login.status}`, login.status)
  const accessToken = String((await asDict(login))['access_token'] ?? '')
  if (!accessToken) throw new ControlPlaneError('el control plane no devolvió un token de sesión')

  return enrollWithSession(base, { ...args, accessToken }, { fetcher, timeout })
}


/** Obtiene una sesión del dueño local usando el secreto efímero heredado por Electron. */
export async function desktopSession(
  apiBase: string,
  bootstrapToken: string,
  options: { fetcher?: Fetcher } = {},
): Promise<{ accessToken: string; user: Record<string, unknown> }> {
  if (!bootstrapToken) throw new AuthError('falta el bootstrap del escritorio')
  const fetcher = options.fetcher ?? defaultFetcher
  const base = apiBase.replace(/\/+$/, '')
  const response = await fetcher(`${base}/auth/desktop-session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bootstrapToken}`, Accept: 'application/json' },
  })
  await raiseForClientError(response)
  if (response.status >= 500) throw new TransientError(`el control plane respondió ${response.status}`, response.status)
  const payload = await asDict(response)
  const accessToken = String(payload['access_token'] ?? '')
  const user = (payload['user'] ?? {}) as Record<string, unknown>
  if (!accessToken || !user['email']) throw new ControlPlaneError('la sesión local vino incompleta')
  return { accessToken, user }
}
/** Enrola con un JWT de consola en la mano, sin pasar por `/auth/login`. */
export async function enrollWithSession(
  apiBase: string,
  args: { accessToken: string; hostname: string; osName?: string; daemonVersion?: string },
  options: { fetcher?: Fetcher; timeout?: number } = {},
): Promise<{ machine: Record<string, unknown>; token: string }> {
  const fetcher = options.fetcher ?? defaultFetcher
  const base = apiBase.replace(/\/+$/, '')
  const enrolled = await fetcher(`${base}/machines/enroll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${args.accessToken}`,
    },
    body: JSON.stringify({ hostname: args.hostname, os: args.osName ?? '', daemon_version: args.daemonVersion ?? '' }),
  })
  await raiseForClientError(enrolled)
  if (enrolled.status >= 500) throw new TransientError(`el control plane respondió ${enrolled.status}`, enrolled.status)
  const payload = await asDict(enrolled)
  const token = String(payload['token'] ?? '')
  const machine = (payload['machine'] ?? {}) as Record<string, unknown>
  if (!token || !machine['id']) throw new ControlPlaneError('la respuesta de enrolamiento vino incompleta')
  return { machine, token }
}

async function asDict(response: FetchResponse): Promise<Record<string, unknown>> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ControlPlaneError('el control plane devolvió una respuesta que no es JSON')
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ControlPlaneError('el control plane devolvió una respuesta con forma inesperada')
  }
  return payload as Record<string, unknown>
}

async function raiseForClientError(response: FetchResponse): Promise<void> {
  const status = response.status
  if (status === UNAUTHORIZED || status === FORBIDDEN) {
    throw new AuthError(`el control plane rechazó las credenciales (${status}): ${await detail(response)}`, status)
  }
  if (status === NOT_FOUND) {
    throw new NotFoundError(`el control plane no encontró el recurso: ${await detail(response)}`, status)
  }
  if (status >= 400 && status < 500 && status !== NOT_MODIFIED) {
    throw new ControlPlaneError(`el control plane rechazó el pedido (${status}): ${await detail(response)}`, status)
  }
}

async function detail(response: FetchResponse): Promise<string> {
  try {
    const payload = await response.json()
    if (payload !== null && typeof payload === 'object' && 'detail' in payload) {
      return String((payload as { detail: unknown }).detail).slice(0, 200)
    }
    return JSON.stringify(payload).slice(0, 200)
  } catch {
    try {
      return (await response.text()).slice(0, 200)
    } catch {
      return ''
    }
  }
}

function short(exc: unknown): string {
  const err = exc as Error
  const d = (err.message ?? '').trim()
  return d ? `${err.name ?? 'Error'}: ${d}` : (err.name ?? 'Error')
}

const defaultFetcher: Fetcher = async (url, init) => {
  const response = await fetch(url, init as RequestInit)
  return {
    status: response.status,
    text: () => response.text(),
    json: () => response.json(),
  }
}
