import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { childEnv } from '@agenthub/gateway/platform'
import { check, MemoryError } from './contracts.js'
import type { MemoryDatabase } from './database.js'
import type { AgentContext } from './agents.js'
import type { LocalChat } from './local-chat.js'
import type { ScheduleAdmin } from './schedule-admin.js'
import type { TeamOrchestration } from './team-orchestration.js'
import { isRunProfileAgent } from './schedule-contract.js'
import { hash } from './store.js'
import { delegationDocument, snapshotDelegation, type DelegationDocument, type RepositorySnapshot, type StoredDelegation } from './project-automation.js'

const exec = promisify(execFile)
const asObject = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/
const DEFAULT_OBJECTIVE = 'Coordinar el seguimiento aprobado del proyecto'
const WEEKDAYS = [1, 2, 3, 4, 5]

/** Read-only git probe. The default runs with a scrubbed environment and no terminal prompts; tests inject their own. */
export type GitProbe = (args: string[], cwd: string) => Promise<{ code: number | null; stdout: string }>
const defaultProbe: GitProbe = async (args, cwd) => {
  const inherited = Object.fromEntries(Object.keys(process.env).filter(key => /^GIT_/i.test(key)).map(key => [key, undefined]))
  try {
    const { stdout } = await exec('git', args, { cwd, env: childEnv({ ...inherited, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh' }), timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true })
    return { code: 0, stdout }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return { code: typeof code === 'number' ? code : null, stdout: '' }
  }
}

export interface ProjectRepositoryView { id: string; repo_path: string; canonical_remote_url: string; remote_name: string; default_branch: string; allowed_branches: string[] }
export interface ProjectAutomationView {
  project_id: string
  enabled: boolean
  delegation: null | { version: number; digest: string; approval_source: 'owner_ui' | 'coordinator_declaration'; instruction: string | null; created_at: string; revoked_at: string | null; document: DelegationDocument }
  /** Channel the person authorized for the project, and the name of the internal automation channel the delegation recorded. */
  channel: { id: string; name: string } | null
  automation_channel: { name: string; objective: string } | null
  channel_candidates: Array<{ id: string; name: string }>
  coordinator: 'ready' | 'no_channel' | 'disabled'
  repositories: ProjectRepositoryView[]
  history: Array<{ version: number; digest: string; approval_source: string; created_at: string; revoked_at: string | null }>
}
/** Canonical effect of a `git_push` item, as stored by the decision store and executed by the core. */
export interface PushEffectView { repo_id: string; repo_path: string; canonical_remote_url: string; ref: string; local_sha: string; expected_remote_sha: string | null }
export type ScheduleOutcome = { template: string; state: 'created' | 'reused' | 'constrained' | 'unavailable' | 'failed'; code?: string; schedule_id?: string }

/** Who activates: an agent declaring the person's instruction, or the owner from the app. */
export type ActivationPrincipal = { kind: 'agent'; agent: AgentContext; session_key?: string | undefined } | { kind: 'human'; ref: string }
export interface ActivationInput {
  project_id: string
  enabled: boolean
  delegation?: DelegationDocument | undefined
  /** Exact words of the person; required when an agent activates and stored as the provenance of the version. */
  human_instruction?: string | undefined
  /** Internal automation channel the person authorized in the same confirmation. */
  channel?: { name: string; objective: string } | undefined
  /** Owner path only: the project channel the person picked. An agent's source channel is its own session channel. */
  channel_id?: string | null | undefined
  expected_version?: number | null | undefined
}

export interface ProjectAutomationOptions {
  db: MemoryDatabase
  chat: LocalChat
  teams(): Pick<TeamOrchestration, 'closeDerivedForProject' | 'ensureProjectLeader' | 'retireProjectLeader'> | undefined
  schedules(): Pick<ScheduleAdmin, 'create'> | undefined
  git?: GitProbe
}

function fail(status: number, code: string, message: string): never { throw new MemoryError(status, message, false, code) }

/** Validates one allowed-branch pattern: an exact branch or `prefix/*`, never the default branch and never a bare wildcard. */
function branchPattern(pattern: string, defaultBranch: string) {
  const exact = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern
  if (!BRANCH.test(exact) || exact.includes('..') || exact.endsWith('/') || exact.endsWith('.lock') || exact.includes('*') || exact === 'HEAD') fail(422, 'branch_invalid', `El patrón de rama ${pattern} no es válido.`)
  if (pattern === defaultBranch || (pattern.endsWith('/*') && defaultBranch.startsWith(pattern.slice(0, -1)))) fail(422, 'branch_invalid', 'Los patrones no pueden incluir la rama principal del repositorio.')
}

/**
 * Per-project activation: a standing delegation (roster, item kinds, repositories, limits) with its provenance, the project channel the person
 * authorized, and the schedules that feed it. Activating never grants a write: every external action still needs an authenticated approval per item.
 */
export class ProjectAutomationService {
  private readonly git: GitProbe
  constructor(private readonly o: ProjectAutomationOptions) { this.git = o.git ?? defaultProbe }
  private get db() { return this.o.db }

  private async project(projectId: string) {
    const row = (await this.db.query("SELECT id,title FROM entities WHERE id=$1 AND kind='project'", [projectId]))[0]
    if (!row) fail(404, 'project_not_found', 'El proyecto no existe.')
    return row as { id: string; title: string }
  }

  private async repositories(projectId: string): Promise<ProjectRepositoryView[]> {
    return (await this.db.query('SELECT id,repo_path,canonical_remote_url,remote_name,default_branch,allowed_branches FROM project_repositories WHERE project_id=$1 ORDER BY created_at,id', [projectId]))
      .map(row => ({ ...row, allowed_branches: asObject(row.allowed_branches) as string[] })) as ProjectRepositoryView[]
  }

  /** Open channels of the project the person could have authorized; the internal automation channels are never candidates. */
  private async candidates(projectId: string) {
    return await this.db.query("SELECT id,name FROM chat_channels WHERE project_id=$1 AND closed_at IS NULL AND scope_key NOT LIKE 'automation:%' ORDER BY name,id", [projectId]) as Array<{ id: string; name: string }>
  }

  async view(projectId: string): Promise<ProjectAutomationView> {
    await this.project(projectId)
    const automation = (await this.db.query('SELECT enabled,delegation_version,channel_id,coordinator_session_id FROM project_automation WHERE project_id=$1', [projectId]))[0]
    const versions = await this.db.query('SELECT version,document,digest,approval_source,instruction,created_at,revoked_at FROM project_delegations WHERE project_id=$1 ORDER BY version DESC LIMIT 10', [projectId])
    const current = automation?.enabled ? versions.find(row => row.version === automation.delegation_version && !row.revoked_at) : undefined
    const stored = current ? asObject(current.document) as StoredDelegation : undefined
    const channel = automation?.channel_id ? ((await this.db.query('SELECT id,name FROM chat_channels WHERE id=$1 AND closed_at IS NULL', [automation.channel_id]))[0] as { id: string; name: string } | undefined) ?? null : null
    const { repositories: snapshots, channel: authorized, ...rest } = stored ?? ({} as StoredDelegation)
    return {
      project_id: projectId, enabled: Boolean(current),
      delegation: current && stored ? { version: current.version, digest: current.digest, approval_source: current.approval_source, instruction: current.instruction ?? null, created_at: current.created_at, revoked_at: null,
        document: { ...rest, repository_ids: snapshots.map(entry => entry.repo_id) } as DelegationDocument } : null,
      channel: current ? channel : null, automation_channel: authorized ?? null,
      channel_candidates: await this.candidates(projectId),
      coordinator: !current ? 'disabled' : authorized && channel && automation?.coordinator_session_id ? 'ready' : 'no_channel',
      repositories: await this.repositories(projectId),
      history: versions.map(row => ({ version: row.version, digest: row.digest, approval_source: row.approval_source, created_at: row.created_at, revoked_at: row.revoked_at ?? null })),
    }
  }

  /** The channel an activation is anchored to: the agent's own session channel, or the one the person picked in the app. Never both, never another project's. */
  private async sourceChannel(principal: ActivationPrincipal, projectId: string, picked: string | null | undefined): Promise<string | null> {
    let channelId: string | null = null
    if (principal.kind === 'human') channelId = picked ?? null
    else {
      const session = await this.o.chat.identity(principal.agent, principal.session_key).catch(() => undefined)
      channelId = session && !session.closed_at && !session.removed_at ? String(session.channel_id) : null
    }
    if (!channelId) return null
    const open = (await this.db.query("SELECT id FROM chat_channels WHERE id=$1 AND project_id=$2 AND closed_at IS NULL AND scope_key NOT LIKE 'automation:%'", [channelId, projectId]))[0]
    // A person choosing a channel that is not the project's gets an error; an agent sitting in an unrelated channel simply activates without coordinator.
    if (!open && principal.kind === 'human') fail(422, 'channel_not_authorized', 'El canal elegido no está autorizado para este proyecto.')
    return open ? channelId : null
  }

  async activate(principal: ActivationPrincipal, input: ActivationInput) {
    if (principal.kind === 'agent') check(!isRunProfileAgent(principal.agent), 'Un run no administra la activación de proyectos.', 403)
    const project = await this.project(input.project_id)
    const actor = principal.kind === 'agent' ? `agent:${principal.agent.agent_id}` : principal.ref
    if (principal.kind === 'agent') check(input.human_instruction?.trim(), 'La activación por un agente requiere la frase textual de la persona.', 422)
    const automation = (await this.db.query('SELECT enabled,delegation_version,channel_id FROM project_automation WHERE project_id=$1', [project.id]))[0]
    const latest = (await this.db.query('SELECT version,document,revoked_at FROM project_delegations WHERE project_id=$1 ORDER BY version DESC LIMIT 1', [project.id]))[0]
    const currentVersion: number | null = automation?.enabled && latest && !latest.revoked_at && latest.version === automation.delegation_version ? latest.version : null
    if (input.expected_version !== undefined && input.expected_version !== currentVersion) fail(409, 'stale_version', 'La activación cambió desde que se leyó; vuelve a cargarla.')

    if (!input.enabled) return this.deactivate(project.id, actor, currentVersion)

    const parsed = delegationDocument.safeParse(input.delegation)
    if (!parsed.success) fail(422, 'invalid_document', 'El documento de delegación no es válido.')
    const document = parsed.data!
    const sourceId = await this.sourceChannel(principal, project.id, input.channel_id)
    const authorized = sourceId ? input.channel ?? (principal.kind === 'human' ? { name: `Automatización: ${project.title}`.slice(0, 200), objective: DEFAULT_OBJECTIVE } : undefined) : undefined
    const repositories = await this.repositories(project.id)
    const version = (latest?.version ?? 0) + 1
    const snapshots: RepositorySnapshot[] = repositories.map(({ id, ...rest }) => ({ repo_id: id, ...rest }))
    let snapshot
    try { snapshot = snapshotDelegation(project.id, version, document, snapshots, authorized) } catch (error) {
      if (error instanceof MemoryError && !error.code) fail(error.statusCode, 'repository_unavailable', error.message)
      throw error
    }
    const unchanged = currentVersion !== null && latest && hash(asObject(latest.document)) === hash(snapshot.stored)
    const approvalSource = principal.kind === 'agent' ? 'coordinator_declaration' : 'owner_ui'
    const replaced = currentVersion !== null && !unchanged
    const reactivated = currentVersion === null

    await this.db.transaction(async sql => {
      if (!unchanged) {
        await sql.query('UPDATE project_delegations SET revoked_at=now() WHERE project_id=$1 AND revoked_at IS NULL', [project.id])
        await sql.query('INSERT INTO project_delegations(project_id,version,document,digest,approval_source,instruction,created_by_user) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [project.id, version, JSON.stringify(snapshot.stored), snapshot.digest, approvalSource, principal.kind === 'agent' ? input.human_instruction!.trim() : null, actor])
      }
      await sql.query(`INSERT INTO project_automation(project_id,enabled,delegation_version,channel_id,coordinator_session_id,updated_at,updated_by_user) VALUES($1,1,$2,$3,NULL,now(),$4)
        ON CONFLICT(project_id) DO UPDATE SET enabled=1,delegation_version=excluded.delegation_version,channel_id=excluded.channel_id,updated_at=now(),updated_by_user=excluded.updated_by_user,
        coordinator_session_id=CASE WHEN $5=1 THEN project_automation.coordinator_session_id ELSE NULL END`,
      [project.id, unchanged ? latest!.version : version, sourceId, actor, unchanged ? 1 : 0])
    })
    const teams = this.o.teams()
    let plans: { closed: string[]; failed: string[] } = { closed: [], failed: [] }
    if (replaced) {
      plans = await teams?.closeDerivedForProject(project.id, 'La delegación del proyecto fue reemplazada.') ?? plans
      await teams?.retireProjectLeader(project.id)
    } else if (reactivated) await teams?.retireProjectLeader(project.id)
    let coordinator: 'ready' | 'no_channel' | 'unavailable' = 'no_channel'
    if (authorized && sourceId && teams) {
      try { await teams.ensureProjectLeader(project.id); coordinator = 'ready' } catch { coordinator = 'unavailable' }
    }
    return { ...await this.view(project.id), changed: !unchanged, plans, coordinator_state: coordinator, schedules: await this.ensureSchedules(principal, project) }
  }

  private async deactivate(projectId: string, actor: string, currentVersion: number | null) {
    await this.db.transaction(async sql => {
      await sql.query('UPDATE project_delegations SET revoked_at=now() WHERE project_id=$1 AND revoked_at IS NULL', [projectId])
      await sql.query(`INSERT INTO project_automation(project_id,enabled,delegation_version,channel_id,coordinator_session_id,updated_at,updated_by_user) VALUES($1,0,NULL,NULL,NULL,now(),$2)
        ON CONFLICT(project_id) DO UPDATE SET enabled=0,delegation_version=NULL,channel_id=NULL,updated_at=now(),updated_by_user=excluded.updated_by_user`, [projectId, actor])
    })
    const teams = this.o.teams()
    const plans = currentVersion === null ? { closed: [], failed: [] } : await teams?.closeDerivedForProject(projectId, 'Proyecto desactivado.') ?? { closed: [], failed: [] }
    await teams?.retireProjectLeader(projectId)
    return { ...await this.view(projectId), changed: currentVersion !== null, plans, coordinator_state: 'no_channel' as const, schedules: [] as ScheduleOutcome[] }
  }

  /**
   * Brief and close are owner-level and the status runs 10 minutes before the brief. Existing schedules are reused, a human cancellation is respected and reported,
   * and a template the scheduler does not know yet is reported instead of blocking the activation.
   */
  private async ensureSchedules(principal: ActivationPrincipal, project: { id: string; title: string }): Promise<ScheduleOutcome[]> {
    const admin = this.o.schedules()
    if (!admin) return []
    const actor = principal.kind === 'agent' ? { kind: 'agent' as const, agent: principal.agent } : { kind: 'human' as const, ref: principal.ref }
    const wanted = [
      { template: 'project_status', title: `Estado · ${project.title}`, time: '07:50', project_id: project.id },
      { template: 'daily_brief', title: 'Brief diario', time: '08:00', project_id: undefined },
      { template: 'daily_close', title: 'Cierre del día', time: '17:30', project_id: undefined },
    ]
    const outcomes: ScheduleOutcome[] = []
    for (const item of wanted) {
      try {
        const { schedule } = await admin.create(actor, { template: item.template, title: item.title, instructions: '', params: {}, project_id: item.project_id,
          recurrence: { type: 'daily', time: item.time, weekdays: WEEKDAYS }, delivery: ['hub_inbox', 'app_window'], request_id: randomUUID() })
        outcomes.push({ template: item.template, state: 'created', schedule_id: schedule.id })
      } catch (error) {
        const code = error instanceof MemoryError ? error.code : undefined
        outcomes.push({ template: item.template, state: code === 'duplicate_target' ? 'reused' : code === 'schedule_constrained' ? 'constrained' : code === 'template_unknown' || code === 'params_invalid' ? 'unavailable' : 'failed', ...(code ? { code } : {}) })
      }
    }
    return outcomes
  }

  /**
   * The backend resolves destination and default branch itself; the client contributes only a path, a remote name and branch patterns.
   * Replacing the set drops repositories no longer listed, so a delegation can only reference repositories that exist.
   */
  async setRepositories(projectId: string, requested: Array<{ repo_path: string; remote_name?: string | undefined; allowed_branches: string[] }>) {
    await this.project(projectId)
    const resolved: Array<{ repo_path: string; url: string; remote: string; default_branch: string; allowed: string[] }> = []
    for (const entry of requested) {
      const remote = entry.remote_name ?? 'origin'
      if (!REMOTE_NAME.test(remote)) fail(422, 'remote_not_allowed', 'Nombre de remoto inválido.')
      if (!isAbsolute(entry.repo_path)) fail(422, 'repository_unavailable', 'repo_path debe ser una ruta absoluta.')
      const repo = await realpath(entry.repo_path).catch(() => null)
      if (!repo) fail(422, 'repository_unavailable', 'El repositorio no existe en esta computadora.')
      const top = await this.git(['rev-parse', '--show-toplevel'], repo!)
      if (top.code !== 0 || await realpath(top.stdout.trim()).catch(() => null) !== repo) fail(422, 'repository_unavailable', 'repo_path debe ser la raíz del repositorio.')
      const urls = async (push: boolean) => {
        const result = await this.git(['remote', 'get-url', ...(push ? ['--push'] : []), '--all', remote], repo!)
        return result.code === 0 ? result.stdout.split('\n').map(line => line.trim()).filter(Boolean) : []
      }
      const [fetch, push] = [await urls(false), await urls(true)]
      if (fetch.length !== 1 || push.length !== 1 || fetch[0] !== push[0]) fail(422, 'remote_not_allowed', 'El remoto no tiene un único destino de push verificable.')
      const url = push[0]!
      if (/[\s\x00-\x1f\x7f]/.test(url) || url.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(url) || !(/^(https:\/\/|ssh:\/\/)/.test(url) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)\S+$/.test(url)))
        fail(422, 'remote_not_allowed', 'El remoto debe usar https o ssh y no puede llevar credenciales.')
      const probe = await this.git(['ls-remote', '--symref', url, 'HEAD'], repo!)
      const head = probe.code === 0 ? /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(probe.stdout)?.[1] : undefined
      if (!head) fail(422, 'repository_unavailable', 'No se pudo determinar la rama principal del remoto.')
      if (!entry.allowed_branches.length) fail(422, 'branch_invalid', 'Cada repositorio necesita al menos una rama permitida.')
      for (const pattern of entry.allowed_branches) branchPattern(pattern, head!)
      resolved.push({ repo_path: repo!, url, remote, default_branch: head!, allowed: [...new Set(entry.allowed_branches)] })
    }
    check(new Set(resolved.map(entry => entry.repo_path)).size === resolved.length, 'Hay repositorios repetidos.', 422)
    await this.db.transaction(async sql => {
      const inUse = new Set((await sql.query("SELECT d.document FROM project_automation a JOIN project_delegations d ON d.project_id=a.project_id AND d.version=a.delegation_version WHERE a.project_id=$1 AND a.enabled=1 AND d.revoked_at IS NULL", [projectId]))
        .flatMap(row => ((asObject(row.document) as StoredDelegation).repositories).map(repo => repo.repo_path)))
      const keep = new Set(resolved.map(entry => entry.repo_path))
      for (const path of inUse) if (!keep.has(path)) fail(409, 'repository_in_use', 'Un repositorio de la delegación vigente no puede quitarse; desactiva o cambia la delegación primero.')
      for (const entry of resolved) {
        await sql.query(`INSERT INTO project_repositories(id,project_id,repo_path,canonical_remote_url,remote_name,default_branch,allowed_branches) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(project_id,repo_path) DO UPDATE SET canonical_remote_url=excluded.canonical_remote_url,remote_name=excluded.remote_name,default_branch=excluded.default_branch,allowed_branches=excluded.allowed_branches`,
        [randomUUID(), projectId, entry.repo_path, entry.url, entry.remote, entry.default_branch, JSON.stringify(entry.allowed)])
      }
      const paths = [...keep]
      await sql.query(`DELETE FROM project_repositories WHERE project_id=$1${paths.length ? ` AND repo_path NOT IN (${paths.map((_, index) => `$${index + 2}`).join(',')})` : ''}`, [projectId, ...paths])
    })
    return { repositories: await this.repositories(projectId) }
  }


  /** Delegation currently in force for a project, with its repository snapshot: the only policy a push candidate is judged against. */
  private async currentDelegation(projectId: string) {
    const row = (await this.db.query(`SELECT d.version,d.document FROM project_automation a JOIN project_delegations d ON d.project_id=a.project_id AND d.version=a.delegation_version
      WHERE a.project_id=$1 AND a.enabled=1 AND d.revoked_at IS NULL`, [projectId]))[0]
    return row ? { version: row.version as number, document: asObject(row.document) as StoredDelegation } : undefined
  }

  /**
   * The agent that did the work judges what to push and records it here. The candidate carries no authority: the close turns open candidates into
   * items the person approves, and the executor revalidates repository, branch and SHA at dispatch.
   */
  async proposePush(principal: { agent: AgentContext; session_key?: string | undefined }, input: { project_id: string; repo_path: string; branch: string; local_sha: string; reason: string }) {
    check(!isRunProfileAgent(principal.agent), 'Un run no propone pushes.', 403)
    await this.project(input.project_id)
    const delegation = await this.currentDelegation(input.project_id)
    check(delegation, 'El proyecto no tiene una delegación vigente.', 409)
    check(delegation!.document.item_kinds.includes('git_push'), 'La delegación del proyecto no habilita pushes.', 409)
    const repo = await realpath(input.repo_path).catch(() => null)
    const snapshot = delegation!.document.repositories.find(entry => entry.repo_path === repo)
    check(repo && snapshot, 'El repositorio no pertenece a la delegación vigente del proyecto.', 409)
    const pattern = (value: string) => snapshot!.allowed_branches.some(entry => entry.endsWith('/*') ? value.startsWith(entry.slice(0, -1)) && value.length > entry.length - 1 : entry === value)
    check(BRANCH.test(input.branch) && !input.branch.includes('..') && !input.branch.endsWith('/') && !input.branch.endsWith('.lock') && input.branch !== snapshot!.default_branch && pattern(input.branch),
      'La rama no está permitida por la delegación o es la principal del repositorio.', 409)
    const tip = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${input.branch}^{commit}`], repo!)
    check(tip.code === 0 && tip.stdout.trim() === input.local_sha, 'local_sha no coincide con la punta actual de la rama local.', 409)
    const session = await this.o.chat.identity(principal.agent, principal.session_key).catch(() => undefined)
    const sessionRef = session ? String(session.id) : principal.agent.session_id
    return this.db.transaction(async sql => {
      const existing = (await sql.query('SELECT id,state FROM push_candidates WHERE repo_id=$1 AND branch=$2 AND local_sha=$3', [snapshot!.repo_id, input.branch, input.local_sha]))[0]
      if (existing) return { candidate_id: existing.id as string, state: existing.state as string, repeated: true }
      await sql.query("UPDATE push_candidates SET state='superseded',updated_at=now() WHERE repo_id=$1 AND branch=$2 AND state='open'", [snapshot!.repo_id, input.branch])
      const id = randomUUID()
      await sql.query("INSERT INTO push_candidates(id,project_id,repo_id,branch,local_sha,reason,proposed_by_agent,proposed_by_session,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'open')",
        [id, input.project_id, snapshot!.repo_id, input.branch, input.local_sha, input.reason, principal.agent.agent_id, sessionRef])
      return { candidate_id: id, state: 'open', repeated: false }
    })
  }

  /**
   * Open candidates of an activated project, each judged against the delegation in force. An executable one carries the exact effect (repository, canonical
   * remote, ref, SHA and the remote tip observed now); the rest are reported with the reason they cannot become an item.
   */
  async pushCandidates(projectId: string) {
    const delegation = await this.currentDelegation(projectId)
    const rows = await this.db.query("SELECT id,repo_id,branch,local_sha,reason FROM push_candidates WHERE project_id=$1 AND state='open' ORDER BY created_at,id", [projectId])
    const out: Array<{ candidate_id: string; branch: string; local_sha: string; reason: string; executable: boolean; not_executable_reason?: string; effect?: PushEffectView }> = []
    for (const row of rows) {
      const base = { candidate_id: row.id as string, branch: row.branch as string, local_sha: row.local_sha as string, reason: row.reason as string }
      const snapshot = delegation?.document.item_kinds.includes('git_push') ? delegation.document.repositories.find(entry => entry.repo_id === row.repo_id) : undefined
      if (!snapshot) { out.push({ ...base, executable: false, not_executable_reason: 'repository_not_delegated' }); continue }
      const allowed = snapshot.allowed_branches.some(entry => entry.endsWith('/*') ? base.branch.startsWith(entry.slice(0, -1)) && base.branch.length > entry.length - 1 : entry === base.branch)
      if (!allowed || base.branch === snapshot.default_branch) { out.push({ ...base, executable: false, not_executable_reason: 'branch_not_allowed' }); continue }
      const tip = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${base.branch}^{commit}`], snapshot.repo_path)
      if (tip.code !== 0 || tip.stdout.trim() !== base.local_sha) { out.push({ ...base, executable: false, not_executable_reason: 'local_branch_moved' }); continue }
      const remote = await this.git(['ls-remote', snapshot.canonical_remote_url, `refs/heads/${base.branch}`], snapshot.repo_path)
      if (remote.code !== 0) { out.push({ ...base, executable: false, not_executable_reason: 'remote_unreachable' }); continue }
      const expected = /^([0-9a-f]{40,64})\trefs\/heads\/\S+$/m.exec(remote.stdout)?.[1] ?? null
      if (expected === base.local_sha) { out.push({ ...base, executable: false, not_executable_reason: 'already_pushed' }); continue }
      out.push({ ...base, executable: true, effect: { repo_id: snapshot.repo_id, repo_path: snapshot.repo_path, canonical_remote_url: snapshot.canonical_remote_url, ref: `refs/heads/${base.branch}`, local_sha: base.local_sha, expected_remote_sha: expected } })
    }
    return out
  }

  /** The close run turned these candidates into items of that run; they stop being offered. */
  async markPushCandidatesProposed(candidateIds: string[], runId: string) {
    for (const id of candidateIds) await this.db.query("UPDATE push_candidates SET state='proposed',run_id=$2,updated_at=now() WHERE id=$1 AND state='open'", [id, runId])
  }

  /** Local branches of a registered repository plus the remote's default branch, to offer allowed-branch patterns. */
  async branches(projectId: string, repoPath: string) {
    await this.project(projectId)
    const repo = (await this.db.query('SELECT repo_path,default_branch FROM project_repositories WHERE project_id=$1 AND repo_path=$2', [projectId, repoPath]))[0]
    if (!repo) fail(404, 'repository_unavailable', 'El repositorio no pertenece al proyecto.')
    const listed = await this.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], repo.repo_path)
    return { branches: listed.code === 0 ? listed.stdout.split('\n').map(line => line.trim()).filter(Boolean) : [], default_branch: repo.default_branch as string }
  }
}
