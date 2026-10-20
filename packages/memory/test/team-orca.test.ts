import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalTeamOrca, type TeamWorkspace } from '../src/team-orca.js'

let directory: string, parent: TeamWorkspace
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hub-team-orca-'))
  parent = { id: `repo::${directory}`, repo_id: 'repo', path: directory, head: 'a'.repeat(40) }
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
const envelope = (result: unknown) => ({ stdout: JSON.stringify({ ok: true, result }) })
function raw(workspace: TeamWorkspace, extra: Record<string, unknown> = {}) {
  return { id: workspace.id, path: workspace.path, repoId: workspace.repo_id, head: workspace.head,
    hostId: 'local', identity: { executionHostId: 'local' }, isBare: false, isArchived: false, ...extra }
}

it('pins repo, parent and approved revision, skips setup and preserves opaque child ids', async () => {
  const child = { ...parent, id: 'opaque-returned-child', path: join(directory, 'child') }
  await mkdir(child.path)
  const run = vi.fn().mockResolvedValueOnce(envelope({ worktree: raw(parent) }))
    .mockResolvedValueOnce(envelope({ worktree: raw(child, { parentWorktreeId: parent.id }) }))
  const adapter = new LocalTeamOrca({ run })
  expect(await adapter.create(parent, 'search-worker')).toEqual(child)
  expect(run.mock.calls[1]![1]).toEqual(['worktree', 'create', '--repo', 'id:repo', '--name', 'search-worker',
    '--parent-worktree', `id:${parent.id}`, '--base-branch', parent.head, '--setup', 'skip', '--json'])
})

it('refuses changed base before creating a checkout', async () => {
  const run = vi.fn().mockResolvedValue(envelope({ worktree: raw({ ...parent, head: 'b'.repeat(40) }) }))
  await expect(new LocalTeamOrca({ run }).create(parent, 'worker')).rejects.toThrow('padre cambió')
  expect(run).toHaveBeenCalledTimes(1)
})

it('rejects a wrong parent in creation receipt without deleting the unexpected resource', async () => {
  const run = vi.fn().mockResolvedValueOnce(envelope({ worktree: raw(parent) }))
    .mockResolvedValueOnce(envelope({ worktree: raw({ ...parent, id: 'child', path: `${directory}/.` }, { parentWorktreeId: 'elsewhere' }) }))
  await expect(new LocalTeamOrca({ run }).create(parent, 'worker')).rejects.toThrow('hijo esperado')
  expect(run).toHaveBeenCalledTimes(2)
})

it('sends model, effort and prompt as literal arguments without permission overrides', async () => {
  const run = vi.fn().mockResolvedValueOnce(envelope({ worktree: raw(parent) }))
    .mockResolvedValueOnce(envelope({ outcome: { kind: 'terminal', handle: 'term_real' },
      prompt: { outcome: 'handed-to-terminal' }, operationId: 'op_real' }))
  const prompt = 'Search $(do-not-execute); `echo unsafe` and report.\nKeep your own identity.'
  expect(await new LocalTeamOrca({ run }).launch(parent, { cli: 'kiro', model: 'provider/model-v1', effort: 'high', prompt }))
    .toEqual({ kind: 'terminal', handle: 'term_real', prompt_outcome: 'handed-to-terminal', operation_id: 'op_real' })
  expect(run.mock.calls[1]![1]).toEqual(['agent', 'launch', '--agent', 'kiro', '--worktree', `id:${parent.id}`,
    '--model', 'provider/model-v1', '--effort', 'high', '--prompt', prompt, '--json'])
})

it('does not retry ambiguous launches and does not return sensitive stderr', async () => {
  const run = vi.fn().mockResolvedValueOnce(envelope({ worktree: raw(parent) }))
    .mockRejectedValueOnce(new Error('secret invite and credential'))
  await expect(new LocalTeamOrca({ run }).launch(parent, { cli: 'claude_code', model: 'exact-model', prompt: 'Task' }))
    .rejects.toThrow('no reintentes como una operación nueva')
  expect(run).toHaveBeenCalledTimes(2)
})

it('retains only a known operation id from a lost launch reply for manual reconciliation', async () => {
  const run = vi.fn().mockResolvedValueOnce(envelope({ worktree: raw(parent) }))
    .mockRejectedValueOnce(Object.assign(new Error('secret'), { stdout: JSON.stringify({
      operationId: 'op-recover', prompt: 'secret invitation', error: 'credential',
    }) }))
  const error = await new LocalTeamOrca({ run }).launch(parent, { cli: 'kiro', model: 'exact', prompt: 'Task' }).catch(e => e)
  expect(error).toMatchObject({ operation_id: 'op-recover' })
  expect(JSON.stringify(error)).not.toContain('secret')
  expect(run).toHaveBeenCalledTimes(2)
})

it.each(['missing', 'not-delivered'])('does not claim delivery when receipt is %s', async outcome => {
  const run = vi.fn().mockResolvedValueOnce(envelope({ worktree: raw(parent) }))
    .mockResolvedValueOnce(envelope({ outcome: { kind: 'terminal', handle: 'term_real' }, prompt: { outcome } }))
  await expect(new LocalTeamOrca({ run }).launch(parent, { cli: 'codex_cli', model: 'exact', prompt: 'Task' }))
    .rejects.toThrow('entrega inicial')
  expect(run).toHaveBeenCalledTimes(2)
})

it('rejects remote workspaces and never inherits host routing or another conversation', async () => {
  const run = vi.fn().mockResolvedValue(envelope({ worktree: raw(parent, { hostId: 'remote' }) }))
  const env = { ORCA_PAIRING_CODE: 'secret', ORCA_ENVIRONMENT: 'remote', ORCA_WORKTREE_ID: 'unrelated',
    AGENTHUB_CHAT_SESSION_KEY: 'other-session', GIT_DIR: 'wrong', PATH: '/bin' }
  await expect(new LocalTeamOrca({ run, env, platform: 'linux' }).workspace(parent.id)).rejects.toThrow('host local')
  expect(run.mock.calls[0]![0]).toBe('orca-ide')
  expect(run.mock.calls[0]![2].env).not.toHaveProperty('ORCA_PAIRING_CODE')
  expect(run.mock.calls[0]![2].env).not.toHaveProperty('AGENTHUB_CHAT_SESSION_KEY')
  expect(run.mock.calls[0]![2].env).not.toHaveProperty('GIT_DIR')
})

it('rejects a selector resolved to another worktree', async () => {
  const run = vi.fn().mockResolvedValue(envelope({ worktree: raw({ ...parent, id: 'another-id' }) }))
  await expect(new LocalTeamOrca({ run }).workspace(parent.id)).rejects.toThrow('otro worktree')
})
