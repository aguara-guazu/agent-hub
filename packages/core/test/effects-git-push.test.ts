import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultGitRunner, executePush, preparePush, reconcilePush, PushRejected, type GitRunner, type PushRequest, type PushPolicy } from '../src/effects/git-push.js'

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...identity }, encoding: 'utf8' }).trim()

let root: string, remote: string, repo: string, policy: PushPolicy
const commit = (message: string, dir = repo) => { writeFileSync(join(dir, `${message}.txt`), message); git(dir, 'add', '-A'); git(dir, 'commit', '-m', message); return git(dir, 'rev-parse', 'HEAD') }
const remoteTip = (branch: string) => { try { return git(remote, 'rev-parse', '--verify', `refs/heads/${branch}`) } catch { return null } }
const item = ({ branch = 'feature/x', ...over }: Partial<PushRequest> & { branch?: string } = {}): PushRequest =>
  ({ repo_path: repo, canonical_remote_url: remote, ref: `refs/heads/${branch}`, local_sha: git(repo, 'rev-parse', 'HEAD'), expected_remote_sha: null, ...over })
const onlyPush = (fake: GitRunner): GitRunner => (args, options) => args.includes('push') ? fake(args, options) : defaultGitRunner(args, options)
const reasonOf = async (promise: Promise<unknown>) => { try { await promise } catch (error) { return error instanceof PushRejected ? error.code : 'other' } return 'none' }

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'git-push-')))
  remote = join(root, 'remote.git'); repo = join(root, 'work')
  git(root, 'init', '--bare', '-b', 'main', remote)
  git(root, 'init', '-b', 'main', repo)
  git(repo, 'remote', 'add', 'origin', remote)
  commit('base'); git(repo, 'push', 'origin', 'main')
  git(repo, 'checkout', '-b', 'feature/x')
  commit('work')
  policy = { canonical_remote_url: remote, default_branch: 'main', allowed_branches: ['feature/*', 'main'], allow_local_remote: true }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('preparePush / executePush', () => {
  it('creates a missing branch by exact SHA and leaves the other refs alone', async () => {
    const main = remoteTip('main'), sha = git(repo, 'rev-parse', 'HEAD')
    const outcome = await executePush(await preparePush(item(), policy))
    expect(outcome).toEqual({ state: 'pushed', remote_sha: sha })
    expect(remoteTip('feature/x')).toBe(sha)
    expect(remoteTip('main')).toBe(main)
  })

  it('fast-forwards an existing branch when the remote tip is the expected one', async () => {
    const first = await executePush(await preparePush(item(), policy))
    expect(first.state).toBe('pushed')
    const previous = git(repo, 'rev-parse', 'HEAD'), next = commit('more')
    const outcome = await executePush(await preparePush(item({ local_sha: next, expected_remote_sha: previous }), policy))
    expect(outcome.state).toBe('pushed')
    expect(remoteTip('feature/x')).toBe(next)
  })

  it('never pushes to the remote default branch, even when the delegation lists it', async () => {
    git(repo, 'checkout', 'main'); const sha = commit('direct')
    expect(await reasonOf(preparePush(item({ branch: 'main', local_sha: sha, expected_remote_sha: remoteTip('main') }), policy))).toBe('branch_protected')
    expect(remoteTip('main')).not.toBe(sha)
  })

  it('treats the remote HEAD as the default branch, not just a fixed list', async () => {
    const first = item()
    await executePush(await preparePush(first, policy))
    git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/feature/x')
    const next = commit('after')
    expect(await reasonOf(preparePush(item({ local_sha: next, expected_remote_sha: first.local_sha }), policy))).toBe('branch_protected')
    expect(remoteTip('feature/x')).toBe(first.local_sha)
  })

  it('protects the default branch configured for the repository even when the remote HEAD says otherwise', async () => {
    expect(await reasonOf(preparePush(item(), { ...policy, default_branch: 'feature/x' }))).toBe('branch_protected')
    expect(remoteTip('feature/x')).toBeNull()
  })

  it('rejects branches outside the delegation and empty delegations', async () => {
    expect(await reasonOf(preparePush(item(), { ...policy, allowed_branches: ['release/*'] }))).toBe('branch_not_allowed')
    expect(await reasonOf(preparePush(item(), { ...policy, allowed_branches: [] }))).toBe('branch_not_allowed')
    expect(await reasonOf(preparePush(item(), { ...policy, allowed_branches: ['feature'] }))).toBe('branch_not_allowed')
  })

  it('rejects when HEAD or the branch moved after the item was built', async () => {
    const stale = item()
    commit('later')
    expect(await reasonOf(preparePush(stale, policy))).toBe('head_mismatch')
    git(repo, 'reset', '--hard', stale.local_sha)
    git(repo, 'checkout', '-b', 'other'); commit('elsewhere')
    expect(await reasonOf(preparePush(stale, policy))).toBe('head_mismatch')
  })

  it('rejects malformed items before touching git', async () => {
    for (const bad of [item({ branch: '-delete' }), item({ branch: 'a..b' }), item({ branch: 'HEAD' }), item({ ref: 'feature/x' }), item({ ref: 'refs/tags/v1' }), item({ local_sha: 'abc' }),
      item({ repo_path: 'relative/path' }), item({ expected_remote_sha: 'z'.repeat(40) }), item({ expected_remote_sha: git(repo, 'rev-parse', 'HEAD') })])
      expect(await reasonOf(preparePush(bad, policy))).toBe('invalid_item')
  })

  it('requires the canonical repository root', async () => {
    mkdirSync(join(repo, 'sub'))
    expect(await reasonOf(preparePush(item({ repo_path: join(repo, 'sub') }), policy))).toBe('repo_not_canonical')
    symlinkSync(repo, join(root, 'link'))
    expect(await reasonOf(preparePush(item({ repo_path: join(root, 'link') }), policy))).toBe('repo_not_canonical')
    expect(await reasonOf(preparePush(item({ repo_path: join(root, 'missing') }), policy))).toBe('repo_not_canonical')
  })

  it('rejects a remote that changed since the item was built, and a non fast-forward update', async () => {
    await executePush(await preparePush(item(), policy))
    const other = join(root, 'other'); git(root, 'clone', remote, other); git(other, 'checkout', 'feature/x')
    const moved = commit('moved', other); git(other, 'push', 'origin', 'feature/x')
    expect(await reasonOf(preparePush(item({ local_sha: git(repo, 'rev-parse', 'HEAD'), expected_remote_sha: null }), policy))).toBe('remote_mismatch')
    git(repo, 'reset', '--hard', 'HEAD~1'); const rewritten = commit('rewritten')
    expect(await reasonOf(preparePush(item({ local_sha: rewritten, expected_remote_sha: moved }), policy))).toBe('not_fast_forward')
  })

  it('blocks a push when the remote moves between prepare and the push itself', async () => {
    const prepared = await preparePush(item(), policy)
    const other = join(root, 'other'); git(root, 'clone', remote, other)
    git(other, 'checkout', '-b', 'feature/x'); const raced = commit('raced', other); git(other, 'push', 'origin', 'feature/x')
    const outcome = await executePush(prepared)
    expect(outcome).toMatchObject({ state: 'rejected', code: 'remote_mismatch' })
    expect(remoteTip('feature/x')).toBe(raced)
  })

  it('lets the pre-push guard catch a remote that moves after the final revalidation', async () => {
    const prepared = await preparePush(item(), policy)
    const other = join(root, 'other'); git(root, 'clone', remote, other)
    git(other, 'checkout', '-b', 'feature/x'); const raced = commit('raced', other)
    const racing = onlyPush(async (args, options) => { git(other, 'push', 'origin', 'feature/x'); return defaultGitRunner(args, options) })
    const outcome = await executePush(prepared, racing)
    expect(outcome).toMatchObject({ state: 'rejected', code: 'remote_mismatch' })
    expect(remoteTip('feature/x')).toBe(raced)
  })

  it('revalidates at dispatch and refuses prepared values it did not build', async () => {
    const prepared = await preparePush(item(), policy)
    commit('after prepare')
    expect(await executePush(prepared)).toMatchObject({ state: 'rejected', code: 'head_mismatch' })
    expect(remoteTip('feature/x')).toBeNull()
    expect(await executePush({ ...prepared })).toMatchObject({ state: 'rejected', code: 'invalid_item' })
  })

  it('keeps its own copy of the request and policy so later mutation cannot retarget a prepared push', async () => {
    git(repo, 'branch', 'feature/y')
    const request = item(), mutablePolicy: PushPolicy = { ...policy, allowed_branches: [...policy.allowed_branches] }
    const prepared = await preparePush(request, mutablePolicy)
    request.ref = 'refs/heads/feature/y'
    mutablePolicy.allowed_branches.push('release/*')
    mutablePolicy.default_branch = 'feature/x'
    const outcome = await executePush(prepared)
    expect(outcome.state).toBe('pushed')
    expect(remoteTip('feature/x')).toBe(request.local_sha)
    expect(remoteTip('feature/y')).toBeNull()
  })

  it('serializes concurrent executions of the same repository so only one push lands', async () => {
    const first = await preparePush(item(), policy), second = await preparePush(item(), policy)
    const outcomes = await Promise.all([executePush(first), executePush(second)])
    expect(outcomes.map(outcome => outcome.state).sort()).toEqual(['pushed', 'rejected'])
  })

  it('does not follow a remote URL that was changed after the item was approved', async () => {
    const other = join(root, 'other.git'); git(root, 'init', '--bare', '-b', 'main', other)
    git(repo, 'remote', 'set-url', 'origin', other)
    expect(await reasonOf(preparePush(item(), policy))).toBe('remote_mismatch')
    expect(git(other, 'for-each-ref')).toBe('')
  })

  it('rejects URL rewrite rules in any scope so the approved destination cannot be redirected', async () => {
    const other = join(root, 'other.git'); git(root, 'init', '--bare', '-b', 'main', other)
    git(repo, 'config', `url.${other}.insteadOf`, remote)
    expect(await reasonOf(preparePush(item(), policy))).toBe('unsafe_repo_config')
    git(repo, 'config', '--unset', `url.${other}.insteadOf`)
    const home = join(root, 'home'); mkdirSync(home)
    writeFileSync(join(home, '.gitconfig'), `[url "${other}"]\n\tpushInsteadOf = ${remote}\n`)
    const previous = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'], XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'] }
    Object.assign(process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') })
    try { expect(await reasonOf(preparePush(item(), policy))).toBe('unsafe_repo_config') } finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    }
    expect(git(other, 'for-each-ref')).toBe('')
  })

  it('rejects config includes defined locally', async () => {
    writeFileSync(join(root, 'extra.config'), '[core]\n\tsshCommand = true\n')
    git(repo, 'config', 'include.path', join(root, 'extra.config'))
    expect(await reasonOf(preparePush(item(), policy))).toBe('unsafe_repo_config')
  })

  it('drops inherited GIT_* variables before talking to the remote', async () => {
    const other = join(root, 'other.git'); git(root, 'init', '--bare', '-b', 'main', other)
    const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_SSH_COMMAND', 'GIT_ASKPASS'], saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${other}.insteadOf`, GIT_CONFIG_VALUE_0: remote, GIT_SSH_COMMAND: 'false', GIT_ASKPASS: 'false' })
    let outcome
    try { outcome = await executePush(await preparePush(item(), policy)) } finally {
      for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }
    }
    expect(outcome?.state).toBe('pushed')
    expect(git(other, 'for-each-ref')).toBe('')
  })

  it('checks the URL git actually uses inside the pre-push guard', async () => {
    const prepared = await preparePush(item(), policy)
    const other = join(root, 'other.git'); git(root, 'init', '--bare', '-b', 'main', other)
    const swapped = onlyPush((args, options) => defaultGitRunner(args.map(arg => arg === prepared.url ? other : arg), options))
    expect(await executePush(prepared, swapped)).toMatchObject({ state: 'rejected', code: 'remote_mismatch' })
    expect(git(other, 'for-each-ref')).toBe('')
    expect(remoteTip('feature/x')).toBeNull()
  })

  it('refuses to dispatch on platforms where the guard is unverified', async () => {
    const prepared = await preparePush(item(), policy), original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try { expect(await executePush(prepared)).toMatchObject({ state: 'rejected', code: 'platform_unverified' }) } finally { Object.defineProperty(process, 'platform', original) }
    expect(remoteTip('feature/x')).toBeNull()
  })

  it('fails closed when git configuration cannot be inspected', async () => {
    const broken: GitRunner = (args, options) => args[0] === 'config' ? Promise.resolve({ code: 128, completed: true, stdout: '', stderr: 'fatal' }) : defaultGitRunner(args, options)
    expect(await reasonOf(preparePush(item(), policy, broken))).toBe('unsafe_repo_config')
  })

  it('does not trust remote-controlled text to classify a failed push as having sent nothing', async () => {
    const prepared = await preparePush(item(), policy)
    const spoof = onlyPush(async () => ({ code: 1, completed: true, stdout: '', stderr: 'remote: AGENTHUB_PRE_PUSH_REJECTED\nnetwork failed after dispatch' }))
    expect((await executePush(prepared, spoof)).state).toBe('uncertain')
    const remoteRejected = onlyPush(async () => ({ code: 1, completed: true, stdout: '!\trefs/heads/feature/x:refs/heads/feature/x\t[remote rejected] (hook declined)\n', stderr: '' }))
    expect((await executePush(prepared, remoteRejected)).state).toBe('uncertain')
  })

  it('ignores repository hooks and never follows tags', async () => {
    const marker = join(root, 'hook-ran')
    writeFileSync(join(repo, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    git(repo, 'tag', 'v1')
    expect((await executePush(await preparePush(item(), policy))).state).toBe('pushed')
    expect(existsSync(marker)).toBe(false)
    expect(git(remote, 'tag', '--list')).toBe('')
  })

  it('refuses ambiguous destinations and local settings that name programs', async () => {
    git(repo, 'remote', 'set-url', '--push', 'origin', join(root, 'elsewhere.git'))
    expect(await reasonOf(preparePush(item(), policy))).toBe('remote_ambiguous')
    git(repo, 'remote', 'set-url', '--push', 'origin', remote)
    git(repo, 'config', 'core.sshCommand', 'sh -c "touch /tmp/never"')
    expect(await reasonOf(preparePush(item(), policy))).toBe('unsafe_repo_config')
  })

  it('only allows local transports when the policy says so, and requires the approved URL', async () => {
    expect(await reasonOf(preparePush(item(), { ...policy, allow_local_remote: false }))).toBe('remote_not_allowed')
    expect(await reasonOf(preparePush(item({ canonical_remote_url: join(root, 'another.git') }), policy))).toBe('remote_mismatch')
    expect(await reasonOf(preparePush(item({ canonical_remote_url: remote }), policy))).toBe('none')
  })

  it('rejects embedded credentials and helper transports in the remote URL', async () => {
    for (const url of ['https://user:secret@example.invalid/r.git', 'https://token@example.invalid/r.git', 'ext::sh -c touch% /tmp/x', 'http://example.invalid/r.git', 'git://example.invalid/r.git']) {
      git(repo, 'remote', 'set-url', 'origin', url)
      expect(await reasonOf(preparePush(item(), policy))).toBe('remote_not_allowed')
    }
  })

  it('reports an unreachable remote as a rejection before any push', async () => {
    rmSync(remote, { recursive: true, force: true })
    expect(await reasonOf(preparePush(item(), policy))).toBe('remote_unreachable')
  })

  it('never reports success without git confirming it', async () => {
    const prepared = await preparePush(item(), policy)
    const silent = onlyPush(async () => ({ code: 0, completed: true, stdout: 'Done\n', stderr: '' }))
    expect((await executePush(prepared, silent)).state).toBe('uncertain')
    const timedOut = onlyPush(async () => ({ code: null, completed: false, stdout: '', stderr: '' }))
    expect((await executePush(prepared, timedOut)).state).toBe('uncertain')
    const crashed = onlyPush(async () => { throw new Error('spawn failed') })
    expect((await executePush(prepared, crashed)).state).toBe('uncertain')
    expect(remoteTip('feature/x')).toBeNull()
  })

  it('passes a plain SHA refspec without force options', async () => {
    const prepared = await preparePush(item(), policy), seen: string[][] = []
    const spy = onlyPush(async args => { seen.push(args); return { code: 1, completed: true, stdout: '', stderr: '' } })
    await executePush(prepared, spy)
    const push = seen[0]!
    expect(push).toContain(`${prepared.local_sha}:refs/heads/feature/x`)
    expect(push.some(arg => /force|^\+|mirror|--delete/.test(arg))).toBe(false)
    expect(push).toContain('--no-follow-tags')
  })
})

describe('reconcilePush', () => {
  it('distinguishes applied, not applied and diverged without pushing', async () => {
    const pending = item()
    expect(await reconcilePush(pending, policy)).toEqual({ state: 'not_applied', remote_sha: null })
    await executePush(await preparePush(pending, policy))
    expect(await reconcilePush(pending, policy)).toEqual({ state: 'applied', remote_sha: pending.local_sha })
    const other = join(root, 'other'); git(root, 'clone', remote, other); git(other, 'checkout', 'feature/x')
    const moved = commit('moved', other); git(other, 'push', 'origin', 'feature/x')
    expect(await reconcilePush(pending, policy)).toEqual({ state: 'diverged', remote_sha: moved })
    expect(remoteTip('feature/x')).toBe(moved)
  })
})
