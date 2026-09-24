/**
 * Orquestación del daemon: lo que los comandos del CLI necesitan.
 *
 * El comportamiento vive acá para que `cli.ts` solo parsee argumentos e imprima. Se
 * apoya en `state`, `sync`, `adapters` y `runtime`, y respeta los invariantes del
 * producto: una sola entrada `hub`, sin secretos ni upstreams en el archivo del CLI,
 * y modo degradado fail-closed (nunca abre lo que estaba cerrado).
 */

import { hostname as osHostname, platform, homedir } from 'node:os'
import { accessSync, constants } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

import type { CliKind } from '@agenthub/shared'
import { buildHeadlessGateway } from '@agenthub/gateway'
import { planMemoryHooks } from './adapters/memory-hooks.js'

import {
  adapterFor,
  applyChanges,
  CLI_KINDS,
  ClaudeDesktopAdapter,
  detectAll,
  exposedNameOf,
  gatewayEndpoint,
  type AccountSkillsReport,
  type ApplyResult,
  type DetectionResult,
  type DriftItem,
  type FileChange,
  type GatewayEndpoint,
  type Snapshot,
} from './adapters/index.js'
import {
  scanDigest,
  scanExternalSkills,
  watchExternalSkills,
  type ExternalScan,
  type ExternalSkillsOutcome,
} from './external_skills.js'
import {
  configApiBase,
  gatewayArgs,
  gatewayUrl,
  stdioGateway,
  type DaemonConfig,
} from './config.js'
import { finalNameFor } from './naming.js'
import { detectPlan } from './runtime/detect.js'
import {
  clientFromCredentials,
  desktopSession,
  enrollMachine,
  enrollWithSession,
  SnapshotSync,
  SyncClient,
  type Fetcher,
  type SyncOutcome,
} from './sync.js'
import { DaemonState, type Credentials } from './state.js'

export class DaemonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonError'
  }
}

export interface DetectionSummary {
  found: DetectionResult[]
  missing: string[]
}

export interface AgentInstance {
  id: string
  cliKind: string
  enabled: boolean
  raw: Record<string, unknown>
}

export interface AgentPass {
  agent: AgentInstance
  outcome: SyncOutcome
  snapshotHash: string
  port: number
  changes: FileChange[]
  drift: DriftItem[]
  applied: ApplyResult | null
  skipped: string
}

export interface SyncReport {
  agents: AgentPass[]
  bootstrapError: string
  /** Qué cambió en el catálogo por la biblioteca de skills; `null` si no hubo nada nuevo que reportar. */
  externalSkills?: ExternalSkillsOutcome | null
  externalScan?: ExternalScan | null
  externalError?: string
}

/** Cada cuánto se vuelve a recorrer la biblioteca aunque el observador no haya avisado. */
const EXTERNAL_RESCAN_MS = 60_000
/** Cada cuánto se recalcula la caché de skills de la cuenta de Claude Desktop sin cambios visibles. */
const ACCOUNT_RECHECK_MS = 5 * 60_000
/** Único cliente que recibe las skills por herramienta y guarda una caché de su cuenta. */
const DESKTOP_KIND: CliKind = 'claude_desktop'

export interface EnrollResult {
  machineId: string
  hostname: string
  userEmail: string
  credentialsPath: string
  detected: DetectionSummary
  registered: AgentInstance[]
  registerError: string
}

/** CLIs detectados y los que faltan, en el orden canónico. */
export function detectClis(home: string): DetectionSummary {
  const found = detectAll(home)
  const seen = new Set(found.map((f) => f.cliKind))
  // Claude Desktop no tiene binario en el PATH: lo detecta su adaptador por el directorio de datos.
  const binaries: Record<string, string> = { claude_code: 'claude', codex_cli: 'codex', gemini_cli: 'gemini', kiro: 'kiro-cli', opencode: 'opencode' }
  const directories = [join(home, '.local/bin'), join(home, '.cargo/bin'), join(home, '.opencode/bin'),
    ...(resolve(home) === resolve(homedir()) ? (process.env.PATH ?? '').split(delimiter) : []),
  ]
  for (const [kind, binary] of Object.entries(binaries)) {
    if (seen.has(kind)) continue
    const executable = directories.flatMap(dir => platform() === 'win32' ? [join(dir, binary + '.exe'), join(dir, binary + '.cmd')] : [join(dir, binary)])
      .find(path => { try { accessSync(path, constants.X_OK); return true } catch { return false } })
    if (!executable) continue
    const paths: Record<string, string> = { claude_code: '.claude.json', codex_cli: '.codex/config.toml', gemini_cli: '.gemini/settings.json', kiro: '.kiro/settings/mcp.json', opencode: '.config/opencode/opencode.json' }
    found.push({ cliKind: kind, home, configPath: join(home, paths[kind]!), evidence: executable, version: '' })
    seen.add(kind)
  }
  const missing = CLI_KINDS.filter((kind) => !seen.has(kind))
  return { found, missing }
}

/** Normaliza el nombre de una herramienta a su exposed_name, con o sin prefijo. */
export function normalizeToolName(raw: string): string {
  const name = raw.trim()
  for (const prefix of ['mcp__hub__', 'hub___', 'hub__']) {
    if (name.startsWith(prefix)) return name.slice(prefix.length)
  }
  return name
}

/** Diff textual de un cambio planificado, para `agenthub plan`. */
export function diffFor(change: FileChange): string {
  if (change.action === 'delete') return `- borrar ${change.path}`
  if (change.action === 'symlink') return `+ enlazar ${change.path} -> ${change.target ?? ''}`
  if (change.action === 'adopt') return `= adoptar ${change.path} (ya enlaza a ${change.target ?? ''})`
  const lines = change.content.split('\n')
  const preview = lines.slice(0, 20)
  const suffix = lines.length > 20 ? [`… (${lines.length - 20} líneas más)`] : []
  return [...preview, ...suffix].map((l) => `+ ${l}`).join('\n')
}

function agentFrom(raw: Record<string, unknown>): AgentInstance {
  return {
    id: String(raw['id'] ?? ''),
    cliKind: String(raw['cli_kind'] ?? ''),
    enabled: raw['enabled'] !== false,
    raw,
  }
}

/** Aplicación del daemon: reúne estado, sincronización y adaptadores. */
export class DaemonApp {
  private readonly deliveryRuns = new Map<string, Promise<void>>()
  readonly config: DaemonConfig
  readonly state: DaemonState
  private readonly fetcher: Fetcher | undefined
  private readonly maxAttempts: number
  private externalDirty = true
  private externalScannedAt = 0
  private externalDigest = ''
  private readonly accountMemo = new Map<string, { stamp: string; report: AccountSkillsReport | null }>()

  constructor(config: DaemonConfig, options: { fetcher?: Fetcher; maxAttempts?: number } = {}) {
    this.config = config
    this.state = new DaemonState(config.stateDir)
    this.fetcher = options.fetcher
    this.maxAttempts = options.maxAttempts ?? 5
  }

  get home(): string {
    return this.config.home
  }

  get stdioGateway(): boolean {
    return stdioGateway(this.config)
  }

  private clientFor(credentials: Credentials): SyncClient {
    return clientFromCredentials(credentials, configApiBase(this.config), {
      timeout: this.config.requestTimeout,
      maxAttempts: this.maxAttempts,
      ...(this.fetcher ? { fetcher: this.fetcher } : {}),
    })
  }

  cachedAgents(): AgentInstance[] {
    return this.state.loadAgents().map(agentFrom)
  }

  /** Cómo llega un agente al gateway, en una línea. */
  gatewayPointer(agent: AgentInstance): string {
    if (this.stdioGateway) {
      const { command, args, env } = gatewayArgs(this.config, agent.id)
      const prefix = Object.entries(env).map(([key, value]) => `${key}=${value} `).join('')
      return `${prefix}${command} ${args.join(' ')}`
    }
    const port = this.state.portFor(agent.id, this.config.gatewayBasePort)
    return gatewayUrl(this.config, port)
  }

  /** El endpoint (puntero al gateway) que baja al archivo de cada CLI. */
  endpointFor(agent: AgentInstance): GatewayEndpoint {
    if (this.stdioGateway) {
      const { command, args, env } = gatewayArgs(this.config, agent.id)
      return gatewayEndpoint({ transport: 'stdio', command, args, env })
    }
    const port = this.state.portFor(agent.id, this.config.gatewayBasePort)
    const token = this.state.gatewayToken(agent.id)
    return gatewayEndpoint({
      transport: 'http',
      url: gatewayUrl(this.config, port),
      headers: { Authorization: `Bearer ${token}` },
    })
  }

  /** Enrola la máquina y registra los CLIs detectados. */
  async enroll(args: { email: string; password: string; hostname?: string }): Promise<EnrollResult> {
    const host = args.hostname || osHostname()
    const { machine, token } = await enrollMachine(
      configApiBase(this.config),
      { email: args.email, password: args.password, hostname: host, osName: platform() },
      this.fetcher ? { fetcher: this.fetcher, timeout: this.config.requestTimeout } : { timeout: this.config.requestTimeout },
    )
    const credentials: Credentials = {
      controlPlaneUrl: this.config.controlPlaneUrl,
      machineId: String(machine['id']),
      userEmail: String(machine['user_email'] ?? args.email),
      token,
    }
    this.state.saveCredentials(credentials)

    const detected = detectClis(this.home)
    let registered: AgentInstance[] = []
    let registerError = ''
    if (detected.found.length > 0) {
      try {
        const client = this.clientFor(credentials)
        const agents = detected.found.map((d) => ({
          cli_kind: d.cliKind,
          cli_version: d.version,
          config_path: d.configPath,
        }))
        const result = await client.registerAgents(credentials.machineId, agents)
        registered = result.map(agentFrom)
        this.state.saveAgents(result)
      } catch (exc) {
        registerError = (exc as Error).message
      }
    }

    return {
      machineId: credentials.machineId,
      hostname: host,
      userEmail: credentials.userEmail,
      credentialsPath: this.state.credentialsPath,
      detected,
      registered,
      registerError,
    }
  }


  /** Auto-enrolamiento del modo desktop: el bootstrap nunca se persiste. */
  async enrollLocal(bootstrapToken: string, hostname = osHostname()): Promise<EnrollResult> {
    const api = configApiBase(this.config)
    const session = await desktopSession(api, bootstrapToken, this.fetcher ? { fetcher: this.fetcher } : {})
    const { machine, token } = await enrollWithSession(
      api,
      { accessToken: session.accessToken, hostname, osName: platform(), daemonVersion: '0.2.0' },
      this.fetcher ? { fetcher: this.fetcher, timeout: this.config.requestTimeout } : { timeout: this.config.requestTimeout },
    )
    const credentials: Credentials = {
      controlPlaneUrl: this.config.controlPlaneUrl,
      machineId: String(machine['id']),
      userEmail: String(machine['user_email'] ?? session.user['email'] ?? ''),
      token,
    }
    this.state.saveCredentials(credentials)

    const detected = detectClis(this.home)
    let registered: AgentInstance[] = []
    let registerError = ''
    if (detected.found.length > 0) {
      try {
        const client = this.clientFor(credentials)
        const result = await client.registerAgents(
          credentials.machineId,
          detected.found.map((item) => ({
            cli_kind: item.cliKind,
            cli_version: item.version,
            config_path: item.configPath,
          })),
        )
        registered = result.map(agentFrom)
        this.state.saveAgents(result)
      } catch (error) {
        registerError = (error as Error).message
      }
    }
    return {
      machineId: credentials.machineId,
      hostname,
      userEmail: credentials.userEmail,
      credentialsPath: this.state.credentialsPath,
      detected,
      registered,
      registerError,
    }
  }

  /** Enrolamiento con el token opaco que la consola muestra una sola vez. */
  async enrollWithToken(token: string, hostname = osHostname()): Promise<EnrollResult> {
    const provisional: Credentials = {
      controlPlaneUrl: this.config.controlPlaneUrl,
      machineId: '',
      userEmail: '',
      token,
    }
    const bootstrap = await this.clientFor(provisional).bootstrap()
    const credentials: Credentials = {
      ...provisional,
      machineId: String(bootstrap['machine_id'] ?? ''),
      userEmail: String(bootstrap['user_email'] ?? ''),
    }
    if (!credentials.machineId || !credentials.userEmail) throw new DaemonError('el token no identifica una máquina')
    this.state.saveCredentials(credentials)
    const detected = detectClis(this.home)
    let registered: AgentInstance[] = []
    let registerError = ''
    if (detected.found.length > 0) {
      try {
        const result = await this.clientFor(credentials).registerAgents(
          credentials.machineId,
          detected.found.map((item) => ({ cli_kind: item.cliKind, cli_version: item.version, config_path: item.configPath })),
        )
        registered = result.map(agentFrom)
        this.state.saveAgents(result)
      } catch (error) {
        registerError = (error as Error).message
      }
    }
    return {
      machineId: credentials.machineId,
      hostname,
      userEmail: credentials.userEmail,
      credentialsPath: this.state.credentialsPath,
      detected,
      registered,
      registerError,
    }
  }

  /** Una pasada de sincronización: baja snapshots, planifica y (opcional) aplica. */
  async syncOnce(opts: { apply: boolean; wait?: number }): Promise<SyncReport> {
    const credentials = this.state.loadCredentials()
    let bootstrapError = ''
    let agents: AgentInstance[] = this.cachedAgents()

    if (credentials !== null) {
      try {
        const client = this.clientFor(credentials)
        const boot = await client.bootstrap()
        const bootAgents = Array.isArray(boot['agents']) ? (boot['agents'] as Array<Record<string, unknown>>) : []
        this.state.saveAgents(bootAgents)
        agents = bootAgents.map(agentFrom)
        const known = new Set(agents.map(agent => agent.cliKind))
        const added = detectClis(this.home).found.filter(item => !known.has(item.cliKind))
        if (added.length > 0) {
          await client.registerAgents(credentials.machineId, added.map(item => ({
            cli_kind: item.cliKind, cli_version: item.version, config_path: item.configPath,
          })))
          const refreshed = await client.bootstrap()
          const roster = refreshed['agents'] as Array<Record<string, unknown>>
          this.state.saveAgents(roster)
          agents = roster.map(agentFrom)
        }
      } catch (exc) {
        // Modo degradado: se sigue con la lista y los snapshots en disco.
        bootstrapError = (exc as Error).message
      }
    }

    let externalSkills: ExternalSkillsOutcome | null = null
    let externalScan: ExternalScan | null = null
    let externalError = ''
    if (credentials !== null && bootstrapError === '') {
      try {
        const result = await this.syncExternalSkills(this.clientFor(credentials))
        externalSkills = result.outcome
        externalScan = result.scan
      } catch (exc) {
        externalError = (exc as Error).message
      }
    }

    const passes: AgentPass[] = []
    const sync =
      credentials !== null ? new SnapshotSync(this.clientFor(credentials), this.state, { pollSeconds: this.config.pollSeconds }) : null

    // Fetch concurrently: one unchanged client's long poll must not delay another's OFF.
    const outcomes = await Promise.all(agents.map(agent => sync?.refresh(agent.id, { wait: opts.wait ?? 0 })))
    for (const [index, agent] of agents.entries()) {
      const pass = await this.processAgent(agent, null, opts, outcomes[index])
      passes.push(pass)
    }

    return { agents: passes, bootstrapError, externalSkills, externalScan, externalError }
  }

  /**
   * Recorre `~/.agents/skills` cuando el observador avisó o venció el plazo, y manda la foto
   * al core sólo si cambió respecto de la última que aceptó. Devuelve el recorrido siempre
   * que lo haya hecho, y el resultado del core sólo cuando le mandó algo.
   */
  async syncExternalSkills(client: SyncClient): Promise<{ scan: ExternalScan | null; outcome: ExternalSkillsOutcome | null }> {
    const now = Date.now()
    if (!this.externalDirty && now - this.externalScannedAt < EXTERNAL_RESCAN_MS) return { scan: null, outcome: null }
    this.externalDirty = false
    this.externalScannedAt = now
    const scan = scanExternalSkills(this.home)
    const digest = scanDigest(scan)
    if (digest === this.externalDigest) return { scan, outcome: null }
    try {
      const outcome = await client.putExternalSkills(scan.skills)
      this.externalDigest = digest
      return { scan, outcome }
    } catch (exc) {
      // El reporte se reintenta en el próximo plazo; mientras tanto el catálogo conserva la foto anterior.
      this.externalDirty = true
      throw exc
    }
  }

  /** Observa la biblioteca para adelantar el reescaneo. Devuelve cómo dejar de observar. */
  watchExternalSkills(): () => void {
    return watchExternalSkills(this.home, () => {
      this.externalDirty = true
    })
  }

  /** Estado de las skills del snapshot en la cuenta de claude.ai de Claude Desktop, con memoria por pasada. */
  private accountSkillsFor(agent: AgentInstance, snapshot: Snapshot, snapshotHash: string): AccountSkillsReport | null {
    if (agent.cliKind !== DESKTOP_KIND) return null
    const adapter = adapterFor(agent.cliKind) as ClaudeDesktopAdapter
    const stamp = `${snapshotHash}|${adapter.accountCacheStamp(this.home)}|${Math.floor(Date.now() / ACCOUNT_RECHECK_MS)}`
    const memo = this.accountMemo.get(agent.id)
    if (memo !== undefined && memo.stamp === stamp) return memo.report
    const report = adapter.readAccountSkills(snapshot, this.home)
    this.accountMemo.set(agent.id, { stamp, report })
    return report
  }

  private async processAgent(
    agent: AgentInstance,
    sync: SnapshotSync | null,
    opts: { apply: boolean; wait?: number },
    refreshed?: SyncOutcome,
  ): Promise<AgentPass> {
    const port = this.stdioGateway ? 0 : this.state.portFor(agent.id, this.config.gatewayBasePort)
    let outcome: SyncOutcome
    if (refreshed) {
      outcome = refreshed
    } else if (sync !== null) {
      outcome = await sync.refresh(agent.id, { wait: opts.wait ?? 0 })
    } else {
      const cached = this.state.loadSnapshot(agent.id)
      outcome = {
        agentId: agent.id,
        source: cached ? 'disk' : 'missing',
        snapshot: cached,
        error: 'sin credenciales',
      }
    }

    const base: Omit<AgentPass, 'changes' | 'drift' | 'applied' | 'skipped'> = {
      agent,
      outcome,
      snapshotHash: outcome.snapshot ? String(outcome.snapshot['snapshot_hash'] ?? '') : '',
      port,
    }

    if (outcome.snapshot === null) {
      return { ...base, changes: [], drift: [], applied: null, skipped: 'sin snapshot local todavía' }
    }

    const snapshot = outcome.snapshot as unknown as Snapshot
    const endpoint = this.endpointFor(agent)
    const adapter = adapterFor(agent.cliKind)
    const [changes, drift] = adapter.planDetailed(snapshot, endpoint, this.home)

    if (!opts.apply) {
      const [hooks, hookDrift] = planMemoryHooks(snapshot, endpoint, this.home)
      return { ...base, changes: [...changes, ...hooks], drift: [...drift, ...hookDrift], applied: null, skipped: '' }
    }

    const applied = applyChanges(changes)
    // Plan after MCP/deny edits: Claude and Gemini keep hooks in the same settings file.
    const [hooks, hookDrift] = planMemoryHooks(snapshot, endpoint, this.home)
    const hookResult = applyChanges(hooks)
    changes.push(...hooks); drift.push(...hookDrift)
    applied.written.push(...hookResult.written); applied.removed.push(...hookResult.removed)
    applied.drift.push(...hookResult.drift); applied.skipped.push(...hookResult.skipped)
    Object.assign(applied.backups, hookResult.backups)
    if (!this.deliveryRuns.has(agent.id)) {
      const delivery = buildHeadlessGateway({ agentInstanceId: agent.id, snapshotPath: this.state.snapshotPath(agent.id), oauthDir: join(this.config.stateDir, 'oauth'), detectContainers: false })
      const running = delivery.gateway.flushMemory().catch(() => undefined).finally(async () => {
        delivery.store.stopWatching(); await delivery.pool.close(); this.deliveryRuns.delete(agent.id)
      })
      this.deliveryRuns.set(agent.id, running)
    }
    this.state.recordManaged({
      agentId: agent.id,
      cliKind: agent.cliKind,
      home: this.home,
      written: applied.written,
      removed: applied.removed,
      drift: [...drift, ...applied.drift].map((d) => `${d.path} [${d.region}]: ${d.reason}`),
    })
    const credentials = this.state.loadCredentials()
    if (credentials) {
      const allDrift = [...drift, ...applied.drift]
      const accountSkills = this.accountSkillsFor(agent, snapshot, base.snapshotHash)
      await this.clientFor(credentials).report(agent.id, {
        driftDetected: allDrift.length > 0,
        driftDetail: allDrift.map(d => `${d.path}: ${d.reason}`).join('\n'),
        syncedHash: allDrift.length === 0 ? base.snapshotHash : '',
        ...(accountSkills !== null ? { accountSkills } : {}),
      }).catch(() => undefined)
    }
    return { ...base, changes, drift, applied, skipped: '' }
  }

  /** Explicación local del estado de una herramienta, por agente. */
  explainToolLocal(raw: string): Array<[AgentInstance, string]> {
    const name = normalizeToolName(raw)
    const out: Array<[AgentInstance, string]> = []
    for (const agent of this.cachedAgents()) {
      const snapshot = this.state.loadSnapshot(agent.id)
      if (snapshot === null) continue
      const final = finalNameFor(agent.cliKind, name)
      const denied = (snapshot['denied'] ?? []) as Array<Record<string, unknown>>
      const servers = (snapshot['servers'] ?? []) as Array<Record<string, unknown>>
      const exposedNames = new Set<string>()
      for (const server of servers) {
        for (const tool of (server['tools'] ?? []) as Array<Record<string, unknown>>) {
          exposedNames.add(String(tool['exposed_name'] ?? ''))
        }
      }
      const deniedNames = new Set(
        denied
          .filter((d) => d['resource_type'] === 'mcp_tool')
          .map((d) => finalNameFor(agent.cliKind, exposedNameOf({ slug: String(d['slug'] ?? '') }))),
      )
      if (deniedNames.has(final)) {
        out.push([agent, `'${final}' está apagada en el panel: el gateway deniega la llamada.`])
      } else if (exposedNames.has(name)) {
        out.push([agent, `'${final}' está disponible: el gateway la deja pasar al server de destino.`])
      }
    }
    return out
  }

  /** Foto del plan de aislamiento de la máquina (motor + ToolHive). */
  isolationSummary(): string[] {
    return detectPlan().availability.engines.map((e) => `${e.name}: ${e.available ? 'disponible' : e.detail}`)
  }

  cliKinds(): readonly CliKind[] {
    return CLI_KINDS
  }
}
