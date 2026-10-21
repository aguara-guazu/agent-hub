import { beforeEach, afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { LocalChat } from '../src/local-chat.js'
import { LocalWatchdog } from '../src/local-watchdog.js'
import { exportMemory, readBackup, restoreMemory } from '../src/backup.js'

let directory:string,db:MemoryDatabase,chat:LocalChat,observer:LocalWatchdog,now:number,channel:string,thread:string
const session='watchdog-worker',leader='watchdog-leader',key=randomUUID()
const agent={agent_id:'watchdog-client',session_id:session,cli_kind:'codex_cli',client:'Codex'}
const iso=(value:number)=>new Date(value).toISOString()
const observation=async(workId='task')=>(await db.query('SELECT * FROM chat_watchdog_observations WHERE session_id=$1 AND work_id=$2',[session,workId]))[0]!
async function work(workId='task',status='active',waitingFor:string|null=null) {
  await db.query(`INSERT INTO chat_work_state(session_id,work_id,thread_id,status,summary,waiting_for,version,updated_at)
    VALUES($1,$2,$3,$4,'Private user text must never enter an observer snapshot',$5,1,$6)`,[session,workId,thread,status,waitingFor,iso(now-300_000)])
}
async function report({attempts=1,read=false,notified=false,recipient=leader,error='transport failed'}={}) {
  const id=randomUUID()
  await db.query(`INSERT INTO chat_messages(id,thread_id,author_id,text,request_id,request_hash) VALUES($1,$2,$3,'report','report','hash')`,[id,thread,session])
  await db.query("UPDATE chat_work_state SET status='completed',report_message_id=$1 WHERE work_id='task'",[id])
  await db.query(`INSERT INTO chat_deliveries(message_id,recipient_id,attempts,next_attempt_at,error,read_at,notified_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,recipient,attempts,iso(now-1),error,read?iso(now-1):null,notified?iso(now-60_000):null])
}
beforeEach(async()=>{
  directory=await mkdtemp(join(tmpdir(),'hub-watchdog-'))
  db=new MemoryDatabase(join(directory,'memory.sqlite'));await db.migrate()
  chat=new LocalChat(new MemoryStore(db,directory));now=Date.now();channel=randomUUID();thread=randomUUID()
  await db.query(`INSERT INTO chat_channels(id,scope_key,path,name,orca_workspace_id) VALUES($1,$2,$3,'test',$4)`,[channel,`orca:${channel}`,directory,`${channel}::${directory}`])
  for(const id of [session,leader])await db.query(`INSERT INTO chat_sessions(id,agent_id,key_hash,label,nickname,cli_kind,channel_id,state,event_at,last_seen_at,lease_until)
    VALUES($1,'watchdog-client',$2,$1,$1,'codex_cli',$3,'idle',$4,$5,$6)`,
  [id,createHash('sha256').update(id===session?key:randomUUID()).digest('hex'),channel,iso(now-300_000),iso(now),iso(now+90_000)])
  await db.query('UPDATE chat_channels SET leader_id=$1 WHERE id=$2',[leader,channel])
  await db.query("INSERT INTO chat_threads(id,channel_id,title,created_by) VALUES($1,$2,'watchdog',$3)",[thread,channel,leader])
  observer=new LocalWatchdog(chat,()=>true,()=>now)
})
afterEach(async()=>{await observer.close();await db.close();await rm(directory,{recursive:true,force:true})})

it('records a hypothetical status inquiry without touching sessions, messages, deliveries or work',async()=>{
  await work()
  const tables=['chat_sessions','chat_messages','chat_deliveries','chat_work_state','chat_work_events']
  const before=await Promise.all(tables.map(table=>db.query(`SELECT * FROM ${table}`)))
  await observer.tick()
  expect((await observation()).decision).toMatchObject({action:'ASK_STATUS',reason:'incomplete_work_idle'})
  expect(await Promise.all(tables.map(table=>db.query(`SELECT * FROM ${table}`)))).toEqual(before)
  expect(JSON.stringify(await db.query('SELECT * FROM chat_watchdog_events'))).not.toContain('Private user text')
  expect((await observation()).snapshot.recovery.statusAttempts).toBe(0)
})

it.each(['human','permission','schedule','tool','agent'])('protects a %s wait even with stale presence',async waitingFor=>{
  await work('task','waiting',waitingFor)
  await db.query('UPDATE chat_sessions SET lease_until=$1,last_seen_at=$1',[iso(now-600_000)])
  await observer.tick()
  expect((await observation()).decision).toMatchObject({action:'WAIT',reason:'explicit_wait'})
})

it('does not treat busy silence or an expired lease as a stuck process',async()=>{
  await work();await db.query("UPDATE chat_sessions SET state='busy' WHERE id=$1",[session]);await observer.tick()
  expect((await observation()).decision.action).toBe('UNKNOWN')
  now+=31_000;await db.query("UPDATE chat_sessions SET state='idle',lease_until=$2 WHERE id=$1",[session,iso(now-1)])
  await observer.tick();expect((await observation()).decision.reason).toBe('session_lease_expired')
})

it('coalesces concurrent ticks and preserves deduplication through observer restart',async()=>{
  await work();await Promise.all([observer.tick(),observer.tick(),observer.tick()])
  expect((await db.query('SELECT count(*) AS n FROM chat_watchdog_events'))[0].n).toBe(1)
  await observer.close();observer=new LocalWatchdog(chat,()=>true,()=>now)
  now+=31_000;await observer.tick()
  expect((await db.query('SELECT count(*) AS n FROM chat_watchdog_events'))[0].n).toBe(1)
  expect((await observation()).decision.action).toBe('ASK_STATUS')
  expect((await observation()).snapshot.recovery.statusAttempts).toBe(0)
})

it('uses the persisted report recipient receipt, preserving transport attempts',async()=>{
  await work();await report()
  const before=await db.query('SELECT * FROM chat_deliveries');await observer.tick()
  expect((await observation()).decision).toMatchObject({action:'RETRY_DELIVERY',reason:'delivery_failed'})
  expect(await db.query('SELECT * FROM chat_deliveries')).toEqual(before)
  await db.query('UPDATE chat_deliveries SET read_at=$1',[iso(now)])
  now+=31_000;await observer.tick()
  expect((await observation()).decision).toMatchObject({action:'WAIT',reason:'report_read_unhandled'})
})

it('surfaces an exhausted unread notification budget without asking the completed worker',async()=>{
  await work();await report({attempts:5,notified:true,error:''});await observer.tick()
  expect((await observation()).decision).toMatchObject({action:'ALERT',reason:'unread_notification_budget_exhausted'})
  expect((await db.query('SELECT count(*) AS n FROM chat_messages'))[0].n).toBe(1)
})

it('does not recommend retrying a report to an unavailable recipient',async()=>{
  await work();await report();await db.query("UPDATE chat_sessions SET closed_at=$2,state='offline' WHERE id=$1",[leader,iso(now)])
  await observer.tick();expect((await observation()).decision.reason).toBe('report_recipient_unavailable')
})

it('keeps completion without an intended recipient receipt unknown',async()=>{
  await work();await report();await db.query('DELETE FROM chat_deliveries');await observer.tick()
  expect((await observation()).decision).toMatchObject({action:'UNKNOWN',reason:'delivery_receipt_unknown'})
})

it.each(['channel','removed','thread'])('skips a closed/revoked %s scope',async scope=>{
  await work()
  if(scope==='channel')await db.query('UPDATE chat_channels SET closed_at=$1',[iso(now)])
  if(scope==='removed')await db.query('UPDATE chat_sessions SET removed_at=$2 WHERE id=$1',[session,iso(now)])
  if(scope==='thread')await db.query("UPDATE chat_threads SET state='resolved'")
  await observer.tick();expect(await db.query('SELECT * FROM chat_watchdog_observations')).toHaveLength(0)
})

it('records disabled clients as protected and does not strand the scan cursor',async()=>{
  await work();await observer.close();observer=new LocalWatchdog(chat,()=>false,()=>now);await observer.tick()
  expect((await observation()).decision.reason).toBe('client_disabled')
  expect((await observation()).next_scan_at).toBe(iso(now+30_000))
})

it('bounds each batch and fairly reaches all 501 tasks',async()=>{
  await db.query(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<501)
    INSERT INTO chat_work_state(session_id,work_id,thread_id,status,summary,version,updated_at)
    SELECT $1,'task-'||n,$2,'active','fixture',1,$3 FROM numbers`,[session,thread,iso(now-300_000)])
  await observer.tick();expect((await db.query('SELECT count(*) AS n FROM chat_watchdog_observations'))[0].n).toBe(100)
  for(let i=0;i<5;i++)await observer.tick()
  expect((await db.query('SELECT count(*) AS n FROM chat_watchdog_observations'))[0].n).toBe(501)
  expect((await db.query('SELECT count(*) AS n FROM chat_watchdog_events'))[0].n).toBe(501)
})

it('caps transition history while keeping the latest observation for each work item',async()=>{
  await work();await observer.tick()
  await db.query(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<1005)
    INSERT INTO chat_watchdog_events(session_id,work_id,work_version,policy_version,policy_config,decision,snapshot,observed_at)
    SELECT e.session_id,e.work_id,e.work_version,e.policy_version,e.policy_config,e.decision,e.snapshot,e.observed_at
    FROM chat_watchdog_events e,numbers WHERE e.seq=1`)
  now+=31_000;await observer.tick()
  expect((await db.query('SELECT count(*) AS n FROM chat_watchdog_events'))[0].n).toBe(1000)
  expect((await observation()).decision.action).toBe('ASK_STATUS')
})

it('exposes shadow evidence through the authorized work list and marks version changes stale',async()=>{
  await work();await observer.tick()
  const list=()=>chat.call('chat_work_list',{session_key:key,thread_id:thread},agent)
  expect((await list()).items[0].watchdog).toMatchObject({mode:'shadow',stale:false,decision:{action:'ASK_STATUS'}})
  await chat.call('chat_work_update',{session_key:key,thread_id:thread,work_id:'task',request_id:'wait',expected_version:1,event:'waiting',waiting_for:'human',summary:'Need a reply'},agent)
  expect((await list()).items[0].watchdog.stale).toBe(true)
  now=Date.now();await observer.tick()
  expect((await list()).items[0].watchdog).toMatchObject({stale:false,decision:{action:'WAIT'}})
  await expect(chat.call('chat_work_list',{session_key:key,thread_id:thread},{...agent,agent_id:'foreign'})).rejects.toThrow()
})

it('preserves observation evidence in backup and restores without creating messages',async()=>{
  await work();await observer.tick()
  const store=new MemoryStore(db,directory),backup=JSON.parse(await readBackup(store,(await exportMemory(store)).id))
  expect(backup.schema_version).toBe(14)
  const restored=new MemoryDatabase(join(directory,'restored.sqlite'));await restored.migrate()
  try {
    await restoreMemory(new MemoryStore(restored,join(directory,'restored')),backup)
    expect((await restored.query('SELECT * FROM chat_watchdog_events'))[0].decision.action).toBe('ASK_STATUS')
    expect(await restored.query('SELECT * FROM chat_messages')).toHaveLength(0)
  }finally{await restored.close()}
})

it.each(['offline','read','resolved','coordinator','recipient-offline'])('invalidates prior evidence immediately after %s changes, before a new scan',async change=>{
  await work();await report();await observer.tick()
  const list=()=>chat.call('chat_work_list',{session_key:key,thread_id:thread},agent)
  expect((await list()).items[0].watchdog.stale).toBe(false)
  if(change==='offline'){
    // Read as the coordinator: the offline worker can no longer call the tool itself.
    await db.query("UPDATE chat_sessions SET state='offline' WHERE id=$1",[session])
  }
  if(change==='read')await db.query('UPDATE chat_deliveries SET read_at=$1',[iso(now)])
  if(change==='resolved')await db.query("UPDATE chat_threads SET state='resolved'")
  if(change==='coordinator')await db.query('UPDATE chat_channels SET leader_id=$1',[session])
  if(change==='recipient-offline')await db.query('UPDATE chat_sessions SET closed_at=$2 WHERE id=$1',[leader,iso(now)])
  expect((await list()).items[0].watchdog.stale).toBe(true)
})

it('does not require a coordinator to mention itself to persist its own report',async()=>{
  await work();await report();await db.query('DELETE FROM chat_deliveries')
  await db.query('UPDATE chat_channels SET leader_id=$1',[session]);await observer.tick()
  expect((await observation()).decision).toMatchObject({action:'WAIT',reason:'coordinator_report_persisted'})
})
