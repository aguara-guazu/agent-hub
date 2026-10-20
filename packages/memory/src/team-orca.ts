import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { childEnv } from '@agenthub/gateway/platform'
import { check, MemoryError } from './contracts.js'
import { validCliModel, type ExtractionCli } from './cli-extraction.js'

export interface TeamWorkspace { id: string; path: string; repo_id: string; head: string }
export interface TeamLaunchReceipt { handle: string; kind: string; operation_id?: string; prompt_outcome: string }
export interface TeamLaunchMember { cli: ExtractionCli; model: string; effort?: string; prompt: string }
export interface TeamOrca {
  workspace(id: string): Promise<TeamWorkspace>
  create(parent: TeamWorkspace, name: string): Promise<TeamWorkspace>
  launch(workspace: TeamWorkspace, member: TeamLaunchMember): Promise<TeamLaunchReceipt>
}

/** A durable operation identifier is safe to retain for inspection; raw CLI output is not. */
export class TeamOrcaError extends MemoryError {
  constructor(message: string, readonly operation_id?: string) { super(503, message) }
}

const exec = promisify(execFile)
const agents = { kiro: 'kiro', claude_code: 'claude', codex_cli: 'codex' }
const safeId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4000 && !/[\x00-\x1f\x7f]/.test(value)
const revision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40,64}$/i.test(value)
type Runner = (command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: boolean }) => Promise<{ stdout: string }>

/** One local execution host. No shell text, remote host inheritance or automatic launch retries. */
export class LocalTeamOrca implements TeamOrca {
  private readonly command: string
  private readonly env: NodeJS.ProcessEnv
  constructor(private options: { run?: Runner; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}) {
    const env = options.env ?? process.env
    const platform = options.platform ?? process.platform
    this.command = env.ORCA_CLI_COMMAND || (env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : platform === 'linux' ? 'orca-ide' : 'orca')
    this.env = options.env ? childEnv(options.env) : childEnv()
    // A daemon can inherit the terminal that started it. Never direct another team's
    // launch to that terminal, execution host, workspace or agent conversation.
    for (const name of Object.keys(this.env)) {
      if (/^(?:ORCA_(?:PAIRING_CODE|ENVIRONMENT|WORKTREE_ID|TERMINAL_ID|TERMINAL_HANDLE|SESSION_ID)|AGENTHUB_|ELECTRON_RUN_AS_NODE$|GIT_(?:DIR|WORK_TREE|COMMON_DIR))/i.test(name))
        delete this.env[name]
    }
    // Desktop processes often start with a minimal PATH.
    this.env.PATH = [this.env.PATH, join(homedir(), '.local', 'bin'),
      ...(platform === 'win32' ? [] : ['/usr/local/bin', '/opt/homebrew/bin'])].filter(Boolean).join(delimiter)
  }

  private async commandResult(args: string[], cwd?: string): Promise<Record<string, any>> {
    let stdout: string
    try {
      ({ stdout } = await (this.options.run ?? exec)(this.command, [...args, '--json'],
        { ...(cwd ? { cwd } : {}), env: this.env, timeout: 45_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }))
    } catch (error) {
      // CLI stderr can contain prompts, invitation tokens or local credentials.
      let operation: unknown
      try {
        const value = JSON.parse(String((error as { stdout?: unknown }).stdout ?? ''))
        operation = value.operationId ?? value.result?.launch?.operationId ?? value.result?.operationId
      } catch { /* no machine-readable receipt */ }
      throw new TeamOrcaError('Orca no devolvió un recibo verificable. Inspeccioná el espacio antes de volver a lanzar; no reintentes como una operación nueva.',
        safeId(operation) ? operation : undefined)
    }
    let envelope: Record<string, any>
    try { envelope = JSON.parse(stdout) } catch { throw new MemoryError(502, 'Respuesta de Orca inválida; el resultado puede ser incierto.') }
    check(envelope && envelope.ok === true && envelope.result && typeof envelope.result === 'object',
      'Orca rechazó la operación o no confirmó el resultado. Revisá el espacio y su versión antes de reintentar.', 409)
    return envelope.result
  }

  private async parseWorkspace(raw: any): Promise<TeamWorkspace> {
    check(raw && safeId(raw.id) && safeId(raw.repoId) && typeof raw.path === 'string' && isAbsolute(raw.path) && revision(raw.head),
      'Orca no devolvió un worktree Git válido.', 502)
    check(raw.hostId === 'local' && raw.identity?.executionHostId === 'local',
      'Los equipos automáticos requieren un worktree del host local.', 409)
    check(!raw.isBare && !raw.isArchived, 'El worktree de Orca no está disponible para trabajar.', 409)
    check(await realpath(raw.path).catch(() => null), 'El worktree de Orca no está disponible en esta computadora.', 409)
    return { id: raw.id, path: raw.path, repo_id: raw.repoId, head: raw.head }
  }

  async workspace(id: string): Promise<TeamWorkspace> {
    check(safeId(id) && id.includes('::'), 'El líder necesita un worktree Git de Orca, no una carpeta virtual.', 409)
    const value = await this.parseWorkspace((await this.commandResult(['worktree', 'show', '--worktree', `id:${id}`])).worktree)
    check(value.id === id, 'Orca devolvió otro worktree.', 409)
    return value
  }

  async create(parent: TeamWorkspace, name: string): Promise<TeamWorkspace> {
    check(/^[a-z0-9][a-z0-9-]{0,79}$/.test(name), 'Nombre de worktree inválido.', 400)
    const current = await this.workspace(parent.id)
    check(current.repo_id === parent.repo_id && current.path === parent.path && current.head === parent.head,
      'El padre cambió desde la propuesta. Prepará un nuevo plan antes de crear recursos.', 409)
    const result = await this.commandResult(['worktree', 'create', '--repo', `id:${parent.repo_id}`, '--name', name,
      '--parent-worktree', `id:${parent.id}`, '--base-branch', parent.head, '--setup', 'skip'], parent.path)
    const child = await this.parseWorkspace(result.worktree)
    check(child.repo_id === parent.repo_id && child.id !== parent.id && await realpath(child.path) !== await realpath(parent.path) && child.head === parent.head &&
      result.worktree.parentWorktreeId === parent.id,
    'Orca no confirmó el worktree hijo esperado. Conservá los recursos e inspeccioná el resultado.', 502)
    return child
  }

  async launch(workspace: TeamWorkspace, member: TeamLaunchMember): Promise<TeamLaunchReceipt> {
    check(Object.hasOwn(agents, member.cli) && validCliModel(member.model), 'CLI o modelo inválido.', 400)
    check(!member.effort || /^[a-z][a-z0-9_-]{0,39}$/.test(member.effort), 'Esfuerzo inválido.', 400)
    check(member.prompt.length > 0 && member.prompt.length <= 24000 && !member.prompt.includes('\0'), 'Instrucción inicial inválida.', 400)
    const current = await this.workspace(workspace.id)
    check(current.repo_id === workspace.repo_id && current.path === workspace.path && current.head === workspace.head,
      'El worktree asignado cambió antes del lanzamiento.', 409)
    const args = ['agent', 'launch', '--agent', agents[member.cli], '--worktree', `id:${workspace.id}`, '--model', member.model]
    if (member.effort) args.push('--effort', member.effort)
    args.push('--prompt', member.prompt)
    const result = await this.commandResult(args, workspace.path)
    const launch = result.launch ?? result
    if (!(launch.outcome && ['terminal', 'structured'].includes(launch.outcome.kind) && safeId(launch.outcome.handle) &&
      ['journaled', 'handed-to-terminal'].includes(launch.prompt?.outcome)))
      throw new TeamOrcaError('Orca no confirmó el agente y la entrega inicial. Inspeccioná el recibo antes de reintentar; no lances un duplicado.',
        safeId(launch.operationId) ? launch.operationId : undefined)
    return {
      kind: launch.outcome.kind, handle: launch.outcome.handle, prompt_outcome: launch.prompt.outcome,
      ...(safeId(launch.operationId) ? { operation_id: launch.operationId } : {}),
    }
  }
}
