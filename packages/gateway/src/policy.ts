/**
 * Vista indexada del snapshot vigente y decision de exposicion en tiempo de llamada.
 *
 * Sostiene el invariante del producto: **listar es cache, llamar es politica**.
 * `tools/list` se responde con el snapshot cacheado; `tools/call` vuelve a consultar
 * el snapshot VIGENTE en ese instante. Entre una cosa y la otra el panel pudo apagar
 * la herramienta, y en ese caso la llamada se deniega aunque el CLI la siga mostrando.
 *
 * La denegacion no es una excepcion de protocolo: es un `CallToolResult` con `isError`,
 * para que el modelo lea el motivo y pueda explicarlo.
 */

import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { PolicySnapshot } from '@agenthub/shared'
import { argsDigest as sharedArgsDigest } from '@agenthub/shared'
import { buildExposedName } from '@agenthub/shared'
import { UpstreamSpec } from './runtime.js'

export const DECISION_ALLOW = 'allow'
export const DECISION_DENY = 'deny'

const RESOURCE_MCP_TOOL = 'mcp_tool'
const RESOURCE_MCP_SERVER = 'mcp_server'
const RESOURCE_SKILL = 'skill'

/** Huella de los argumentos de una llamada. Se reporta en lugar de los argumentos. */
export function argsDigest(args: unknown): string {
  return sharedArgsDigest(args ?? {})
}

export interface ExposedTool {
  exposedName: string
  serverSlug: string
  toolName: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  definitionHash: string
  serverId: string
  toolId: string
}

export interface DeniedTool {
  exposedName: string
  slug: string
  resourceId: string
  source: string
  detail: string
  lockedAt: string | null
}

/** Una skill habilitada para el agente, tal como la entrega la herramienta `use_skill`. */
export interface ExposedSkill {
  slug: string
  displayName: string
  description: string
  body: string
  /** `external` cuando vive en la biblioteca de la persona; `hub` cuando el cuerpo esta en el snapshot. */
  source: 'hub' | 'external'
  sourcePath: string
}

export function denialMessage(denied: DeniedTool): string {
  const parts = [
    `El hub tiene apagada la herramienta '${denied.exposedName}' para este agente, asi que la llamada no se ejecuto.`,
    'La lista que muestra este CLI quedo vieja: la decision vigente del hub es la que vale.',
  ]
  if (denied.detail) parts.push(`Motivo: ${denied.detail}.`)
  if (denied.source) parts.push(`Nivel que decide: ${denied.source}.`)
  if (denied.lockedAt) parts.push(`La decision esta congelada en el nivel ${denied.lockedAt}.`)
  parts.push(
    `Para ver el detalle completo: 'agenthub why ${denied.exposedName}'. ` +
      'Para volver a habilitarla hace falta cambiarlo en el panel del hub.',
  )
  return parts.join(' ')
}

export function serverOffMessage(exposedName: string, server: DeniedTool): string {
  const parts = [
    `El hub tiene apagado el MCP server '${server.slug}' para este cliente, asi que su herramienta '${exposedName}' no se expone y la llamada no se ejecuto.`,
  ]
  const motivo = (server.detail || '').trim()
  if (motivo) parts.push(`Motivo: ${motivo.replace(/\.+$/, '')}.`)
  if (server.source) parts.push(`Nivel que decide: ${server.source}.`)
  parts.push('Para volver a tenerla hay que prender el server en el panel del hub.')
  return parts.join(' ')
}

export function unknownToolMessage(exposedName: string): string {
  return (
    `El hub no expone ninguna herramienta llamada '${exposedName}' para este agente. ` +
    'Puede que este CLI este mostrando una lista vieja o que la herramienta se haya quitado del catalogo. ' +
    'Volve a listar las herramientas para ver las vigentes.'
  )
}

interface DeniedEntry {
  resource_type?: string
  resource_id?: string
  slug?: string
  exposed?: string
  source?: string
  detail?: string
  locked_at?: string | null
}

/** Snapshot ya indexado por nombre expuesto. Inmutable: cambiar de politica es reemplazar la vista entera. */
export class SnapshotView {
  readonly agentInstanceId: string
  readonly cliKind: string
  readonly snapshotHash: string
  readonly generatedAt: string
  readonly userEmail: string
  readonly tools: readonly ExposedTool[]
  readonly skills: readonly ExposedSkill[]
  private readonly specs: ReadonlyMap<string, UpstreamSpec>
  private readonly denied: ReadonlyMap<string, DeniedTool>
  private readonly deniedServers: ReadonlyMap<string, DeniedTool>
  private readonly deniedSkills: ReadonlyMap<string, DeniedTool>
  private readonly byName: ReadonlyMap<string, ExposedTool>
  private readonly bySkill: ReadonlyMap<string, ExposedSkill>

  private constructor(init: {
    agentInstanceId: string
    cliKind: string
    snapshotHash: string
    generatedAt: string
    userEmail: string
    tools: ExposedTool[]
    skills: ExposedSkill[]
    specs: Map<string, UpstreamSpec>
    denied: Map<string, DeniedTool>
    deniedServers: Map<string, DeniedTool>
    deniedSkills: Map<string, DeniedTool>
  }) {
    this.agentInstanceId = init.agentInstanceId
    this.cliKind = init.cliKind
    this.snapshotHash = init.snapshotHash
    this.generatedAt = init.generatedAt
    this.userEmail = init.userEmail
    this.tools = init.tools
    this.skills = init.skills
    this.specs = init.specs
    this.denied = init.denied
    this.deniedServers = init.deniedServers
    this.deniedSkills = init.deniedSkills
    this.byName = new Map(init.tools.map((tool) => [tool.exposedName, tool]))
    this.bySkill = new Map(init.skills.map((skill) => [skill.slug, skill]))
  }

  /** Vista sin herramientas, para antes del primer snapshot: vacia, no "todo prendido". */
  static empty(agentInstanceId: string): SnapshotView {
    return new SnapshotView({
      agentInstanceId,
      cliKind: '',
      snapshotHash: '',
      generatedAt: '',
      userEmail: '',
      tools: [],
      skills: [],
      specs: new Map(),
      denied: new Map(),
      deniedServers: new Map(),
      deniedSkills: new Map(),
    })
  }

  static fromSnapshot(payload: Partial<PolicySnapshot> & Record<string, unknown>): SnapshotView {
    const tools: ExposedTool[] = []
    const specs = new Map<string, UpstreamSpec>()
    const servers = (payload['servers'] ?? []) as unknown as Array<Record<string, unknown>>
    for (const server of servers) {
      const slug = String(server['slug'])
      specs.set(slug, UpstreamSpec.fromSnapshot(server as never))
      const serverTools = (server['tools'] ?? []) as Array<Record<string, unknown>>
      for (const tool of serverTools) {
        tools.push({
          exposedName: String(tool['exposed_name']),
          serverSlug: slug,
          toolName: String(tool['name']),
          title: String(tool['title'] ?? ''),
          description: String(tool['description'] ?? ''),
          inputSchema: (tool['input_schema'] ?? { type: 'object', properties: {} }) as Record<string, unknown>,
          definitionHash: String(tool['definition_hash'] ?? ''),
          serverId: String(server['id'] ?? ''),
          toolId: String(tool['id'] ?? ''),
        })
      }
    }

    const skills: ExposedSkill[] = []
    for (const skill of (payload['skills'] ?? []) as unknown as Array<Record<string, unknown>>) {
      const slug = String(skill['slug'] ?? '')
      if (!slug) continue
      const sourcePath = String(skill['source_path'] ?? '')
      skills.push({
        slug,
        displayName: String(skill['display_name'] ?? ''),
        description: String(skill['description'] ?? ''),
        body: String(skill['body'] ?? ''),
        source: skill['source'] === 'external' && sourcePath ? 'external' : 'hub',
        sourcePath,
      })
    }
    skills.sort((a, b) => a.slug.localeCompare(b.slug))

    const denied = new Map<string, DeniedTool>()
    const deniedServers = new Map<string, DeniedTool>()
    const deniedSkills = new Map<string, DeniedTool>()
    const deniedEntries = (payload['denied'] ?? []) as DeniedEntry[]
    for (const item of deniedEntries) {
      const kind = item.resource_type
      if (kind === RESOURCE_SKILL) {
        const slug = String(item.slug ?? '')
        if (slug) {
          deniedSkills.set(slug, {
            exposedName: slug,
            slug,
            resourceId: String(item.resource_id ?? ''),
            source: String(item.source ?? ''),
            detail: String(item.detail ?? ''),
            lockedAt: item.locked_at ?? null,
          })
        }
        continue
      }
      if (kind === RESOURCE_MCP_SERVER) {
        const slug = String(item.slug ?? '')
        if (slug) {
          deniedServers.set(slug, {
            exposedName: slug,
            slug,
            resourceId: String(item.resource_id ?? ''),
            source: String(item.source ?? ''),
            detail: String(item.detail ?? ''),
            lockedAt: item.locked_at ?? null,
          })
        }
        continue
      }
      if (kind !== RESOURCE_MCP_TOOL) continue
      const parts = String(item.slug ?? '').split('/')
      const name = typeof item.exposed === 'string' && item.exposed
        ? item.exposed : parts.length === 2 ? buildExposedName(parts[0]!, parts[1]!) : String(item.slug ?? '')
      denied.set(name, {
        exposedName: name,
        slug: String(item.slug ?? ''),
        resourceId: String(item.resource_id ?? ''),
        source: String(item.source ?? ''),
        detail: String(item.detail ?? ''),
        lockedAt: item.locked_at ?? null,
      })
    }

    const ordered = [...tools].sort((a, b) => a.exposedName.localeCompare(b.exposedName))
    return new SnapshotView({
      agentInstanceId: String(payload['agent_instance_id'] ?? ''),
      cliKind: String(payload['cli_kind'] ?? ''),
      snapshotHash: String(payload['snapshot_hash'] ?? ''),
      generatedAt: String(payload['generated_at'] ?? ''),
      userEmail: String(payload['user_email'] ?? ''),
      tools: ordered,
      skills,
      specs,
      denied,
      deniedServers,
      deniedSkills,
    })
  }

  tool(exposedName: string): ExposedTool | undefined {
    return this.byName.get(exposedName)
  }

  skill(slug: string): ExposedSkill | undefined {
    return this.bySkill.get(slug)
  }

  deniedSkill(slug: string): DeniedTool | undefined {
    return this.deniedSkills.get(slug)
  }

  denialFor(exposedName: string): DeniedTool | undefined {
    return this.denied.get(exposedName)
  }

  /** El server apagado que serviria esa herramienta, si lo hay. */
  deniedServerFor(exposedName: string, hint = ''): DeniedTool | undefined {
    if (hint) {
      const found = this.deniedServers.get(hint)
      if (found !== undefined) return found
    }
    const candidates = [...this.deniedServers.keys()].filter((slug) => exposedName.startsWith(`${slug}_`))
    if (candidates.length === 0) return undefined
    const longest = candidates.reduce((a, b) => (b.length > a.length ? b : a))
    return this.deniedServers.get(longest)
  }

  specFor(serverSlug: string): UpstreamSpec | undefined {
    return this.specs.get(serverSlug)
  }

  upstreams(): UpstreamSpec[] {
    return [...this.specs.keys()].sort().map((slug) => this.specs.get(slug)!)
  }

  /** Una frase sobre el estado de una herramienta. La usa `agenthub why`. */
  explain(exposedName: string, serverSlug = ''): string {
    const tool = this.tool(exposedName)
    if (tool !== undefined) {
      return `'${exposedName}' esta disponible: la sirve el server '${tool.serverSlug}' como '${tool.toolName}'.`
    }
    const denied = this.denialFor(exposedName)
    if (denied !== undefined) return denialMessage(denied)
    const off = this.deniedServerFor(exposedName, serverSlug)
    if (off !== undefined) return serverOffMessage(exposedName, off)
    return unknownToolMessage(exposedName)
  }
}

export type PolicyListener = (view: SnapshotView) => void

/** Snapshot vigente de UN agente, reemplazable en caliente. */
export class PolicyStore {
  protected view: SnapshotView
  private readonly listeners: PolicyListener[] = []
  readonly agentInstanceId: string

  constructor(agentInstanceId: string, view?: SnapshotView) {
    if (view !== undefined && view.agentInstanceId && view.agentInstanceId !== agentInstanceId) {
      throw new Error('el snapshot no pertenece a este agent_instance')
    }
    this.agentInstanceId = agentInstanceId
    this.view = view ?? SnapshotView.empty(agentInstanceId)
  }

  get current(): SnapshotView {
    return this.view
  }

  /** Updated synchronously before every list/call, even when an OS notification was missed. */
  refresh(): void {}

  subscribe(listener: PolicyListener): void {
    this.listeners.push(listener)
  }

  /** Instala una vista nueva. Devuelve `true` si cambio el hash. */
  replace(view: SnapshotView): boolean {
    if (view.agentInstanceId && view.agentInstanceId !== this.agentInstanceId) {
      throw new Error(`el snapshot es del agente ${view.agentInstanceId} y este store es de ${this.agentInstanceId}`)
    }
    const changed = view.snapshotHash !== this.view.snapshotHash
    this.view = view
    if (changed) {
      for (const listener of [...this.listeners]) listener(view)
    }
    return changed
  }

  apply(snapshot: Partial<PolicySnapshot> & Record<string, unknown>): boolean {
    return this.replace(SnapshotView.fromSnapshot(snapshot))
  }
}

/**
 * PolicyStore respaldado por un archivo de snapshot en disco.
 *
 * El daemon escribe el snapshot vigente de cada agente en disco; el gateway headless,
 * que corre como proceso hijo lanzado por el CLI, lo lee de ahi. `reload()` vuelve a
 * leer el archivo y, si el hash cambio, reemplaza la vista y avisa a los suscriptores.
 * En modo degradado (el archivo no esta o no se puede leer) conserva el ultimo
 * snapshot valido: nunca fail-open, nunca "todo prendido".
 *
 * `watch()` observa el archivo para reaccionar a un cambio del panel sin reiniciar el
 * CLI; ese es el mecanismo que apaga una herramienta en la sesion ya abierta.
 */
export class DiskPolicyStore extends PolicyStore {
  private readonly path: string
  private lastContent = ''
  private watcher: FSWatcher | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null

  constructor(agentInstanceId: string, path: string, options: { loadNow?: boolean } = {}) {
    super(agentInstanceId)
    this.path = path
    if (options.loadNow ?? true) this.reload()
  }

  get snapshotPath(): string {
    return this.path
  }

  /** Relee el archivo. Devuelve `true` si cambio el hash. Nunca lanza: degrada. */
  reload(): boolean {
    if (!existsSync(this.path)) return false
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf-8')
      if (raw === this.lastContent) return false
    } catch {
      // Modo degradado: se conserva el ultimo snapshot valido.
      return false
    }
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return false
    }
    let view: SnapshotView
    try { view = SnapshotView.fromSnapshot(payload) } catch { return false }
    if (view.agentInstanceId && view.agentInstanceId !== this.agentInstanceId) {
      // Un archivo de otro agente no se aplica: seria exponer la politica ajena.
      return false
    }
    this.lastContent = raw
    return this.replace(view)
  }

  override refresh(): void { this.reload() }

  /** Observa el archivo y recarga en cada cambio. Idempotente. */
  watch(): void {
    if (this.refreshTimer !== null) return
    this.attachWatcher()
    // Filesystem events can be coalesced or missed during watcher startup on macOS.
    this.refreshTimer = setInterval(() => { this.reload(); this.attachWatcher() }, 500)
    this.refreshTimer.unref()
  }

  private attachWatcher(): void {
    if (this.watcher !== null) return
    // The daemon replaces the file with rename. Watch its parent, never the old inode.
    if (!existsSync(dirname(this.path))) return
    try {
      const watcher = watch(dirname(this.path), { persistent: false }, (_event, name) => {
        if (!name || String(name) === basename(this.path)) this.reload()
      })
      this.watcher = watcher
      watcher.on('error', () => { watcher.close(); if (this.watcher === watcher) this.watcher = null })
    } catch { /* The polling fallback can retry when the directory becomes available. */ }
  }

  stopWatching(): void {
    if (this.refreshTimer !== null) { clearInterval(this.refreshTimer); this.refreshTimer = null }
    if (this.watcher !== null) {
      this.watcher.close()
      this.watcher = null
    }
  }
}
