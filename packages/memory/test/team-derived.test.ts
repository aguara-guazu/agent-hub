import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { LocalChat } from '../src/local-chat.js'
import { HubTeamRuntime } from '../src/team-hub.js'
import { TeamOrchestration, teamDefinitions, type DerivedFollowUp, type DerivedPorts } from '../src/team-orchestration.js'
import { snapshotDelegation, type ApprovedItem, type DelegationDocument, type RepositorySnapshot } from '../src/project-automation.js'
import type { AgentContext } from '../src/agents.js'

let dir: string, folder: string, db: MemoryDatabase, chat: LocalChat, backend: HubTeamRuntime, teams: TeamOrchestration
let collaboration = true, automations = true, projectId: string, sourceChannel: string
let approvedItems: Array<ApprovedItem & { state: string }>, followUp: DerivedFollowUp | null
const digest = 'c'.repeat(64)
const authorizedChannel = { name: 'Seguimiento Ñandú', objective: 'Coordinar el seguimiento aprobado del proyecto' }
const document: DelegationDocument = { schema_version: 1,
  roster: { coordinator: { cli: 'claude_code', model: 'test-model', effort: 'high' }, project_agent: { cli: 'claude_code', model: 'test-model' } },
  item_kinds: ['jira_worklog'], repository_ids: [], limits: { max_concurrent_plans: 1, max_runtime_minutes: 30 } }
const item = (ordinal: number, over: Partial<ApprovedItem & { state: string }> = {}) => ({ item_id: `item-${ordinal}`, ordinal, kind: 'jira_worklog', project_id: projectId,
  summary: `Horas ${ordinal}`, effect_digest: 'd'.repeat(64), state: 'approved', ...over })
const reply = (over: Partial<DerivedFollowUp> = {}): DerivedFollowUp => ({ text: 'Revisa la rama feature/x', ref: 'msg-1', source: 'channel_reply', expires_at: new Date(Date.now() + 3_600_000).toISOString(), ...over })
const ports: DerivedPorts = {
  approved: vi.fn(async () => ({ canonical_digest: digest, items: approvedItems, follow_up: followUp })),
  actionProfile: vi.fn(async member => ({ kind: 'action' as const, agent_instance_id: 'hub_run_action', principal_handle: `handle-${member.member_id}` })),
  automationsEnabled: () => automations, ownerId: () => 'owner' }
const input = (over: Record<string, unknown> = {}) => ({ project_id: projectId, delegation_version: 1, request_id: 'req-1', ...over })
const rejection = async (promise: Promise<unknown>) => { try { await promise } catch (error) { return (error as Error).message } return 'none' }
const plansCount = async () => Number((await db.query('SELECT count(*) AS n FROM chat_team_plans WHERE delegation_project_id IS NOT NULL'))[0]!.n)

async function activate(version = 1, doc: DelegationDocument = document, repositories: RepositorySnapshot[] = [], channel: typeof authorizedChannel | null = authorizedChannel) {
  const { stored, digest: versionDigest } = snapshotDelegation(projectId, version, doc, repositories, channel ?? undefined)
  await db.query("INSERT INTO project_automation(project_id,enabled,delegation_version,channel_id,updated_by_user) VALUES($1,1,$2,$3,'owner') ON CONFLICT(project_id) DO UPDATE SET delegation_version=excluded.delegation_version,enabled=1,channel_id=excluded.channel_id",
    [projectId, version, sourceChannel])
  await db.query("INSERT INTO project_delegations(project_id,version,document,digest,approval_source,instruction,created_by_user) VALUES($1,$2,$3,$4,'owner_ui',NULL,'owner')",
    [projectId, version, JSON.stringify(stored), versionDigest])
  return teams.ensureProjectLeader(projectId)
}
async function workerSession(path: string) {
  const agent: AgentContext = { agent_id: 'client', session_id: `native:${randomUUID()}`, cli_kind: 'claude_code', client: 'Claude', cwd: path }, key = randomUUID()
  const internal = await chat.lifecycle(agent, { session_key: key, native_id: agent.session_id, event: 'SessionStart', at: new Date().toISOString() })
  await chat.call('chat_set_nick', { session_key: key, nickname: randomUUID().slice(0, 15) }, agent)
  return { agent, key, ...internal }
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' }).trim()

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'hub-derived-'))); folder = join(dir, 'context'); await mkdir(folder)
  db = new MemoryDatabase(join(dir, 'memory.sqlite')); await db.migrate(); chat = new LocalChat(new MemoryStore(db, dir))
  backend = new HubTeamRuntime(chat, join(dir, 'runtime'))
  Object.defineProperty(backend, 'supportsProfiles', { value: true, configurable: true })
  vi.spyOn(backend, 'preflight').mockResolvedValue()
  vi.spyOn(backend, 'launch').mockImplementation(async (_workspace, member) => ({ handle: member.member_id!, kind: 'hub_process', prompt_outcome: 'input-accepted' }))
  vi.spyOn(backend, 'stop').mockImplementation(async handle => {
    const row = (await db.query('SELECT runtime FROM chat_team_members WHERE launch_handle=$1', [handle]))[0]
    if (row) await db.query('UPDATE chat_team_members SET runtime=$2 WHERE launch_handle=$1', [handle, JSON.stringify({ ...row.runtime, state: 'stopped' })])
    return { state: 'stopped' } as any
  })
  collaboration = true; automations = true
  teams = new TeamOrchestration(chat, { catalog: async () => ({ clis: [{ id: 'claude_code', launchable: true }], models: [{ cli: 'claude_code', id: 'test-model' }] }), validate: async () => ({ launchable: true }) }, backend, undefined, () => collaboration)
  teams.attachAutomation(ports)
  projectId = randomUUID(); sourceChannel = randomUUID()
  await db.query("INSERT INTO entities(id,kind,title) VALUES($1,'project','Proyecto Ñandú')", [projectId])
  await db.query("INSERT INTO chat_channels(id,project_id,path,name,scope_key,kind,activated_at) VALUES($1,$2,$3,'Canal del proyecto',$4,'git',now())", [sourceChannel, projectId, folder, `fixture:${sourceChannel}`])
  approvedItems = [item(1), item(2)]; followUp = reply()
  vi.mocked(ports.approved).mockReset().mockImplementation(async () => ({ canonical_digest: digest, items: approvedItems, follow_up: followUp }))
  vi.mocked(ports.actionProfile!).mockClear()
})
afterEach(async () => { await backend.close(); await db.close(); await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

it('creates the automation channel only from the authorization recorded in the delegation, anchored to the authorized channel and to a Hub-owned workspace', async () => {
  const sessionId = await activate()
  expect(await teams.ensureProjectLeader(projectId)).toBe(sessionId)
  const session = (await db.query('SELECT * FROM chat_sessions WHERE id=$1', [sessionId]))[0]!
  expect(session).toMatchObject({ agent_id: 'agenthub-system', cli_kind: 'hub', capability: 'hub_system', closed_at: null })
  const channel = (await db.query('SELECT * FROM chat_channels WHERE id=$1', [session.channel_id]))[0]!
  expect(channel).toMatchObject({ leader_id: sessionId, scope_key: `automation:${projectId}`, project_id: projectId, name: authorizedChannel.name, path: join(backend.directory, 'automation-workspaces', projectId) })
  expect(channel.path).not.toBe(folder)
  expect(channel.id).not.toBe(sourceChannel)
  expect((await db.query('SELECT leader_id FROM chat_channels WHERE id=$1', [sourceChannel]))[0]!.leader_id).toBeNull()
  expect((await db.query('SELECT channel_id,coordinator_session_id FROM project_automation WHERE project_id=$1', [projectId]))[0]).toMatchObject({ channel_id: sourceChannel, coordinator_session_id: sessionId })
  expect(Number((await db.query("SELECT count(*) AS n FROM chat_sessions WHERE capability='hub_system'"))[0]!.n)).toBe(1)
})

it('refuses to create a channel the delegation did not authorize, or one anchored to another project or channel', async () => {
  expect(await rejection(activate(1, document, [], null))).toMatch(/no autoriza un canal/)
  expect(Number((await db.query('SELECT count(*) AS n FROM chat_channels WHERE scope_key LIKE $1', ['automation:%']))[0]!.n)).toBe(0)
  await db.query('DELETE FROM project_delegations WHERE project_id=$1', [projectId]); await db.query('DELETE FROM project_automation WHERE project_id=$1', [projectId])
  const other = randomUUID()
  await db.query("INSERT INTO chat_channels(id,project_id,path,name,scope_key,kind,activated_at) VALUES($1,NULL,$2,'Otro',$3,'git',now())", [other, folder, `fixture:${other}`])
  sourceChannel = other
  expect(await rejection(activate())).toMatch(/canal autorizado/)
  expect(await rejection(teams.ensureProjectLeader(randomUUID()))).toMatch(/delegación vigente/)
})

it('revalidates an existing system session against its channel instead of trusting any live leader', async () => {
  const sessionId = await activate()
  await db.query("UPDATE chat_sessions SET capability='next_turn' WHERE id=$1", [sessionId])
  expect(await rejection(teams.ensureProjectLeader(projectId))).toMatch(/no coincide con su canal/)
  await db.query("UPDATE chat_sessions SET capability='hub_system' WHERE id=$1", [sessionId])
  await db.query('UPDATE chat_channels SET leader_id=NULL WHERE id=(SELECT channel_id FROM chat_sessions WHERE id=$1)', [sessionId])
  expect(await rejection(teams.ensureProjectLeader(projectId))).toMatch(/no coincide con su canal/)
  expect(await rejection(teams.launchDerived(input()))).toMatch(/no coincide con su canal/)
})

it('launches nothing without the action profile: no spawn, no worktree, no plan', async () => {
  await activate()
  Object.defineProperty(backend, 'supportsProfiles', { value: false, configurable: true })
  expect(await rejection(teams.launchDerived(input()))).toMatch(/action_profile_unavailable/)
  Object.defineProperty(backend, 'supportsProfiles', { value: true, configurable: true })
  const withoutIssuer = new TeamOrchestration(chat, { catalog: async () => ({}), validate: async () => ({ launchable: true }) }, backend, undefined, () => collaboration)
  withoutIssuer.attachAutomation({ approved: ports.approved, automationsEnabled: () => true, ownerId: () => 'owner' })
  expect(await rejection(withoutIssuer.launchDerived(input()))).toMatch(/action_profile_unavailable/)
  expect(vi.mocked(backend.launch)).not.toHaveBeenCalled()
  expect(vi.mocked(ports.approved)).not.toHaveBeenCalled()
  expect(await plansCount()).toBe(0)
  await expect(readdir(join(dir, 'runtime', 'fleet-worktrees'))).rejects.toThrow()
})

it('the real runtime also refuses a profile it cannot apply', async () => {
  const real = new HubTeamRuntime(chat, join(dir, 'runtime-real'))
  vi.spyOn(real, 'preflight').mockResolvedValue()
  const workspace = { id: 'x', path: folder, repo_id: 'r', head: 'virtual', kind: 'virtual' as const }
  await expect(real.launch(workspace, { cli: 'claude_code', model: 'm', prompt: 'p', profile: { kind: 'action', agent_instance_id: 'a', principal_handle: 'h' } })).rejects.toThrow(/action_profile_unavailable/)
  await real.close()
})

it('launches the roster from the delegation, each member with its own action profile, verified provenance and derived plan data', async () => {
  const leader = await activate()
  const plan = await teams.launchDerived(input())
  expect(plan.state).toBe('launched')
  expect(plan.created_by).toBe(leader)
  expect(plan.members.map((member: any) => [member.worktree_name, member.cli, member.model, member.effort])).toEqual([
    ['coordinador', 'claude_code', 'test-model', 'high'], ['proyecto-proyecto-nandu', 'claude_code', 'test-model', null]])
  const row = (await db.query('SELECT * FROM chat_team_plans WHERE id=$1', [plan.id]))[0]!
  expect(row).toMatchObject({ approval_source: 'standing_delegation+channel_reply', approved_by_user_id: 'owner', delegation_project_id: projectId, delegation_version: 1, decision_request_id: 'req-1' })
  expect(plan.authorization).toMatchObject({ source: 'standing_delegation+channel_reply', permissions: 'action_profile', delegation: { project_id: projectId, version: 1, decision_request_id: 'req-1' } })
  expect(row.plan.derived).toMatchObject({ kind: 'standing_delegation', profile: 'action', decision: { request_id: 'req-1', canonical_digest: digest }, follow_up: { ref: 'msg-1', source: 'channel_reply' } })
  expect(row.digest).toBe(plan.digest)
  const launches = vi.mocked(backend.launch).mock.calls
  expect(launches).toHaveLength(2)
  for (const [, member] of launches) expect(member.profile).toEqual({ kind: 'action', agent_instance_id: 'hub_run_action', principal_handle: `handle-${member.member_id}` })
  expect(new Set(launches.map(([, member]) => member.profile!.principal_handle)).size).toBe(2)
})

it('takes the follow-up only from the authenticated receipt and records its real source', async () => {
  await activate()
  followUp = null
  expect(await rejection(teams.launchDerived(input()))).toMatch(/instrucción de seguimiento autenticada/)
  followUp = reply({ expires_at: new Date(Date.now() - 1000).toISOString() })
  expect(await rejection(teams.launchDerived(input()))).toMatch(/instrucción de seguimiento autenticada/)
  expect(await plansCount()).toBe(0)
  followUp = reply({ source: 'owner_ui', ref: 'app-9' })
  const plan = await teams.launchDerived(input())
  expect((await db.query('SELECT approval_source FROM chat_team_plans WHERE id=$1', [plan.id]))[0]!.approval_source).toBe('standing_delegation+owner_ui')
  const prompt = vi.mocked(backend.launch).mock.calls[0]![1].prompt
  expect(prompt).not.toContain('Revisa la rama')
  expect((await db.query('SELECT prompt FROM chat_team_members WHERE team_id=$1 ORDER BY ordinal', [plan.id]))[0]!.prompt).toContain('Revisa la rama feature/x')
  await teams.close({ plan_id: plan.id, digest: plan.digest, reason: 'prueba' }, (await db.query('SELECT * FROM chat_sessions WHERE id=$1', [plan.created_by]))[0]!)
  followUp = reply({ ref: 'msg-2' })
  const second = await teams.launchDerived(input({ request_id: 'req-2' }))
  expect(second.digest).not.toBe(plan.digest)
})

it('is idempotent per approved request: a replay returns the same plan without launching again', async () => {
  await activate()
  const first = await teams.launchDerived(input()), replay = await teams.launchDerived(input())
  expect(replay.id).toBe(first.id)
  expect(vi.mocked(backend.launch)).toHaveBeenCalledTimes(2)
  const raced = await Promise.all([teams.launchDerived(input()), teams.launchDerived(input())])
  expect(new Set(raced.map(plan => plan.id))).toEqual(new Set([first.id]))
  expect(await plansCount()).toBe(1)
})

it('claims the concurrency slot atomically: two different requests racing past every pre-check create one plan', async () => {
  await activate()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve }), arrived: string[] = []
  vi.mocked(ports.approved).mockImplementation(async requestId => { arrived.push(requestId); if (arrived.length === 2) release(); await barrier; return { canonical_digest: digest, items: approvedItems, follow_up: followUp } })
  const outcomes = await Promise.allSettled([teams.launchDerived(input({ request_id: 'req-a' })), teams.launchDerived(input({ request_id: 'req-b' }))])
  expect([...arrived].sort()).toEqual(['req-a', 'req-b'])
  expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect(String((outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult).reason.message)).toMatch(/tope de planes simultáneos/)
  expect(await plansCount()).toBe(1)
  expect(vi.mocked(backend.launch)).toHaveBeenCalledTimes(2)
})

it('requires a current, unrevoked delegation and the automations switch for the stated version', async () => {
  await activate()
  expect(await rejection(teams.launchDerived(input({ delegation_version: 2 })))).toMatch(/no está vigente/)
  await db.query('UPDATE project_delegations SET revoked_at=now() WHERE project_id=$1', [projectId])
  expect(await rejection(teams.launchDerived(input()))).toMatch(/no está vigente/)
  await db.query('UPDATE project_delegations SET revoked_at=NULL WHERE project_id=$1', [projectId])
  automations = false
  expect(await rejection(teams.launchDerived(input()))).toMatch(/automatizaciones están deshabilitadas/)
  automations = true
  await db.query('UPDATE project_automation SET enabled=0 WHERE project_id=$1', [projectId])
  expect(await rejection(teams.launchDerived(input()))).toMatch(/no está vigente/)
  expect(vi.mocked(backend.launch)).not.toHaveBeenCalled()
})

it('starts no worker when the delegation is revoked while preflight is still pending', async () => {
  await activate()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  vi.mocked(backend.preflight).mockImplementation(async () => { await pending })
  const attempt = rejection(teams.launchDerived(input()))
  await vi.waitFor(() => expect(vi.mocked(backend.preflight)).toHaveBeenCalled())
  await db.query('UPDATE project_delegations SET revoked_at=now() WHERE project_id=$1', [projectId])
  release()
  expect(await attempt).toMatch(/no está vigente/)
  expect(vi.mocked(backend.launch)).not.toHaveBeenCalled()
  expect(await plansCount()).toBe(0)
})

it('revalidates the delegation immediately before each spawn and leaves no process behind', async () => {
  await activate()
  const spawned: string[] = []
  vi.mocked(backend.launch).mockImplementation(async (_workspace, member) => {
    if (spawned.length === 0) automations = false
    await member.authorize?.()
    spawned.push(member.member_id!)
    return { handle: member.member_id!, kind: 'hub_process', prompt_outcome: 'input-accepted' }
  })
  expect(await rejection(teams.launchDerived(input()))).toMatch(/automatizaciones están deshabilitadas/)
  expect(spawned).toEqual([])
  const plan = (await db.query('SELECT state FROM chat_team_plans WHERE delegation_project_id=$1', [projectId]))[0]!
  expect(plan.state).toBe('paused')
})

it('closes running derived plans and stops their workers when the delegation is revoked, and records a close that cannot be confirmed', async () => {
  await activate()
  const plan = await teams.launchDerived(input())
  collaboration = false
  const failed = await teams.closeDerivedForProject(projectId, 'Delegación revocada.')
  expect(failed).toEqual({ closed: [], failed: [plan.id] })
  expect((await db.query('SELECT state FROM chat_team_plans WHERE id=$1', [plan.id]))[0]!.state).not.toBe('cancelled')
  expect(Number((await db.query("SELECT count(*) AS n FROM chat_team_events WHERE team_id=$1 AND type='close_failed'", [plan.id]))[0]!.n)).toBe(1)
  collaboration = true
  expect(await teams.closeDerivedForProject(projectId, 'Delegación revocada.')).toEqual({ closed: [plan.id], failed: [] })
  expect((await db.query('SELECT state FROM chat_team_plans WHERE id=$1', [plan.id]))[0]!.state).toBe('cancelled')
  expect(vi.mocked(backend.stop).mock.calls.length).toBeGreaterThanOrEqual(2)
})

it('derives only from approved items of this project that the delegation allows', async () => {
  await activate()
  approvedItems = [item(1, { state: 'proposed' }), item(2, { state: 'rejected' }), item(3, { project_id: randomUUID() })]
  expect(await rejection(teams.launchDerived(input()))).toMatch(/al menos un ítem aprobado/)
  approvedItems = [item(1, { kind: 'jira_transition' })]
  expect(await rejection(teams.launchDerived(input()))).toMatch(/no habilita/)
  expect(vi.mocked(backend.launch)).not.toHaveBeenCalled()
  expect(await plansCount()).toBe(0)
})

it('binds the parent workspace to the delegated repository and rejects a channel that points elsewhere', async () => {
  const repo = join(dir, 'service'); await mkdir(repo); execFileSync('git', ['init', '-q', repo]); git(repo, 'commit', '--allow-empty', '-qm', 'seed')
  const repoSnapshot: RepositorySnapshot = { repo_id: 'repo-1', repo_path: repo, canonical_remote_url: 'https://example.invalid/app.git', remote_name: 'origin', default_branch: 'main', allowed_branches: ['feature/*'] }
  const withRepo: DelegationDocument = { ...document, repository_ids: ['repo-1'] }
  const leader = await activate(1, withRepo, [repoSnapshot])
  const channelId = (await db.query('SELECT channel_id FROM chat_sessions WHERE id=$1', [leader]))[0]!.channel_id
  expect((await db.query('SELECT path FROM chat_channels WHERE id=$1', [channelId]))[0]!.path).toBe(repo)
  await db.query('UPDATE chat_channels SET path=$2 WHERE id=$1', [channelId, folder])
  expect(await rejection(teams.launchDerived(input()))).toMatch(/no corresponde a los repositorios/)
  expect(vi.mocked(backend.launch)).not.toHaveBeenCalled()
  await db.query('UPDATE chat_channels SET path=$2 WHERE id=$1', [channelId, repo])
  const plan = await teams.launchDerived(input())
  expect(plan.parent).toMatchObject({ path: repo })
})

it('does nothing when collaboration is off or the ports were never attached', async () => {
  await activate()
  collaboration = false
  expect(await rejection(teams.launchDerived(input()))).toMatch(/deshabilitada/)
  collaboration = true
  const bare = new TeamOrchestration(chat, { catalog: async () => ({}), validate: async () => ({}) }, backend)
  expect(await rejection(bare.launchDerived(input()))).toMatch(/no están disponibles/)
  expect(vi.mocked(backend.launch)).not.toHaveBeenCalled()
})

it('is not reachable through any agent operation', async () => {
  await activate()
  expect(Object.keys(teamDefinitions).some(name => /derived|leader|automation/.test(name))).toBe(false)
  const agent: AgentContext = { agent_id: 'client', session_id: `native:${randomUUID()}`, cli_kind: 'claude_code', client: 'Claude', cwd: folder }
  await expect(teams.call('launch_derived', input(), agent)).rejects.toThrow('Operación de equipo inexistente')
})

it('blocks members of a derived plan from administering teams or editing the plan', async () => {
  const leader = await activate()
  const plan = await teams.launchDerived(input())
  const slot = plan.members[1], prompt = vi.mocked(backend.launch).mock.calls[1]![1].prompt
  const worker = await workerSession(slot.workspace_path)
  await teams.call('team_join', { session_key: worker.key, invitation: /invitation=([A-Za-z0-9_-]+)/.exec(prompt)![1] }, worker.agent)
  expect((await db.query('SELECT state FROM chat_team_members WHERE id=$1', [slot.id]))[0]!.state).toBe('joined')
  const attempt = await rejection(teams.call('team_prepare', { session_key: worker.key, objective: 'Equipo anidado', members: [{ worktree_name: 'extra', cli: 'claude_code', model: 'test-model', role: 'r', task: 't', prompt: 'p' }] }, worker.agent))
  expect(attempt).toMatch(/plan derivado|líder activo/)
  const system = (await db.query('SELECT * FROM chat_sessions WHERE id=$1', [leader]))[0]!
  const edit = await rejection((teams as any).control({ plan_id: plan.id, member_id: slot.id, expected_generation: 'none', action: 'edit', prompt: 'Haz otra cosa' }, system))
  expect(edit).toMatch(/no admite cambios|generación/)
  expect((await db.query('SELECT prompt FROM chat_team_members WHERE id=$1', [slot.id]))[0]!.prompt).not.toBe('Haz otra cosa')
})

it('closes derived plans and stops their workers once the delegation runtime elapses', async () => {
  await activate()
  const plan = await teams.launchDerived(input())
  expect(await teams.expireDerived(Date.now() + 29 * 60_000)).toEqual({ closed: [], failed: [] })
  expect(await teams.expireDerived(Date.now() + 31 * 60_000)).toEqual({ closed: [plan.id], failed: [] })
  expect((await db.query('SELECT state FROM chat_team_plans WHERE id=$1', [plan.id]))[0]!.state).toBe('cancelled')
  expect(vi.mocked(backend.stop).mock.calls.length).toBeGreaterThanOrEqual(2)
  expect(await teams.expireDerived(Date.now() + 31 * 60_000)).toEqual({ closed: [], failed: [] })
})
