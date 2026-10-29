import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dailyTemplates, DecisionService, DecisionStore, delegatedPushPolicy, MemoryDatabase, MemoryStore, ProjectAutomationService } from '@agenthub/memory'
import { CoreActionExecutor } from '../src/effects/executor.js'
import { createGitPushAdapter, type GitPushEffect } from '../src/effects/git-push-adapter.js'
import type { EffectToolResolver } from '../src/effects/tools.js'

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...identity }, encoding: 'utf8' }).trim()
// The service probe only allows https and ssh; the bare remote of the test is a local path, so its probe is real git with the file protocol enabled.
const probe = async (args: string[], cwd: string) => {
  try { return { code: 0, stdout: execFileSync('git', args, { cwd, env: { ...process.env, ...identity, GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8' }) } }
  catch (error) { const status = (error as { status?: unknown }).status; return { code: typeof status === 'number' ? status : null, stdout: '' } }
}
const OWNER = 'owner-1', KEY = randomBytes(32), clock = new Date('2026-10-29T20:00:00.000Z')
const resolver: EffectToolResolver = { candidates: () => [], forServer: serverId => ({ server_id: serverId, enabled: () => false, call: async () => { throw new Error('git_push no usa herramientas MCP') } }) }
const teams = { closeDerivedForProject: vi.fn(async () => ({ closed: [] as string[], failed: [] as string[] })), ensureProjectLeader: vi.fn(async () => 'system:x'), retireProjectLeader: vi.fn(async () => undefined) }
const delegation = (repoId: string) => ({ schema_version: 1 as const, roster: { coordinator: { cli: 'claude_code', model: 'm', effort: 'high' }, project_agent: { cli: 'claude_code', model: 'm' } },
  item_kinds: ['git_push' as const], repository_ids: [repoId], limits: { max_concurrent_plans: 1, max_runtime_minutes: 30 } })
const context = { run_id: 'run-close', schedule_id: 'sch-close', generation: 0, scheduled_for: clock.toISOString(), scope: 'owner', project_id: null, template: 'daily_close', template_version: 1, title: 'Cierre del día',
  params: {}, instructions: '', covered_since: null, trigger: 'schedule', deferred_until: null, extend_from: null, signal: new AbortController().signal } as never

let root: string, remote: string, repo: string, db: MemoryDatabase, decisions: DecisionStore, service: ProjectAutomationService, projectId: string, repoId: string, sha: string
const commit = (message: string) => { writeFileSync(join(repo, `${message}.txt`), message); git(repo, 'add', '-A'); git(repo, 'commit', '-m', message); return git(repo, 'rev-parse', 'HEAD') }
const remoteTip = (branch: string) => { try { return git(remote, 'rev-parse', '--verify', `refs/heads/${branch}`) } catch { return null } }

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'git-push-close-')))
  remote = join(root, 'remote.git'); repo = join(root, 'work'); mkdirSync(repo)
  git(root, 'init', '--bare', '-b', 'main', remote)
  git(repo, 'init', '-b', 'main'); git(repo, 'remote', 'add', 'origin', remote)
  commit('base'); git(repo, 'push', 'origin', 'main')
  git(repo, 'checkout', '-b', 'feature/x'); sha = commit('work')
  db = new MemoryDatabase(join(root, 'memory.sqlite')); await db.migrate()
  projectId = randomUUID(); repoId = randomUUID()
  await db.query("INSERT INTO entities(id,kind,title) VALUES($1,'project','Proyecto Ñandú')", [projectId])
  // The activation route only registers https or ssh remotes; the repository is seeded with the local bare remote and everything after it is the real path.
  await db.query("INSERT INTO project_repositories(id,project_id,repo_path,canonical_remote_url,remote_name,default_branch,allowed_branches) VALUES($1,$2,$3,$4,'origin','main',$5)", [repoId, projectId, repo, remote, JSON.stringify(['feature/*'])])
  service = new ProjectAutomationService({ db, chat: { identity: async () => undefined } as never, teams: () => teams, schedules: () => undefined, git: probe })
  await service.activate({ kind: 'human', ref: 'owner' }, { project_id: projectId, enabled: true, delegation: delegation(repoId), channel_id: null })
  decisions = new DecisionStore(':memory:', { key: KEY, now: () => clock, exclusions: { async add() {} } })
})
afterEach(async () => { decisions.close(); await db.close(); rmSync(root, { recursive: true, force: true }) })

it('carries a recorded push candidate through the close, the approval and the executor without an invalid effect', async () => {
  const agent = { agent_id: 'client', session_id: `native:${randomUUID()}`, cli_kind: 'claude_code', client: 'Claude', cwd: root }
  expect(await service.proposePush({ agent, session_key: randomUUID() }, { project_id: projectId, repo_path: repo, branch: 'feature/x', local_sha: sha, reason: 'Corrección de hoy' })).toMatchObject({ state: 'open', repeated: false })

  const template = dailyTemplates.find(entry => entry.id === 'daily_close')!
  const deps = { store: new MemoryStore(db, root), now: () => clock, attention: service.attentionReaders(), statusProjects: async () => [projectId] }
  const draft = template.render(context, await template.collect(context, deps), null)
  const pushes = draft.items.filter(item => item.kind === 'git_push')
  expect(pushes).toHaveLength(1)
  expect(pushes[0]).toMatchObject({ project_id: projectId, operation_key: `git_push:${repoId}:refs/heads/feature/x:${sha}` })
  const exact = draft.proposed_effects!.find(entry => entry.ordinal === pushes[0]!.ordinal)!.effect as GitPushEffect
  expect(exact).toEqual({ repo_id: repoId, repo_path: repo, canonical_remote_url: remote, ref: 'refs/heads/feature/x', local_sha: sha, expected_remote_sha: null })

  const prepared = decisions.prepareDecision({ run_id: 'run-close', artifact_id: 'art-close', owner_id: OWNER, project_ids: [projectId], expires_at: new Date(clock.getTime() + 3600_000).toISOString(),
    items: [{ kind: 'git_push', project_id: projectId, summary: pushes[0]!.summary, exact_effect: exact, operation_key: pushes[0]!.operation_key! }] })
  const reserved = await decisions.reserveDelivery({ request_id: prepared.request_id, integration: 'gmail', account: 'me@example.com', correlation: '<close@hub>', provenance: 'test' })
  decisions.beginSend(reserved.delivery_id)
  await decisions.recordNative(reserved.delivery_id, { native_id: 'n1', thread_id: 't1' })
  const consumed = decisions.consumeReply({ integration: 'gmail', account: 'me@example.com', native_message_id: 'm1', binding_id: reserved.binding_id,
    parsed: { kind: 'approve', code: decisions.codeFor(prepared.request_id).replace(/-/g, ''), items: 'all' } })
  expect(consumed.outcome).toBe('approved')

  const executor = new CoreActionExecutor({ decisions: new DecisionService(decisions, async () => 'live'), adapters: [createGitPushAdapter({ policy: id => delegatedPushPolicy(db, id), allowLocalRemote: true })],
    automationsEnabled: () => true, tools: resolver })
  const receipt = await executor.executeApprovedAction({ intent_id: consumed.approved![0]!.intent_id, expected_generation: 0 })
  expect(receipt).toMatchObject({ state: 'succeeded', remote_ref: 'refs/heads/feature/x' })
  expect(remoteTip('feature/x')).toBe(sha)
  expect(remoteTip('main')).toBe(git(repo, 'rev-parse', 'main'))
})
