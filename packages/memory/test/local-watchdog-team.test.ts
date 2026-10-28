import { beforeEach, afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { LocalChat } from '../src/local-chat.js'
import { LocalWatchdog } from '../src/local-watchdog.js'

let directory: string, db: MemoryDatabase, chat: LocalChat, observer: LocalWatchdog, now: number
let master: string, child: string, root: string, linked: string, plan: string, member: string
const leader = 'team-leader', worker = 'team-worker'
const iso = (value: number) => new Date(value).toISOString()
const observed = async () => (await db.query('SELECT session_id,work_id FROM chat_watchdog_observations ORDER BY session_id,work_id')).map(row => `${row.session_id}/${row.work_id}`)
const channel = async (id: string, name: string) => db.query(`INSERT INTO chat_channels(id,scope_key,path,name,orca_workspace_id) VALUES($1,$2,$3,$4,$5)`,
  [id, `orca:${id}`, join(directory, name), name, `${id}::${directory}`])
const session = async (id: string, channelId: string) => db.query(`INSERT INTO chat_sessions(id,agent_id,key_hash,label,nickname,cli_kind,channel_id,state,event_at,last_seen_at,lease_until)
  VALUES($1,'team-client',$2,$1,$1,'codex_cli',$3,'idle',$4,$5,$6)`, [id, createHash('sha256').update(randomUUID()).digest('hex'), channelId, iso(now - 300_000), iso(now), iso(now + 90_000)])
const thread = async (id: string, channelId: string, rootId: string | null = null) =>
  db.query("INSERT INTO chat_threads(id,channel_id,title,created_by,team_root_thread_id) VALUES($1,$2,'team',$3,$4)", [id, channelId, leader, rootId])
const work = async (sessionId: string, threadId: string, workId = 'task') => db.query(`INSERT INTO chat_work_state(session_id,work_id,thread_id,status,summary,version,updated_at)
  VALUES($1,$2,$3,'active','fixture',1,$4)`, [sessionId, workId, threadId, iso(now - 300_000)])

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hub-watchdog-team-'))
  db = new MemoryDatabase(join(directory, 'memory.sqlite')); await db.migrate()
  chat = new LocalChat(new MemoryStore(db, directory)); now = Date.now()
  ;[master, child, root, linked, plan, member] = Array.from({ length: 6 }, () => randomUUID())
  await channel(master, 'master'); await channel(child, 'child')
  await session(leader, master); await session(worker, child)
  await db.query('UPDATE chat_channels SET leader_id=$1 WHERE id=$2', [leader, master])
  await thread(root, master); await thread(linked, master, root)
  await db.query(`INSERT INTO chat_team_plans(id,master_channel_id,root_thread_id,created_by,objective,parent,base_revision,plan,digest,state)
    VALUES($1,$2,$3,$4,'objective','{}','virtual','{}',$5,'launched')`, [plan, master, root, leader, randomUUID()])
  await db.query(`INSERT INTO chat_team_members(id,team_id,ordinal,worktree_name,cli,model,role,task,prompt,state,session_id,channel_id,work_thread_id)
    VALUES($1,$2,1,'worker','codex_cli','model','role','task','prompt','joined',$3,$4,$5)`, [member, plan, worker, child, linked])
  observer = new LocalWatchdog(chat, () => true, () => now)
})
afterEach(async () => { await observer.close(); await db.close(); await rm(directory, { recursive: true, force: true }) })

it('observes the work thread of a worker that lives in its own child channel', async () => {
  await work(worker, linked); await observer.tick()
  expect(await observed()).toEqual([`${worker}/task`])
})

it('observes a thematic thread linked to the team root', async () => {
  const thematic = randomUUID(); await thread(thematic, master, root)
  await work(worker, thematic); await observer.tick()
  expect(await observed()).toEqual([`${worker}/task`])
})

it('observes the coordinator working on the team root thread', async () => {
  await work(leader, root); await observer.tick()
  expect(await observed()).toEqual([`${leader}/task`])
})

it('keeps observing local work that has no team', async () => {
  const local = randomUUID(); await thread(local, master)
  await session('local-peer', master); await work('local-peer', local); await observer.tick()
  expect(await observed()).toEqual(['local-peer/task'])
})

it('never falls back to the local case for a thread linked to a root without a plan', async () => {
  const orphanRoot = randomUUID(), orphan = randomUUID()
  await thread(orphanRoot, master); await thread(orphan, master, orphanRoot)
  await session('master-peer', master); await work('master-peer', orphan); await observer.tick()
  expect(await observed()).toEqual([])
})

it.each(['completed', 'cancelled', 'paused', 'prepared'])('skips a team whose plan is %s', async state => {
  await work(worker, linked); await db.query('UPDATE chat_team_plans SET state=$1', [state]); await observer.tick()
  expect(await observed()).toEqual([])
})

it('skips a replaced member whose session no longer belongs to the plan', async () => {
  await work(worker, linked)
  await db.query('UPDATE chat_team_members SET session_id=NULL,channel_id=NULL WHERE id=$1', [member]); await observer.tick()
  expect(await observed()).toEqual([])
})

it('skips a member that is no longer joined', async () => {
  await work(worker, linked); await db.query("UPDATE chat_team_members SET state='closed'"); await observer.tick()
  expect(await observed()).toEqual([])
})

it('skips the team when the plan creator is no longer the channel leader', async () => {
  await work(worker, linked); await session('other-leader', master)
  await db.query('UPDATE chat_channels SET leader_id=$1 WHERE id=$2', ['other-leader', master]); await observer.tick()
  expect(await observed()).toEqual([])
})

it('skips the team when the plan creator was removed', async () => {
  await work(worker, linked); await db.query('UPDATE chat_sessions SET removed_at=$2 WHERE id=$1', [leader, iso(now)]); await observer.tick()
  expect(await observed()).toEqual([])
})

it.each(['master', 'child'])('skips the team when the %s channel is closed', async scope => {
  await work(worker, linked); await db.query('UPDATE chat_channels SET closed_at=$2 WHERE id=$1', [scope === 'master' ? master : child, iso(now)]); await observer.tick()
  expect(await observed()).toEqual([])
})

it('records a late report from the worker without asking it for status again', async () => {
  await work(worker, linked)
  const message = randomUUID()
  await db.query(`INSERT INTO chat_messages(id,thread_id,author_id,text,request_id,request_hash) VALUES($1,$2,$3,'report','late','hash')`, [message, linked, worker])
  await db.query("UPDATE chat_work_state SET status='completed',report_message_id=$1", [message])
  await db.query(`INSERT INTO chat_deliveries(message_id,recipient_id,notified_at,read_at,handled_at) VALUES($1,$2,$3,$3,$3)`, [message, leader, iso(now - 1)])
  await observer.tick()
  const row = (await db.query('SELECT decision FROM chat_watchdog_observations'))[0]!
  expect(row.decision.action).not.toBe('ASK_STATUS')
  expect(await db.query('SELECT * FROM chat_status_notices')).toHaveLength(0)
})
