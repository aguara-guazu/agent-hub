import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { LocalChat } from './local-chat.js'
import { HubTeamRuntime, type HubTeamOptions, type HubTeamStatus } from './team-hub.js'

const exec = promisify(execFile)
let directory: string
const backends: HubTeamRuntime[] = []
const help = '--print --input-format --output-format --verbose --dangerously-skip-permissions --model --session-id --resume --effort --listen stdio'
const fixture = String.raw`
const {createInterface}=require('node:readline');
const [kind,mode,serialized]=process.argv.slice(2),args=JSON.parse(serialized);
const out=p=>process.stdout.write(JSON.stringify(p)+'\n');
const session=args[args.indexOf('--session-id')+1];
let n=0,turn;
createInterface({input:process.stdin}).on('line',line=>{
 const p=JSON.parse(line);
 if(mode==='invalid'){process.stdout.write('PRIVATE invalid CLI data\n');return;}
 if(kind==='claude') {
  if(p.type==='user'){
   if(!n++)out({type:'system',subtype:'init',session_id:session});
   out({type:'assistant',message:{content:'PRIVATE output'}});
   if(mode!=='hold')setTimeout(()=>out({type:'result',subtype:'success',session_id:session,uuid:'result-'+n,result:'PRIVATE output'}),10);
  }
  if(p.type==='control_request')out({type:'result',subtype:'success',session_id:session,uuid:'interrupted'});
 } else {
  if(p.method==='initialize')out({id:p.id,result:{}});
  if(p.method==='thread/start')out({id:p.id,result:{thread:{id:'native'}}});
  if(p.method==='turn/start') {
   turn='turn-'+(++n);
   out({id:p.id,result:{turn:{id:turn,status:'inProgress'}}});
   out({method:'item/agentMessage/delta',params:{threadId:'native',delta:'PRIVATE output'}});
   if(mode!=='hold')setTimeout(()=>out({method:'turn/completed',params:{threadId:'native',turn:{id:turn,status:'completed'}}}),10);
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
  let authorized = true
  const lifecycle = vi.fn(async (_session: string, _event: string, _at: string, _turn?: string) => {})
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
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
  return { chat: { db: { query }, managedLifecycle: lifecycle } as unknown as LocalChat, rows, lifecycle, query, setAuthorized: (value: boolean) => { authorized = value } }
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
    requestTimeoutMs: 300, shutdownTimeoutMs: 50, launcher: launched, run, ...extra,
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
      expect((await exec('git', ['-C', child.path, 'branch', '--show-current'], { env: { PATH: process.env.PATH } })).stdout.trim()).toMatch(/^hub\/[0-9a-f-]{36}-review$/)
      expect(run.mock.calls.every(call => !Object.keys(call[2].env).some(key => key.startsWith('GIT_')))).toBe(true)
    } finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous }
  })
  it('rejects missing/bare/non Git roots and noncanonical Hub selectors', async () => {
    const { backend } = setup()
    await expect(backend.workspace(directory)).rejects.toThrow('operación local')
    await expect(backend.workspace('relative')).rejects.toThrow('ruta absoluta')
    await expect(backend.workspace('hub:%%%')).rejects.toThrow('inválido')
    const nested = join(directory, 'repo', 'nested'); await mkdir(nested)
    await expect(backend.workspace(`hub:${Buffer.from(nested).toString('base64url')}`)).rejects.toThrow('worktree real')
    await exec('git', ['init', '--bare', join(directory, 'bare')])
    await expect(backend.workspace(join(directory, 'bare'))).rejects.toThrow('worktree Git')
  })
  it('does not create a child when the approved revision has changed', async () => {
    const { backend, run } = setup()
    const parent = await backend.workspace(join(directory, 'repo'))
    await exec('git', ['-C', parent.path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'changed'])
    await expect(backend.create(parent, 'worker')).rejects.toThrow('cambió')
    expect(run.mock.calls.some(call => call[1].includes('add'))).toBe(false)
  })
  it('checks installed native flags and rejects unsupported Kiro and invalid choices before spawning', async () => {
    const { backend, launched, run } = setup()
    await backend.preflight([{ cli: 'claude_code', model: 'opus', effort: 'high' }, { cli: 'codex_cli', model: 'exact-model' }])
    expect(run.mock.calls.map(call => call.slice(0, 2))).toEqual([['claude', ['--help']], ['codex', ['app-server', '--help']]])
    await expect(backend.preflight([{ cli: 'kiro', model: 'kiro-model' }])).rejects.toThrow('Kiro')
    await expect(backend.preflight([{ cli: 'codex_cli', model: '-config' }])).rejects.toThrow('modelo válido')
    expect(launched).not.toHaveBeenCalled()
    const old = setup('normal', { run: async () => ({ stdout: '--help --model' }) })
    await expect(old.backend.preflight([{ cli: 'claude_code', model: 'opus' }])).rejects.toThrow('protocolo nativo')
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
  it('keeps failed startup metadata and never claims input delivery', async () => {
    const { backend, id, rows, lifecycle } = setup('invalid')
    rows.get(id)!.session_id = 'joined'
    const parent = await backend.workspace(join(directory, 'repo'))
    await expect(backend.launch(parent, { member_id: id, cli: 'codex_cli', model: 'test', prompt: 'PRIVATE' })).rejects.toThrow('no confirmó')
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
