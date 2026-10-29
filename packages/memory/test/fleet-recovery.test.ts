import { expect, it, vi } from 'vitest'
import type { UsageQuotaTransition } from '@agenthub/shared'
import { FleetQuotaRecovery, QUOTA_RESUME_PROMPT, classifyQuotaFailure, type RecoveryFallback, type RecoveryIncidentLog } from '../src/fleet-recovery.js'
import type { HubTeamStatus } from '../src/team-hub.js'

const failedAt = '2026-10-28T18:38:00.000Z'
const runtime = (patch: Partial<HubTeamStatus> = {}): HubTeamStatus => ({ id: 'member-1', cli: 'codex_cli', cwd: '/work', model: 'model-a', state: 'failed', error_code: 'fleet_turn_failed',
  error_cause: 'quota_exhausted', error_evidence: 'protocol', native_id: 'thread-1', provider: 'hub', generation: 'gen-1', updated_at: failedAt, ...patch })
const pool = (status = 'available') => ({ id: 'pool-a', status }) as never
function setup(options: { members?: Array<{ id: string; runtime: HubTeamStatus; team_id?: string }>; exhausted?: { pool_key: string } | undefined; quota?: { status: string; pools: unknown[] }; claims?: boolean[]; resume?: () => Promise<unknown>; check?: { ready: boolean; kind: string; plan?: { rung?: string; reason?: string } }; fallback?: RecoveryFallback['restart'] } = {}, withNotices = false) {
  const members = options.members ?? [{ id: 'member-1', runtime: runtime() }]
  const query = vi.fn(async () => members.map(member => ({ id: member.id, team_id: member.team_id ?? 'team-1', worktree_name: `tree-${member.id}`, session_id: `session-${member.id}`, runtime: JSON.stringify(member.runtime) })))
  const exhaustedAt = vi.fn(async () => 'exhausted' in options ? options.exhausted : { pool_key: 'pool-a' })
  const forCli = vi.fn(async () => (options.quota ?? { status: 'available', pools: [pool()] }) as never)
  const resumeMember = vi.fn(options.resume ?? (async () => ({})))
  const checkResume = vi.fn(async () => options.check ?? { ready: true, kind: 'ready' })
  const queue = [...(options.claims ?? [])]
  const claim = vi.fn(async () => queue.length ? queue.shift()! : true)
  const settle = vi.fn(async () => {})
  const log: RecoveryIncidentLog = { claim, settle }
  const publishResumption = vi.fn(async () => true)
  const publishLeaderClosed = vi.fn(async () => true)
  const restart = options.fallback ? vi.fn(options.fallback) : undefined
  const fallback: RecoveryFallback | undefined = restart ? { restart } : undefined
  const recovery = new FleetQuotaRecovery({ query } as never, { exhaustedAt, forCli }, { resumeMember, checkResume }, log, withNotices ? { publishResumption, publishLeaderClosed } : undefined, fallback)
  return { recovery, exhaustedAt, forCli, resumeMember, checkResume, claim, settle, publishResumption, publishLeaderClosed, restart }
}
const transition = (patch: Partial<UsageQuotaTransition> = {}): UsageQuotaTransition => ({ id: 't', pool_key: 'pool-a', before: 'exhausted', after: 'available', observed_at: '2026-10-29T04:00:00.000Z', binding_ids: ['b'], clis: ['codex_cli'], ...patch })

it('resumes a Codex member whose protocol reported a usage limit once the same pool recovered', async () => {
  const { recovery, resumeMember, claim, settle } = setup()
  expect(await recovery.recover()).toEqual([{ member_id: 'member-1', team_id: 'team-1', worktree_name: 'tree-member-1', cli: 'codex_cli', model: 'model-a', generation: 'gen-1', result: 'resumed', reason: 'exclusive_resume', evidence: 'protocol' }])
  expect(resumeMember).toHaveBeenCalledExactlyOnceWith('member-1', { prompt: QUOTA_RESUME_PROMPT, pool_key: 'pool-a' })
  expect(claim.mock.calls.map(call => (call[0] as { cause: string }).cause)).toEqual(['quota_exhausted', 'quota_resume'])
  expect(claim.mock.calls[1]![0]).toMatchObject({ member_id: 'member-1', generation: 'gen-1', detail: { evidence: 'protocol', pool_key: 'pool-a', cli: 'codex_cli', model: 'model-a' } })
  expect(settle).toHaveBeenCalledWith(expect.objectContaining({ member_id: 'member-1', generation: 'gen-1', action: 'resumed' }))
})

it('accepts a Claude failure only when the Hub observed the pool exhausted around it', async () => {
  const claude = runtime({ cli: 'claude_code', error_code: 'fleet_turn_failed' })
  delete (claude as { error_cause?: unknown }).error_cause
  const corroborated = setup({ members: [{ id: 'member-1', runtime: claude }] })
  expect((await corroborated.recovery.recover())[0]).toMatchObject({ result: 'resumed', evidence: 'protocol+quota_observation' })
  expect(corroborated.exhaustedAt).toHaveBeenCalledWith('claude_code', 'model-a', failedAt, 120_000)
  const alone = setup({ members: [{ id: 'member-1', runtime: claude }], exhausted: undefined })
  expect(await alone.recovery.recover()).toEqual([{ member_id: 'member-1', team_id: 'team-1', worktree_name: 'tree-member-1', cli: 'claude_code', model: 'model-a', generation: 'gen-1', result: 'skipped', reason: 'generic_failure' }])
  expect(alone.resumeMember).not.toHaveBeenCalled()
  expect(alone.claim).not.toHaveBeenCalled()
})

it('keeps every other failure generic and never resumes it', async () => {
  const usage = { exhaustedAt: vi.fn(async () => ({ pool_key: 'pool-a' })) }
  for (const patch of [{ cli: 'kiro' as const, error_cause: undefined }, { error_cause: undefined }, { cli: 'claude_code' as const, error_code: 'fleet_process_exited' }, { state: 'idle' as const }]) {
    expect(await classifyQuotaFailure(runtime(patch as Partial<HubTeamStatus>), usage)).toBeUndefined()
  }
})

it('does not resume a member whose pool is not identified, is still exhausted or belongs to another pool', async () => {
  const missing = setup({ exhausted: undefined })
  expect((await missing.recovery.recover())[0]).toMatchObject({ result: 'skipped', reason: 'pool_not_identified', evidence: 'protocol' })
  const still = setup({ quota: { status: 'exhausted', pools: [pool('exhausted')] } })
  expect((await still.recovery.recover())[0]).toMatchObject({ result: 'skipped', reason: 'quota_not_recovered' })
  expect(still.claim.mock.calls.map(call => (call[0] as { cause: string }).cause)).toEqual(['quota_exhausted'])
  const other = setup({ quota: { status: 'available', pools: [{ id: 'pool-b', status: 'available' }] } })
  expect((await other.recovery.recover())[0]).toMatchObject({ result: 'skipped', reason: 'quota_not_recovered' })
  for (const item of [missing, still, other]) expect(item.resumeMember).not.toHaveBeenCalled()
})

it('makes a single attempt per member and generation', async () => {
  const { recovery, resumeMember } = setup({ claims: [true, false] })
  expect((await recovery.recover())[0]).toMatchObject({ result: 'skipped', reason: 'already_attempted' })
  expect(resumeMember).not.toHaveBeenCalled()
})

it('reports a refused resume as unsupported and any other failure as failed, without retrying', async () => {
  const plan = Object.assign(new Error('refused'), { continuity: { rung: 'linked_new', reason: 'no_fork_or_exclusive_resume' } })
  const unsupported = setup({ resume: async () => { throw plan } })
  expect((await unsupported.recovery.recover())[0]).toMatchObject({ result: 'unsupported', reason: 'no_fork_or_exclusive_resume' })
  expect(unsupported.settle).toHaveBeenCalledWith(expect.objectContaining({ action: 'resume_unsupported' }))
  const failed = setup({ resume: async () => { throw new Error('boom') } })
  expect((await failed.recovery.recover())[0]).toMatchObject({ result: 'failed', reason: 'resume_failed' })
  expect(failed.settle).toHaveBeenCalledWith(expect.objectContaining({ action: 'resume_failed' }))
  expect(failed.resumeMember).toHaveBeenCalledTimes(1)
})

it('sweeps only the CLIs whose pool left exhaustion or cooldown', async () => {
  const members = [{ id: 'codex-member', runtime: runtime() }, { id: 'claude-member', runtime: runtime({ cli: 'claude_code', error_code: 'fleet_turn_failed' }) }]
  const first = setup({ members })
  expect(await first.recovery.onTransitions([transition({ before: 'available', after: 'low' }), transition({ before: 'unknown', after: 'exhausted' })])).toEqual([])
  expect(first.resumeMember).not.toHaveBeenCalled()
  const second = setup({ members })
  const outcomes = await second.recovery.onTransitions([transition({ before: 'cooldown', after: 'low', clis: ['claude_code'] })])
  expect(outcomes.map(item => item.member_id)).toEqual(['claude-member'])
  expect(second.resumeMember).toHaveBeenCalledExactlyOnceWith('claude-member', expect.objectContaining({ pool_key: 'pool-a' }))
})

it('tells each team leader once what was attempted, never about skipped members, and survives a failing notice', async () => {
  const members = [{ id: 'a', runtime: runtime(), team_id: 'team-1' }, { id: 'b', runtime: runtime({ error_cause: undefined } as Partial<HubTeamStatus>), team_id: 'team-1' }, { id: 'c', runtime: runtime(), team_id: 'team-2' }]
  const { recovery, publishResumption } = setup({ members, resume: async () => { throw Object.assign(new Error('refused'), { continuity: { rung: 'linked_new', reason: 'no_fork_or_exclusive_resume' } }) } }, true)
  await recovery.onTransitions([transition({ id: 'restore-1' })])
  expect(publishResumption).toHaveBeenCalledTimes(2)
  const events = publishResumption.mock.calls.map(call => call[0] as { key: string; team_id: string; members: Array<{ member_id: string; result: string }> })
  expect(events.map(item => [item.team_id, item.members.map(member => [member.member_id, member.result])])).toEqual([
    ['team-1', [['a', 'unsupported']]], ['team-2', [['c', 'unsupported']]]])
  expect(events[0]!.key).toMatch(/^fleet_resumption:team-1:restore-1:[0-9a-f]{16}$/)
  const failing = setup({}, true)
  failing.publishResumption.mockRejectedValueOnce(new Error('db'))
  await expect(failing.recovery.recover()).resolves.toHaveLength(1)
})

it('keeps the single attempt when authority or the exit proof is missing, and spends it when the CLI cannot resume', async () => {
  for (const kind of ['unauthorized', 'exit_unconfirmed', 'unavailable']) {
    const waiting = setup({ check: { ready: false, kind } })
    expect((await waiting.recovery.recover())[0]).toMatchObject({ result: 'skipped', reason: kind, evidence: 'protocol' })
    expect(waiting.claim.mock.calls.map(call => (call[0] as { cause: string }).cause)).toEqual(['quota_exhausted'])
    expect(waiting.resumeMember).not.toHaveBeenCalled()
  }
  const unsupported = setup({ check: { ready: false, kind: 'unsupported', plan: { rung: 'linked_new', reason: 'resume_by_id_unverified' } } })
  expect((await unsupported.recovery.recover())[0]).toMatchObject({ result: 'unsupported', reason: 'resume_by_id_unverified' })
  expect(unsupported.claim.mock.calls.map(call => (call[0] as { cause: string }).cause)).toEqual(['quota_exhausted', 'quota_resume'])
  expect(unsupported.settle).toHaveBeenCalledWith(expect.objectContaining({ action: 'resume_unsupported' }))
  expect(unsupported.resumeMember).not.toHaveBeenCalled()
})

it('waits without spending the attempt when the leader is closed and leaves one notice per team and episode', async () => {
  const members = [{ id: 'a', runtime: runtime(), team_id: 'team-1' }, { id: 'b', runtime: runtime({ generation: 'gen-b' }), team_id: 'team-1' }, { id: 'c', runtime: runtime(), team_id: 'team-2' }]
  const { recovery, claim, resumeMember, publishLeaderClosed, publishResumption } = setup({ members, check: { ready: false, kind: 'leader_closed' } }, true)
  const outcomes = await recovery.recover()
  expect(outcomes.map(item => [item.member_id, item.result, item.reason])).toEqual([['a', 'skipped', 'leader_closed'], ['b', 'skipped', 'leader_closed'], ['c', 'skipped', 'leader_closed']])
  expect(claim.mock.calls.every(call => (call[0] as { cause: string }).cause === 'quota_exhausted')).toBe(true)
  expect(resumeMember).not.toHaveBeenCalled()
  expect(publishResumption).not.toHaveBeenCalled()
  const events = publishLeaderClosed.mock.calls.map(call => call[0] as { key: string; team_id: string; members: string[] })
  expect(events.map(item => [item.team_id, item.members])).toEqual([['team-1', ['tree-a', 'tree-b']], ['team-2', ['tree-c']]])
  const again = setup({ members, check: { ready: false, kind: 'leader_closed' } }, true)
  await again.recovery.recover()
  expect(again.publishLeaderClosed.mock.calls.map(call => (call[0] as { key: string }).key)).toEqual(events.map(item => item.key))
})

const cannotResume = { ready: false, kind: 'unsupported', plan: { rung: 'linked_new', reason: 'resume_by_id_unverified' } }

it('restarts the member in a new conversation once, and says so in the incident and in the notice, when the CLI cannot resume', async () => {
  const { recovery, restart, settle, resumeMember, publishResumption } = setup({ check: cannotResume, fallback: async () => 'restarted' }, true)
  const [outcome] = await recovery.recover()
  expect(outcome).toMatchObject({ result: 'restarted', reason: 'new_conversation', evidence: 'protocol', member_id: 'member-1', generation: 'gen-1' })
  expect(restart).toHaveBeenCalledExactlyOnceWith({ member_id: 'member-1', team_id: 'team-1', generation: 'gen-1' })
  expect(resumeMember).not.toHaveBeenCalled()
  expect(settle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'resume_unsupported', detail: expect.objectContaining({ fallback: 'restarted', reason: 'resume_by_id_unverified' }) }))
  expect(publishResumption).toHaveBeenCalledWith(expect.objectContaining({ members: [expect.objectContaining({ member_id: 'member-1', result: 'restarted', reason: 'new_conversation' })] }))
})

it('also falls back when the resume attempt itself is refused for a plan that is not an exclusive resume, but never after an ordinary failure', async () => {
  const refused = Object.assign(new Error('refused'), { continuity: { rung: 'linked_new', reason: 'no_fork_or_exclusive_resume' } })
  const viaPlan = setup({ resume: async () => { throw refused }, fallback: async () => 'restarted' })
  expect((await viaPlan.recovery.recover())[0]).toMatchObject({ result: 'restarted' })
  expect(viaPlan.resumeMember).toHaveBeenCalledTimes(1)
  const ordinary = setup({ resume: async () => { throw new Error('boom') }, fallback: async () => 'restarted' })
  expect((await ordinary.recovery.recover())[0]).toMatchObject({ result: 'failed', reason: 'resume_failed' })
  expect(ordinary.restart).not.toHaveBeenCalled()
})

it('reports a refused or failed fallback as unsupported with its own reason, and survives a fallback that throws', async () => {
  for (const [answer, reason] of [['refused', 'fallback_refused'], ['failed', 'fallback_failed']] as const) {
    const attempt = setup({ check: cannotResume, fallback: async () => answer })
    expect((await attempt.recovery.recover())[0]).toMatchObject({ result: 'unsupported', reason })
    expect(attempt.settle).toHaveBeenCalledWith(expect.objectContaining({ action: 'resume_unsupported', detail: expect.objectContaining({ fallback: answer }) }))
  }
  const throwing = setup({ check: cannotResume, fallback: async () => { throw new Error('boom') } })
  expect((await throwing.recovery.recover())[0]).toMatchObject({ result: 'unsupported', reason: 'fallback_failed' })
})

it('does not touch the fallback while the attempt is not final, or when the claim was already spent, so it runs once per member and generation', async () => {
  const waiting = setup({ check: { ready: false, kind: 'exit_unconfirmed' }, fallback: async () => 'restarted' })
  expect((await waiting.recovery.recover())[0]).toMatchObject({ result: 'skipped', reason: 'exit_unconfirmed' })
  const spent = setup({ check: cannotResume, claims: [true, false], fallback: async () => 'restarted' })
  expect((await spent.recovery.recover())[0]).toMatchObject({ result: 'skipped', reason: 'already_attempted' })
  const generic = setup({ members: [{ id: 'member-1', runtime: runtime({ error_cause: undefined as never, cli: 'kiro' }) }], check: cannotResume, fallback: async () => 'restarted' })
  expect((await generic.recovery.recover())[0]).toMatchObject({ result: 'skipped', reason: 'generic_failure' })
  for (const attempt of [waiting, spent, generic]) expect(attempt.restart).not.toHaveBeenCalled()
})
