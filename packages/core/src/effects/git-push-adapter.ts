import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { DelegatedPushPolicy } from '@agenthub/memory'
import { EffectRejected, type ActionAdapter, type ActionContext } from './executor.js'
import { defaultGitRunner, executePush, preparePush, reconcilePush, PushRejected, type GitRunner, type PreparedPush, type PushPolicy, type PushRequest } from './git-push.js'

/** Canonical effect of a `git_push` item. Repository and destination are identities; the limits are looked up from the delegation, never carried here. */
export interface GitPushEffect { repo_id: string; repo_path: string; canonical_remote_url: string; ref: string; local_sha: string; expected_remote_sha: string | null }

export const GIT_PUSH_SERVER = 'local:git'
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const KEYS = ['repo_id', 'repo_path', 'canonical_remote_url', 'ref', 'local_sha', 'expected_remote_sha']

function parseEffect(raw: unknown): GitPushEffect {
  const value = raw as Record<string, unknown> | null
  const text = (key: string) => typeof value?.[key] === 'string' && (value[key] as string).length > 0 && (value[key] as string).length <= 4000
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !KEYS.includes(key)) || !KEYS.every(key => key in value)
    || !text('repo_id') || !text('repo_path') || !isAbsolute(value['repo_path'] as string) || !text('canonical_remote_url') || !text('ref') || !(value['ref'] as string).startsWith('refs/heads/')
    || typeof value['local_sha'] !== 'string' || !SHA.test(value['local_sha'])
    || !(value['expected_remote_sha'] === null || (typeof value['expected_remote_sha'] === 'string' && SHA.test(value['expected_remote_sha']))))
    throw new Error('invalid git_push effect')
  return value as unknown as GitPushEffect
}

export interface GitPushAdapterOptions {
  /** The delegation in force for a repository, or null when none permits pushing it. Read at prepare and again at reconcile. */
  policy(repoId: string): Promise<DelegatedPushPolicy | null>
  git?: GitRunner
  /** Tests only: allows a bare local repository as the remote. */
  allowLocalRemote?: boolean
}

const digest = (branch: string, sha: string) => createHash('sha256').update(`${branch}\0${sha}`).digest('hex')

/**
 * `git_push` on the generic executor. The approved item names a repository, a ref and a SHA; the allowed branches, the default branch and the
 * canonical remote come from the delegation version in force, so revoking or replacing the delegation stops an already approved push.
 */
export function createGitPushAdapter(options: GitPushAdapterOptions): ActionAdapter<GitPushEffect> {
  const git = options.git ?? defaultGitRunner
  async function request(effect: GitPushEffect): Promise<{ request: PushRequest; policy: PushPolicy }> {
    const delegated = await options.policy(effect.repo_id)
    if (!delegated) throw new EffectRejected('repo_not_delegated', 'Ninguna delegación vigente permite empujar este repositorio.')
    if (delegated.repo_path !== effect.repo_path || delegated.policy.canonical_remote_url !== effect.canonical_remote_url) throw new EffectRejected('repo_mismatch', 'El ítem no coincide con el repositorio ni el destino de la delegación.')
    return {
      request: { repo_path: effect.repo_path, canonical_remote_url: effect.canonical_remote_url, ref: effect.ref, local_sha: effect.local_sha, expected_remote_sha: effect.expected_remote_sha },
      policy: { ...delegated.policy, ...(options.allowLocalRemote ? { allow_local_remote: true } : {}) },
    }
  }
  return {
    kind: 'git_push', tools: [], server: () => GIT_PUSH_SERVER, effect: { parse: parseEffect },
    async prepare(_ctx: ActionContext, effect) {
      const { request: item, policy } = await request(effect)
      try { return await preparePush(item, policy, git) } catch (error) {
        if (error instanceof PushRejected) throw new EffectRejected(error.code, error.message)
        throw new EffectRejected('prepare_failed')
      }
    },
    async execute(_ctx, prepared) {
      const outcome = await executePush(prepared as PreparedPush, git)
      const { branch } = prepared as PreparedPush
      if (outcome.state === 'pushed') return { state: 'succeeded', remote_ref: `refs/heads/${branch}`, result_digest: digest(branch, outcome.remote_sha) }
      if (outcome.state === 'rejected') return { state: 'rejected_before_dispatch', error_code: outcome.code }
      return { state: 'uncertain', error_code: 'push_uncertain' }
    },
    /** Read-only. Only a remote already at the approved SHA is evidence; a tip that still matches the expected one proves nothing about an earlier attempt. */
    async reconcile(_ctx, _intentId, effect?: GitPushEffect) {
      if (!effect) return null
      try {
        const { request: item, policy } = await request(effect)
        const outcome = await reconcilePush(item, policy, git)
        const branch = effect.ref.slice('refs/heads/'.length)
        return outcome.state === 'applied' ? { state: 'succeeded', remote_ref: effect.ref, result_digest: digest(branch, effect.local_sha) } : null
      } catch { return null }
    },
  }
}
