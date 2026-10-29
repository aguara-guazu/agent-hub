import { unavailableActivity, type FleetActivity } from './fleet-activity.js'
import { execFile, spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { check, MemoryError } from './contracts.js'
import { validCliModel, type ExtractionCli } from './cli-extraction.js'
import { helpCommands, helpFlags, parseCliVersion, resumeSurface, schemaMethods, type InstalledEvidence } from './resume-capabilities.js'
import { planResume, type OriginObservation, type ResumeOrigin, type ResumePlan } from './resume-ladder.js'
import { projectForPath } from './agents.js'
import { sessionStatus, virtualFolder, type LocalChat } from './local-chat.js'
import type { TeamOrca, TeamWorkspace, TeamLaunchReceipt, TeamLaunchMember } from './team-orca.js'
import { FleetProcessManager, type FleetEvent, type FleetProcessOptions, type FleetStatus, type FleetPendingQuestion, type FleetQuestionAnswers } from './fleet-process.js'

const exec = promisify(execFile)
type RunOptions = { cwd?: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: boolean }
export interface HubTeamOptions extends FleetProcessOptions {
  /** Read-only CLI capability checks and Git operations; prompts never travel through this runner. */
  run?: (command: string, args: string[], options: RunOptions) => Promise<{ stdout: string }>
  /**
   * Account that would run the new conversation now. undefined = unknown. null only with positive evidence that the
   * CLI has no account: two nulls compare as compatible, so any doubt must resolve to undefined.
   */
  resolveAccount?: (cli: string, model: string) => Promise<string | null | undefined>
  /**
   * Account bound to a conversation when its ID was captured: historical evidence about that session, never the
   * login that is current today. undefined = unknown, and an unknown origin never allows restoring it. null only with
   * positive evidence that the session had no account (see resolveAccount).
   */
  resolveOriginAccount?: (session: Record<string, unknown>) => Promise<string | null | undefined>
}
export interface HubTeamStatus extends FleetStatus {
  provider: 'hub'
  generation: string
  updated_at: string
}
/**
 * Request to continue a creator conversation. The runtime resolves the origin from its own records and decides the
 * rung at the launch boundary; the caller supplies no capability, ID or exclusion claim.
 */
export interface HubContinuation {
  /** chat_sessions.id of the conversation whose context should continue. */
  origin_session_id: string
  /** Project of the run, owned by the backend (null = verified none). */
  project_id: string | null
  /** A restricted profile cannot be applied to a fleet child yet, so asking for one blocks every rung. */
  profile?: { restricted: boolean }
}
export interface HubResumeRequest {
  /** Fixed instruction delivered as the first message of the resumed conversation. */
  prompt: string
  /** Pool that was exhausted when the member failed: stands for the account of both the failed run and the restarted one. */
  pool_key: string
}
export interface HubTeamLaunchReceipt extends TeamLaunchReceipt { runtime: HubTeamStatus; continuity?: ResumePlan }
type ManagedChat = LocalChat & {
  managedLifecycle(sessionId: string, event: string, at: string, turnId?: string): Promise<unknown>
  managedQuestions(senderId: string, questions: FleetPendingQuestion[], generation: string): Promise<unknown>
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
      check(member.cli === 'claude_code' || member.cli === 'codex_cli' || member.cli === 'kiro', 'La flota del Hub admite Claude Code, Codex CLI y Kiro.', 409)
      check(validCliModel(member.model), 'Elegí un nombre de modelo válido.', 400)
      check(!member.effort || /^[a-z][a-z0-9_-]{0,39}$/.test(member.effort), 'Esfuerzo inválido.', 400)
      let help = checked.get(member.cli)
      if (!help) {
        help = await this.run(member.cli === 'claude_code' ? 'claude' : member.cli === 'kiro' ? 'kiro-cli' : 'codex',
          member.cli === 'claude_code' ? ['--help'] : member.cli === 'kiro' ? ['acp', '--help'] : ['app-server', '--help'])
        checked.set(member.cli, help)
      }
      const required = member.cli === 'claude_code'
        ? ['--print', '--input-format', '--output-format', '--verbose', '--dangerously-skip-permissions', '--model', '--session-id', '--resume', ...(member.effort ? ['--effort'] : [])]
        : member.cli === 'kiro' ? ['--model', '--trust-all-tools', ...(member.effort ? ['--effort'] : [])]
        : ['--listen', 'stdio']
      check(required.every(flag => help.includes(flag)), 'La CLI instalada no confirma el protocolo nativo requerido por la flota del Hub. Actualizá la CLI antes de lanzar.', 409)
      this.requireEnabled()
    }
  }
  async workspace(id: string): Promise<TeamWorkspace> {
    check(safeId(id), 'Identificador de worktree del Hub inválido.', 400)
    let path = id
    if (id.startsWith('hub-virtual:')) {
      const token=id.slice('hub-virtual:'.length)
      path=Buffer.from(token,'base64url').toString('utf8')
      check(encode(path)===token && isAbsolute(path),'Identificador virtual inválido.',400)
      return this.virtualWorkspace(path)
    }
    if (id.startsWith('hub:')) {
      const token = id.slice(4)
      check(/^[A-Za-z0-9_-]+$/.test(token), 'Identificador de worktree del Hub inválido.', 400)
      path = Buffer.from(token, 'base64url').toString('utf8')
      check(encode(path) === token, 'Identificador de worktree del Hub inválido.', 400)
    }
    check(isAbsolute(path) && safeId(path), 'El Hub necesita una ruta absoluta de un worktree Git local.', 409)
    const resolved = await realpath(path).catch(() => null)
    check(resolved, 'El worktree Git no está disponible en esta computadora.', 409)
    let inside:string
    try { inside=await this.run('git', ['-C', resolved, 'rev-parse', '--is-inside-work-tree']) }
    catch {
      // Only a verified ordinary folder can become virtual. Missing Git, permissions,
      // bare repositories and invalid worktrees must retain their actual failure.
      await virtualFolder(resolved)
      check(!id.startsWith('hub:'),'El worktree Git dejó de estar disponible.',409)
      return this.virtualWorkspace(resolved)
    }
    check(inside === 'true', 'La ruta Git no es un worktree disponible.', 409)
    const root = await realpath(await this.run('git', ['-C', resolved, 'rev-parse', '--show-toplevel'])).catch(() => null)
    const head = await this.run('git', ['-C', resolved, 'rev-parse', '--verify', 'HEAD']).catch(()=>{throw new MemoryError(409,'Git no confirmó HEAD. El repositorio necesita una revisión válida y accesible; no se reemplaza por un espacio virtual.')})
    const common = await realpath(await this.run('git', ['-C', resolved, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).catch(() => null)
    check(root && common && revision(head), 'Git no confirmó el worktree y su revisión.', 409)
    const canonical = `hub:${encode(root)}`
    check(!id.startsWith('hub:') || id === canonical, 'El identificador del Hub no corresponde al worktree real.', 409)
    return { id: canonical, path: root, repo_id: `hub-repo:${encode(common)}`, head }
  }
  private async virtualWorkspace(path:string):Promise<TeamWorkspace> {
    const root=await virtualFolder(path)
    const manifest=join(this.directory,'virtual-workspaces',`${createHash('sha256').update(root).digest('hex')}.json`)
    const saved=await readFile(manifest,'utf8').then(text=>JSON.parse(text) as TeamWorkspace).catch(error=>{
      if(error.code==='ENOENT')return null
      throw error
    })
    return saved ?? {id:`hub-virtual:${encode(root)}`,path:root,repo_id:`virtual:${encode(root)}`,head:'virtual',kind:'virtual',source_path:root}
  }
  private async unchanged(workspace: TeamWorkspace, resumeWorktree = false) {
    const current = await this.workspace(workspace.id)
    check(current.id === workspace.id && current.path === workspace.path && current.repo_id === workspace.repo_id && (resumeWorktree || current.head === workspace.head),
      'El worktree cambió desde la propuesta. Prepará un nuevo plan antes de crear recursos.', 409)
    return current
  }
  async baseRevision(parent: TeamWorkspace, base: string): Promise<string> {
    if(parent.kind==='virtual') {
      check(base==='virtual','Un espacio virtual sólo admite la base virtual.',409)
      return base
    }
    check(revision(base),'La base debe ser el hash completo de un commit del repositorio.',400)
    const resolved=await this.run('git',['-C',parent.path,'rev-parse','--verify',`${base}^{commit}`])
      .catch(()=>{throw new MemoryError(409,'La revisión base no es un commit disponible en el repositorio. Actualizá las referencias y prepará el plan con el hash elegido; no lo sustituyas por HEAD.')})
    check(resolved.toLowerCase()===base.toLowerCase(),'La base no identifica un commit exacto.',409)
    return resolved
  }
  async create(parent: TeamWorkspace, name: string, baseRevision=parent.head): Promise<TeamWorkspace> {
    this.requireEnabled()
    check(/^[a-z0-9][a-z0-9-]{0,79}$/.test(name), 'Nombre de worktree inválido.', 400)
    const current = await this.unchanged(parent)
    const base=await this.baseRevision(current,baseRevision)
    this.requireEnabled()
    if(current.kind==='virtual') {
      const path=join(this.directory,'fleet-workspaces',randomUUID())
      await mkdir(path,{recursive:true})
      const root=await realpath(path)
      const child:TeamWorkspace={id:`hub-virtual:${encode(root)}`,path:root,repo_id:current.repo_id,head:'virtual',kind:'virtual',source_path:current.source_path ?? current.path}
      await mkdir(join(this.directory,'virtual-workspaces'),{recursive:true})
      await writeFile(join(this.directory,'virtual-workspaces',`${createHash('sha256').update(root).digest('hex')}.json`),JSON.stringify(child),{flag:'wx',mode:0o600})
      return child
    }
    const worktrees = join(this.directory, 'fleet-worktrees')
    await mkdir(worktrees, { recursive: true })
    const root = await realpath(worktrees)
    const unique = randomUUID()
    const path = join(root, unique)
    this.requireEnabled()
    await this.run('git', ['-C', current.path, 'worktree', 'add', '-b', `hub/${unique}`, path, base])
    const child = await this.workspace(path)
    check(child.path === path && child.repo_id === current.repo_id && child.head === base && child.id !== current.id,
      'Git no confirmó el worktree hijo esperado. Conservá los recursos e inspeccioná el resultado.', 502)
    return child
  }
  /** Evidence of what the installed binary offers, gathered read-only; any probe that fails leaves its field unknown. */
  private async installedEvidence(cli: ExtractionCli): Promise<InstalledEvidence> {
    const surface = resumeSurface(cli, 'fleet')
    const records = Object.values(surface?.capabilities ?? {})
    const flags = records.flatMap(record => record.flags ?? []), commands = records.flatMap(record => record.commands ?? [])
    const binary = cli === 'claude_code' ? 'claude' : cli === 'kiro' ? 'kiro-cli' : 'codex'
    const evidence: InstalledEvidence = {}
    const version = parseCliVersion(await this.run(binary, ['--version']).catch(() => ''))
    if (version) evidence.version = version
    const help = await this.run(binary, cli === 'claude_code' ? ['--help'] : cli === 'kiro' ? ['acp', '--help'] : ['--help']).catch(() => undefined)
    if (help !== undefined) {
      evidence.flags = helpFlags(help, flags)
      if (cli !== 'codex_cli') evidence.commands = helpCommands(help, commands)
    }
    if (cli === 'codex_cli') {
      // The fleet speaks the app-server protocol: its methods come from the schema the installed binary generates
      // (no conversation is touched). Without that schema they stay unknown rather than contradicted.
      const methods = commands
      const directory = await mkdtemp(join(tmpdir(), 'hub-codex-schema-'))
      try {
        await this.run(binary, ['app-server', 'generate-json-schema', '--out', directory])
        const files = (await readdir(directory, { recursive: true })).filter(name => name.endsWith('.json'))
        const schema = (await Promise.all(files.map(name => readFile(join(directory, name), 'utf8').catch(() => '')))).join('\n')
        if (schema.trim()) evidence.commands = schemaMethods(schema, methods)
      } catch { /* Without the schema the protocol methods stay unverified. */ }
      finally { await rm(directory, { recursive: true, force: true }).catch(() => {}) }
    }
    return evidence
  }
  /** Resolves the continuation from this runtime's own records; the decision cannot be supplied by the caller. */
  private async planContinuation(member: TeamLaunchMember & { continuation: HubContinuation }, cwd: string): Promise<ResumePlan> {
    const row = (await this.chat.db.query('SELECT * FROM chat_sessions WHERE id=$1', [member.continuation.origin_session_id]))[0]
    const originCwd = typeof row?.native_cwd === 'string' ? row.native_cwd : null
    const [originProject, originAccount, targetAccount, installed] = await Promise.all([
      originCwd ? projectForPath(this.chat.db, originCwd) : Promise.resolve(undefined),
      row ? this.options.resolveOriginAccount?.(row) : undefined,
      this.options.resolveAccount?.(member.cli, member.model),
      this.installedEvidence(member.cli),
    ])
    const now = Date.now()
    const origin: ResumeOrigin = {
      native_id: row && typeof row.native_id === 'string' ? row.native_id : null,
      cli: row ? String(row.cli_kind) : '', surface: row && typeof row.surface === 'string' ? row.surface : '',
      cwd: originCwd, live: row ? ['idle', 'busy', 'blocked'].includes(sessionStatus(row, now).state) : false,
      id_authentic: Boolean(row && row.resumable === 1 && ['hook', 'fleet_protocol'].includes(String(row.id_captured_by))),
      ...(originCwd ? { project_id: originProject?.id ?? null } : {}),
      ...(originAccount !== undefined ? { account: originAccount } : {}),
    }
    const observed: OriginObservation = row ? { lease_active: Date.parse(row.lease_until) > now } : {}
    // FleetProcessManager always starts children with full permissions; no effective restricted profile exists to verify.
    const restricted = member.continuation.profile?.restricted === true
    return planResume(origin, {
      cli: member.cli, surface: 'fleet', cwd, headless: true, profile: { restricted, verified: !restricted },
      project_id: member.continuation.project_id, ...(targetAccount !== undefined ? { account: targetAccount } : {}),
    }, installed, observed)
  }
  async launch(workspace: TeamWorkspace, member: TeamLaunchMember & { member_id?: string; resume_worktree?: boolean; continuation?: HubContinuation; authorize?: () => Promise<void> }): Promise<HubTeamLaunchReceipt> {
    this.requireEnabled()
    const id = member.member_id ?? randomUUID()
    check(safeId(id) && id.length <= 200, 'Identificador de miembro inválido.', 400)
    check(!this.launching.has(id), 'El miembro ya tiene un lanzamiento en curso.', 409)
    check(member.prompt.length > 0 && member.prompt.length <= 24_000 && !member.prompt.includes('\0'), 'Instrucción inicial inválida.', 400)
    this.launching.add(id)
    let attempted = false, plan: ResumePlan | undefined
    try {
      await this.preflight([member])
      const current = await this.unchanged(workspace, member.resume_worktree === true)
      await member.authorize?.()
      this.requireEnabled()
      check(member.cli === 'claude_code' || member.cli === 'codex_cli' || member.cli === 'kiro', 'CLI no soportada por la flota del Hub.', 409)
      if (member.continuation) {
        plan = await this.planContinuation({ ...member, continuation: member.continuation }, current.path)
        this.requireEnabled()
        const refuse = (message: string) => { throw Object.assign(new MemoryError(409, message), { continuity: plan }) }
        if (plan.rung === 'live_destination') refuse('El chat creador sigue conectado: entregá el resultado allí; no se lanza otra conversación.')
        if (plan.rung === 'blocked_unsupported') refuse('El perfil restringido no pudo verificarse; no se lanza ningún agente.')
        // No adapter acquires an exclusion over the original session, so a plain resume is never launched.
        if (plan.rung === 'exclusive_resume') refuse('El runtime no obtiene exclusión sobre la sesión original; sólo se admite fork o una conversación nueva vinculada.')
      }
      this.nextGenerations.set(id, randomUUID())
      attempted = true
      const result = await this.manager.start({ id, cli: member.cli, cwd: current.path, model: member.model, prompt: member.prompt,
        ...(member.effort ? { effort: member.effort } : {}), ...(plan?.rung === 'fork' ? { resume_id: plan.native_id!, fork: true } : {}) })
      await this.verifyLaunchEnabled(id)
      if (!['busy', 'idle', 'waiting_input'].includes(result.state)) {
        throw new MemoryError(503, 'El agente del Hub no confirmó la entrega inicial. Inspeccioná su estado antes de volver a lanzar.')
      }
      const runtime = await this.status(id)
      check(runtime, 'El Hub no confirmó los metadatos del agente.', 503)
      await this.verifyLaunchEnabled(id)
      return { handle: id, kind: 'hub_process', prompt_outcome: 'input-accepted', runtime, ...(plan ? { continuity: plan } : {}) }
    } catch (error) {
      if (!attempted) throw error
      const failure = error instanceof MemoryError ? error : new MemoryError(503, 'El Hub no confirmó el proceso del agente. Inspeccioná su estado antes de reintentar.')
      // After an attempted fork/resume a process may exist: the caller reconciles and never walks down another rung.
      throw Object.assign(failure, { launch_handle: id, ...(plan ? { continuity: plan } : {}), ...(plan?.rung === 'fork' ? { resume_outcome: 'launch_uncertain' as const } : {}) })
    } finally { this.launching.delete(id); this.nextGenerations.delete(id) }
  }
  /** Everything that decides a resume and has no effect: read-only checks, the plan, and why it is not possible yet. */
  private async evaluateResume(handle: string, request: HubResumeRequest) {
    const member = (await this.chat.db.query('SELECT id,session_id,runtime FROM chat_team_members WHERE id=$1', [handle]))[0]
    const runtime = this.runtime(member?.runtime)
    if (!member?.session_id || runtime?.state !== 'failed' || !runtime.native_id) return { kind: 'not_failed' as const }
    const leader = (await this.chat.db.query(`SELECT leader.closed_at,leader.removed_at FROM chat_team_members m JOIN chat_team_plans t ON t.id=m.team_id
      LEFT JOIN chat_sessions leader ON leader.id=t.created_by WHERE m.id=$1`, [handle]))[0]
    if (!leader || leader.closed_at || leader.removed_at) return { kind: 'leader_closed' as const }
    try { await this.assertAuthorized(handle, String(member.session_id), true) } catch { return { kind: 'unauthorized' as const } }
    const owned = this.manager.status(handle)
    const exited = owned ? this.generations.get(handle) === runtime.generation && this.manager.exitConfirmed(handle)
      : Boolean((await this.chat.db.query(`SELECT id FROM process_incidents WHERE subject_kind='fleet_member' AND subject_id=$1 AND generation=$2
        AND action IN ('terminated','already_exited') LIMIT 1`, [handle, runtime.generation]))[0])
    let current: TeamWorkspace, project: Awaited<ReturnType<typeof projectForPath>>, installed: InstalledEvidence
    try {
      current = await this.workspace(runtime.cwd)
      project = await projectForPath(this.chat.db, runtime.cwd)
      installed = await this.installedEvidence(runtime.cli)
    } catch { return { kind: 'unavailable' as const } }
    const plan = (exclusive?: 'hub_process_exit') => planResume(
      { native_id: runtime.native_id!, cli: runtime.cli, surface: 'fleet', cwd: runtime.cwd, live: false, id_authentic: true, project_id: project?.id ?? null, account: request.pool_key },
      { cli: runtime.cli, surface: 'fleet', cwd: current.path, headless: true, profile: { restricted: false, verified: true }, project_id: project?.id ?? null,
        account: request.pool_key, same_conversation: true },
      installed, exclusive ? { exclusive_by: exclusive } : {})
    const possible = plan('hub_process_exit')
    if (possible.rung !== 'exclusive_resume') return { kind: 'unsupported' as const, plan: possible }
    if (!exited) return { kind: 'exit_unconfirmed' as const, plan: plan() }
    return { kind: 'ready' as const, runtime, current, plan: possible }
  }
  /** Side-effect-free verdict for the caller that rations attempts: only 'unsupported' is a property of the CLI, the rest can change. */
  async checkResume(handle: string, request: HubResumeRequest): Promise<{ ready: boolean; kind: 'ready' | 'not_failed' | 'leader_closed' | 'unauthorized' | 'unavailable' | 'exit_unconfirmed' | 'unsupported'; plan?: ResumePlan }> {
    const result = await this.evaluateResume(handle, request)
    return { ready: result.kind === 'ready', kind: result.kind, ...('plan' in result && result.plan ? { plan: result.plan } : {}) }
  }
  /**
   * Restarts, in the same conversation, a member that failed in place. The caller supplies the quota evidence; this method
   * verifies the authority, the identity of the conversation and that the previous child is gone, and it never starts a
   * different conversation: anything short of an exclusive resume is refused with the plan that explains why.
   */
  async resumeMember(handle: string, request: HubResumeRequest): Promise<HubTeamLaunchReceipt> {
    this.requireEnabled()
    check(safeId(handle) && handle.length <= 200, 'Identificador de miembro inválido.', 400)
    check(request.prompt.length > 0 && request.prompt.length <= 24_000 && !request.prompt.includes('\0'), 'Instrucción de reanudación inválida.', 400)
    check(!this.launching.has(handle), 'El miembro ya tiene un lanzamiento en curso.', 409)
    this.launching.add(handle)
    let attempted = false, plan: ResumePlan | undefined
    try {
      await this.queues.get(handle)
      const evaluated = await this.evaluateResume(handle, request)
      check(evaluated.kind !== 'not_failed', 'El miembro no tiene una conversación fallida que reanudar.', 409)
      check(evaluated.kind !== 'leader_closed', 'El líder del equipo está cerrado; los miembros esperan a que se reabra.', 409)
      check(evaluated.kind !== 'unauthorized', 'El equipo o sus sesiones ya no están autorizados para recibir el aviso.', 403)
      check(evaluated.kind !== 'unavailable', 'El Hub no pudo verificar el espacio de trabajo ni la CLI instalada.', 503)
      plan = 'plan' in evaluated ? evaluated.plan : undefined
      this.requireEnabled()
      if (evaluated.kind !== 'ready') throw Object.assign(new MemoryError(409, 'El Hub no puede reanudar la misma conversación con evidencia suficiente; no se lanzó nada.'), { continuity: plan })
      const { runtime, current } = evaluated
      await this.preflight([{ cli: runtime.cli, model: runtime.model, ...(runtime.effort ? { effort: runtime.effort } : {}) }])
      this.nextGenerations.set(handle, randomUUID())
      attempted = true
      const result = await this.manager.start({ id: handle, cli: runtime.cli, cwd: current.path, model: runtime.model, prompt: request.prompt,
        ...(runtime.effort ? { effort: runtime.effort } : {}), resume_id: plan!.native_id! })
      await this.verifyLaunchEnabled(handle)
      if (!['busy', 'idle', 'waiting_input'].includes(result.state)) throw new MemoryError(503, 'El agente del Hub no confirmó la reanudación.')
      const status = await this.status(handle)
      check(status, 'El Hub no confirmó los metadatos del agente reanudado.', 503)
      return { handle, kind: 'hub_process', prompt_outcome: 'input-accepted', runtime: status, continuity: plan! }
    } catch (error) {
      if (!attempted) throw error
      const failure = error instanceof MemoryError ? error : new MemoryError(503, 'El Hub no confirmó la reanudación del agente. Inspeccioná su estado antes de reintentar.')
      throw Object.assign(failure, { launch_handle: handle, continuity: plan, resume_outcome: 'launch_uncertain' as const })
    } finally { this.launching.delete(handle); this.nextGenerations.delete(handle) }
  }
  private async verifyLaunchEnabled(id: string): Promise<void> {
    if (this.enabled()) return
    await this.manager.stop(id)
    // Even if the switch changes again while stopping, this launch was cancelled.
    throw new MemoryError(409, 'La flota de agentes del Hub se desactivó durante el lanzamiento. El proceso fue detenido.')
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
    if (runtime.questions) await (this.chat as ManagedChat).managedQuestions(event.id, runtime.questions, generation)
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
      : runtime.state === 'waiting_input' ? 'RequestUserInput'
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
      if (runtime && this.manager.status(memberId) && this.generations.get(memberId) === runtime.generation) {
        await this.lifecycle(sessionId, runtime)
        if (runtime.questions) await (this.chat as ManagedChat).managedQuestions(memberId, runtime.questions, runtime.generation)
      }
    })
  }
  /** Human observer; deliberately excluded from the fleet tool/status interface. */
  async activity(sessionId: string, after = 0): Promise<FleetActivity> {
    const members = await this.chat.db.query('SELECT id,session_id,runtime FROM chat_team_members WHERE session_id=$1', [sessionId])
    for (const member of members) {
      const handle = String(member.id)
      const runtime = this.runtime(member.runtime)
      if (runtime && this.manager.status(handle) && this.generations.get(handle) === runtime.generation) return this.manager.activity(handle, after)
    }
    return unavailableActivity()
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
  /** Same guards as a delivery: live plan, human instruction, current leader, open channels and the member's own workspace. */
  private async assertAuthorized(handle: string, sessionId: string, allowClosedSession = false): Promise<void> {
    const authorized = (await this.chat.db.query(`SELECT m.id FROM chat_team_members m
        JOIN chat_team_plans t ON t.id=m.team_id
        JOIN chat_channels master ON master.id=t.master_channel_id
        JOIN chat_sessions leader ON leader.id=t.created_by
        JOIN chat_sessions participant ON participant.id=m.session_id
        JOIN chat_channels child ON child.id=m.channel_id
        WHERE m.id=$1 AND m.session_id=$2 AND m.state='joined'
        AND t.state NOT IN ('paused','cancelled','completed','prepared') AND t.human_instruction IS NOT NULL
        AND master.closed_at IS NULL AND master.leader_id=t.created_by
        AND leader.channel_id=master.id AND leader.closed_at IS NULL AND leader.removed_at IS NULL
        AND participant.channel_id=child.id AND (participant.closed_at IS NULL OR $3=1) AND participant.removed_at IS NULL
        AND child.closed_at IS NULL AND child.path=m.workspace_path`, [handle, sessionId, allowClosedSession ? 1 : 0]))[0]
    check(authorized, 'El equipo o sus sesiones ya no están autorizados para recibir el aviso.', 403)
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
      check(owned.state === 'idle' || (owned.state === 'busy' && this.manager.supportsMidTurn(handle)), 'El agente del Hub todavía no está disponible para recibir el aviso. Reintentá después.', 409)
      await this.assertAuthorized(handle, sessionId)
      const result = await this.send(handle, text)
      check(result.state === 'busy' || result.state === 'idle', 'El agente del Hub no confirmó la entrega del aviso. Reintentá después.', 503)
      return true
    }
    return false
  }
  async send(handle: string, text: string): Promise<FleetStatus> {
    this.requireEnabled()
    check(text.length > 0 && text.length <= 24_000 && !text.includes('\0'), 'Instrucción inválida.', 400)
    if (this.manager.status(handle)?.state === 'busy' && this.manager.supportsMidTurn(handle)) return this.manager.enqueue(handle, text)
    return this.manager.send(handle, text)
  }
  async answer(handle: string, questionId: string, answers: FleetQuestionAnswers): Promise<FleetStatus> {
    this.requireEnabled()
    return this.manager.answer(handle, questionId, answers)
  }
  async interrupt(handle: string): Promise<FleetStatus> { this.requireEnabled(); return this.manager.interrupt(handle) }
  async stop(handle: string): Promise<FleetStatus> { return this.manager.stop(handle) }
  async suspend(): Promise<void> { await Promise.all(this.manager.list().map(member => this.manager.stop(member.id))) }
  async close(): Promise<void> { await this.manager.close() }
}
