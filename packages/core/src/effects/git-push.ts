import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { childEnv } from '@agenthub/gateway/platform'

/** Approved effect. `expected_remote_sha` is the remote tip observed when the item was built; null means the branch did not exist. */
export interface PushRequest { repo_path: string; canonical_remote_url: string; ref: string; local_sha: string; expected_remote_sha: string | null }
/** Limits come from the project repository and standing delegation, never from the approved item or from an agent. */
export interface PushPolicy { canonical_remote_url: string; default_branch: string; allowed_branches: string[]; remote_name?: string; protected_branches?: string[]; allow_local_remote?: boolean; timeout_ms?: number }
export type PushRejection = 'invalid_item' | 'repo_not_canonical' | 'unsafe_repo_config' | 'branch_not_allowed' | 'branch_protected' | 'head_mismatch'
  | 'platform_unverified' | 'remote_ambiguous' | 'remote_not_allowed' | 'remote_mismatch' | 'remote_unreachable' | 'default_branch_unknown' | 'not_fast_forward'
export interface PreparedPush { repo: string; remote: string; url: string; branch: string; local_sha: string; remote_sha: string | null; local_remote: boolean; timeout_ms: number }
/** `rejected`: git proved nothing was sent. `uncertain`: no proof either way; the caller must reconcile and never retry. */
export type PushOutcome = { state: 'pushed'; remote_sha: string } | { state: 'rejected'; code: PushRejection; reason: string } | { state: 'uncertain'; reason: string }
export type ReconcileOutcome = { state: 'applied' | 'not_applied' | 'diverged'; remote_sha: string | null }
export interface GitResult { code: number | null; completed: boolean; stdout: string; stderr: string }
export type GitRunner = (args: string[], options: { cwd: string; env: Record<string, string>; timeout: number }) => Promise<GitResult>

export class PushRejected extends Error {
  constructor(readonly code: PushRejection, message: string) { super(message) }
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/
const DEFAULT_TIMEOUT = 60_000
const DEFAULT_PROTECTED = ['main', 'master']
// Repo-scoped settings that name a program git would run during a push.
const EXECUTABLE_CONFIG = '^(core\\.(sshcommand|gitproxy|askpass)|credential\\..*|include(if\\..*)?\\.path|remote\\..*\\.(receivepack|uploadpack|vcs|proxy))$'
// A rewrite in any scope changes the destination after the approved URL was validated.
const REWRITE_CONFIG = '^url\\..*\\.(insteadof|pushinsteadof)$'
// Single-ref guard run by git itself with the OIDs it is about to announce, so the remote tip is compared at push time and not at an earlier read.
const PRE_PUSH = `#!/bin/sh
n=0
reject() { printf '%s' "$AGENTHUB_PUSH_NONCE" > "$AGENTHUB_PUSH_SENTINEL"; exit 1; }
[ "$2" = "$AGENTHUB_PUSH_URL" ] || reject
while read -r lref lsha rref rsha; do
  n=$((n+1))
  if [ "$lsha" != "$AGENTHUB_PUSH_LOCAL_SHA" ] || [ "$rref" != "refs/heads/$AGENTHUB_PUSH_BRANCH" ] || [ "$rsha" != "$AGENTHUB_PUSH_REMOTE_SHA" ]; then
    reject
  fi
done
[ "$n" = 1 ] || reject
`

export const defaultGitRunner: GitRunner = (args, options) => new Promise(resolve => {
  execFile('git', args, { ...options, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
    const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null
    const completed = !failure || (typeof failure.code === 'number' && !failure.killed)
    resolve({ code: !failure ? 0 : typeof failure.code === 'number' ? failure.code : null, completed, stdout: String(stdout), stderr: String(stderr) })
  })
})

// Every inherited GIT_* variable is dropped: config injection, GIT_SSH_COMMAND, GIT_ASKPASS, GIT_EXEC_PATH and tracing can all alter where or how git pushes.
const inheritedGit = () => Object.fromEntries(Object.keys(process.env).filter(key => /^GIT_/i.test(key)).map(key => [key, undefined]))

function gitEnv(allowLocal: boolean, extra: Record<string, string> = {}) {
  return childEnv({
    ...inheritedGit(), GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: allowLocal ? 'https:ssh:file' : 'https:ssh', ...extra
  })
}

function allowedBranch(branch: string, patterns: string[]) {
  return patterns.some(pattern => pattern.endsWith('/*') ? branch.startsWith(pattern.slice(0, -1)) && branch.length > pattern.length - 1 : pattern === branch)
}

/** Accepts https, ssh and (only when the policy allows it) local paths. No credentials in the URL, no helper-driven transports. */
function remoteKind(url: string, allowLocal: boolean): 'network' | 'local' | null {
  if (!url || url.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(url)) return null
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)\S+$/.test(url)) return 'network'
  if (allowLocal && (isAbsolute(url) || url.startsWith('file:///'))) return 'local'
  try {
    const parsed = new URL(url)
    if (!parsed.hostname || parsed.password) return null
    return parsed.protocol === 'ssh:' || (parsed.protocol === 'https:' && !parsed.username) ? 'network' : null
  } catch { return null }
}

/** Returns the branch name of an approved `refs/heads/<branch>` ref. */
function validate(item: PushRequest, policy: PushPolicy): string {
  const reject = (message: string) => { throw new PushRejected('invalid_item', message) }
  if (!item || typeof item.repo_path !== 'string' || !isAbsolute(item.repo_path) || item.repo_path.includes('\0')) reject('El repositorio debe indicarse con una ruta absoluta.')
  const branch = typeof item.ref === 'string' && item.ref.startsWith('refs/heads/') ? item.ref.slice('refs/heads/'.length) : ''
  if (!BRANCH.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock') || branch === 'HEAD') reject('La ref debe ser refs/heads/<rama> con un nombre válido.')
  if (typeof item.canonical_remote_url !== 'string' || !item.canonical_remote_url) reject('Falta el destino remoto aprobado.')
  if (typeof item.local_sha !== 'string' || !SHA.test(item.local_sha)) reject('local_sha debe ser un hash completo en minúsculas.')
  if (item.expected_remote_sha !== null && (typeof item.expected_remote_sha !== 'string' || !SHA.test(item.expected_remote_sha) || item.expected_remote_sha.length !== item.local_sha.length)) reject('expected_remote_sha debe ser un hash completo o null.')
  if (item.expected_remote_sha === item.local_sha) reject('El remoto ya está en local_sha; no hay nada que empujar.')
  if (!policy.allowed_branches?.length) throw new PushRejected('branch_not_allowed', 'La delegación no habilita ramas para push.')
  if (typeof policy.canonical_remote_url !== 'string' || !policy.canonical_remote_url) reject('La delegación no fija el destino remoto aprobado.')
  if (typeof policy.default_branch !== 'string' || !BRANCH.test(policy.default_branch)) reject('La rama principal del repositorio no está configurada.')
  if (policy.remote_name !== undefined && !REMOTE_NAME.test(policy.remote_name)) reject('Nombre de remoto inválido.')
  return branch
}

async function resolveRemote(item: PushRequest, policy: PushPolicy, repo: string, git: GitRunner) {
  const timeout = policy.timeout_ms ?? DEFAULT_TIMEOUT, env = gitEnv(Boolean(policy.allow_local_remote)), remote = policy.remote_name ?? 'origin'
  const urls = async (push: boolean) => {
    const result = await git(['remote', 'get-url', ...(push ? ['--push'] : []), '--all', remote], { cwd: repo, env, timeout })
    return result.code === 0 ? result.stdout.split('\n').map(line => line.trim()).filter(Boolean) : []
  }
  const [fetch, push] = [await urls(false), await urls(true)]
  // A second push destination (pushurl or several URLs) would send the objects somewhere that was not approved.
  if (fetch.length !== 1 || push.length !== 1 || fetch[0] !== push[0]) throw new PushRejected('remote_ambiguous', 'El remoto no tiene un único destino de push verificable.')
  const url = push[0]!, kind = remoteKind(url, Boolean(policy.allow_local_remote))
  if (!kind) throw new PushRejected('remote_not_allowed', 'El destino del remoto no es un transporte permitido.')
  if (item.canonical_remote_url !== url || policy.canonical_remote_url !== url) throw new PushRejected('remote_mismatch', 'El remoto no coincide con el destino aprobado.')
  return { remote, url, local_remote: kind === 'local', env, timeout }
}

async function readRemote(url: string, branch: string, repo: string, env: Record<string, string>, timeout: number, git: GitRunner) {
  const result = await git(['ls-remote', '--symref', url, 'HEAD', `refs/heads/${branch}`], { cwd: repo, env, timeout })
  if (result.code !== 0 || !result.completed) throw new PushRejected('remote_unreachable', 'No se pudo consultar el remoto.')
  let tip: string | null = null, defaultBranch: string | null = null
  for (const line of result.stdout.split('\n')) {
    const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line)
    if (symref) defaultBranch = symref[1]!
    const head = /^([0-9a-f]{40,64})\trefs\/heads\/(\S+)$/.exec(line)
    if (head && head[2] === branch) tip = head[1]!
  }
  return { tip, defaultBranch }
}

// Only values built by preparePush can be executed; the request and policy they came from are re-checked at dispatch.
const contexts = new WeakMap<PreparedPush, { request: PushRequest; policy: PushPolicy }>()
const locks = new Map<string, Promise<unknown>>()
function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const current = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(work)
  locks.set(key, current)
  void current.finally(() => { if (locks.get(key) === current) locks.delete(key) }).catch(() => undefined)
  return current
}

// The caller's objects are never kept: later mutation of the request or the policy must not change what a prepared push is allowed to do.
const snapshotRequest = (request: PushRequest): PushRequest => Object.freeze({ ...request })
const snapshotPolicy = (policy: PushPolicy): PushPolicy => Object.freeze({
  ...policy, allowed_branches: Object.freeze([...(policy.allowed_branches ?? [])]) as string[],
  ...(policy.protected_branches ? { protected_branches: Object.freeze([...policy.protected_branches]) as string[] } : {})
})

/** Read-only guards. Every rejection here happens before any object leaves the machine. */
export async function preparePush(request: PushRequest, rawPolicy: PushPolicy, git: GitRunner = defaultGitRunner): Promise<PreparedPush> {
  const item = snapshotRequest(request), policy = snapshotPolicy(rawPolicy)
  const branch = validate(item, policy)
  const timeout = policy.timeout_ms ?? DEFAULT_TIMEOUT, probe = { cwd: '/', env: gitEnv(false), timeout }
  const repo = await realpath(item.repo_path).catch(() => null)
  if (!repo) throw new PushRejected('repo_not_canonical', 'El repositorio no existe en esta computadora.')
  const top = await git(['rev-parse', '--show-toplevel'], { ...probe, cwd: repo })
  const root = top.code === 0 ? await realpath(top.stdout.trim()).catch(() => null) : null
  if (root !== repo || item.repo_path !== repo) throw new PushRejected('repo_not_canonical', 'repo_path debe ser la raíz canónica del repositorio.')
  const query = async (pattern: string) => {
    const result = await git(['config', '--show-scope', '--get-regexp', pattern], { cwd: repo, env: gitEnv(false), timeout })
    // Exit 1 is "no match"; anything else means the configuration could not be inspected.
    if (!result.completed || (result.code !== 0 && result.code !== 1)) throw new PushRejected('unsafe_repo_config', 'No se pudo inspeccionar la configuración de git.')
    return result.code === 0 ? result.stdout.split('\n').filter(Boolean) : []
  }
  if ((await query(EXECUTABLE_CONFIG)).some(line => /^(local|worktree|command)\t/.test(line))) throw new PushRejected('unsafe_repo_config', 'La configuración del repositorio define programas que git ejecutaría durante el push.')
  if ((await query(REWRITE_CONFIG)).length) throw new PushRejected('unsafe_repo_config', 'La configuración de git reescribe URLs y podría redirigir el destino aprobado.')
  const resolve = async (name: string) => {
    const result = await git(['rev-parse', '--verify', '--quiet', `${name}^{commit}`], { cwd: repo, env: gitEnv(false), timeout })
    return result.code === 0 ? result.stdout.trim() : null
  }
  if (await resolve('HEAD') !== item.local_sha || await resolve(`refs/heads/${branch}`) !== item.local_sha) throw new PushRejected('head_mismatch', 'HEAD o la rama local ya no apuntan a local_sha.')
  if (!allowedBranch(branch, policy.allowed_branches)) throw new PushRejected('branch_not_allowed', 'La rama no está en la lista de la delegación.')
  const target = await resolveRemote(item, policy, repo, git)
  const { tip, defaultBranch } = await readRemote(target.url, branch, repo, target.env, target.timeout, git)
  if (!defaultBranch) throw new PushRejected('default_branch_unknown', 'No se pudo determinar la rama principal del remoto.')
  if (branch === defaultBranch || [policy.default_branch, ...(policy.protected_branches ?? DEFAULT_PROTECTED)].includes(branch)) throw new PushRejected('branch_protected', 'No se empuja a la rama principal.')
  if (tip !== item.expected_remote_sha) throw new PushRejected('remote_mismatch', 'El remoto cambió desde que se armó el ítem.')
  if (tip) {
    const ancestor = await git(['merge-base', '--is-ancestor', tip, item.local_sha], { cwd: repo, env: gitEnv(false), timeout })
    if (ancestor.code !== 0) throw new PushRejected('not_fast_forward', 'El push no sería un avance directo del remoto.')
  }
  const prepared: PreparedPush = Object.freeze({ repo, remote: target.remote, url: target.url, branch, local_sha: item.local_sha, remote_sha: tip, local_remote: target.local_remote, timeout_ms: timeout })
  contexts.set(prepared, { request: item, policy })
  return prepared
}

/**
 * Pushes `<sha>:refs/heads/<branch>` to the resolved URL without force. Every guard runs again under a per-repository lock
 * immediately before dispatch. Repo hooks are replaced by the single-ref guard. `rejected` is returned only with local proof
 * that nothing was sent: a failed guard, the guard's private nonce file, or git's own client-side `[rejected]` status.
 */
export async function executePush(prepared: PreparedPush, git: GitRunner = defaultGitRunner): Promise<PushOutcome> {
  if (process.platform === 'win32') return { state: 'rejected', code: 'platform_unverified', reason: 'El guard de push no está verificado en Windows.' }
  const context = contexts.get(prepared)
  if (!context) return { state: 'rejected', code: 'invalid_item', reason: 'El push no proviene de una preparación verificada.' }
  return exclusive(prepared.repo, async () => {
    let fresh: PreparedPush
    try { fresh = await preparePush(context.request, context.policy, git) } catch (error) {
      if (error instanceof PushRejected) return { state: 'rejected', code: error.code, reason: error.message } as PushOutcome
      return { state: 'rejected', code: 'remote_unreachable', reason: 'No se pudo revalidar el push antes de enviarlo.' } as PushOutcome
    }
    const changed = (Object.keys(prepared) as Array<keyof PreparedPush>).some(key => fresh[key] !== prepared[key])
    if (changed)
      return { state: 'rejected', code: 'remote_mismatch', reason: 'El destino cambió entre la preparación y el envío.' }
    const hooks = await mkdtemp(join(tmpdir(), 'agenthub-push-'))
    const sentinel = join(hooks, 'rejected'), nonce = randomBytes(16).toString('hex')
    try {
      await writeFile(join(hooks, 'pre-push'), PRE_PUSH, { mode: 0o700 })
      const env = gitEnv(fresh.local_remote, {
        AGENTHUB_PUSH_LOCAL_SHA: fresh.local_sha, AGENTHUB_PUSH_BRANCH: fresh.branch, AGENTHUB_PUSH_SENTINEL: sentinel, AGENTHUB_PUSH_NONCE: nonce, AGENTHUB_PUSH_URL: fresh.url,
        AGENTHUB_PUSH_REMOTE_SHA: fresh.remote_sha ?? '0'.repeat(fresh.local_sha.length)
      })
      const result = await git(['-c', `core.hooksPath=${hooks}`, '-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no',
        'push', '--porcelain', '--no-follow-tags', '--no-recurse-submodules', fresh.url, `${fresh.local_sha}:refs/heads/${fresh.branch}`],
      { cwd: fresh.repo, env, timeout: fresh.timeout_ms })
      const lines = result.stdout.split('\n')
      if (result.completed && result.code === 0 && lines.some(line => /^[ *]\t/.test(line))) return { state: 'pushed', remote_sha: fresh.local_sha }
      if (result.completed && await readFile(sentinel, 'utf8').then(text => text === nonce, () => false)) return { state: 'rejected', code: 'remote_mismatch', reason: 'El remoto cambió antes del anuncio del push.' }
      if (result.completed && lines.some(line => /^!\t.*\[rejected\]/.test(line))) return { state: 'rejected', code: 'not_fast_forward', reason: 'git rechazó la actualización de la rama.' }
      return { state: 'uncertain', reason: 'git no confirmó el resultado del push.' }
    } catch { return { state: 'uncertain', reason: 'No se pudo completar o verificar el push.' } }
    finally { await rm(hooks, { recursive: true, force: true }).catch(() => undefined) }
  })
}

/** Read-only check used after an uncertain result. Never pushes. `not_applied` only says the tip is the expected one now; it does not prove an earlier push never happened. */
export async function reconcilePush(request: PushRequest, rawPolicy: PushPolicy, git: GitRunner = defaultGitRunner): Promise<ReconcileOutcome> {
  const item = snapshotRequest(request), policy = snapshotPolicy(rawPolicy)
  const branch = validate(item, policy)
  const repo = await realpath(item.repo_path).catch(() => null)
  if (!repo || repo !== item.repo_path) throw new PushRejected('repo_not_canonical', 'repo_path debe ser la raíz canónica del repositorio.')
  const target = await resolveRemote(item, policy, repo, git)
  const { tip } = await readRemote(target.url, branch, repo, target.env, target.timeout, git)
  return { state: tip === item.local_sha ? 'applied' : tip === item.expected_remote_sha ? 'not_applied' : 'diverged', remote_sha: tip }
}
