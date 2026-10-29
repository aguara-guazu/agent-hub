import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { LocalChat } from './local-chat.js'
import { HubTeamRuntime, type HubTeamOptions, type HubTeamStatus } from './team-hub.js'
import { resumeSurface } from './resume-capabilities.js'

const exec = promisify(execFile)
let directory: string
const backends: HubTeamRuntime[] = []
const help = '--print --input-format --output-format --verbose --dangerously-skip-permissions --model --session-id --resume --effort --listen stdio --trust-all-tools'
const fixture = String.raw`
const {createInterface}=require('node:readline');
const [kind,mode,serialized]=process.argv.slice(2),args=JSON.parse(serialized);
const out=p=>process.stdout.write(JSON.stringify(p)+'\n');
const session=args.includes('--fork-session')?'11111111-2222-4333-8444-555555555555':args.includes('--resume')?args[args.indexOf('--resume')+1]:args[args.indexOf('--session-id')+1];
let n=0,turn;
createInterface({input:process.stdin}).on('line',line=>{
 const p=JSON.parse(line);
 if(mode==='invalid'){process.stdout.write('PRIVATE invalid CLI data\n');return;}
 if(kind==='claude') {
  if(p.type==='user'){
   if(!n++)out({type:'system',subtype:'init',session_id:session});
   out({type:'assistant',message:{content:'PRIVATE output'}});
   if(mode==='question')out({type:'control_request',request_id:'question-raw',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input:{questions:[{header:'Choice',question:'What should I do?',options:[{label:'Yes',description:'Proceed'},{label:'No',description:'Wait'}]}]}}});
   if(!['hold','question'].includes(mode))setTimeout(()=>out({type:'result',subtype:'success',session_id:session,uuid:'result-'+n,result:'PRIVATE output'}),10);
  }
  if(p.type==='control_request')out({type:'result',subtype:'success',session_id:session,uuid:'interrupted'});
 } else {
  if(p.method==='initialize')out({id:p.id,result:{}});
  if(p.method==='thread/start')out({id:p.id,result:{thread:{id:'native'}}});
  if(p.method==='thread/resume')out({id:p.id,result:{thread:{id:p.params.threadId}}});
  if(p.method==='thread/fork')out({id:p.id,result:{thread:{id:'native-fork',sessionId:'root-session'}}});
  if(p.method==='turn/start') {
   if(require('node:fs').realpathSync(p.params.cwd)!==process.cwd())process.exit(20);
   turn='turn-'+(++n);
   out({id:p.id,result:{turn:{id:turn,status:'inProgress'}}});
   out({method:'item/agentMessage/delta',params:{threadId:'native',delta:'PRIVATE output'}});
   if(mode==='question')out({method:'item/tool/requestUserInput',id:42,params:{threadId:'native',turnId:turn,isBlocking:true,questions:[{id:'choice',header:'Choice',question:'What should I do?',options:[{label:'Yes',description:'Proceed'},{label:'No',description:'Wait'}]}]}});
   if(!['hold','question'].includes(mode)){const failing=mode==='failSecond'&&n===2;setTimeout(()=>out({method:'turn/completed',params:{threadId:'native',turn:{id:turn,status:failing?'failed':'completed',...(failing?{error:{message:'PRIVATE',codexErrorInfo:'usageLimitExceeded'}}:{})}}}),10);}
  }
  if(p.method==='turn/steer') {
   if(p.params.expectedTurnId!==turn)out({id:p.id,error:{message:'PRIVATE stale turn'}});
   else out({id:p.id,result:{turnId:turn}});
  }
  if(p.method==='turn/interrupt'){
   out({id:p.id,result:{}});
   out({method:'turn/completed',params:{threadId:'native',turn:{id:turn,status:'interrupted'}}});
  }
 }
});`
function mockChat() {
  const rows = new Map<string, { id: string; session_id: string | null; runtime: HubTeamStatus | null }>()
  const sessions = new Map<string, Record<string, unknown>>()
  let authorized = true
  const incidents = new Set<string>()
  const managedQuestions = vi.fn(async (_sender: string, _questions: unknown[], _generation: string) => {})
  const lifecycle = vi.fn(async (_session: string, _event: string, _at: string, _turn?: string) => {})
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SELECT * FROM chat_sessions WHERE id=$1')) return sessions.has(String(params[0])) ? [{ ...sessions.get(String(params[0])) }] : []
    if (sql.startsWith("SELECT id,title,data FROM entities WHERE kind='project'")) return []
    if (sql.includes('FROM process_incidents')) return incidents.has(`${params[0]}:${params[1]}`) ? [{ id: 'incident' }] : []
    if (sql.startsWith('SELECT m.id FROM chat_team_members')) return authorized && rows.get(String(params[0]))?.session_id === params[1] ? [{ id: params[0] }] : []
    if (sql.startsWith('SELECT id,session_id,runtime') && sql.includes('WHERE session_id=$1')) return [...rows.values()].filter(row => row.session_id === params[0]).map(row => ({ ...row }))
    if (sql.startsWith('SELECT id,session_id,runtime')) {
      const value = rows.get(String(params[0])); return value ? [{ ...value }] : []
    }
    if (sql.startsWith('UPDATE chat_team_members SET runtime')) {
      const row = rows.get(String(params[1])); if (row) row.runtime = JSON.parse(String(params[0])); return []
    }
    throw new Error('Unexpected test SQL')
  })
  return { chat: { db: { query }, managedLifecycle: lifecycle, managedQuestions } as unknown as LocalChat, rows, sessions, lifecycle, managedQuestions, query, incidents, setAuthorized: (value: boolean) => { authorized = value } }
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hub-team-runtime-'))
  await mkdir(join(directory, 'repo'))
  await exec('git', ['init', join(directory, 'repo')])
  await exec('git', ['-C', join(directory, 'repo'), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture'])
  await writeFile(join(directory, 'fixture.cjs'), fixture)
})
afterEach(async () => {
  await Promise.all(backends.splice(0).map(runtime => runtime.close()))
  await rm(directory, { recursive: true, force: true })
})
function setup(mode = 'normal', extra: HubTeamOptions = {}) {
  const mock = mockChat()
  const launched = vi.fn((command, args, options) => spawn(process.execPath,
    [join(directory, 'fixture.cjs'), command, mode, JSON.stringify(args)], { ...options, stdio: 'pipe' }))
  const run = vi.fn<NonNullable<HubTeamOptions['run']>>(async (command, args, options) => command === 'git' ? exec(command, args, options) : { stdout: help })
  let enabled = true
  const backend = new HubTeamRuntime(mock.chat, join(directory, 'state'), () => enabled, {
    requestTimeoutMs: 1500, shutdownTimeoutMs: 50, launcher: launched, run, ...extra,
  })
  backends.push(backend)
  const id = randomUUID()
  mock.rows.set(id, { id, session_id: null, runtime: null })
  return { ...mock, backend, launched, run, id, setEnabled: (value: boolean) => { enabled = value } }
}
async function until(predicate: () => boolean | Promise<boolean>) { await expect.poll(predicate, { timeout: 2000, interval: 10 }).toBe(true) }

describe('HubTeamRuntime worktrees and native preflight', () => {
  it('canonicalizes Git worktrees, ignores inherited Git routing, and creates an isolated branch', async () => {
    const previous = process.env.GIT_DIR
    process.env.GIT_DIR = '/wrong/repository'
    try {
      const { backend, run } = setup()
      const parent = await backend.workspace(join(directory, 'repo'))
      expect(parent.id).toBe(`hub:${Buffer.from(await realpath(join(directory, 'repo'))).toString('base64url')}`)
      expect(await backend.workspace(parent.id)).toEqual(parent)
      const child = await backend.create(parent, 'review')
      expect(child.repo_id).toBe(parent.repo_id)
      expect(child.head).toBe(parent.head)
      expect(child.path).toContain('/fleet-worktrees/')
      expect(child.id).not.toBe(parent.id)
      expect((await exec('git', ['-C', child.path, 'branch', '--show-current'], { env: { PATH: process.env.PATH } })).stdout.trim()).toMatch(/^hub\/[0-9a-f-]{36}$/)
      expect(run.mock.calls.every(call => !Object.keys(call[2].env).some(key => key.startsWith('GIT_')))).toBe(true)
    } finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous }
  })
  it('supports ordinary folders but rejects missing/bare roots and noncanonical Hub selectors', async () => {
    const { backend } = setup()
    expect(await backend.workspace(directory)).toMatchObject({kind:'virtual',head:'virtual'})
    await expect(backend.workspace(join(directory,'missing'))).rejects.toThrow('no está disponible')
    await expect(backend.workspace('relative')).rejects.toThrow('ruta absoluta')
    await expect(backend.workspace('hub:%%%')).rejects.toThrow('inválido')
    const nested = join(directory, 'repo', 'nested'); await mkdir(nested)
    await expect(backend.workspace(`hub:${Buffer.from(nested).toString('base64url')}`)).rejects.toThrow('worktree real')
    await exec('git', ['init', '--bare', join(directory, 'bare')])
    await expect(backend.workspace(join(directory, 'bare'))).rejects.toThrow('worktree disponible')
  })
  it('does not replace a broken Git marker or an empty repository with a virtual space',async()=>{
    const {backend}=setup()
    const broken=join(directory,'broken');await mkdir(broken)
    await writeFile(join(broken,'.git'),'gitdir: /nonexistent/hub-fixture-git')
    await expect(backend.workspace(broken)).rejects.toThrow('Git inválido')
    const empty=join(directory,'empty');await exec('git',['init',empty])
    await expect(backend.workspace(empty)).rejects.toThrow('HEAD')
  })
  it('does not create a child when the approved revision has changed', async () => {
    const { backend, run } = setup()
    const parent = await backend.workspace(join(directory, 'repo'))
    await exec('git', ['-C', parent.path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'changed'])
    await expect(backend.create(parent, 'worker')).rejects.toThrow('cambió')
    expect(run.mock.calls.some(call => call[1].includes('add'))).toBe(false)
  })
  it('checks installed native flags, including Kiro ACP, and rejects invalid choices before spawning', async () => {
    const { backend, launched, run } = setup()
    await backend.preflight([{ cli: 'claude_code', model: 'opus', effort: 'high' }, { cli: 'codex_cli', model: 'exact-model' }, { cli: 'kiro', model: 'kiro-model', effort: 'high' }])
    expect(run.mock.calls.map(call => call.slice(0, 2))).toEqual([['claude', ['--help']], ['codex', ['app-server', '--help']], ['kiro-cli', ['acp', '--help']]])
    const noAcp = setup('normal', { run: async () => ({ stdout: '--help --model' }) })
    await expect(noAcp.backend.preflight([{ cli: 'kiro', model: 'kiro-model' }])).rejects.toThrow('protocolo nativo')
    await expect(backend.preflight([{ cli: 'codex_cli', model: '-config' }])).rejects.toThrow('modelo válido')
    expect(launched).not.toHaveBeenCalled()
    const old = setup('normal', { run: async () => ({ stdout: '--help --model' }) })
    await expect(old.backend.preflight([{ cli: 'claude_code', model: 'opus' }])).rejects.toThrow('protocolo nativo')
  })
})

describe('HubTeamRuntime continuation', () => {
  const methods = '{"methods":["thread/fork","thread/resume"]}'
  const iso = (offset: number) => new Date(Date.now() + offset).toISOString()
  const withSchema = (extra: Partial<HubTeamOptions> = {}): HubTeamOptions => ({
    run: async (command, args, options) => {
      if (command === 'git') return exec(command, args, options)
      const out = args.indexOf('--out')
      if (args.includes('generate-json-schema') && out >= 0) await writeFile(join(args[out + 1]!, 'schema.json'), methods)
      return { stdout: help }
    },
    resolveAccount: async () => 'account-a', resolveOriginAccount: async () => 'account-a', ...extra,
  })
  const origin = (patch: Record<string, unknown> = {}) => ({ id: 'creator', cli_kind: 'codex_cli', surface: 'interactive', native_id: 'thread-source', native_cwd: '',
    model: 'exact-model', resumable: 1, id_captured_by: 'hook', state: 'idle', closed_at: iso(-1000), lease_until: iso(-60_000), event_at: iso(-60_000), removed_at: null, ...patch })
  async function prepare(mode = 'hold', extra: HubTeamOptions = withSchema(), patch: Record<string, unknown> = {}) {
    const set = setup(mode, extra)
    const parent = await set.backend.workspace(join(directory, 'repo'))
    set.sessions.set('creator', origin({ native_cwd: parent.path, ...patch }))
    return { ...set, parent, launch: (continuation: Parameters<typeof set.backend.launch>[1]['continuation']) =>
      set.backend.launch(parent, { member_id: set.id, cli: 'codex_cli', model: 'exact-model', prompt: 'PRIVATE', ...(continuation ? { continuation } : {}) }) }
  }
  const request = { origin_session_id: 'creator', project_id: null }

  it('forks a Codex thread only when installed schema, origin metadata, project and account are all verified', async () => {
    const { launch, launched } = await prepare()
    const receipt = await launch(request)
    expect(receipt.continuity).toMatchObject({ rung: 'fork', reason: 'fork_headless', native_id: 'thread-source' })
    expect(receipt.runtime.native_id).toBe('native-fork')
    expect(launched).toHaveBeenCalledTimes(1)
  })
  it('does not fork from documentation alone: without the installed schema it starts a new linked conversation', async () => {
    const { launch } = await prepare('hold', { resolveAccount: async () => 'account-a', resolveOriginAccount: async () => 'account-a' })
    const receipt = await launch(request)
    expect(receipt.continuity).toMatchObject({ rung: 'linked_new' })
    expect(receipt.continuity!.downgrades).toContain('fork_headless_unverified')
    expect(receipt.runtime.native_id).toBe('native')
  })
  it.each([
    ['an unknown target account', withSchema({ resolveAccount: async () => undefined }), {}, 'account_unverified'],
    ['an origin without a captured account', withSchema({ resolveOriginAccount: async () => undefined }), {}, 'account_unverified'],
    ['a login rotated after the ID was captured', withSchema({ resolveOriginAccount: async () => 'account-a', resolveAccount: async () => 'account-b' }), {}, 'account_mismatch'],
    ['a transport identifier', withSchema(), { native_id: 'tui:3f9d2b6a-1c64-4b0e-8a77-0d5f2f6c9e11' }, 'no_authentic_id'],
    ['an ID that was not captured from a hook', withSchema(), { resumable: 0, id_captured_by: null }, 'no_authentic_id'],
    ['another directory', withSchema(), { native_cwd: '/somewhere/else' }, 'cwd_incompatible'],
    ['another CLI surface', withSchema(), { cli_kind: 'claude_code' }, 'id_namespace_mismatch'],
  ])('starts a new linked conversation for %s', async (_name, options, patch, reason) => {
    const { launch } = await prepare('hold', options, patch)
    const receipt = await launch(request)
    expect(receipt.continuity!.rung).toBe('linked_new')
    expect(receipt.continuity!.downgrades).toContain(reason)
    expect(receipt.runtime.native_id).toBe('native')
  })
  it('does not launch another conversation while the creator chat is still connected', async () => {
    const { launch, launched } = await prepare('hold', withSchema(), { closed_at: null, state: 'idle', lease_until: iso(60_000), event_at: iso(-1000) })
    await expect(launch(request)).rejects.toMatchObject({ message: expect.stringContaining('sigue conectado'), continuity: { rung: 'live_destination' } })
    expect(launched).not.toHaveBeenCalled()
  })
  it('launches nothing when a restricted profile is requested, even if a fork or a new conversation would be possible', async () => {
    const { launch, launched } = await prepare()
    await expect(launch({ ...request, profile: { restricted: true } })).rejects.toMatchObject({ continuity: { rung: 'blocked_unsupported', reason: 'profile_unverifiable' } })
    const unverifiedFork = await prepare('hold', { resolveAccount: async () => undefined })
    await expect(unverifiedFork.launch({ ...request, profile: { restricted: true } })).rejects.toMatchObject({ continuity: { rung: 'blocked_unsupported' } })
    expect(launched).not.toHaveBeenCalled()
    expect(unverifiedFork.launched).not.toHaveBeenCalled()
    expect((await launch({ ...request, profile: { restricted: false } })).continuity!.rung).toBe('fork')
  })
  it('never resumes the original session without an adapter-held exclusion', async () => {
    const surface = resumeSurface('codex_cli', 'fleet')!
    const lock = surface.capabilities.exclusive_resume, fork = surface.capabilities.fork_headless
    const previous = { lock: { status: lock.status, commands: lock.commands }, fork: fork.status }
    lock.status = 'supported'; lock.commands = ['thread/resume']; fork.status = 'unsupported'
    try {
      const { launch, launched } = await prepare()
      await expect(launch(request)).rejects.toMatchObject({ message: expect.stringContaining('exclusión'), continuity: { rung: 'exclusive_resume' } })
      expect(launched).not.toHaveBeenCalled()
    } finally { lock.status = previous.lock.status; if (previous.lock.commands) lock.commands = previous.lock.commands; else delete lock.commands; fork.status = previous.fork }
  })
  it('reports an attempted fork that fails as uncertain and does not try another rung', async () => {
    const { launch, launched, id } = await prepare('invalid')
    const failure = await launch(request).catch(error => error)
    expect(failure).toMatchObject({ launch_handle: id, resume_outcome: 'launch_uncertain', continuity: { rung: 'fork' } })
    expect(launched).toHaveBeenCalledTimes(1)
  })
  it('keeps launches without a continuation exactly as before', async () => {
    const { launch } = await prepare()
    const receipt = await launch(undefined)
    expect(receipt).not.toHaveProperty('continuity')
    expect(receipt.runtime.native_id).toBe('native')
  })
})

describe('HubTeamRuntime lifecycle', () => {
  it.each(['codex_cli', 'claude_code'] as const)('persists metadata and binds a late-joined %s session after completion', async cli => {
    const { backend, id, rows, lifecycle } = setup()
    const parent = await backend.workspace(join(directory, 'repo'))
    const receipt = await backend.launch(parent, { member_id: id, cli, model: 'exact-model', prompt: 'PRIVATE invitation and task' })
    expect(receipt).toMatchObject({ handle: id, kind: 'hub_process', prompt_outcome: 'input-accepted', runtime: { provider: 'hub' } })
    expect(receipt.runtime.generation).toMatch(/^[0-9a-f-]{36}$/)
    await until(async () => (await backend.status(id))?.state === 'idle')
    const row = rows.get(id)!
    expect(lifecycle).not.toHaveBeenCalled()
    row.session_id = 'joined-late'
    const timestamp = row.runtime!.updated_at
    await backend.bind(id, 'joined-late')
    expect(lifecycle).toHaveBeenLastCalledWith('joined-late', 'Stop', timestamp, row.runtime!.turn_id)
    expect((await backend.status(id))?.updated_at).toBe(timestamp)
    expect(JSON.stringify(row.runtime)).not.toContain('PRIVATE')
    await expect(backend.bind(id, 'wrong-session')).rejects.toThrow('no corresponde')
  })
  it('updates joined session activity through busy, interrupt, idle and stopped', async () => {
    const { backend, id, rows, lifecycle } = setup('hold')
    rows.get(id)!.session_id = 'joined'
    const parent = await backend.workspace(join(directory, 'repo'))
    await backend.launch(parent, { member_id: id, cli: 'codex_cli', model: 'test', prompt: 'PRIVATE' })
    expect(lifecycle.mock.calls.some(call => call[1] === 'UserPromptSubmit' && call[3] === 'turn-1')).toBe(true)
    await backend.interrupt(id)
    await until(async () => (await backend.status(id))?.state === 'idle')
    expect(lifecycle.mock.calls.some(call => call[1] === 'Stop' && call[3] === 'turn-1')).toBe(true)
    await backend.send(id, 'PRIVATE follow up')
    expect(lifecycle.mock.calls.at(-1)?.[3]).toBe('turn-2')
    await backend.stop(id)
    expect(lifecycle).toHaveBeenLastCalledWith('joined', 'SessionEnd', expect.any(String), 'turn-2')
  })
  it.each(['codex_cli', 'claude_code'] as const)('publishes native %s questions to the master before join and rebinds idempotently', async cli => {
    const { backend, id, rows, managedQuestions, lifecycle } = setup('question')
    const parent = await backend.workspace(join(directory, 'repo'))
    const receipt = await backend.launch(parent, { member_id: id, cli, model: 'test', prompt: 'PRIVATE' })
    await until(async () => (await backend.status(id))?.state === 'waiting_input')
    const waiting = (await backend.status(id))!
    const pending = waiting.questions![0]!
    expect(managedQuestions).toHaveBeenCalledWith(id, [pending], receipt.runtime.generation)
    expect(lifecycle).not.toHaveBeenCalled()
    rows.get(id)!.session_id = 'joined-late'
    await backend.bind(id, 'joined-late')
    expect(lifecycle).toHaveBeenLastCalledWith('joined-late', 'RequestUserInput', waiting.updated_at, waiting.turn_id)
    expect(managedQuestions).toHaveBeenLastCalledWith(id, [pending], receipt.runtime.generation)
    const after = await backend.answer(id, pending.id, { [pending.questions[0]!.id]: { answers: ['PRIVATE ANSWER'] } })
    expect(after.state).toBe('busy')
    expect((await backend.status(id))?.questions).toEqual([])
    expect(JSON.stringify(rows.get(id)?.runtime)).not.toContain('PRIVATE ANSWER')
  })
  it('keeps failed startup metadata and never claims input delivery', async () => {
    const { backend, id, rows, lifecycle } = setup('invalid')
    rows.get(id)!.session_id = 'joined'
    const parent = await backend.workspace(join(directory, 'repo'))
    await expect(backend.launch(parent, { member_id: id, cli: 'codex_cli', model: 'test', prompt: 'PRIVATE' })).rejects.toThrow('no confirmó')
    await expect(backend.launch(parent, { member_id: id, cli: 'codex_cli', model: 'test', prompt: 'PRIVATE' })).rejects.toMatchObject({ launch_handle: id })
    expect(rows.get(id)?.runtime?.state).toBe('failed')
    expect(lifecycle.mock.calls.some(call => call[1] === 'StopFailure')).toBe(true)
    expect(JSON.stringify(rows.get(id)?.runtime)).not.toContain('PRIVATE')
  })
  it('suspends only owned agents while disabled and can launch a new generation after enabling', async () => {
    const { backend, id, rows, setEnabled, launched } = setup('hold')
    const parent = await backend.workspace(join(directory, 'repo'))
    const member = { member_id: id, cli: 'codex_cli' as const, model: 'test', prompt: 'PRIVATE' }
    const first = await backend.launch(parent, member)
    setEnabled(false)
    await expect(backend.send(id, 'message')).rejects.toThrow('desactivada')
    await expect(backend.interrupt(id)).rejects.toThrow('desactivada')
    await expect(backend.create(parent, 'blocked')).rejects.toThrow('desactivada')
    await backend.suspend()
    expect((await backend.status(id))?.state).toBe('stopped')
    await expect(backend.launch(parent, member)).rejects.toThrow('desactivada')
    setEnabled(true)
    const second = await backend.launch(parent, member)
    expect(second.runtime.generation).not.toBe(first.runtime.generation)
    expect(rows.get(id)?.runtime?.generation).toBe(second.runtime.generation)
    expect(launched).toHaveBeenCalledTimes(2)
  })
  it('resumes the same isolated worktree after worker commits, while initial launch and create remain strict', async () => {
    const { backend, id } = setup('hold')
    const parent = await backend.workspace(join(directory, 'repo'))
    const child = await backend.create(parent, 'worker')
    const member = { member_id: id, cli: 'codex_cli' as const, model: 'test', prompt: 'PRIVATE' }
    await backend.launch(child, member)
    await backend.stop(id)
    await exec('git', ['-C', child.path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'worker change'])
    await expect(backend.launch(child, member)).rejects.toThrow('cambió')
    await expect(backend.create(child, 'grandchild')).rejects.toThrow('cambió')
    const resumed = await backend.launch(child, { ...member, resume_worktree: true })
    expect(resumed.runtime.state).toBe('busy')
    expect(resumed.runtime.cwd).toBe(child.path)
    await backend.stop(id)
    await expect(backend.launch({ ...child, repo_id: 'different-repository' }, { ...member, resume_worktree: true })).rejects.toThrow('cambió')
    await expect(backend.launch({ ...child, path: parent.path }, { ...member, resume_worktree: true })).rejects.toThrow('cambió')
  })
  it('stops a process if disabled while native startup is still being acknowledged', async () => {
    const value = setup('hold', { onEvent: event => { if (event.state === 'busy') value.setEnabled(false) } })
    const parent = await value.backend.workspace(join(directory, 'repo'))
    await expect(value.backend.launch(parent, { member_id: value.id, cli: 'codex_cli', model: 'test', prompt: 'PRIVATE' })).rejects.toThrow('desactivó durante')
    expect((await value.backend.status(value.id))?.state).toBe('stopped')
    expect(value.launched).toHaveBeenCalledTimes(1)
    value.setEnabled(true)
    await expect(value.backend.wake('unknown-session', 'notice')).resolves.toBe(false)
    expect(value.launched).toHaveBeenCalledTimes(1)
  })
  it('exposes bounded activity only for the currently owned member/session binding', async () => {
    const { backend, id, chat, rows } = setup('hold')
    const parent = await backend.workspace(join(directory, 'repo'))
    await backend.launch(parent, { member_id: id, cli: 'codex_cli', model: 'test', prompt: 'Synthetic human task' })
    rows.get(id)!.session_id = 'session'
    expect((await backend.activity('session')).supported).toBe(true)
    expect((await backend.activity('session')).items[0]!.text).toBe('Synthetic human task')
    expect((await backend.activity('external')).supported).toBe(false)
    const restarted = new HubTeamRuntime(chat, join(directory, 'restart')); backends.push(restarted)
    expect((await restarted.activity('session')).supported).toBe(false)
    rows.get(id)!.runtime!.generation = randomUUID()
    expect((await backend.activity('session')).supported).toBe(false)
  })
  it('does not claim ownership of stale database metadata after a Hub restart', async () => {
    const { backend, id, chat } = setup('hold')
    const parent = await backend.workspace(join(directory, 'repo'))
    await backend.launch(parent, { member_id: id, cli: 'codex_cli', model: 'test', prompt: 'PRIVATE' })
    const restarted = new HubTeamRuntime(chat, join(directory, 'another-runtime')); backends.push(restarted)
    expect((await restarted.status(id))?.state).toBe('unknown')
    await expect(restarted.stop(id)).rejects.toThrow('fleet_unknown_id')
    expect((await backend.status(id))?.state).toBe('busy')
  })
  it('wakes an active Codex session natively and retries disabled bindings without respawning', async () => {
    const { backend, id, rows, launched, setEnabled } = setup('hold')
    const parent = await backend.workspace(join(directory, 'repo'))
    rows.get(id)!.session_id = 'joined'
    await backend.launch(parent, { member_id: id, cli: 'codex_cli', model: 'test', prompt: 'PRIVATE' })
    expect(await backend.wake('another-session', 'notice')).toBe(false)
    expect(await backend.wake('joined', 'PRIVATE notice')).toBe(true)
    expect((await backend.status(id))?.turn_id).toBe('turn-1')
    expect((await backend.send(id, 'PRIVATE direct steer')).turn_id).toBe('turn-1')
    await backend.interrupt(id)
    await until(async () => (await backend.status(id))?.state === 'idle')
    setEnabled(false)
    await expect(backend.wake('joined', 'PRIVATE notice')).rejects.toThrow('desactivada')
    setEnabled(true)
    expect(await backend.wake('joined', 'PRIVATE notice')).toBe(true)
    expect((await backend.status(id))?.state).toBe('busy')
    expect(launched).toHaveBeenCalledTimes(1)
    setEnabled(false)
    await backend.suspend()
    await expect(backend.wake('joined', 'PRIVATE notice')).rejects.toThrow('desactivada')
    expect((await backend.status(id))?.state).toBe('stopped')
    setEnabled(true)
    await expect(backend.wake('joined', 'PRIVATE notice')).rejects.toThrow('todavía no está disponible')
    expect(launched).toHaveBeenCalledTimes(1)
  })
  it('keeps a busy Claude wake pending for native hook delivery', async () => {
    const { backend, id, rows, launched } = setup('hold')
    rows.get(id)!.session_id = 'joined'
    const parent = await backend.workspace(join(directory, 'repo'))
    await backend.launch(parent, { member_id: id, cli: 'claude_code', model: 'test', prompt: 'PRIVATE' })
    await expect(backend.wake('joined', 'PRIVATE notice')).rejects.toThrow('todavía no está disponible')
    await expect(backend.send(id, 'PRIVATE direct notice')).rejects.toThrow('fleet_not_idle')
    expect((await backend.status(id))?.state).toBe('busy')
    expect(launched).toHaveBeenCalledTimes(1)
  })
  it('declines a binding whose recorded generation does not belong to this manager', async () => {
    const { backend, id, rows } = setup('hold')
    const parent = await backend.workspace(join(directory, 'repo'))
    rows.get(id)!.session_id = 'joined'
    await backend.launch(parent, { member_id: id, cli: 'codex_cli', model: 'test', prompt: 'PRIVATE' })
    rows.get(id)!.runtime!.generation = randomUUID()
    expect(await backend.wake('joined', 'PRIVATE notice')).toBe(false)
  })
  it('revalidates launch authority after native help and Git checks, before spawning', async () => {
    const { backend, id, launched, run } = setup('hold')
    const parent = await backend.workspace(join(directory, 'repo'))
    let verified = false
    const authorize = vi.fn(async () => {
      verified = run.mock.calls.at(-1)?.[0] === 'git'
      throw new Error('Plan cancelled while checking the CLI')
    })
    await expect(backend.launch(parent, { member_id: id, cli: 'codex_cli', model: 'test', prompt: 'PRIVATE', authorize })).rejects.toThrow('Plan cancelled')
    expect(verified).toBe(true)
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(launched).not.toHaveBeenCalled()
  })
  it('revalidates current team and session authority immediately before waking an idle worker', async () => {
    const { backend, id, rows, setAuthorized, query, launched } = setup('hold')
    const parent = await backend.workspace(join(directory, 'repo'))
    rows.get(id)!.session_id = 'joined'
    await backend.launch(parent, { member_id: id, cli: 'codex_cli', model: 'test', prompt: 'PRIVATE' })
    await backend.interrupt(id)
    await until(async () => (await backend.status(id))?.state === 'idle')
    setAuthorized(false)
    await expect(backend.wake('joined', 'PRIVATE notice')).rejects.toThrow('ya no están autorizados')
    expect((await backend.status(id))?.state).toBe('idle')
    expect(launched).toHaveBeenCalledTimes(1)
    const validation = query.mock.calls.find(call => call[0].startsWith('SELECT m.id FROM chat_team_members'))![0]
    expect(validation).toContain('master.leader_id=t.created_by')
    expect(validation).toContain('leader.removed_at IS NULL')
    expect(validation).toContain('participant.removed_at IS NULL')
    expect(validation).toContain("t.state NOT IN ('paused','cancelled','completed','prepared')")
    setAuthorized(true)
    expect(await backend.wake('joined', 'PRIVATE notice')).toBe(true)
  })
  it('checks the enable switch again after asynchronous preflight before spawning', async () => {
    const value = setup('hold')
    const parent = await value.backend.workspace(join(directory, 'repo'))
    value.run.mockImplementationOnce(async () => { value.setEnabled(false); return { stdout: help } })
    await expect(value.backend.launch(parent, { member_id: value.id, cli: 'codex_cli', model: 'test', prompt: 'PRIVATE' })).rejects.toThrow('desactivada')
    expect(value.launched).not.toHaveBeenCalled()
  })
  it('strips Hub secrets, routing and Git overrides from the owned launcher environment', async () => {
    const { backend, id, launched } = setup('hold')
    const previous = process.env.AGENTHUB_CHAT_SESSION_KEY
    process.env.AGENTHUB_CHAT_SESSION_KEY = 'PRIVATE PARENT KEY'
    try {
      const parent = await backend.workspace(join(directory, 'repo'))
      await backend.launch(parent, { member_id: id, cli: 'codex_cli', model: 'test', prompt: 'PRIVATE' })
    } finally { if (previous === undefined) delete process.env.AGENTHUB_CHAT_SESSION_KEY; else process.env.AGENTHUB_CHAT_SESSION_KEY = previous }
    expect(Object.keys(launched.mock.calls[0]![2].env).some(key => /^(AGENTHUB_|ORCA_|GIT_)/.test(key))).toBe(false)
  })
})

describe('HubTeamRuntime same-conversation resume', () => {
  const schema = '{"methods":["thread/fork","thread/resume"]}'
  const options: HubTeamOptions = {
    run: async (command, args, runOptions) => {
      if (command === 'git') return exec(command, args, runOptions)
      const out = args.indexOf('--out')
      if (args.includes('generate-json-schema') && out >= 0) await writeFile(join(args[out + 1]!, 'schema.json'), schema)
      return { stdout: help }
    },
  }
  const request = { prompt: 'FIXED PROMPT', pool_key: 'pool-a' }
  async function failedMember(mode = 'failSecond') {
    const set = setup(mode, options)
    const parent = await set.backend.workspace(join(directory, 'repo'))
    set.rows.get(set.id)!.session_id = 'member-session'
    await set.backend.launch(parent, { member_id: set.id, cli: 'codex_cli', model: 'exact-model', prompt: 'PRIVATE' })
    await until(() => set.rows.get(set.id)!.runtime?.state === 'idle')
    await set.backend.send(set.id, 'again')
    await until(() => set.rows.get(set.id)!.runtime?.state === 'failed')
    await until(() => (set.backend as unknown as { manager: { exitConfirmed(id: string): boolean } }).manager.exitConfirmed(set.id))
    return { ...set, parent }
  }
  it('restarts the failed Codex thread in place once the Hub confirmed the child exit', async () => {
    const { backend, rows, id, launched } = await failedMember()
    const before = rows.get(id)!.runtime!
    expect(before).toMatchObject({ state: 'failed', error_cause: 'quota_exhausted', error_evidence: 'protocol', native_id: 'native' })
    const receipt = await backend.resumeMember(id, request)
    expect(receipt.continuity).toMatchObject({ rung: 'exclusive_resume', native_id: 'native' })
    expect(receipt.runtime).toMatchObject({ native_id: 'native', cli: 'codex_cli', model: 'exact-model' })
    expect(receipt.runtime.generation).not.toBe(before.generation)
    expect(launched).toHaveBeenCalledTimes(2)
  })
  it('refuses a failed member whose process exit nobody confirmed, then accepts the recorded incident', async () => {
    const { backend, rows, id, incidents, launched } = setup('hold', options)
    const workspace = await backend.workspace(join(directory, 'repo'))
    rows.get(id)!.session_id = 'member-session'
    rows.get(id)!.runtime = { id, cli: 'codex_cli', cwd: workspace.path, model: 'exact-model', state: 'failed', native_id: 'thread-old', provider: 'hub', generation: 'old-generation', updated_at: new Date().toISOString() } as HubTeamStatus
    await expect(backend.resumeMember(id, request)).rejects.toMatchObject({ continuity: { rung: 'linked_new' } })
    expect(await backend.checkResume(id, request)).toMatchObject({ ready: false, kind: 'exit_unconfirmed' })
    expect(launched).not.toHaveBeenCalled()
    incidents.add(`${id}:old-generation`)
    expect(await backend.checkResume(id, request)).toMatchObject({ ready: true, kind: 'ready', plan: { rung: 'exclusive_resume' } })
    expect(launched).not.toHaveBeenCalled()
    const receipt = await backend.resumeMember(id, request)
    expect(receipt.continuity).toMatchObject({ rung: 'exclusive_resume', native_id: 'thread-old' })
    expect(receipt.runtime.native_id).toBe('thread-old')
  })
  it('does not resume a member that did not fail, lost its authority or has no installed resume evidence', async () => {
    const { backend, rows, id, setAuthorized, launched } = setup('hold', options)
    rows.get(id)!.session_id = 'member-session'
    await expect(backend.resumeMember(id, request)).rejects.toMatchObject({ statusCode: 409 })
    const workspace = await backend.workspace(join(directory, 'repo'))
    rows.get(id)!.runtime = { id, cli: 'codex_cli', cwd: workspace.path, model: 'exact-model', state: 'failed', native_id: 'thread-old', provider: 'hub', generation: 'g', updated_at: new Date().toISOString() } as HubTeamStatus
    setAuthorized(false)
    expect(await backend.checkResume(id, request)).toMatchObject({ ready: false, kind: 'unauthorized' })
    await expect(backend.resumeMember(id, request)).rejects.toMatchObject({ statusCode: 403 })
    setAuthorized(true)
    const bare = setup('hold', { run: async (command, args, runOptions) => command === 'git' ? exec(command, args, runOptions) : { stdout: help } })
    bare.rows.get(bare.id)!.session_id = 'member-session'
    bare.rows.get(bare.id)!.runtime = { ...rows.get(id)!.runtime!, id: bare.id } as HubTeamStatus
    bare.incidents.add(`${bare.id}:g`)
    expect(await bare.backend.checkResume(bare.id, request)).toMatchObject({ ready: false, kind: 'unsupported', plan: { rung: 'linked_new' } })
    await expect(bare.backend.resumeMember(bare.id, request)).rejects.toMatchObject({ continuity: { rung: 'linked_new' } })
    expect(launched).not.toHaveBeenCalled()
    expect(bare.launched).not.toHaveBeenCalled()
  })
})
