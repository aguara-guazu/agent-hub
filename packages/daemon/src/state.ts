/**
 * Estado persistente del daemon en el directorio de estado del sistema.
 *
 * Guarda:
 *
 * 1. `credentials.json`: a qué control plane pertenece esta máquina y con qué token
 *    habla. Es el único archivo con material sensible; se escribe 0600 dentro de un
 *    directorio 0700 y nunca se loguea ni se imprime.
 * 2. `snapshots/<agent_id>.json`: el último snapshot servido. Es lo que hace posible
 *    el MODO DEGRADADO.
 * 3. `managed.json`: índice de alto nivel de lo que escribió el daemon por agente.
 *
 * También asigna el puerto del listener de cada agente y lo persiste: un puerto
 * estable evita reescribir la configuración de los CLIs en cada arranque.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const STATE_VERSION = 1

/** Entropía del token que protege el listener local del gateway. */
export const GATEWAY_TOKEN_BYTES = 32
/** Cuántos puertos se prueban hacia arriba desde el base antes de rendirse. */
export const PORT_SCAN_RANGE = 200

const CREDENTIALS_FILE = 'credentials.json'
const SNAPSHOTS_DIR = 'snapshots'
const AGENTS_FILE = 'agents.json'
const MANAGED_FILE = 'managed.json'
const PORTS_FILE = 'ports.json'
const GATEWAY_TOKENS_FILE = 'gateway_tokens.json'
const HUB_FILE = 'hub.json'
export const HUB_DB_FILE = 'hub.db'

/** Identidad de la máquina frente al control plane. */
export interface Credentials {
  controlPlaneUrl: string
  machineId: string
  userEmail: string
  token: string
}

/** Versión imprimible de las credenciales: el token se reduce a si está o no. */
export function describeCredentials(credentials: Credentials): Record<string, string> {
  return {
    control_plane_url: credentials.controlPlaneUrl,
    machine_id: credentials.machineId,
    user_email: credentials.userEmail,
    token: credentials.token ? 'presente' : 'ausente',
  }
}

/** Lo que el daemon escribió para un agente en la última aplicación. */
export interface ManagedFiles {
  agentId: string
  cliKind: string
  home: string
  written: string[]
  removed: string[]
  drift: string[]
}

function managedToDict(entry: ManagedFiles): Record<string, unknown> {
  return {
    agent_id: entry.agentId,
    cli_kind: entry.cliKind,
    home: entry.home,
    written: [...entry.written],
    removed: [...entry.removed],
    drift: [...entry.drift],
  }
}

function managedFromDict(payload: Record<string, unknown>): ManagedFiles {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : [])
  return {
    agentId: String(payload['agent_id'] ?? ''),
    cliKind: String(payload['cli_kind'] ?? ''),
    home: String(payload['home'] ?? ''),
    written: arr(payload['written']),
    removed: arr(payload['removed']),
    drift: arr(payload['drift']),
  }
}

function safeName(value: string): string {
  const cleaned = [...value].map((ch) => (/[A-Za-z0-9\-_]/.test(ch) ? ch : '_')).join('')
  return cleaned || 'sin_id'
}

/** Acceso al directorio de estado. Todas las escrituras son atómicas. */
export class DaemonState {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  get credentialsPath(): string {
    return join(this.root, CREDENTIALS_FILE)
  }

  get snapshotsDir(): string {
    return join(this.root, SNAPSHOTS_DIR)
  }

  get agentsPath(): string {
    return join(this.root, AGENTS_FILE)
  }

  get managedPath(): string {
    return join(this.root, MANAGED_FILE)
  }

  get portsPath(): string {
    return join(this.root, PORTS_FILE)
  }

  get gatewayTokensPath(): string {
    return join(this.root, GATEWAY_TOKENS_FILE)
  }

  get hubPath(): string {
    return join(this.root, HUB_FILE)
  }

  get hubDbPath(): string {
    return join(this.root, HUB_DB_FILE)
  }

  /** Socket de control de ToolHive para este directorio de estado. */
  toolhiveSocketPath(): string {
    const digest = createHash('sha256').update(this.root).digest('hex').slice(0, 10)
    return join(tmpdir(), `agenthub-${digest}.sock`)
  }

  snapshotPath(agentId: string): string {
    return join(this.snapshotsDir, `${safeName(agentId)}.json`)
  }

  // ---- credenciales ----

  loadCredentials(): Credentials | null {
    const payload = readJson(this.credentialsPath)
    if (payload === null) return null
    const token = String(payload['token'] ?? '')
    if (!token) return null
    return {
      controlPlaneUrl: String(payload['control_plane_url'] ?? ''),
      machineId: String(payload['machine_id'] ?? ''),
      userEmail: String(payload['user_email'] ?? ''),
      token,
    }
  }

  saveCredentials(credentials: Credentials): void {
    writeJson(
      this.credentialsPath,
      {
        version: STATE_VERSION,
        control_plane_url: credentials.controlPlaneUrl,
        machine_id: credentials.machineId,
        user_email: credentials.userEmail,
        token: credentials.token,
      },
      0o600,
    )
  }

  clearCredentials(): void {
    rmSync(this.credentialsPath, { force: true })
  }

  // ---- snapshots ----

  saveSnapshot(snapshot: Record<string, unknown>): void {
    const agentId = String(snapshot['agent_instance_id'] ?? '')
    if (!agentId) throw new Error('el snapshot no trae agent_instance_id')
    writeJson(this.snapshotPath(agentId), snapshot)
  }

  loadSnapshot(agentId: string): Record<string, unknown> | null {
    return readJson(this.snapshotPath(agentId))
  }

  /** Hash del snapshot en disco, o cadena vacía. Es el `known_hash` del 304. */
  knownHash(agentId: string): string {
    const snapshot = this.loadSnapshot(agentId)
    return snapshot ? String(snapshot['snapshot_hash'] ?? '') : ''
  }

  snapshotAgentIds(): string[] {
    let names: string[]
    try {
      names = readdirSync(this.snapshotsDir)
    } catch {
      return []
    }
    const ids: string[] = []
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const payload = readJson(join(this.snapshotsDir, name))
      if (payload) ids.push(String(payload['agent_instance_id'] ?? name.replace(/\.json$/, '')))
    }
    return ids
  }

  allSnapshots(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {}
    for (const agentId of this.snapshotAgentIds()) {
      const snapshot = this.loadSnapshot(agentId)
      if (snapshot !== null) out[agentId] = snapshot
    }
    return out
  }

  dropSnapshot(agentId: string): void {
    rmSync(this.snapshotPath(agentId), { force: true })
  }

  // ---- agentes conocidos ----

  saveAgents(agents: ReadonlyArray<Record<string, unknown>>): void {
    writeJson(this.agentsPath, { version: STATE_VERSION, agents: agents.map((a) => ({ ...a })) })
  }

  loadAgents(): Array<Record<string, unknown>> {
    const payload = readJson(this.agentsPath)
    if (!payload) return []
    const agents = payload['agents']
    return Array.isArray(agents) ? agents.map((a) => ({ ...(a as Record<string, unknown>) })) : []
  }

  // ---- archivos gestionados ----

  recordManaged(entry: ManagedFiles): void {
    const current = new Map<string, ManagedFiles>()
    for (const item of this.loadManaged()) current.set(item.agentId, item)
    current.set(entry.agentId, entry)
    const keys = [...current.keys()].sort()
    writeJson(this.managedPath, { version: STATE_VERSION, agents: keys.map((k) => managedToDict(current.get(k)!)) })
  }

  loadManaged(): ManagedFiles[] {
    const payload = readJson(this.managedPath)
    if (!payload) return []
    const agents = payload['agents']
    return Array.isArray(agents) ? agents.map((a) => managedFromDict(a as Record<string, unknown>)) : []
  }

  // ---- token del gateway local ----

  gatewayToken(agentId: string): string {
    const tokens = readJson(this.gatewayTokensPath) ?? {}
    const existing = tokens[agentId]
    if (typeof existing === 'string' && existing) return existing
    const token = tokenUrlsafe(GATEWAY_TOKEN_BYTES)
    tokens[agentId] = token
    writeJson(this.gatewayTokensPath, tokens, 0o600)
    return token
  }

  rotateGatewayToken(agentId: string): string {
    const tokens = readJson(this.gatewayTokensPath) ?? {}
    const token = tokenUrlsafe(GATEWAY_TOKEN_BYTES)
    tokens[agentId] = token
    writeJson(this.gatewayTokensPath, tokens, 0o600)
    return token
  }

  dropGatewayToken(agentId: string): void {
    const tokens = readJson(this.gatewayTokensPath) ?? {}
    if (agentId in tokens) {
      delete tokens[agentId]
      writeJson(this.gatewayTokensPath, tokens, 0o600)
    }
  }

  // ---- secreto del hub local ----

  hubSecret(): string {
    const payload = readJson(this.hubPath) ?? {}
    const existing = payload['jwt_secret']
    if (typeof existing === 'string' && existing) return existing
    const secret = tokenUrlsafe(GATEWAY_TOKEN_BYTES)
    payload['jwt_secret'] = secret
    writeJson(this.hubPath, payload, 0o600)
    return secret
  }

  hubPrepared(): boolean {
    const payload = readJson(this.hubPath) ?? {}
    return Boolean(payload['jwt_secret'])
  }

  // ---- puertos ----

  /**
   * Puerto estable del listener de un agente.
   *
   * `isFree` comprueba que el puerto esté libre en el sistema. Node no ofrece un
   * bind síncrono, así que por defecto solo se evita chocar con otro agente ya
   * asignado; quien quiera además verificar el sistema puede inyectar un predicado
   * — es el punto que las pruebas usan para simular puertos ocupados.
   */
  portFor(agentId: string, basePort: number, isFree: (port: number) => boolean = () => true): number {
    const assigned = this.loadPorts()
    const existing = assigned[agentId]
    if (existing !== undefined) return existing
    const used = new Set(Object.values(assigned))
    let port = basePort
    while (used.has(port) || !isFree(port)) {
      port += 1
      if (port > basePort + PORT_SCAN_RANGE) {
        throw new Error(`no hay ningún puerto libre entre ${basePort} y ${basePort + PORT_SCAN_RANGE}`)
      }
    }
    assigned[agentId] = port
    this.savePorts(assigned)
    return port
  }

  ports(): Record<string, number> {
    return { ...this.loadPorts() }
  }

  private loadPorts(): Record<string, number> {
    const payload = readJson(this.portsPath)
    if (!payload) return {}
    const raw = (payload['ports'] ?? {}) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw)) out[String(k)] = Number(v)
    return out
  }

  private savePorts(ports: Record<string, number>): void {
    const sorted = Object.fromEntries(Object.entries(ports).sort(([a], [b]) => (a < b ? -1 : 1)))
    writeJson(this.portsPath, { version: STATE_VERSION, ports: sorted })
  }

  /** Resumen para `agenthub status`, sin material sensible. */
  describe(): Record<string, unknown> {
    const credentials = this.loadCredentials()
    const snapshots: Record<string, string> = {}
    for (const [agentId, snapshot] of Object.entries(this.allSnapshots())) {
      snapshots[agentId] = String(snapshot['snapshot_hash'] ?? '')
    }
    return {
      state_dir: this.root,
      credentials: credentials ? describeCredentials(credentials) : null,
      snapshots,
      ports: this.ports(),
    }
  }
}

export function stateFor(root: string): DaemonState {
  return new DaemonState(root)
}

/** Ids de agente de una respuesta de bootstrap, en orden estable. */
export function iterAgentIds(agents: ReadonlyArray<Record<string, unknown>>): string[] {
  return agents.filter((a) => a['id']).map((a) => String(a['id']))
}

/** Versión async del chequeo de puerto libre (Node no ofrece bind síncrono). */
export function portIsFreeAsync(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

function tokenUrlsafe(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

function readJson(path: string): Record<string, unknown> | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return null
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    // Un archivo de estado corrupto se trata como ausente.
    return null
  }
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null
}

/** Escritura atómica: temp en el mismo directorio y rename, con permisos. */
function writeJson(path: string, payload: Record<string, unknown>, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true })
  chmodSync(dirname(path), 0o700)
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  const body = JSON.stringify(payload, null, 2) + '\n'
  const fd = openSync(tmp, 'w', mode)
  try {
    writeSync(fd, body)
    fsyncSync(fd)
    closeSync(fd)
  } catch (exc) {
    try {
      closeSync(fd)
    } catch {
      /* ya cerrado */
    }
    rmSync(tmp, { force: true })
    throw exc
  }
  renameSync(tmp, path)
  chmodSync(path, mode)
}
