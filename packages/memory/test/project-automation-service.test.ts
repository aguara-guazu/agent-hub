import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { LocalChat } from '../src/local-chat.js'
import { MemoryError } from '../src/contracts.js'
import { ProjectAutomationService, type GitProbe } from '../src/project-automation-service.js'
import { callProjectAutomationTool } from '../src/project-automation-tools.js'
import { delegatedPushPolicy } from '../src/project-push-policy.js'
import type { DelegationDocument } from '../src/project-automation.js'
import type { AgentContext } from '../src/agents.js'

let dir: string, repo: string, db: MemoryDatabase, chat: LocalChat, service: ProjectAutomationService, projectId: string, otherProject: string, channelId: string
const SHA = 'a'.repeat(40), OLD = 'b'.repeat(40), URL = 'git@example.invalid:team/app.git'
const teams = { closeDerivedForProject: vi.fn(async () => ({ closed: [] as string[], failed: [] as string[] })), ensureProjectLeader: vi.fn(async () => 'system:x'), retireProjectLeader: vi.fn(async () => undefined) }
const created: Array<Record<string, any>> = []
let scheduleBehavior: (input: Record<string, any>) => Promise<unknown>
const schedules = { create: vi.fn(async (_principal: unknown, input: Record<string, any>) => { created.push(input); return scheduleBehavior(input) as any }) }
let tip = SHA, remoteTip: string | null = null, remoteDefault = 'main', fetchUrls = [URL], pushUrls = [URL]
const probe: GitProbe = vi.fn(async (args, cwd) => {
  const [command] = args
  if (command === 'rev-parse' && args.includes('--show-toplevel')) return { code: 0, stdout: `${cwd}\n` }
  if (command === 'rev-parse') return { code: tip ? 0 : 1, stdout: `${tip}\n` }
  if (command === 'remote') return { code: 0, stdout: `${(args.includes('--push') ? pushUrls : fetchUrls).join('\n')}\n` }
  if (command === 'ls-remote' && args.includes('--symref')) return { code: 0, stdout: `ref: refs/heads/${remoteDefault}\tHEAD\n${SHA}\tHEAD\n` }
  if (command === 'ls-remote') return remoteTip === undefined ? { code: 128, stdout: '' } : { code: 0, stdout: remoteTip ? `${remoteTip}\t${args[2]}\n` : '' }
  if (command === 'for-each-ref') return { code: 0, stdout: 'main\nfeature/a\n' }
  return { code: 1, stdout: '' }
})
const document = (over: Partial<DelegationDocument> = {}): DelegationDocument => ({ schema_version: 1,
  roster: { coordinator: { cli: 'claude_code', model: 'm', effort: 'high' }, project_agent: { cli: 'claude_code', model: 'm' } },
  item_kinds: ['jira_worklog'], repository_ids: [], limits: { max_concurrent_plans: 1, max_runtime_minutes: 30 }, ...over })
const owner = { kind: 'human' as const, ref: 'owner' }
const error = async (promise: Promise<unknown>) => { try { await promise } catch (value) { return value as MemoryError } return undefined }
async function agentIn(channel: string | null) {
  const agent: AgentContext = { agent_id: 'client', session_id: `native:${randomUUID()}`, cli_kind: 'claude_code', client: 'Claude', cwd: dir }, key = randomUUID()
  const internal = await chat.lifecycle(agent, { session_key: key, native_id: agent.session_id, event: 'SessionStart', at: new Date().toISOString() })
  if (channel) await db.query('UPDATE chat_sessions SET channel_id=$2 WHERE id=$1', [internal.session.id, channel])
  return { agent, key }
}
async function repositories() {
  return (await service.addRepository(projectId, { repo_path: repo, allowed_branches: ['feature/*'] })).repository.id
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'hub-activation-'))); repo = join(dir, 'app'); await mkdir(repo)
  db = new MemoryDatabase(join(dir, 'memory.sqlite')); await db.migrate(); chat = new LocalChat(new MemoryStore(db, dir))
  service = new ProjectAutomationService({ db, chat, teams: () => teams, schedules: () => schedules, git: probe })
  projectId = randomUUID(); otherProject = randomUUID(); channelId = randomUUID()
  await db.query("INSERT INTO entities(id,kind,title) VALUES($1,'project','Proyecto Ñandú'),($2,'project','Otro')", [projectId, otherProject])
  await db.query("INSERT INTO chat_channels(id,project_id,path,name,scope_key,kind,activated_at) VALUES($1,$2,$3,'feature/x',$4,'git',now())", [channelId, projectId, repo, `fixture:${channelId}`])
  tip = SHA; remoteTip = null; remoteDefault = 'main'; fetchUrls = [URL]; pushUrls = [URL]
  created.length = 0
  scheduleBehavior = async input => ({ schedule: { id: `sch-${input.template}` } })
  for (const fn of [...Object.values(teams), schedules.create, probe as any]) fn.mockClear()
})
afterEach(async () => { await db.close(); await rm(dir, { recursive: true, force: true }) })

it('activates from the app with owner provenance, a default automation channel and the three schedules, without a model or a write', async () => {
  const result = await service.activate(owner, { project_id: projectId, enabled: true, delegation: document(), channel_id: channelId, expected_version: null })
  expect(result.delegation).toMatchObject({ version: 1, approval_source: 'owner_ui', instruction: null, revoked_at: null, document: { roster: { coordinator: { cli: 'claude_code' } }, repository_ids: [] } })
  expect(result).toMatchObject({ enabled: true, channel: { id: channelId, name: 'feature/x' }, automation_channel: { name: 'Automatización: Proyecto Ñandú' }, coordinator_state: 'ready', changed: true })
  expect(teams.ensureProjectLeader).toHaveBeenCalledWith(projectId)
  expect(created.map(input => [input.template, input.recurrence, input.project_id ?? null, input.delivery])).toEqual([
    ['project_status', { type: 'daily', time: '07:50', weekdays: [1, 2, 3, 4, 5] }, projectId, ['hub_inbox', 'app_window']],
    ['daily_brief', { type: 'daily', time: '08:00', weekdays: [1, 2, 3, 4, 5] }, null, ['hub_inbox', 'app_window']],
    ['daily_close', { type: 'daily', time: '17:30', weekdays: [1, 2, 3, 4, 5] }, null, ['hub_inbox', 'app_window']]])
  expect(result.schedules.map(entry => entry.state)).toEqual(['created', 'created', 'created'])
  expect((await service.view(projectId)).history).toHaveLength(1)
})

it('reuses existing schedules, respects a human cancellation and reports a template the scheduler does not know yet', async () => {
  scheduleBehavior = async input => {
    if (input.template === 'project_status') throw new MemoryError(409, 'x', false, 'duplicate_target')
    if (input.template === 'daily_brief') throw new MemoryError(409, 'x', false, 'schedule_constrained')
    throw new MemoryError(400, 'x', false, 'template_unknown')
  }
  const result = await service.activate(owner, { project_id: projectId, enabled: true, delegation: document(), channel_id: null })
  expect(result.schedules.map(entry => [entry.template, entry.state])).toEqual([['project_status', 'reused'], ['daily_brief', 'constrained'], ['daily_close', 'unavailable']])
  expect(result).toMatchObject({ channel: null, automation_channel: null, coordinator: 'no_channel', coordinator_state: 'no_channel' })
  expect(teams.ensureProjectLeader).not.toHaveBeenCalled()
})

it('lets an agent activate only with the words of the person, anchored to its own project channel, and records them as provenance', async () => {
  const { agent, key } = await agentIn(channelId)
  const call = (over: Record<string, unknown> = {}) => callProjectAutomationTool(service, 'project_automation_activate', { project_id: projectId, delegation: document(), human_instruction: 'Sí, activa el brief de este proyecto', expected_version: null, session_key: key, request_id: 'r-1', ...over }, agent)
  expect((await error(call({ human_instruction: undefined })))?.statusCode).toBe(422)
  expect((await error(call({ expected_version: undefined })))?.statusCode).toBe(422)
  const without = await call()
  expect(without).toMatchObject({ coordinator_state: 'no_channel', automation_channel: null, delegation: { approval_source: 'coordinator_declaration', instruction: 'Sí, activa el brief de este proyecto' }, channel: { id: channelId } })
  expect((await error(call({ expected_version: 7 })))?.code).toBe('stale_version')
  const withChannel = await call({ expected_version: 1, channel: { name: 'Automatización: Ñandú', objective: 'Coordinar seguimiento' } })
  expect(withChannel).toMatchObject({ coordinator_state: 'ready', automation_channel: { name: 'Automatización: Ñandú', objective: 'Coordinar seguimiento' }, changed: true })
  expect(withChannel.delegation!.version).toBe(2)
  expect(withChannel.delegation!.document).not.toHaveProperty('channel')
  const unrelated = await agentIn(null)
  const elsewhere = await callProjectAutomationTool(service, 'project_automation_activate', { project_id: otherProject, delegation: document(), human_instruction: 'Activa también el otro', expected_version: null, session_key: unrelated.key, request_id: 'r-2', channel: { name: 'x', objective: 'y' } }, unrelated.agent)
  expect(elsewhere).toMatchObject({ channel: null, coordinator_state: 'no_channel' })
  const profile: AgentContext = { agent_id: 'run', session_id: 'native:run', cli_kind: 'hub_run_action', client: 'Hub', cwd: dir }
  expect((await error(callProjectAutomationTool(service, 'project_automation_activate', { project_id: projectId, delegation: document(), human_instruction: 'x', expected_version: null, request_id: 'r-3' }, profile)))?.statusCode).toBe(403)
})

it('creates a new version only when the delegation changed, retiring plans and the old leader, and honors expected_version', async () => {
  await service.activate(owner, { project_id: projectId, enabled: true, delegation: document(), channel_id: channelId, expected_version: null })
  teams.closeDerivedForProject.mockClear(); teams.retireProjectLeader.mockClear(); teams.ensureProjectLeader.mockClear()
  const same = await service.activate(owner, { project_id: projectId, enabled: true, delegation: document(), channel_id: channelId, expected_version: 1 })
  expect(same).toMatchObject({ changed: false, delegation: { version: 1 } })
  expect(teams.closeDerivedForProject).not.toHaveBeenCalled()
  expect((await error(service.activate(owner, { project_id: projectId, enabled: true, delegation: document(), channel_id: channelId, expected_version: null })))?.code).toBe('stale_version')
  const changed = await service.activate(owner, { project_id: projectId, enabled: true, delegation: document({ item_kinds: ['jira_worklog', 'jira_comment'] }), channel_id: channelId, expected_version: 1 })
  expect(changed).toMatchObject({ changed: true, delegation: { version: 2, document: { item_kinds: ['jira_worklog', 'jira_comment'] } } })
  expect(teams.closeDerivedForProject).toHaveBeenCalledWith(projectId, expect.stringContaining('reemplazada'))
  expect(teams.retireProjectLeader).toHaveBeenCalledWith(projectId)
  expect((await db.query('SELECT version,revoked_at FROM project_delegations WHERE project_id=$1 ORDER BY version', [projectId])).map(row => [row.version, Boolean(row.revoked_at)])).toEqual([[1, true], [2, false]])
  expect((await db.query('SELECT delegation_version FROM project_automation WHERE project_id=$1', [projectId]))[0]!.delegation_version).toBe(2)
})

it('rejects an invalid document, a channel of another project, and a delegation that references a missing repository', async () => {
  expect((await error(service.activate(owner, { project_id: projectId, enabled: true, delegation: { ...document(), roster: undefined } as any, channel_id: null })))?.code).toBe('invalid_document')
  const foreign = randomUUID()
  await db.query("INSERT INTO chat_channels(id,project_id,path,name,scope_key,kind,activated_at) VALUES($1,$2,$3,'Otro',$4,'git',now())", [foreign, otherProject, repo, `fixture:${foreign}`])
  expect((await error(service.activate(owner, { project_id: projectId, enabled: true, delegation: document(), channel_id: foreign })))?.code).toBe('channel_not_authorized')
  expect((await error(service.activate(owner, { project_id: projectId, enabled: true, delegation: document({ item_kinds: ['git_push'], repository_ids: ['missing'] }), channel_id: null })))?.code).toBe('repository_unavailable')
  expect((await error(service.activate(owner, { project_id: randomUUID(), enabled: false })))?.code).toBe('project_not_found')
  expect(Number((await db.query('SELECT count(*) AS n FROM project_delegations'))[0]!.n)).toBe(0)
})

it('deactivates: revokes the version, closes plans, retires the leader, and lets the project be activated again with a higher version', async () => {
  await service.activate(owner, { project_id: projectId, enabled: true, delegation: document(), channel_id: channelId, expected_version: null })
  const off = await service.activate(owner, { project_id: projectId, enabled: false, channel_id: null, expected_version: 1 })
  expect(off).toMatchObject({ enabled: false, delegation: null, coordinator: 'disabled', channel: null })
  expect(teams.closeDerivedForProject).toHaveBeenCalledWith(projectId, 'Proyecto desactivado.')
  expect(teams.retireProjectLeader).toHaveBeenCalledWith(projectId)
  expect((await db.query('SELECT revoked_at FROM project_delegations WHERE project_id=$1', [projectId]))[0]!.revoked_at).not.toBeNull()
  const again = await service.activate(owner, { project_id: projectId, enabled: true, delegation: document(), channel_id: channelId, expected_version: null })
  expect(again.delegation!.version).toBe(2)
})

it('resolves a repository itself and refuses ambiguous destinations, credentials, the default branch and wildcards', async () => {
  const saved = await service.addRepository(projectId, { repo_path: repo, allowed_branches: ['feature/*', 'release/1'] })
  expect(saved.repository).toEqual(expect.objectContaining({ repo_path: repo, canonical_remote_url: URL, remote_name: 'origin', default_branch: 'main', allowed_branches: ['feature/*', 'release/1'] }))
  const attempt = (over: Record<string, unknown> = {}) => error(service.addRepository(projectId, { repo_path: repo, allowed_branches: ['feature/*'], ...over } as any))
  expect((await attempt({ allowed_branches: ['main'] }))?.code).toBe('branch_invalid')
  expect((await attempt({ allowed_branches: ['*'] }))?.code).toBe('branch_invalid')
  expect((await attempt({ allowed_branches: [] }))?.code).toBe('branch_invalid')
  expect((await attempt({ repo_path: 'relative' }))?.code).toBe('repository_unavailable')
  expect((await attempt({ repo_path: join(dir, 'missing') }))?.code).toBe('repository_unavailable')
  pushUrls = ['git@elsewhere.invalid:x/y.git']
  expect((await attempt())?.code).toBe('remote_not_allowed')
  pushUrls = fetchUrls = ['https://user:secret@example.invalid/app.git']
  expect((await attempt())?.code).toBe('remote_not_allowed')
  pushUrls = fetchUrls = ['/tmp/local-remote']
  expect((await attempt())?.code).toBe('remote_not_allowed')
  expect((await service.branches(projectId, repo))).toEqual({ branches: ['main', 'feature/a'], default_branch: 'main' })
  expect((await error(service.branches(projectId, join(dir, 'nope'))))?.code).toBe('repository_unavailable')
})

it('adds one repository without touching the others, and updates or removes one by id', async () => {
  const second = join(dir, 'lib'); await mkdir(second)
  const first = (await service.addRepository(projectId, { repo_path: repo, allowed_branches: ['feature/*'] })).repository
  const other = (await service.addRepository(projectId, { repo_path: second, allowed_branches: ['fix/*'] })).repository
  expect((await service.view(projectId)).repositories.map(entry => entry.id).sort()).toEqual([first.id, other.id].sort())
  expect((await service.addRepository(projectId, { repo_path: repo, allowed_branches: ['feature/*', 'wip/*'] })).repository).toMatchObject({ id: first.id, allowed_branches: ['feature/*', 'wip/*'] })
  const updated = await service.updateRepository(projectId, other.id, { allowed_branches: ['hotfix/*'] })
  expect(updated.repository).toMatchObject({ id: other.id, repo_path: second, allowed_branches: ['hotfix/*'] })
  expect((await error(service.updateRepository(projectId, randomUUID(), { allowed_branches: ['x/*'] })))?.code).toBe('repository_unavailable')
  expect((await error(service.updateRepository(otherProject, first.id, { allowed_branches: ['x/*'] })))?.code).toBe('repository_unavailable')
  expect(await service.removeRepository(projectId, other.id)).toEqual({ removed: other.id })
  expect((await service.view(projectId)).repositories.map(entry => entry.id)).toEqual([first.id])
  expect((await error(service.removeRepository(projectId, other.id)))?.code).toBe('repository_unavailable')
})

it('replaces the whole list only against the digest of the list that was shown', async () => {
  const second = join(dir, 'lib'); await mkdir(second)
  await service.addRepository(projectId, { repo_path: repo, allowed_branches: ['feature/*'] })
  const shown = (await service.view(projectId)).repositories_digest
  await service.addRepository(projectId, { repo_path: second, allowed_branches: ['fix/*'] })
  expect((await error(service.replaceRepositories(projectId, [{ repo_path: repo, allowed_branches: ['feature/*'] }], shown)))?.code).toBe('stale_repositories')
  expect((await service.view(projectId)).repositories).toHaveLength(2)
  const current = (await service.view(projectId)).repositories_digest
  const replaced = await service.replaceRepositories(projectId, [{ repo_path: repo, allowed_branches: ['feature/*'] }], current)
  expect(replaced.repositories.map(entry => entry.repo_path)).toEqual([repo])
  expect((await error(service.replaceRepositories(projectId, [{ repo_path: repo, allowed_branches: ['feature/*'] }, { repo_path: repo, allowed_branches: ['x/*'] }], (await service.view(projectId)).repositories_digest)))?.statusCode).toBe(422)
})

it('refuses to drop a repository that the delegation in force references, by any route, and removes it once the delegation is gone', async () => {
  const repoId = await repositories()
  await service.activate(owner, { project_id: projectId, enabled: true, delegation: document({ item_kinds: ['git_push'], repository_ids: [repoId] }), channel_id: null })
  expect((await error(service.removeRepository(projectId, repoId)))?.code).toBe('repository_in_use')
  expect((await error(service.replaceRepositories(projectId, [], (await service.view(projectId)).repositories_digest)))?.code).toBe('repository_in_use')
  await service.activate(owner, { project_id: projectId, enabled: false, channel_id: null })
  expect(await service.removeRepository(projectId, repoId)).toEqual({ removed: repoId })
})

async function activatedForPush() {
  const repoId = await repositories()
  await service.activate(owner, { project_id: projectId, enabled: true, delegation: document({ item_kinds: ['git_push'], repository_ids: [repoId] }), channel_id: null })
  return repoId
}
const propose = (agent: AgentContext, key: string, over: Record<string, unknown> = {}) => callProjectAutomationTool(service, 'push_propose',
  { project_id: projectId, repo_path: repo, branch: 'feature/x', local_sha: SHA, reason: 'Corrección de hoy', session_key: key, request_id: 'p-1', ...over }, agent)

it('records a push candidate only for a delegated repository, an allowed branch and the exact local tip, idempotently and superseding older ones', async () => {
  await activatedForPush()
  const { agent, key } = await agentIn(channelId)
  const first = await propose(agent, key)
  expect(first).toMatchObject({ state: 'open', repeated: false })
  expect(await propose(agent, key)).toMatchObject({ candidate_id: first.candidate_id, repeated: true })
  tip = OLD
  const next = await propose(agent, key, { local_sha: OLD })
  expect(next.state).toBe('open')
  expect((await db.query('SELECT state FROM push_candidates ORDER BY created_at,id')).map(row => row.state).sort()).toEqual(['open', 'superseded'])
  tip = SHA
  for (const [over, status] of [[{ branch: 'main' }, 409], [{ branch: 'hotfix/x' }, 409], [{ local_sha: 'c'.repeat(40) }, 409], [{ repo_path: dir }, 409]] as const) expect((await error(propose(agent, key, over)))?.statusCode).toBe(status)
  const profile: AgentContext = { agent_id: 'run', session_id: 'native:run', cli_kind: 'hub_run_action', client: 'Hub', cwd: dir }
  expect((await error(propose(profile, key)))?.statusCode).toBe(403)
  await service.activate(owner, { project_id: projectId, enabled: true, delegation: document({ item_kinds: ['jira_worklog'] }), channel_id: null })
  expect((await error(propose(agent, key, { branch: 'feature/y' })))?.message).toMatch(/no habilita pushes/)
})

it('turns open candidates into exact effects with the observed remote tip, and explains the ones that cannot become an item', async () => {
  const repoId = await activatedForPush()
  const { agent, key } = await agentIn(channelId)
  await propose(agent, key)
  remoteTip = OLD
  const [ready] = await service.pushCandidates(projectId)
  expect(ready).toMatchObject({ executable: true, branch: 'feature/x', local_sha: SHA, effect: { repo_id: repoId, repo_path: repo, canonical_remote_url: URL, ref: 'refs/heads/feature/x', local_sha: SHA, expected_remote_sha: OLD } })
  remoteTip = null
  expect((await service.pushCandidates(projectId))[0]!.effect!.expected_remote_sha).toBeNull()
  remoteTip = SHA
  expect((await service.pushCandidates(projectId))[0]).toMatchObject({ executable: false, not_executable_reason: 'already_pushed' })
  remoteTip = undefined as unknown as string
  expect((await service.pushCandidates(projectId))[0]).toMatchObject({ executable: false, not_executable_reason: 'remote_unreachable' })
  remoteTip = null; tip = OLD
  expect((await service.pushCandidates(projectId))[0]).toMatchObject({ executable: false, not_executable_reason: 'local_branch_moved' })
  tip = SHA
  await service.markPushCandidatesProposed([ready!.candidate_id], 'run-1')
  expect(await service.pushCandidates(projectId)).toEqual([])
  expect((await db.query('SELECT state,run_id FROM push_candidates'))[0]).toMatchObject({ state: 'proposed', run_id: 'run-1' })
  await service.activate(owner, { project_id: projectId, enabled: false, channel_id: null })
  await db.query("UPDATE push_candidates SET state='open'")
  expect((await service.pushCandidates(projectId))[0]).toMatchObject({ executable: false, not_executable_reason: 'repository_not_delegated' })
})

it('exposes the policy of a delegated repository only while the delegation in force permits pushes and names that repository', async () => {
  const repoId = await repositories()
  expect(await delegatedPushPolicy(db, repoId)).toBeNull()
  await service.activate(owner, { project_id: projectId, enabled: true, delegation: document({ item_kinds: ['git_push'], repository_ids: [repoId] }), channel_id: null })
  expect(await delegatedPushPolicy(db, repoId)).toEqual({ project_id: projectId, repo_id: repoId, repo_path: repo,
    policy: { canonical_remote_url: URL, default_branch: 'main', allowed_branches: ['feature/*'], remote_name: 'origin' } })
  expect(await delegatedPushPolicy(db, randomUUID())).toBeNull()
  await service.activate(owner, { project_id: projectId, enabled: true, delegation: document({ item_kinds: ['jira_worklog'], repository_ids: [repoId] }), channel_id: null })
  expect(await delegatedPushPolicy(db, repoId)).toBeNull()
  await service.activate(owner, { project_id: projectId, enabled: true, delegation: document({ item_kinds: ['git_push'], repository_ids: [repoId] }), channel_id: null })
  expect(await delegatedPushPolicy(db, repoId)).not.toBeNull()
  await service.activate(owner, { project_id: projectId, enabled: false, channel_id: null })
  expect(await delegatedPushPolicy(db, repoId)).toBeNull()
})

it('lets an agent read the state it must echo back, with the open push candidates and without any effect or code', async () => {
  const { agent, key } = await agentIn(channelId)
  const status = (over: Record<string, unknown> = {}) => callProjectAutomationTool(service, 'project_automation_status', { project_id: projectId, session_key: key, ...over }, agent)
  expect(await status()).toMatchObject({ enabled: false, delegation: null, push_candidates: [] })
  const repoId = await repositories()
  await service.activate(owner, { project_id: projectId, enabled: true, delegation: document({ item_kinds: ['git_push'], repository_ids: [repoId] }), channel_id: null })
  await propose(agent, key)
  const view = await status()
  expect(view).toMatchObject({ enabled: true, delegation: { version: 1, approval_source: 'owner_ui' }, push_candidates: [{ branch: 'feature/x', local_sha: SHA, reason: 'Corrección de hoy' }] })
  expect(view.push_candidates[0]).not.toHaveProperty('effect')
  expect((await error(status({ extra: 1 })))?.statusCode).toBeGreaterThanOrEqual(400)
})

it('lists as activated only the projects whose delegation is in force, for any item kind', async () => {
  const readers = service.attentionReaders()
  expect(await readers.activated_projects()).toEqual([])
  await service.activate(owner, { project_id: projectId, enabled: true, delegation: document(), channel_id: null })
  await service.activate(owner, { project_id: otherProject, enabled: true, delegation: document(), channel_id: null })
  const lines = await readers.activated_projects()
  expect(lines.map(line => line.project_id)).toEqual([otherProject, projectId])
  expect(lines[1]).toMatchObject({ ref: projectId, summary: 'Automatización activa en Proyecto Ñandú' })
  expect(Number.isNaN(Date.parse(lines[1]!.at))).toBe(false)
  await service.activate(owner, { project_id: otherProject, enabled: false, channel_id: null })
  expect((await readers.activated_projects()).map(line => line.project_id)).toEqual([projectId])
  await service.activate(owner, { project_id: projectId, enabled: false, channel_id: null })
  expect(await readers.activated_projects()).toEqual([])
})

it('offers only executable push candidates as lines whose effect is the canonical effect and whose kind travels apart', async () => {
  const repoId = await activatedForPush()
  const readers = service.attentionReaders()
  expect(await readers.push_candidates()).toEqual([])
  const { agent, key } = await agentIn(channelId)
  await propose(agent, key, { reason: '  Corrección\n de hoy  ' })
  remoteTip = OLD
  const [line] = await readers.push_candidates()
  expect(line).toMatchObject({ kind: 'git_push', project_id: projectId, summary: `Empujar feature/x de app (${SHA.slice(0, 7)}): Corrección de hoy` })
  expect(line!.effect).toEqual({ repo_id: repoId, repo_path: repo, canonical_remote_url: URL, ref: 'refs/heads/feature/x', local_sha: SHA, expected_remote_sha: OLD })
  expect(line!.ref).toBe((await service.pushCandidates(projectId))[0]!.candidate_id)
  for (const [mutate, restore] of [[() => { remoteTip = SHA }, () => { remoteTip = OLD }], [() => { remoteTip = undefined as unknown as string }, () => { remoteTip = OLD }], [() => { tip = OLD }, () => { tip = SHA }]] as const) {
    mutate()
    expect(await readers.push_candidates()).toEqual([])
    restore()
  }
  expect(await readers.push_candidates()).toHaveLength(1)
  await service.activate(owner, { project_id: projectId, enabled: false, channel_id: null })
  expect(await readers.push_candidates()).toEqual([])
})
