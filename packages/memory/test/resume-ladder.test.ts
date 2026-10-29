import { afterEach, expect, it } from 'vitest'
import { RESUME_CATALOG, compareVersions, effectiveCapability, helpCommands, helpFlags, parseCliVersion, restorableNativeId, resumeSurface, schemaMethods } from '../src/resume-capabilities.js'
import { planResume, type ResumeOrigin, type ResumeTarget } from '../src/resume-ladder.js'

const codexSchema = { version: '0.9.1', commands: ['thread/fork', 'thread/resume'] }
const origin = (patch: Partial<ResumeOrigin> = {}): ResumeOrigin => ({ native_id: 'thread-1', cli: 'codex_cli', surface: 'interactive',
  cwd: '/work/repo', live: false, id_authentic: true, project_id: null, account: 'account-a', ...patch })
const target = (patch: Partial<ResumeTarget> = {}): ResumeTarget => ({ cli: 'codex_cli', surface: 'fleet', cwd: '/work/repo', headless: true,
  profile: { restricted: true, verified: true }, project_id: null, account: 'account-a', ...patch })
const surface = (cli: string, name: string) => resumeSurface(cli, name)!
const restore: Array<() => void> = []
afterEach(() => { while (restore.length) restore.pop()!() })
const patchCapability = (cli: string, name: string, capability: keyof ReturnType<typeof surface>['capabilities'], patch: { status?: 'supported' | 'unsupported' | 'unverified'; commands?: string[] }) => {
  const record = surface(cli, name).capabilities[capability], previous = { status: record.status, commands: record.commands }
  if (patch.status) record.status = patch.status
  if (patch.commands) record.commands = patch.commands
  restore.push(() => { record.status = previous.status; if (previous.commands) record.commands = previous.commands; else delete record.commands })
}

it('uses the live creator chat as the destination before anything else', () => {
  expect(planResume(origin({ live: true }), target(), codexSchema)).toMatchObject({ rung: 'live_destination', reason: 'creator_chat_live' })
})

it('blocks instead of launching when the restricted profile cannot be verified', () => {
  expect(planResume(origin(), target({ profile: { restricted: true, verified: false } }), codexSchema)).toMatchObject({ rung: 'blocked_unsupported', reason: 'profile_unverifiable' })
  expect(planResume(origin({ live: true }), target({ profile: { restricted: true, verified: false } }), codexSchema).rung).toBe('live_destination')
})

it('forks a Codex thread only when the installed schema confirms the method', () => {
  expect(planResume(origin(), target(), codexSchema)).toMatchObject({ rung: 'fork', reason: 'fork_headless', native_id: 'thread-1', headless: true })
  const documentation = planResume(origin(), target())
  expect(documentation).toMatchObject({ rung: 'linked_new', reason: 'no_fork_or_exclusive_resume' })
  expect(documentation.downgrades).toContain('fork_headless_unverified')
  const old = planResume(origin(), target(), { version: '0.1.0', commands: ['thread/resume'] })
  expect(old.rung).toBe('linked_new')
  expect(old.downgrades).toContain('fork_headless_unsupported')
})

it('forks through installed flags where the CLI documents them', () => {
  const flags = { flags: ['--session', '--fork'] }
  const plan = planResume(origin({ cli: 'opencode', native_id: 'ses_1' }), target({ cli: 'opencode', surface: 'interactive' }), flags)
  expect(plan).toMatchObject({ rung: 'fork', native_id: 'ses_1' })
  expect(planResume(origin({ cli: 'opencode', native_id: 'ses_1' }), target({ cli: 'opencode', surface: 'interactive' }), { flags: ['--session'] }).rung).toBe('linked_new')
})

it('does not fork a Claude fleet member: stream-json fork is not documented', () => {
  const flags = { version: '2.1.300', flags: ['--print', '--resume', '--fork-session', '--session-id'] }
  const plan = planResume(origin({ cli: 'claude_code', native_id: '3f9d2b6a-1c64-4b0e-8a77-0d5f2f6c9e11' }), target({ cli: 'claude_code' }), flags)
  expect(plan.rung).toBe('linked_new')
  expect(plan.downgrades).toContain('fork_headless_unverified')
})

it('never restores from transport identifiers, last-session markers or inferred IDs', () => {
  for (const native_id of ['tui:3f9d2b6a-1c64-4b0e-8a77-0d5f2f6c9e11', 'last', 'LATEST', '', 'two words', null]) {
    expect(planResume(origin({ native_id }), target(), codexSchema)).toMatchObject({ rung: 'linked_new', reason: 'no_authentic_id' })
  }
  expect(planResume(origin({ id_authentic: false }), target(), codexSchema)).toMatchObject({ rung: 'linked_new', reason: 'no_authentic_id' })
})

it('requires verified, equal bindings: unknown project or account never enables a restore', () => {
  expect(planResume(origin({ cli: 'kiro', surface: 'fleet' }), target(), codexSchema).reason).toBe('id_namespace_mismatch')
  expect(planResume(origin({ cwd: '/work/other' }), target(), codexSchema).reason).toBe('cwd_incompatible')
  expect(planResume(origin({ cwd: null }), target(), codexSchema).reason).toBe('cwd_incompatible')
  expect(planResume(origin({ project_id: 'a' }), target({ project_id: 'b' }), codexSchema).reason).toBe('project_mismatch')
  expect(planResume(origin({ account: 'a' }), target({ account: 'b' }), codexSchema).reason).toBe('account_mismatch')
  const { project_id, ...withoutProject } = origin(); void project_id
  expect(planResume(withoutProject, target(), codexSchema).reason).toBe('project_unverified')
  const { account, ...withoutAccount } = target(); void account
  expect(planResume(origin(), withoutAccount, codexSchema).reason).toBe('account_unverified')
  expect(planResume(origin({ project_id: 'a' }), target({ project_id: 'a' }), codexSchema).rung).toBe('fork')
  expect(planResume(origin({ project_id: null }), target({ project_id: null }), codexSchema).rung).toBe('fork')
})

it('compares paths without assuming a case-insensitive filesystem', () => {
  expect(planResume(origin({ cwd: '/Work/Repo' }), target({ cwd: '/work/repo' }), codexSchema).reason).toBe('cwd_incompatible')
  expect(planResume(origin({ cwd: '/work/repo/' }), target({ cwd: '/work/repo' }), codexSchema).rung).toBe('fork')
  expect(planResume(origin({ cwd: 'C:\\work\\repo' }), target({ cwd: 'C:/work/repo' }), codexSchema).rung).toBe('fork')
})

it('does not turn a documented resume into an exclusive one: every CLI starts without a verified lock', () => {
  for (const item of RESUME_CATALOG) expect(item.capabilities.exclusive_resume.status).not.toBe('supported')
  const plan = planResume(origin({ cli: 'kiro', surface: 'fleet', native_id: 'kiro-session' }), target({ cli: 'kiro' }))
  expect(plan.rung).toBe('linked_new')
  expect(plan.downgrades).toEqual(expect.arrayContaining(['fork_headless_unverified', 'resume_by_id_unverified', 'exclusive_resume_unverified']))
})

it('resumes only with an adapter lock and never when the origin looks active', () => {
  patchCapability('opencode', 'interactive', 'exclusive_resume', { status: 'supported', commands: ['lock'] })
  patchCapability('opencode', 'interactive', 'fork_headless', { status: 'unsupported' })
  const evidence = { flags: ['--session', '--fork'], commands: ['lock'] }
  const base = origin({ cli: 'opencode', surface: 'interactive', native_id: 'ses_1' }), run = target({ cli: 'opencode', surface: 'interactive' })
  expect(planResume(base, run, evidence)).toMatchObject({ rung: 'exclusive_resume', reason: 'adapter_exclusive_resume', native_id: 'ses_1' })
  const busy = planResume(base, run, evidence, { process_alive: true, lease_active: false, watch_active: null })
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
  expect(planResume(origin(), target(), codexSchema)).toEqual(planResume(origin(), target(), codexSchema))
})

it('never enables a function from documentation alone', () => {
  const flagged = surface('claude_code', 'interactive').capabilities.fork_interactive
  expect(effectiveCapability(flagged)).toBe('unverified')
  expect(effectiveCapability(flagged, { flags: ['--resume'] })).toBe('unsupported')
  expect(effectiveCapability(flagged, { flags: ['--resume', '--fork-session'] })).toBe('supported')
  const method = surface('codex_cli', 'fleet').capabilities.fork_headless
  expect(effectiveCapability(method)).toBe('unverified')
  expect(effectiveCapability(method, { flags: ['--x'] })).toBe('unverified')
  expect(effectiveCapability(method, { commands: ['thread/resume'] })).toBe('unsupported')
  expect(effectiveCapability(method, { commands: ['thread/fork'] })).toBe('supported')
  expect(effectiveCapability(surface('claude_code', 'fleet').capabilities.capture_id, { flags: ['--resume'] })).toBe('unverified')
  expect(effectiveCapability(undefined)).toBe('unverified')
  expect(effectiveCapability(surface('claude_desktop', 'code_tab').capabilities.headless_resume)).toBe('unsupported')
})

it('applies minimum versions only against an installed version', () => {
  const record = surface('claude_desktop', 'code_tab').capabilities.resume_by_id
  expect(effectiveCapability(record)).toBe('unverified')
  expect(effectiveCapability(record, { version: '2.1.284' })).toBe('unsupported')
  expect(effectiveCapability(record, { version: '2.1.285' })).toBe('supported')
  expect(effectiveCapability(record, { version: '2.2.0' })).toBe('supported')
  expect(effectiveCapability(record, { version: 'weird' })).toBe('unverified')
  expect(compareVersions('2.1.285', '2.1.285')).toBe(0)
  expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0)
})

it('records an official source and a verification date for every documented capability', () => {
  for (const item of RESUME_CATALOG) for (const [name, record] of Object.entries(item.capabilities)) {
    expect(record.checked_at, `${item.cli}/${item.surface}/${name}`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    if (record.status === 'supported' || record.status === 'unsupported') expect(record.source, `${item.cli}/${item.surface}/${name}`).toMatch(/^https:\/\//)
  }
})

it('extracts versions, flags, subcommands and schema methods without trusting arbitrary output', () => {
  expect(parseCliVersion('2.1.300 (Claude Code)')).toBe('2.1.300')
  expect(parseCliVersion('codex-cli 0.9.1-beta.2')).toBe('0.9.1-beta.2')
  expect(parseCliVersion('no version here')).toBeUndefined()
  const help = '  --resume, -r  Resume\n  --resume-picker  x\n  [--fork-session]\n  --print\nCommands:\n  fork     Fork a session\n  exec     Run\n  forked   no'
  expect(helpFlags(help, ['--resume', '--fork-session', '--session-id', '--print', '--resume'])).toEqual(['--resume', '--fork-session', '--print'])
  expect(helpCommands(help, ['fork', 'exec', 'resume', 'fork'])).toEqual(['fork', 'exec'])
  expect(schemaMethods('{"a":"thread/fork","b":"thread/forked"}', ['thread/fork', 'thread/resume', 'thread/fork'])).toEqual(['thread/fork'])
})

it('accepts only restorable native IDs', () => {
  expect(restorableNativeId('3f9d2b6a-1c64-4b0e-8a77-0d5f2f6c9e11')).toBe(true)
  for (const id of ['tui:abc', 'last', '', 'a b', 'a\nb', 42, undefined, 'x'.repeat(301)]) expect(restorableNativeId(id)).toBe(false)
})

it('resumes the same conversation without forking only when the Hub proves the child process exited', () => {
  const flags = { version: '2.1.300', flags: ['--print', '--resume'] }
  const claudeOrigin = origin({ cli: 'claude_code', surface: 'fleet', native_id: '3f9d2b6a-1c64-4b0e-8a77-0d5f2f6c9e11' })
  const same = target({ cli: 'claude_code', same_conversation: true })
  expect(planResume(claudeOrigin, same, flags)).toMatchObject({ rung: 'linked_new', reason: 'no_fork_or_exclusive_resume' })
  const proven = planResume(claudeOrigin, same, flags, { exclusive_by: 'hub_process_exit' })
  expect(proven).toMatchObject({ rung: 'exclusive_resume', native_id: '3f9d2b6a-1c64-4b0e-8a77-0d5f2f6c9e11', headless: true })
  expect(proven.evidence).toContain('exclusive_by=hub_process_exit')
  expect(proven.downgrades.some(item => item.startsWith('fork_'))).toBe(false)
  expect(planResume(claudeOrigin, same, flags, { exclusive_by: 'hub_process_exit', process_alive: true }).rung).toBe('linked_new')
})

it('keeps the Hub-proven resume conditional on installed evidence, account and directory', () => {
  const proof = { exclusive_by: 'hub_process_exit' as const }
  const base = origin({ cli: 'claude_code', surface: 'fleet', native_id: '3f9d2b6a-1c64-4b0e-8a77-0d5f2f6c9e11' })
  const same = target({ cli: 'claude_code', same_conversation: true })
  expect(planResume(base, same, undefined, proof).rung).toBe('linked_new')
  const flags = { version: '2.1.300', flags: ['--print', '--resume'] }
  expect(planResume(base, { ...same, account: 'account-b' }, flags, proof)).toMatchObject({ rung: 'linked_new', reason: 'account_mismatch' })
  expect(planResume(base, { ...same, cwd: '/elsewhere' }, flags, proof)).toMatchObject({ rung: 'linked_new', reason: 'cwd_incompatible' })
  const { account: _omitted, ...unknown } = same
  expect(planResume(base, unknown, flags, proof)).toMatchObject({ rung: 'linked_new', reason: 'account_unverified' })
  const kiro = planResume(origin({ cli: 'kiro', surface: 'fleet', native_id: 'kiro-1' }), target({ cli: 'kiro', same_conversation: true }), { flags: [] }, proof)
  expect(kiro.rung).toBe('linked_new')
})
