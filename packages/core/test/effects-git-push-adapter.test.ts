import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionService, DecisionStore, type DelegatedPushPolicy } from '@agenthub/memory'
import { CoreActionExecutor, EffectRejected, type ActionContext } from '../src/effects/executor.js'
import { createGitPushAdapter, GIT_PUSH_SERVER, type GitPushEffect } from '../src/effects/git-push-adapter.js'
import { defaultGitRunner, type GitRunner } from '../src/effects/git-push.js'
import type { EffectToolResolver } from '../src/effects/tools.js'

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...identity }, encoding: 'utf8' }).trim()
const key = randomBytes(32), OWNER = 'owner-1', REPO_ID = 'repo-1'
const clock = new Date('2026-10-28T20:00:00.000Z')

let seq = 0
let root: string, remote: string, repo: string, store: DecisionStore, delegated: DelegatedPushPolicy | null, runner: GitRunner, serversRequested: string[]
const commit = (message: string) => { writeFileSync(join(repo, `${message}.txt`), message); git(repo, 'add', '-A'); git(repo, 'commit', '-m', message); return git(repo, 'rev-parse', 'HEAD') }
const remoteTip = (branch: string) => { try { return git(remote, 'rev-parse', '--verify', `refs/heads/${branch}`) } catch { return null } }
const effect = (over: Partial<GitPushEffect> = {}): GitPushEffect => ({ repo_id: REPO_ID, repo_path: repo, canonical_remote_url: remote, ref: 'refs/heads/feature/x', local_sha: git(repo, 'rev-parse', 'HEAD'), expected_remote_sha: null, ...over })
const resolver: EffectToolResolver = { candidates: () => [], forServer: serverId => { serversRequested.push(serverId); return { server_id: serverId, enabled: () => false, call: async () => { throw new Error('git_push no usa herramientas MCP') } } } }

function adapter() { return createGitPushAdapter({ policy: async () => delegated, git: runner, allowLocalRemote: true }) }
function executor() { return new CoreActionExecutor({ decisions: new DecisionService(store, async () => 'live'), adapters: [adapter()], automationsEnabled: () => true, tools: resolver }) }
async function approved(exact: unknown) {
  const prepared = store.prepareDecision({ run_id: `run-${++seq}`, artifact_id: `art-${seq}`, owner_id: OWNER, project_ids: ['p1'], expires_at: new Date(clock.getTime() + 3600_000).toISOString(),
    items: [{ kind: 'git_push', project_id: 'p1', summary: 'Empujar feature/x', exact_effect: exact }] })
  const reserved = await store.reserveDelivery({ request_id: prepared.request_id, integration: 'gmail', account: 'me@example.com', correlation: `<h${seq}@hub>`, provenance: 'test' })
  store.beginSend(reserved.delivery_id)
  await store.recordNative(reserved.delivery_id, { native_id: `n${seq}`, thread_id: `t${seq}` })
  const consumed = store.consumeReply({ integration: 'gmail', account: 'me@example.com', native_message_id: `m${seq}`, binding_id: reserved.binding_id,
    parsed: { kind: 'approve', code: store.codeFor(prepared.request_id).replace(/-/g, ''), items: 'all' } })
  if (consumed.outcome !== 'approved') throw new Error(`no aprobado: ${consumed.outcome}`)
  return consumed.approved![0]!.intent_id
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'git-push-adapter-')))
  remote = join(root, 'remote.git'); repo = join(root, 'work'); mkdirSync(repo)
  git(root, 'init', '--bare', '-b', 'main', remote)
  git(repo, 'init', '-b', 'main'); git(repo, 'remote', 'add', 'origin', remote)
  commit('base'); git(repo, 'push', 'origin', 'main')
  git(repo, 'checkout', '-b', 'feature/x'); commit('work')
  delegated = { project_id: 'p1', repo_id: REPO_ID, repo_path: repo, policy: { canonical_remote_url: remote, default_branch: 'main', allowed_branches: ['feature/*'], remote_name: 'origin' } }
  runner = defaultGitRunner; serversRequested = []
  store = new DecisionStore(':memory:', { key, now: () => clock, exclusions: { async add() {} } })
})
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }) })

describe('adaptador git_push', () => {
  it('declares no MCP tools and a fixed local server, and only parses the exact canonical effect', () => {
    const push = adapter()
    expect(push).toMatchObject({ kind: 'git_push', tools: [] })
    expect(push.server!(effect())).toBe(GIT_PUSH_SERVER)
    const ok = effect()
    expect(push.effect.parse(ok)).toEqual(ok)
    for (const bad of [{ ...ok, extra: 1 }, { ...ok, ref: 'feature/x' }, { ...ok, local_sha: 'abc' }, { ...ok, repo_path: 'relative' }, { ...ok, expected_remote_sha: 'zz' }, { ...ok, repo_id: '' }, null, [], { ...ok, expected_remote_sha: undefined }])
      expect(() => push.effect.parse(bad)).toThrow()
  })

  it('pushes the approved SHA through the generic executor with no catalog server, and records the receipt once', async () => {
    const sha = git(repo, 'rev-parse', 'HEAD'), main = remoteTip('main')
    const intentId = await approved(effect())
    const receipt = await executor().executeApprovedAction({ intent_id: intentId, expected_generation: 0 })
    expect(receipt).toMatchObject({ intent_id: intentId, state: 'succeeded', remote_ref: 'refs/heads/feature/x' })
    expect(receipt.result_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(remoteTip('feature/x')).toBe(sha)
    expect(remoteTip('main')).toBe(main)
    expect(serversRequested).toEqual([GIT_PUSH_SERVER])
    expect(store.intent(intentId)).toMatchObject({ state: 'succeeded' })
    expect(await executor().executeApprovedAction({ intent_id: intentId, expected_generation: 0 })).toMatchObject({ state: 'rejected_before_dispatch' })
    expect(git(remote, 'rev-list', '--count', 'refs/heads/feature/x')).toBe('2')
  })

  it.each([
    ['the delegation was revoked after the approval', () => { delegated = null }, 'repo_not_delegated'],
    ['the delegated repository path changed', () => { delegated!.repo_path = join(root, 'other') }, 'repo_mismatch'],
    ['the delegated remote changed', () => { delegated!.policy.canonical_remote_url = 'https://example.invalid/other.git' }, 'repo_mismatch'],
    ['the branch left the allowed list', () => { delegated!.policy.allowed_branches = ['release/*'] }, 'branch_not_allowed'],
    ['the branch is the default one', () => { delegated!.policy.allowed_branches = ['feature/*']; delegated!.policy.default_branch = 'feature/x' }, 'branch_protected'],
  ])('rejects before dispatch when %s', async (_name, change, code) => {
    const intentId = await approved(effect())
    change()
    expect(await executor().executeApprovedAction({ intent_id: intentId, expected_generation: 0 })).toMatchObject({ state: 'rejected_before_dispatch', error_code: code })
    expect(remoteTip('feature/x')).toBeNull()
  })

  it('rejects before dispatch when HEAD moved or the remote tip changed after the item was built', async () => {
    const moved = await approved(effect())
    commit('later')
    expect(await executor().executeApprovedAction({ intent_id: moved, expected_generation: 0 })).toMatchObject({ state: 'rejected_before_dispatch', error_code: 'head_mismatch' })
    const sha = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'push', 'origin', `${sha}:refs/heads/feature/x`)
    const stale = await approved(effect({ expected_remote_sha: null, local_sha: sha }))
    commit('after')
    expect(remoteTip('feature/x')).toBe(sha)
    expect(await executor().executeApprovedAction({ intent_id: stale, expected_generation: 0 })).toMatchObject({ state: 'rejected_before_dispatch' })
  })

  it('leaves the intent uncertain, never retried, when git does not confirm the push', async () => {
    runner = (args, options) => args.includes('push') ? Promise.resolve({ code: null, completed: false, stdout: '', stderr: '' }) : defaultGitRunner(args, options)
    const intentId = await approved(effect())
    const receipt = await executor().executeApprovedAction({ intent_id: intentId, expected_generation: 0 })
    expect(receipt).toMatchObject({ state: 'uncertain', error_code: 'push_uncertain' })
    expect(store.intent(intentId)).toMatchObject({ state: 'uncertain' })
    expect(await executor().executeApprovedAction({ intent_id: intentId, expected_generation: 0 })).toMatchObject({ state: 'rejected_before_dispatch' })
    expect(store.intent(intentId)).toMatchObject({ state: 'uncertain' })
  })

  it('reconciles read-only: only a remote already at the approved SHA is evidence', async () => {
    const push = adapter(), item = effect(), ctx = {} as ActionContext
    expect(await push.reconcile(ctx, 'i')).toBeNull()
    expect(await push.reconcile(ctx, 'i', item)).toBeNull()
    git(repo, 'push', 'origin', `${item.local_sha}:refs/heads/feature/x`)
    expect(await push.reconcile(ctx, 'i', item)).toMatchObject({ state: 'succeeded', remote_ref: 'refs/heads/feature/x' })
    delegated = null
    expect(await push.reconcile(ctx, 'i', item)).toBeNull()
    await expect(push.prepare(ctx, item)).rejects.toBeInstanceOf(EffectRejected)
  })
})
