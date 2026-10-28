import { afterEach, expect, it } from 'vitest'
import { RESUME_CATALOG, effectiveCapability, helpFlags, parseCliVersion, restorableNativeId, resumeSurface } from '../src/resume-capabilities.js'
import { planResume, type ResumeOrigin, type ResumeTarget } from '../src/resume-ladder.js'

const claudeFlags = { version: '2.1.300', flags: ['--print', '--resume', '--fork-session', '--session-id'] }
const origin = (patch: Partial<ResumeOrigin> = {}): ResumeOrigin => ({ native_id: '3f9d2b6a-1c64-4b0e-8a77-0d5f2f6c9e11', cli: 'claude_code', surface: 'interactive',
  cwd: '/work/repo', live: false, id_authentic: true, ...patch })
const target = (patch: Partial<ResumeTarget> = {}): ResumeTarget => ({ cli: 'claude_code', surface: 'fleet', cwd: '/work/repo', headless: true,
  profile: { restricted: true, verified: true }, ...patch })
const surface = (cli: string, name: string) => resumeSurface(cli, name)!
const restore: Array<() => void> = []
afterEach(() => { while (restore.length) restore.pop()!() })
const patchCapability = (cli: string, name: string, capability: keyof ReturnType<typeof surface>['capabilities'], status: 'supported' | 'unsupported' | 'unverified') => {
  const record = surface(cli, name).capabilities[capability], previous = record.status
  record.status = status
  restore.push(() => { record.status = previous })
}

it('uses the live creator chat as the destination before anything else', () => {
  const plan = planResume(origin({ live: true }), target(), claudeFlags)
  expect(plan).toMatchObject({ rung: 'live_destination', reason: 'creator_chat_live' })
})

it('blocks instead of launching when the restricted profile cannot be verified', () => {
  expect(planResume(origin(), target({ profile: { restricted: true, verified: false } }), claudeFlags)).toMatchObject({ rung: 'blocked_unsupported', reason: 'profile_unverifiable' })
  expect(planResume(origin({ live: true }), target({ profile: { restricted: true, verified: false } }), claudeFlags).rung).toBe('live_destination')
})

it('forks a Claude conversation only when the installed binary confirms the flags', () => {
  expect(planResume(origin(), target(), claudeFlags)).toMatchObject({ rung: 'fork', reason: 'fork_headless', native_id: origin().native_id, headless: true })
  const uninspected = planResume(origin(), target())
  expect(uninspected).toMatchObject({ rung: 'linked_new', reason: 'no_fork_or_exclusive_resume' })
  expect(uninspected.downgrades).toContain('fork_headless_unverified')
  const old = planResume(origin(), target(), { version: '1.0.0', flags: ['--print', '--resume'] })
  expect(old.rung).toBe('linked_new')
  expect(old.downgrades).toContain('fork_headless_unsupported')
})

it('forks a Codex thread through the app-server without installed flags', () => {
  const plan = planResume(origin({ cli: 'codex_cli', native_id: 'thread-1' }), target({ cli: 'codex_cli' }))
  expect(plan).toMatchObject({ rung: 'fork', native_id: 'thread-1' })
})

it('never restores from transport identifiers, last-session markers or inferred IDs', () => {
  for (const native_id of ['tui:3f9d2b6a-1c64-4b0e-8a77-0d5f2f6c9e11', 'last', 'LATEST', '', 'two words', null]) {
    expect(planResume(origin({ native_id }), target(), claudeFlags)).toMatchObject({ rung: 'linked_new', reason: 'no_authentic_id' })
  }
  expect(planResume(origin({ id_authentic: false }), target(), claudeFlags)).toMatchObject({ rung: 'linked_new', reason: 'no_authentic_id' })
})

it('does not mix ID namespaces, directories, projects or accounts', () => {
  expect(planResume(origin({ cli: 'kiro', surface: 'fleet' }), target(), claudeFlags).reason).toBe('id_namespace_mismatch')
  expect(planResume(origin({ cwd: '/work/other' }), target(), claudeFlags).reason).toBe('cwd_incompatible')
  expect(planResume(origin({ cwd: null }), target(), claudeFlags).reason).toBe('cwd_incompatible')
  expect(planResume(origin({ project_id: 'a' }), target({ project_id: 'b' }), claudeFlags).reason).toBe('project_mismatch')
  expect(planResume(origin({ account: 'a' }), target({ account: 'b' }), claudeFlags).reason).toBe('account_mismatch')
  expect(planResume(origin({ project_id: 'a' }), target({ project_id: 'a' }), claudeFlags).rung).toBe('fork')
})

it('does not turn a documented resume into an exclusive one: every CLI starts without a verified lock', () => {
  for (const item of RESUME_CATALOG) expect(item.capabilities.exclusive_resume.status).not.toBe('supported')
  const plan = planResume(origin({ cli: 'kiro', surface: 'fleet', native_id: 'kiro-session' }), target({ cli: 'kiro' }))
  expect(plan.rung).toBe('linked_new')
  expect(plan.downgrades).toEqual(expect.arrayContaining(['fork_headless_unverified', 'resume_by_id_unverified', 'exclusive_resume_unverified']))
})

it('resumes only with an adapter lock and never when the origin looks active', () => {
  patchCapability('opencode', 'interactive', 'exclusive_resume', 'supported')
  patchCapability('opencode', 'interactive', 'fork_headless', 'unsupported')
  const flags = { flags: ['--session', '--fork'] }
  const base = origin({ cli: 'opencode', surface: 'interactive', native_id: 'ses_1' }), run = target({ cli: 'opencode', surface: 'interactive' })
  expect(planResume(base, run, flags)).toMatchObject({ rung: 'exclusive_resume', reason: 'adapter_exclusive_resume', native_id: 'ses_1' })
  const busy = planResume(base, run, flags, { process_alive: true, lease_active: false, watch_active: null })
  expect(busy.rung).toBe('linked_new')
  expect(busy.downgrades).toContain('origin_possibly_active')
  expect(busy.evidence).toEqual(expect.arrayContaining(['process_alive=true', 'lease_active=false']))
  expect(busy.evidence.some(item => item.startsWith('watch_active'))).toBe(false)
})

it('treats a dead process and an expired lease as evidence, not as exclusion', () => {
  const plan = planResume(origin({ cli: 'opencode', surface: 'interactive', native_id: 'ses_1' }), target({ cli: 'opencode', surface: 'interactive' }), { flags: ['--session'] },
    { process_alive: false, lease_active: false, watch_active: false })
  expect(plan.rung).not.toBe('exclusive_resume')
})

it('is deterministic for identical inputs', () => {
  expect(planResume(origin(), target(), claudeFlags)).toEqual(planResume(origin(), target(), claudeFlags))
})

it('keeps a documented capability unverified until its flags are confirmed', () => {
  const record = surface('claude_code', 'fleet').capabilities.fork_headless
  expect(effectiveCapability(record)).toBe('unverified')
  expect(effectiveCapability(record, { flags: ['--resume'] })).toBe('unsupported')
  expect(effectiveCapability(record, claudeFlags)).toBe('supported')
  expect(effectiveCapability(undefined)).toBe('unverified')
  expect(effectiveCapability(surface('claude_desktop', 'code_tab').capabilities.headless_resume)).toBe('unsupported')
})

it('records an official source and a verification date for every documented capability', () => {
  for (const item of RESUME_CATALOG) for (const [name, record] of Object.entries(item.capabilities)) {
    expect(record.checked_at, `${item.cli}/${item.surface}/${name}`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    if (record.status === 'supported' || record.status === 'unsupported') expect(record.source, `${item.cli}/${item.surface}/${name}`).toMatch(/^https:\/\//)
  }
})

it('extracts versions and flags without trusting arbitrary output', () => {
  expect(parseCliVersion('2.1.300 (Claude Code)')).toBe('2.1.300')
  expect(parseCliVersion('codex-cli 0.9.1-beta.2')).toBe('0.9.1-beta.2')
  expect(parseCliVersion('no version here')).toBeUndefined()
  const help = '  --resume, -r  Resume\n  --resume-picker  x\n  [--fork-session]\n  --print'
  expect(helpFlags(help, ['--resume', '--fork-session', '--session-id', '--print', '--resume'])).toEqual(['--resume', '--fork-session', '--print'])
})

it('accepts only restorable native IDs', () => {
  expect(restorableNativeId('3f9d2b6a-1c64-4b0e-8a77-0d5f2f6c9e11')).toBe(true)
  for (const id of ['tui:abc', 'last', '', 'a b', 'a\nb', 42, undefined, 'x'.repeat(301)]) expect(restorableNativeId(id)).toBe(false)
})
