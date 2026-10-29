import { afterEach, beforeEach, expect, it } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryOperations } from '../src/operations.js'
import { MemoryAI } from '../src/ai.js'
import { Vault, defaultAI } from '../src/config.js'
import { HubTeamRuntime } from '../src/team-hub.js'
import { ScheduleRuntime, type ProcessControl } from '../src/schedule-runtime.js'
import { ScheduleStore } from '../src/schedule-store.js'
import { QUOTA_RESUME_PROMPT, createFleetRecovery } from '../src/fleet-recovery.js'
import { startClockThenRecover } from '../src/service.js'
import type { AgentContext } from '../src/agents.js'
import { existingChannel } from './helpers/chat-channel.js'

const exec = promisify(execFile)
const help = '--print --input-format --output-format --verbose --dangerously-skip-permissions --model --session-id --resume --effort --listen stdio --trust-all-tools'
const schema = '{"methods":["thread/fork","thread/resume"]}'
const fixture = String.raw`
const {createInterface}=require('node:readline');
const {appendFileSync}=require('node:fs');
const out=p=>process.stdout.write(JSON.stringify(p)+'\n');
let thread,n=0;
createInterface({input:process.stdin}).on('line',line=>{
 const p=JSON.parse(line);
 appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({method:p.method,params:p.params})+'\n');
 if(p.method==='initialize')out({id:p.id,result:{}});
 if(p.method==='thread/resume'){thread=p.params.threadId;out({id:p.id,result:{thread:{id:thread}}});}
 if(p.method==='thread/start'){thread='fresh';out({id:p.id,result:{thread:{id:thread}}});}
 if(p.method==='turn/start'){
  const turn='turn-'+(++n);
  out({id:p.id,result:{turn:{id:turn,status:'inProgress'}}});
  setTimeout(()=>out({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}}),10);
 }
});`

let dir: string, repo: string, db: MemoryDatabase, ops: MemoryOperations, fleet: HubTeamRuntime, log: string
const leaderKey = randomUUID(), memberKey = randomUUID()
const minutes = (offset: number) => new Date(Date.now() + offset * 60_000).toISOString()
const agent = (id: string, cwd: string, cli: string): AgentContext => ({ agent_id: id, session_id: `native:${id.padEnd(64, '0')}`, cli_kind: cli, client: cli, cwd, orca_workspace_id: `${randomUUID()}::${cwd}` } as AgentContext)

async function session(id: string, key: string, cwd: string, cli: string, scope: string) {
  const context = agent(id, cwd, cli)
  const joined = await ops.chat.lifecycle(context, { session_key: key, native_id: id, event: 'SessionStart', at: new Date().toISOString() })
  await existingChannel(ops.chat, joined, scope)
  await ops.chat.call('chat_set_nick', { session_key: key, nickname: `Nick ${id}`, }, context)
  return joined as { session: { id: string }; channel: { id: string } }
}

/** A team whose Codex member failed on an exhausted quota; its process identity is the one the fleet persisted. */
async function seedFailedMember(generation = 'gen-1') {
  const leader = await session('leader', leaderKey, dir, 'claude_code', 'leader'), member = await session('member', memberKey, repo, 'codex_cli', 'member')
  await db.query('UPDATE chat_channels SET leader_id=$2 WHERE id=$1', [leader.channel.id, leader.session.id])
  await db.query('UPDATE chat_channels SET path=$2 WHERE id=$1', [member.channel.id, repo])
  const team = randomUUID(), thread = randomUUID(), memberId = randomUUID()
  await db.query('INSERT INTO chat_threads(id,channel_id,title,created_by) VALUES($1,$2,$3,$4)', [thread, leader.channel.id, 'Equipo', leader.session.id])
  await db.query(`INSERT INTO chat_team_plans(id,master_channel_id,root_thread_id,created_by,objective,parent,base_revision,plan,digest,state,human_instruction)
    VALUES($1,$2,$3,$4,'Reanudar tras cuota','{}',$5,'{}',$6,'launched','Aprobado')`, [team, leader.channel.id, thread, leader.session.id, 'a'.repeat(40), 'b'.repeat(64)])
  const runtime = { id: memberId, provider: 'hub', cli: 'codex_cli', cwd: repo, model: 'exact-model', state: 'failed', error_code: 'fleet_turn_failed', error_cause: 'quota_exhausted',
    error_evidence: 'protocol', native_id: 'thread-1', generation, pid: 424242, process_started: 'INICIO', updated_at: minutes(-9) }
  await db.query(`INSERT INTO chat_team_members(id,team_id,ordinal,worktree_name,cli,model,role,task,prompt,capabilities,state,session_id,channel_id,workspace_path,runtime)
    VALUES($1,$2,0,'member','codex_cli','exact-model','implementer','task','prompt','{}','joined',$3,$4,$5,$6)`, [memberId, team, member.session.id, member.channel.id, repo, JSON.stringify(runtime)])
  return { team, memberId, leader }
}

/** Exhausted before the failure, available now: the pool leaves exhaustion and the failure is explained by an observation. */
async function quotaCameBack() {
  const bound = await ops.usage.bind({ binding_id: 'client-member', cli: 'codex_cli', provider: 'openai', account_ref: 'a'.repeat(64), sample_started_at: minutes(-30) })
  const observation = (observed_at: string, used: number) => ({ cli: 'codex_cli', provider: 'openai', account_ref: 'a'.repeat(64), pool_id: 'codex', observed_at, expires_at: minutes(60),
    source: { kind: 'native' as const, adapter: 'codex-app-server' }, complete: true, windows: [{ id: 'five_hour', unit: 'percent' as const, used, limit: 100, resets_at: minutes(120) }] })
  await ops.usage.ingest(observation(minutes(-10), 100), bound)
  return (await ops.usage.ingest(observation(minutes(-1), 5), bound)).transitions
}

const incidents = () => db.query('SELECT cause,action,generation FROM process_incidents ORDER BY cause')
const launches = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { method: string; params: Record<string, any> })

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'hub-quota-restart-')))
  db = new MemoryDatabase(join(dir, 'memory.sqlite')); await db.migrate()
  ops = new MemoryOperations(new MemoryStore(db, dir), new MemoryAI(async () => defaultAI, new Vault(dir)))
  repo = join(dir, 'repo'); await mkdir(repo)
  await exec('git', ['init', repo])
  await exec('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture'])
  repo = await realpath(repo)
  const script = join(dir, 'fixture.cjs'); log = join(dir, 'fixture.log')
  await writeFile(script, fixture)
  fleet = new HubTeamRuntime(ops.chat, join(dir, 'state'), () => true, {
    requestTimeoutMs: 1500, shutdownTimeoutMs: 50,
    launcher: (command, args, options) => spawn(process.execPath, [script, command, JSON.stringify(args)], { ...options, env: { ...options.env, FIXTURE_LOG: log }, stdio: 'pipe' }),
    run: async (command, args, options) => {
      if (command === 'git') return exec(command, args, options)
      const out = args.indexOf('--out')
      if (args.includes('generate-json-schema') && out >= 0) await writeFile(join(args[out + 1]!, 'schema.json'), schema)
      return { stdout: help }
    },
  })
})
afterEach(async () => { await fleet.close(); await db.close(); await rm(dir, { recursive: true, force: true }) })

/** The clock's own reconciliation, with the member's previous process already gone. */
const reconciler = (reusedBy?: string) => {
  const processes: ProcessControl = { inspect: async () => reusedBy ? { started: reusedBy } : null, signal: () => undefined }
  const clock = new ScheduleRuntime({ store: new ScheduleStore(db), db, processes, now: () => new Date() } as never)
  return { start: () => clock.reconcileOrphans(), clock }
}

it('resumes a member that failed on an exhausted quota after a restart: the clock records its exit, then the sweep resumes it once', async () => {
  const { memberId, leader } = await seedFailedMember()
  await quotaCameBack()
  const recovery = createFleetRecovery(db, ops.usage, fleet, ops.usageNotices)!
  const { start, clock } = reconciler()
  try {
    // A sweep that comes first finds no proof that the child is gone: it waits and keeps the single attempt.
    expect((await recovery.recover())[0]).toMatchObject({ member_id: memberId, result: 'skipped', reason: 'exit_unconfirmed', evidence: 'protocol' })
    expect((await incidents()).map(row => row.cause)).toEqual(['quota_exhausted'])
    expect(await launches()).toEqual([])
    // The startup order: the clock reconciles restart incidents, then the sweep runs.
    await startClockThenRecover({ start }, recovery)
    expect(await incidents()).toEqual([
      { cause: 'hub_restart', action: 'already_exited', generation: 'gen-1' },
      { cause: 'quota_exhausted', action: 'none', generation: 'gen-1' },
      { cause: 'quota_resume', action: 'resumed', generation: 'gen-1' }])
    const calls = await launches()
    expect(calls.map(call => call.method)).toContain('thread/resume')
    expect(calls.find(call => call.method === 'thread/resume')!.params.threadId).toBe('thread-1')
    expect(JSON.stringify(calls.find(call => call.method === 'turn/start')!.params)).toContain(QUOTA_RESUME_PROMPT)
    expect(calls.some(call => call.method === 'thread/start')).toBe(false)
    await expect.poll(async () => (await db.query('SELECT runtime FROM chat_team_members WHERE id=$1', [memberId]))[0]!.runtime.state, { timeout: 10_000 }).toBe('idle')
    const resumed = (await db.query('SELECT runtime FROM chat_team_members WHERE id=$1', [memberId]))[0]!.runtime
    expect(resumed).toMatchObject({ native_id: 'thread-1', cli: 'codex_cli', model: 'exact-model' })
    expect(resumed.generation).not.toBe('gen-1')
    const notices = await ops.usageNotices.pending(leader.session.id)
    expect(notices.map(item => (item.payload as { kind: string }).kind)).toEqual(['fleet_resumption'])
    expect(notices[0]!.payload).toMatchObject({ members: [{ member_id: memberId, result: 'resumed' }] })
    // Nothing is left to resume and nothing is attempted twice.
    expect(await recovery.recover()).toEqual([])
    expect((await launches()).filter(call => call.method === 'thread/resume')).toHaveLength(1)
  } finally { await clock.close() }
})

it('does not resume when the pid now belongs to another process, and leaves the attempt unspent', async () => {
  const { memberId } = await seedFailedMember()
  await quotaCameBack()
  const recovery = createFleetRecovery(db, ops.usage, fleet, ops.usageNotices)!
  const { start, clock } = reconciler('OTRO INICIO')
  try {
    await startClockThenRecover({ start }, recovery)
    expect((await incidents()).map(row => [row.cause, row.action])).toEqual([['hub_restart', 'unverified_left_running'], ['quota_exhausted', 'none']])
    expect(await launches()).toEqual([])
    expect((await db.query('SELECT runtime FROM chat_team_members WHERE id=$1', [memberId]))[0]!.runtime.state).toBe('failed')
  } finally { await clock.close() }
})

it('waits while the quota is still exhausted and resumes on the next sweep once the pool is back', async () => {
  const { memberId } = await seedFailedMember()
  const bound = await ops.usage.bind({ binding_id: 'client-member', cli: 'codex_cli', provider: 'openai', account_ref: 'a'.repeat(64), sample_started_at: minutes(-30) })
  const observe = (observed_at: string, used: number) => ops.usage.ingest({ cli: 'codex_cli', provider: 'openai', account_ref: 'a'.repeat(64), pool_id: 'codex', observed_at, expires_at: minutes(60),
    source: { kind: 'native', adapter: 'codex-app-server' }, complete: true, windows: [{ id: 'five_hour', unit: 'percent', used, limit: 100, resets_at: minutes(120) }] }, bound)
  await observe(minutes(-10), 100)
  const recovery = createFleetRecovery(db, ops.usage, fleet, ops.usageNotices)!
  const { start, clock } = reconciler()
  try {
    await start()
    expect((await recovery.recover())[0]).toMatchObject({ member_id: memberId, result: 'skipped', reason: 'quota_not_recovered' })
    expect((await incidents()).map(row => row.cause)).toEqual(['hub_restart', 'quota_exhausted'])
    const restored = (await observe(minutes(-1), 5)).transitions
    expect((await recovery.onTransitions(restored))[0]).toMatchObject({ member_id: memberId, result: 'resumed' })
  } finally { await clock.close() }
})
