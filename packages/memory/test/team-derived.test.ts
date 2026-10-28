import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { LocalChat } from '../src/local-chat.js'
import { HubTeamRuntime } from '../src/team-hub.js'
import { TeamOrchestration, teamDefinitions, type DerivedPorts } from '../src/team-orchestration.js'
import { snapshotDelegation, type ApprovedItem, type DelegationDocument } from '../src/project-automation.js'
import type { AgentContext } from '../src/agents.js'

let dir: string, folder: string, db: MemoryDatabase, chat: LocalChat, backend: HubTeamRuntime, teams: TeamOrchestration
let collaboration = true, projectId: string, sourceChannel: string, approvedItems: Array<ApprovedItem & { state: string }>
const digest = 'c'.repeat(64)
const document: DelegationDocument = { schema_version: 1,
  roster: { coordinator: { cli: 'claude_code', model: 'test-model', effort: 'high' }, project_agent: { cli: 'claude_code', model: 'test-model' } },
  item_kinds: ['jira_worklog'], repository_ids: [], limits: { max_concurrent_plans: 1, max_runtime_minutes: 30 } }
const item = (ordinal: number, over: Partial<ApprovedItem & { state: string }> = {}) => ({ item_id: `item-${ordinal}`, ordinal, kind: 'jira_worklog', project_id: projectId,
  summary: `Horas ${ordinal}`, effect_digest: 'd'.repeat(64), state: 'approved', ...over })
const ports: DerivedPorts = { approved: vi.fn(async () => ({ canonical_digest: digest, items: approvedItems })), ownerId: () => 'owner' }
const input = (over: Record<string, unknown> = {}) => ({ project_id: projectId, delegation_version: 1, request_id: 'req-1', follow_up: 'Revisa la rama feature/x', ...over })
const rejection = async (promise: Promise<unknown>) => { try { await promise } catch (error) { return (error as Error).message } return 'none' }

async function activate(version = 1, doc: DelegationDocument = document) {
  const { stored, digest: versionDigest } = snapshotDelegation(projectId, version, doc, [])
  await db.query("INSERT INTO project_automation(project_id,enabled,delegation_version,channel_id,updated_by_user) VALUES($1,1,$2,$3,'owner') ON CONFLICT(project_id) DO UPDATE SET delegation_version=excluded.delegation_version,enabled=1",
    [projectId, version, sourceChannel])
  await db.query("INSERT INTO project_delegations(project_id,version,document,digest,approval_source,instruction,created_by_user) VALUES($1,$2,$3,$4,'owner_ui',NULL,'owner')",
    [projectId, version, JSON.stringify(stored), versionDigest])
  return teams.ensureProjectLeader(projectId, sourceChannel)
}
async function workerSession(path: string) {
  const agent: AgentContext = { agent_id: 'client', session_id: `native:${randomUUID()}`, cli_kind: 'claude_code', client: 'Claude', cwd: path }, key = randomUUID()
  const internal = await chat.lifecycle(agent, { session_key: key, native_id: agent.session_id, event: 'SessionStart', at: new Date().toISOString() })
  await chat.call('chat_set_nick', { session_key: key, nickname: randomUUID().slice(0, 15) }, agent)
  return { agent, key, ...internal }
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'hub-derived-'))); folder = join(dir, 'context'); await mkdir(folder)
  db = new MemoryDatabase(join(dir, 'memory.sqlite')); await db.migrate(); chat = new LocalChat(new MemoryStore(db, dir))
  backend = new HubTeamRuntime(chat, join(dir, 'runtime'))
  vi.spyOn(backend, 'preflight').mockResolvedValue()
  vi.spyOn(backend, 'launch').mockImplementation(async (_workspace, member) => ({ handle: member.member_id!, kind: 'hub_process', prompt_outcome: 'input-accepted' }))
  vi.spyOn(backend, 'stop').mockImplementation(async handle => {
    const row = (await db.query('SELECT runtime FROM chat_team_members WHERE launch_handle=$1', [handle]))[0]
    if (row) await db.query('UPDATE chat_team_members SET runtime=$2 WHERE launch_handle=$1', [handle, JSON.stringify({ ...row.runtime, state: 'stopped' })])
    return { state: 'stopped' } as any
  })
  collaboration = true
  teams = new TeamOrchestration(chat, { catalog: async () => ({ clis: [{ id: 'claude_code', launchable: true }], models: [{ cli: 'claude_code', id: 'test-model' }] }), validate: async () => ({ launchable: true }) }, backend, undefined, () => collaboration)
  teams.attachAutomation(ports)
  projectId = randomUUID(); sourceChannel = randomUUID()
  await db.query("INSERT INTO entities(id,kind,title) VALUES($1,'project','Proyecto Ñandú')", [projectId])
  await db.query("INSERT INTO chat_channels(id,project_id,path,name,scope_key,kind,activated_at) VALUES($1,$2,$3,'Canal del proyecto',$4,'git',now())", [sourceChannel, projectId, folder, `fixture:${sourceChannel}`])
  approvedItems = [item(1), item(2)]
  vi.mocked(ports.approved).mockClear()
})
afterEach(async () => { await backend.close(); await db.close(); await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

it('creates one automation channel led by a system session that no client can authenticate as', async () => {
  const sessionId = await activate()
  expect(await teams.ensureProjectLeader(projectId, sourceChannel)).toBe(sessionId)
  const session = (await db.query('SELECT * FROM chat_sessions WHERE id=$1', [sessionId]))[0]!
  expect(session).toMatchObject({ agent_id: 'agenthub-system', cli_kind: 'hub', capability: 'hub_system', closed_at: null })
  const channel = (await db.query('SELECT * FROM chat_channels WHERE id=$1', [session.channel_id]))[0]!
  expect(channel).toMatchObject({ leader_id: sessionId, scope_key: `automation:${projectId}`, project_id: projectId, path: folder })
  expect(channel.id).not.toBe(sourceChannel)
  expect((await db.query('SELECT leader_id FROM chat_channels WHERE id=$1', [sourceChannel]))[0]!.leader_id).toBeNull()
  expect((await db.query('SELECT coordinator_session_id FROM project_automation WHERE project_id=$1', [projectId]))[0]!.coordinator_session_id).toBe(sessionId)
  expect((await db.query("SELECT count(*) AS n FROM chat_sessions WHERE capability='hub_system'"))[0]!.n).toBe(1)
  await expect(teams.ensureProjectLeader(projectId, randomUUID())).resolves.toBe(sessionId)
})

it('rejects a source channel of another project', async () => {
  await db.query("INSERT INTO project_automation(project_id,enabled,updated_by_user) VALUES($1,0,'owner')", [projectId])
  const other = randomUUID()
  await db.query("INSERT INTO chat_channels(id,project_id,path,name,scope_key,kind,activated_at) VALUES($1,NULL,$2,'Otro',$3,'git',now())", [other, folder, `fixture:${other}`])
  expect(await rejection(teams.ensureProjectLeader(projectId, other))).toMatch(/no pertenece al proyecto/)
})

it('launches the roster from the delegation with verified provenance and derived plan data', async () => {
  const leader = await activate()
  const plan = await teams.launchDerived(input())
  expect(plan.state).toBe('launched')
  expect(plan.created_by).toBe(leader)
  expect(plan.members.map((member: any) => [member.worktree_name, member.cli, member.model, member.effort])).toEqual([
    ['coordinador', 'claude_code', 'test-model', 'high'], ['proyecto-proyecto-nandu', 'claude_code', 'test-model', null]])
  const row = (await db.query('SELECT * FROM chat_team_plans WHERE id=$1', [plan.id]))[0]!
  expect(row).toMatchObject({ approval_source: 'standing_delegation+channel_reply', approved_by_user_id: 'owner', delegation_project_id: projectId, delegation_version: 1, decision_request_id: 'req-1' })
  expect(plan.authorization).toMatchObject({ source: 'standing_delegation+channel_reply', approved_by_user_id: 'owner', delegation: { project_id: projectId, version: 1, decision_request_id: 'req-1' } })
  expect(row.plan.derived).toMatchObject({ kind: 'standing_delegation', decision: { request_id: 'req-1', canonical_digest: digest } })
  expect(row.digest).toBe(plan.digest)
  const prompts = vi.mocked(backend.launch).mock.calls.map(call => call[1].prompt)
  expect(prompts).toHaveLength(2)
  expect(vi.mocked(backend.launch).mock.calls.map(call => [call[1].cli, call[1].model])).toEqual([['claude_code', 'test-model'], ['claude_code', 'test-model']])
})

it('does not trust the caller for the roster: the plan digest changes only with delegation, decision, items or follow-up', async () => {
  await activate()
  const first = await teams.launchDerived(input())
  await teams.close({ plan_id: first.id, digest: first.digest, reason: 'prueba' }, (await db.query('SELECT * FROM chat_sessions WHERE id=$1', [first.created_by]))[0]!)
  const second = await teams.launchDerived(input({ request_id: 'req-2' }))
  expect(second.id).not.toBe(first.id)
  expect(second.digest).not.toBe(first.digest)
})

it('is idempotent per approved request: a replay returns the same plan without launching again', async () => {
  await activate()
  const first = await teams.launchDerived(input()), replay = await teams.launchDerived(input())
  expect(replay.id).toBe(first.id)
  expect(vi.mocked(backend.launch)).toHaveBeenCalledTimes(2)
  const raced = await Promise.all([teams.launchDerived(input()), teams.launchDerived(input())])
  expect(new Set(raced.map(plan => plan.id))).toEqual(new Set([first.id]))
  expect((await db.query('SELECT count(*) AS n FROM chat_team_plans WHERE delegation_project_id=$1', [projectId]))[0]!.n).toBe(1)
})

it('enforces the delegation concurrency limit across different requests', async () => {
  await activate()
  await teams.launchDerived(input())
  expect(await rejection(teams.launchDerived(input({ request_id: 'req-2' })))).toMatch(/tope de planes simultáneos/)
  expect((await db.query('SELECT count(*) AS n FROM chat_team_plans WHERE delegation_project_id=$1', [projectId]))[0]!.n).toBe(1)
})

it('requires a current, unrevoked delegation for the stated version', async () => {
  await activate()
  expect(await rejection(teams.launchDerived(input({ delegation_version: 2 })))).toMatch(/no está vigente/)
  await db.query('UPDATE project_delegations SET revoked_at=now() WHERE project_id=$1', [projectId])
  expect(await rejection(teams.launchDerived(input()))).toMatch(/no está vigente/)
  await db.query('UPDATE project_delegations SET revoked_at=NULL WHERE project_id=$1', [projectId])
  await db.query('UPDATE project_automation SET enabled=0 WHERE project_id=$1', [projectId])
  expect(await rejection(teams.launchDerived(input()))).toMatch(/no está vigente/)
  expect(vi.mocked(backend.launch)).not.toHaveBeenCalled()
})

it('derives only from approved items of this project that the delegation allows', async () => {
  await activate()
  approvedItems = [item(1, { state: 'proposed' }), item(2, { state: 'rejected' }), item(3, { project_id: randomUUID() })]
  expect(await rejection(teams.launchDerived(input()))).toMatch(/al menos un ítem aprobado/)
  approvedItems = [item(1, { kind: 'jira_transition' })]
  expect(await rejection(teams.launchDerived(input()))).toMatch(/no habilita/)
  approvedItems = [item(1)]
  expect(await rejection(teams.launchDerived(input({ follow_up: '   ' })))).toMatch(/seguimiento/)
  expect(vi.mocked(backend.launch)).not.toHaveBeenCalled()
  expect((await db.query('SELECT count(*) AS n FROM chat_team_plans WHERE delegation_project_id IS NOT NULL'))[0]!.n).toBe(0)
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
  const joined = (await db.query('SELECT state FROM chat_team_members WHERE id=$1', [slot.id]))[0]!
  expect(joined.state).toBe('joined')
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
  expect(await teams.expireDerived(Date.now() + 29 * 60_000)).toEqual([])
  expect(await teams.expireDerived(Date.now() + 31 * 60_000)).toEqual([plan.id])
  expect((await db.query('SELECT state FROM chat_team_plans WHERE id=$1', [plan.id]))[0]!.state).toBe('cancelled')
  expect(vi.mocked(backend.stop).mock.calls.length).toBeGreaterThanOrEqual(2)
  expect(await teams.expireDerived(Date.now() + 31 * 60_000)).toEqual([])
})
