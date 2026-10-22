import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { check, MemoryError } from './contracts.js'
import { validCliModel, type ExtractionCli } from './cli-extraction.js'
import type { LocalChat } from './local-chat.js'
import type { TeamOrca, TeamWorkspace, TeamLaunchReceipt, TeamLaunchMember } from './team-orca.js'
import { FleetProcessManager, type FleetEvent, type FleetProcessOptions, type FleetStatus } from './fleet-process.js'

const exec = promisify(execFile)
type RunOptions = { cwd?: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: boolean }
export interface HubTeamOptions extends FleetProcessOptions {
  /** Read-only CLI capability checks and Git operations; prompts never travel through this runner. */
  run?: (command: string, args: string[], options: RunOptions) => Promise<{ stdout: string }>
}
export interface HubTeamStatus extends FleetStatus {
  provider: 'hub'
  generation: string
  updated_at: string
}
export interface HubTeamLaunchReceipt extends TeamLaunchReceipt { runtime: HubTeamStatus }
type ManagedChat = LocalChat & {
  managedLifecycle(sessionId: string, event: string, at: string, turnId?: string): Promise<unknown>
}
const encode = (path: string) => Buffer.from(path, 'utf8').toString('base64url')
const safeId = (id: string) => typeof id === 'string' && id.length > 0 && id.length <= 4000 && !/[\x00-\x1f\x7f]/.test(id)
const revision = (head: string) => /^[0-9a-f]{40,64}$/i.test(head)

/** Local Hub-owned worktrees and background children. No terminal, transcript or foreign PID interface. */
export class HubTeamRuntime implements TeamOrca {
  readonly provider = 'hub' as const
  private readonly manager: FleetProcessManager
  private readonly generations = new Map<string, string>()
  private readonly nextGenerations = new Map<string, string>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly launching = new Set<string>()
  private readonly env: NodeJS.ProcessEnv
  constructor(private readonly chat: LocalChat, readonly directory: string,
    private readonly enabled: () => boolean = () => true, private readonly options: HubTeamOptions = {}) {
    this.env = this.cleanEnv(process.env)
    this.manager = new FleetProcessManager(directory, {
      ...options,
      launcher: (command, args, launchOptions) => {
        const configured = { ...launchOptions, env: this.cleanEnv(launchOptions.env ?? this.env) }
        return options.launcher ? options.launcher(command, args, configured) : spawn(command, args, { ...configured, stdio: 'pipe' })
      },
      onEvent: event => this.enqueue(event.id, async () => {
        if (event.state === 'starting') {
          const generation = this.nextGenerations.get(event.id)
          check(generation, 'El lanzamiento del Hub no tiene generación válida.', 409)
          this.generations.set(event.id, generation)
          this.nextGenerations.delete(event.id)
        }
        const generation = this.generations.get(event.id)
        check(generation, 'El proceso del Hub no tiene generación válida.', 409)
        await this.persist(event, generation)
        await options.onEvent?.(event)
      }),
    })
  }
  private cleanEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...source }
    for (const key of Object.keys(env)) if (/^(AGENTHUB_|ORCA_|GIT_|ELECTRON_RUN_AS_NODE$)/i.test(key)) delete env[key]
    env.PATH = [env.PATH, join(homedir(), '.local', 'bin'), ...(process.platform === 'win32' ? [] : ['/usr/local/bin', '/opt/homebrew/bin'])]
      .filter(Boolean).join(delimiter)
    return env
  }
  private requireEnabled() { check(this.enabled(), 'La flota de agentes del Hub está desactivada.', 409) }
  private enqueue(id: string, work: () => Promise<void>): Promise<void> {
    const result = (this.queues.get(id) ?? Promise.resolve()).then(work)
    // Keep the queue usable after an operation fails, but return the failure to its caller.
    const tail = result.catch(() => {})
    this.queues.set(id, tail)
    void tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id) })
    return result
  }
  private async run(command: string, args: string[], cwd?: string) {
    try {
      return (await (this.options.run ?? exec)(command, args, { ...(cwd ? { cwd } : {}), env: this.env,
        timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })).stdout.trim()
    } catch { throw new MemoryError(503, 'No se pudo verificar la operación local del Hub. No se reintentó ni se eliminaron recursos.') }
  }
  async preflight(members: Array<{ cli: ExtractionCli; model: string; effort?: string }>): Promise<void> {
    this.requireEnabled()
    const checked = new Map<string, string>()
    for (const member of members) {
      check(member.cli === 'claude_code' || member.cli === 'codex_cli', 'La flota del Hub admite Claude Code y Codex CLI; Kiro todavía no está soportado.', 409)
      check(validCliModel(member.model), 'Elegí un nombre de modelo válido.', 400)
      check(!member.effort || /^[a-z][a-z0-9_-]{0,39}$/.test(member.effort), 'Esfuerzo inválido.', 400)
      let help = checked.get(member.cli)
      if (!help) {
        help = await this.run(member.cli === 'claude_code' ? 'claude' : 'codex', member.cli === 'claude_code' ? ['--help'] : ['app-server', '--help'])
        checked.set(member.cli, help)
      }
      const required = member.cli === 'claude_code'
        ? ['--print', '--input-format', '--output-format', '--verbose', '--dangerously-skip-permissions', '--model', '--session-id', '--resume', ...(member.effort ? ['--effort'] : [])]
        : ['--listen', 'stdio']
      check(required.every(flag => help.includes(flag)), 'La CLI instalada no confirma el protocolo nativo requerido por la flota del Hub. Actualizá la CLI antes de lanzar.', 409)
      this.requireEnabled()
    }
  }
  async workspace(id: string): Promise<TeamWorkspace> {
    check(safeId(id), 'Identificador de worktree del Hub inválido.', 400)
    let path = id
    if (id.startsWith('hub:')) {
      const token = id.slice(4)
      check(/^[A-Za-z0-9_-]+$/.test(token), 'Identificador de worktree del Hub inválido.', 400)
      path = Buffer.from(token, 'base64url').toString('utf8')
      check(encode(path) === token, 'Identificador de worktree del Hub inválido.', 400)
    }
    check(isAbsolute(path) && safeId(path), 'El Hub necesita una ruta absoluta de un worktree Git local.', 409)
    const resolved = await realpath(path).catch(() => null)
    check(resolved, 'El worktree Git no está disponible en esta computadora.', 409)
    check(await this.run('git', ['-C', resolved, 'rev-parse', '--is-inside-work-tree']) === 'true', 'La flota necesita un worktree Git disponible.', 409)
    const root = await realpath(await this.run('git', ['-C', resolved, 'rev-parse', '--show-toplevel'])).catch(() => null)
    const head = await this.run('git', ['-C', resolved, 'rev-parse', '--verify', 'HEAD'])
    const common = await realpath(await this.run('git', ['-C', resolved, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).catch(() => null)
    check(root && common && revision(head), 'Git no confirmó el worktree y su revisión.', 409)
    const canonical = `hub:${encode(root)}`
    check(!id.startsWith('hub:') || id === canonical, 'El identificador del Hub no corresponde al worktree real.', 409)
    return { id: canonical, path: root, repo_id: `hub-repo:${encode(common)}`, head }
  }
  private async unchanged(workspace: TeamWorkspace) {
    const current = await this.workspace(workspace.id)
    check(current.id === workspace.id && current.path === workspace.path && current.repo_id === workspace.repo_id && current.head === workspace.head,
      'El worktree cambió desde la propuesta. Prepará un nuevo plan antes de crear recursos.', 409)
    return current
  }
  async create(parent: TeamWorkspace, name: string): Promise<TeamWorkspace> {
    this.requireEnabled()
    check(/^[a-z0-9][a-z0-9-]{0,79}$/.test(name), 'Nombre de worktree inválido.', 400)
    const current = await this.unchanged(parent)
    this.requireEnabled()
    const worktrees = join(this.directory, 'fleet-worktrees')
    await mkdir(worktrees, { recursive: true })
    const root = await realpath(worktrees)
    const unique = `${randomUUID()}-${name}`
    const path = join(root, unique)
    this.requireEnabled()
    await this.run('git', ['-C', current.path, 'worktree', 'add', '-b', `hub/${unique}`, path, current.head])
    const child = await this.workspace(path)
    check(child.path === path && child.repo_id === current.repo_id && child.head === current.head && child.id !== current.id,
      'Git no confirmó el worktree hijo esperado. Conservá los recursos e inspeccioná el resultado.', 502)
    return child
  }
  async launch(workspace: TeamWorkspace, member: TeamLaunchMember & { member_id?: string }): Promise<HubTeamLaunchReceipt> {
    this.requireEnabled()
    const id = member.member_id ?? randomUUID()
    check(safeId(id) && id.length <= 200, 'Identificador de miembro inválido.', 400)
    check(!this.launching.has(id), 'El miembro ya tiene un lanzamiento en curso.', 409)
    check(member.prompt.length > 0 && member.prompt.length <= 24_000 && !member.prompt.includes('\0'), 'Instrucción inicial inválida.', 400)
    this.launching.add(id)
    try {
      await this.preflight([member])
      const current = await this.unchanged(workspace)
      this.requireEnabled()
      check(member.cli === 'claude_code' || member.cli === 'codex_cli', 'CLI no soportada por la flota del Hub.', 409)
      this.nextGenerations.set(id, randomUUID())
      const result = await this.manager.start({ id, cli: member.cli, cwd: current.path, model: member.model, prompt: member.prompt,
        ...(member.effort ? { effort: member.effort } : {}) })
      if (!['busy', 'idle'].includes(result.state)) {
        throw new MemoryError(503, 'El agente del Hub no confirmó la entrega inicial. Inspeccioná su estado antes de volver a lanzar.')
      }
      const runtime = await this.status(id)
      check(runtime, 'El Hub no confirmó los metadatos del agente.', 503)
      return { handle: id, kind: 'hub_process', prompt_outcome: 'input-accepted', runtime }
    } finally { this.launching.delete(id); this.nextGenerations.delete(id) }
  }
  private async persist(event: FleetEvent, generation: string) {
    if (this.generations.get(event.id) !== generation) return
    const member = (await this.chat.db.query('SELECT id,session_id,runtime FROM chat_team_members WHERE id=$1', [event.id]))[0]
    check(member, 'El proceso no corresponde a un miembro de equipo registrado.', 409)
    const previous = this.runtime(member.runtime)
    // A new starting event establishes the generation; later events cannot overwrite another launch.
    if (event.state !== 'starting' && previous && previous.generation !== generation) return
    const turn = event.turn_id ?? (previous?.generation === generation ? previous.turn_id : undefined)
    const runtime: HubTeamStatus = { ...event, ...(turn ? { turn_id: turn } : {}), provider: 'hub', generation, updated_at: new Date().toISOString() }
    await this.chat.db.query('UPDATE chat_team_members SET runtime=$1 WHERE id=$2', [JSON.stringify(runtime), event.id])
    if (member.session_id) await this.lifecycle(String(member.session_id), runtime)
  }
  private runtime(raw: unknown): HubTeamStatus | undefined {
    try {
      const value = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (value && typeof value === 'object' && value.provider === 'hub' && typeof value.generation === 'string') return value as HubTeamStatus
    } catch { /* Old or incomplete metadata cannot establish process ownership. */ }
    return undefined
  }
  private async lifecycle(sessionId: string, runtime: HubTeamStatus) {
    const event = runtime.state === 'busy' && runtime.turn_id ? 'UserPromptSubmit'
      : runtime.state === 'idle' ? 'Stop'
      : runtime.state === 'stopped' ? 'SessionEnd'
      : runtime.state === 'failed' ? 'StopFailure' : undefined
    if (event) await (this.chat as ManagedChat).managedLifecycle(sessionId, event, runtime.updated_at, runtime.turn_id)
  }
  /** Called after team_join writes session_id, including a join after native completion. */
  async bind(memberId: string, sessionId: string): Promise<void> {
    await this.enqueue(memberId, async () => {
      const member = (await this.chat.db.query('SELECT id,session_id,runtime FROM chat_team_members WHERE id=$1', [memberId]))[0]
      check(member?.session_id === sessionId, 'La sesión no corresponde al miembro del equipo.', 409)
      const runtime = this.runtime(member.runtime)
      if (runtime && this.manager.status(memberId) && this.generations.get(memberId) === runtime.generation) await this.lifecycle(sessionId, runtime)
    })
  }
  async status(handle: string): Promise<HubTeamStatus | undefined> {
    await this.queues.get(handle)
    const member = (await this.chat.db.query('SELECT id,session_id,runtime FROM chat_team_members WHERE id=$1', [handle]))[0]
    const runtime = this.runtime(member?.runtime)
    if (!runtime) return undefined
    const owned = this.manager.status(handle)
    if (!owned || this.generations.get(handle) !== runtime.generation) return { ...runtime, state: 'unknown', error_code: 'fleet_process_not_owned' }
    return { ...runtime }
  }
  /** False permits another wake provider; an owned but unavailable worker must be retried. */
  async wake(sessionId: string, text: string): Promise<boolean> {
    const members = await this.chat.db.query('SELECT id,session_id,runtime FROM chat_team_members WHERE session_id=$1', [sessionId])
    for (const member of members) {
      const handle = String(member.id)
      const runtime = this.runtime(member.runtime)
      const owned = this.manager.status(handle)
      if (!runtime || !owned || this.generations.get(handle) !== runtime.generation) continue
      this.requireEnabled()
      check(owned.state === 'idle', 'El agente del Hub todavía no está disponible para recibir el aviso. Reintentá después.', 409)
      const result = await this.send(handle, text)
      check(result.state === 'busy' || result.state === 'idle', 'El agente del Hub no confirmó la entrega del aviso. Reintentá después.', 503)
      return true
    }
    return false
  }
  async send(handle: string, text: string): Promise<FleetStatus> {
    this.requireEnabled()
    check(text.length > 0 && text.length <= 24_000 && !text.includes('\0'), 'Instrucción inválida.', 400)
    return this.manager.send(handle, text)
  }
  async interrupt(handle: string): Promise<FleetStatus> { this.requireEnabled(); return this.manager.interrupt(handle) }
  async stop(handle: string): Promise<FleetStatus> { return this.manager.stop(handle) }
  async suspend(): Promise<void> { await Promise.all(this.manager.list().map(member => this.manager.stop(member.id))) }
  async close(): Promise<void> { await this.manager.close() }
}
