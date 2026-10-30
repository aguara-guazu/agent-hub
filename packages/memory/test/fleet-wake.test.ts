import { existingChannel } from './helpers/chat-channel.js'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryOperations } from '../src/operations.js'
import { MemoryAI } from '../src/ai.js'
import { Vault,defaultAI } from '../src/config.js'
import { LocalChatRuntime,type FleetReadiness } from '../src/local-chat-runtime.js'
import { sessionStatus } from '../src/local-chat.js'
import { FleetActivityBuffer } from '../src/fleet-activity.js'
import type { AgentContext } from '../src/agents.js'

let directory:string,db:MemoryDatabase,ops:MemoryOperations,runtime:LocalChatRuntime|undefined
const git=(...args:string[])=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']})
const agent=(name:string):AgentContext=>({agent_id:`fleet-wake-${name}`,session_id:`native:${name.padEnd(64,'0')}`,cli_kind:'codex_cli',client:'Codex',cwd:directory})
beforeEach(async()=>{
  directory=await mkdtemp(join(tmpdir(),'hub-fleet-wake-'));git('init','-q','-b','main')
  git('-c','user.name=t','-c','user.email=t@invalid','-c','commit.gpgSign=false','commit','--allow-empty','-qm','seed')
  db=new MemoryDatabase(join(directory,'memory.sqlite'));await db.migrate()
  ops=new MemoryOperations(new MemoryStore(db,directory),new MemoryAI(async()=>defaultAI,new Vault(directory)))
})
afterEach(async()=>{await runtime?.close();runtime=undefined;await db.close();await rm(directory,{recursive:true,force:true})})

type Who=Awaited<ReturnType<typeof register>>
async function register(name:string) {
  const a=agent(name),key=randomUUID()
  const r=await ops.chat.lifecycle(a,{session_key:key,native_id:name,event:'SessionStart',at:new Date().toISOString()})
  await existingChannel(ops.chat,r,directory)
  const named=await ops.call('chat_set_nick',{session_key:key,nickname:`Fleet ${name}`},'mcp',a)
  return {a,key,...r,session:named.session}
}
/** A session shaped like a hookless Kiro worker: Hub-owned, no native id on its row. */
async function worker(capability='hub_fleet',state='idle',eventAt=new Date().toISOString()) {
  const w=await register('worker')
  await db.query("UPDATE chat_sessions SET capability=$2,native_id=NULL,cli_kind='kiro',state=$3,event_at=$4,lease_until=$5 WHERE id=$1",
    [w.session.id,capability,state,eventAt,new Date(Date.now()+60_000).toISOString()])
  return w
}
const send=(from:Who,to:Who)=>ops.call('chat_send',{session_key:from.key,channel_id:from.channel.id,title:'Trabajo',text:'Decisión del líder',mentions:[to.session.id],request_id:randomUUID()},'mcp',from.a)
const delivery=async(messageId:string,recipient:string)=>(await db.query('SELECT * FROM chat_deliveries WHERE message_id=$1 AND recipient_id=$2',[messageId,recipient]))[0]
const makeDue=(messageId:string)=>db.query("UPDATE chat_deliveries SET next_attempt_at='1970-01-01T00:00:00.000Z' WHERE message_id=$1",[messageId])
const fleet=()=>({
  wake:vi.fn(async(_sessionId:string,_text:string)=>true),
  connected:vi.fn(async(_sessionId:string)=>true),
  readiness:vi.fn(async(_sessionId:string):Promise<FleetReadiness>=>'idle'),
  activityAt:vi.fn(async(_sessionId:string):Promise<{at:string;turn_id:string}|undefined>=>undefined)
})
const start=(f:ReturnType<typeof fleet>,queue=vi.fn(async()=>{}))=>{
  runtime=new LocalChatRuntime(ops.chat,queue,()=>true,async()=>undefined,()=>true,f)
  return runtime
}
const stalled=()=>db.query("SELECT * FROM chat_status_notices WHERE cause='delivery_stalled'")

it('wakes a hub_fleet worker whose session row has no native id',async()=>{
  const leader=await register('leader'),w=await worker()
  const message=await send(leader,w),f=fleet()
  await start(f).tick()
  expect(f.wake).toHaveBeenCalledTimes(1)
  expect(f.wake.mock.calls[0]![0]).toBe(w.session.id)
  expect(f.wake.mock.calls[0]![1]).toContain(message.id)
  const d=await delivery(message.id,w.session.id)
  expect(d.notified_at).toBeTruthy();expect(d.attempts).toBe(1);expect(d.error).toBeNull()
})

it('keeps requiring a native id for the codex queue transport',async()=>{
  const leader=await register('leader'),w=await worker('codex_queue')
  const message=await send(leader,w),f=fleet(),queue=vi.fn(async()=>{})
  await start(f,queue).tick()
  expect(queue).not.toHaveBeenCalled();expect(f.wake).not.toHaveBeenCalled()
  expect((await delivery(message.id,w.session.id)).attempts).toBe(0)
})

it('trusts the process owner over a stale persisted state',async()=>{
  const leader=await register('leader'),w=await worker('hub_fleet','busy',new Date(Date.now()-600_000).toISOString())
  const message=await send(leader,w),f=fleet()
  await start(f).tick()
  expect(f.wake).toHaveBeenCalledTimes(1)
  expect((await delivery(message.id,w.session.id)).notified_at).toBeTruthy()
})

it('defers without spending an attempt while the process cannot take input, then delivers',async()=>{
  const leader=await register('leader'),w=await worker()
  const message=await send(leader,w),f=fleet()
  f.readiness.mockResolvedValue('busy')
  const dispatcher=start(f)
  await dispatcher.tick();await dispatcher.tick()
  expect(f.wake).not.toHaveBeenCalled()
  expect((await delivery(message.id,w.session.id)).attempts).toBe(0)
  f.readiness.mockResolvedValue('idle')
  await dispatcher.tick()
  const d=await delivery(message.id,w.session.id)
  expect(f.wake).toHaveBeenCalledTimes(1);expect(d.notified_at).toBeTruthy()
})

it('returns the attempt when the process refuses transiently, however often that repeats',async()=>{
  const leader=await register('leader'),w=await worker()
  const message=await send(leader,w),f=fleet()
  f.wake.mockRejectedValue(Object.assign(new Error('not idle yet'),{retryLater:true}))
  const dispatcher=start(f)
  for(let i=0;i<7;i++){await makeDue(message.id);await dispatcher.tick()}
  const d=await delivery(message.id,w.session.id)
  expect(f.wake).toHaveBeenCalledTimes(7)
  expect(d.attempts).toBe(0);expect(d.notified_at).toBeNull();expect(d.error).toBeNull()
  expect((await db.query('SELECT wake_error FROM chat_sessions WHERE id=$1',[w.session.id]))[0].wake_error).toBeNull()
})

it('spends attempts on a process the Hub does not own and stops at five with the cause recorded',async()=>{
  const leader=await register('leader'),w=await worker()
  const message=await send(leader,w),f=fleet()
  f.readiness.mockResolvedValue('unowned');f.wake.mockResolvedValue(false)
  const dispatcher=start(f)
  for(let i=0;i<8;i++){await makeDue(message.id);await dispatcher.tick()}
  const d=await delivery(message.id,w.session.id)
  expect(f.wake).toHaveBeenCalledTimes(5)
  expect(d.attempts).toBe(5);expect(d.notified_at).toBeNull();expect(d.error).toBeTruthy()
})

it('does not send team bootstrap to idle hub_fleet rows without a native id',async()=>{
  const leader=await register('leader'),w=await worker()
  await db.query('UPDATE chat_channels SET leader_id=$2 WHERE id=$1',[w.channel.id,leader.session.id])
  await db.query('UPDATE chat_sessions SET team_seen=0,bootstrap_attempts=0,bootstrap_sent_at=NULL WHERE id=$1',[w.session.id])
  const f=fleet()
  await start(f).tick()
  expect(f.wake).not.toHaveBeenCalled()
})

it('tells the sender once when a Hub-managed recipient never received a mention',async()=>{
  const leader=await register('leader'),w=await worker()
  const message=await send(leader,w),now=Date.now()
  await ops.chat.processStalledDeliveries(now+599_000);expect(await stalled()).toHaveLength(0)
  await ops.chat.processStalledDeliveries(now+601_000);await ops.chat.processStalledDeliveries(now+700_000)
  const rows=await stalled()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({recipient_id:leader.session.id,session_id:w.session.id,work_thread_id:message.thread_id})
  const item=(await ops.call('chat_inbox',{session_key:leader.key},'mcp',leader.a)).items.find((i:any)=>i.cause==='delivery_stalled')
  expect(item).toMatchObject({kind:'status_notice',author_source:'hub',thread_id:null})
  expect(item.text).toContain(message.id);expect(item.text).toContain('team_control send')
})

it('raises the stalled notice from the dispatcher loop without any manual call',async()=>{
  const leader=await register('leader'),w=await worker()
  const message=await send(leader,w),f=fleet()
  f.readiness.mockResolvedValue('busy')
  await db.query('UPDATE chat_messages SET created_at=$2 WHERE id=$1',[message.id,new Date(Date.now()-700_000).toISOString()])
  await start(f).tick()
  expect(await stalled()).toHaveLength(1)
})

it('does not raise a stalled notice for a delivery the same tick can still make',async()=>{
  const leader=await register('leader'),w=await worker()
  const message=await send(leader,w),f=fleet()
  await db.query('UPDATE chat_messages SET created_at=$2 WHERE id=$1',[message.id,new Date(Date.now()-700_000).toISOString()])
  await start(f).tick()
  expect(f.wake).toHaveBeenCalledTimes(1)
  expect(await stalled()).toHaveLength(0)
})

it('skips mentions already escalated as unanswered and mentions older than a day',async()=>{
  const leader=await register('leader'),w=await worker()
  const escalated=await send(leader,w),ancient=await send(leader,w)
  await db.query('UPDATE chat_deliveries SET response_alerted_at=now() WHERE message_id=$1',[escalated.id])
  await db.query('UPDATE chat_messages SET created_at=$2 WHERE id=$1',[ancient.id,new Date(Date.now()-90_000_000).toISOString()])
  await ops.chat.processStalledDeliveries(Date.now()+601_000)
  expect(await stalled()).toHaveLength(0)
})

it('states the recipient state and tells a long busy turn apart from a transport failure',async()=>{
  const leader=await register('leader'),w=await worker('hub_fleet','busy')
  await send(leader,w)
  await ops.chat.processStalledDeliveries(Date.now()+601_000)
  const text=(await stalled())[0].text as string
  expect(text).toContain('recipient state: busy');expect(text).toContain('long turn');expect(text).toContain('over 10 minutes')
})

it('drops the stalled notice when the sender no longer belongs to the thread channel',async()=>{
  const leader=await register('leader'),w=await worker(),third=await register('third')
  await send(leader,w)
  await ops.chat.processStalledDeliveries(Date.now()+601_000)
  expect(await stalled()).toHaveLength(1)
  const other=await ops.call('chat_create_channel',{session_key:third.key,name:'Canal aparte',task_key:'aparte'},'mcp',third.a)
  await db.query('UPDATE chat_sessions SET channel_id=$2 WHERE id=$1',[leader.session.id,other.channel.id])
  const inbox=await ops.call('chat_inbox',{session_key:leader.key},'mcp',leader.a)
  expect(inbox.items.filter((i:any)=>i.cause==='delivery_stalled')).toHaveLength(0)
  expect((await stalled())[0].cancelled_at).toBeTruthy()
})

it('does not wake the sender with a stalled notice ahead of the delivery that resolves it',async()=>{
  const leader=await register('leader')
  await db.query("UPDATE chat_sessions SET capability='hub_fleet',native_id=NULL,cli_kind='kiro',state='idle',lease_until=$2 WHERE id=$1",[leader.session.id,new Date(Date.now()+60_000).toISOString()])
  const w=await worker()
  const message=await send(leader,w),f=fleet()
  await db.query('UPDATE chat_messages SET created_at=$2 WHERE id=$1',[message.id,new Date(Date.now()-700_000).toISOString()])
  f.readiness.mockImplementation(async id=>id===w.session.id?'busy':'idle')
  const dispatcher=start(f)
  await dispatcher.tick()
  expect(await stalled()).toHaveLength(1)
  f.readiness.mockResolvedValue('idle')
  await dispatcher.tick()
  expect(f.wake.mock.calls.map(call=>call[0])).toEqual([w.session.id])
  expect((await stalled())[0].cancelled_at).toBeTruthy()
})

it('lists a busy worker with recent output as busy in the work list and the watchdog view',async()=>{
  const leader=await register('leader'),w=await worker('hub_fleet','busy',new Date(Date.now()-600_000).toISOString())
  const thread=await send(leader,w),work={session_key:w.key,thread_id:thread.thread_id,work_id:'verify',summary:'Verificar cambio'}
  await ops.call('chat_work_update',{...work,event:'started',request_id:'start',expected_version:0},'mcp',w.a)
  const listed=()=>ops.call('chat_work_list',{session_key:leader.key,thread_id:thread.thread_id},'mcp',leader.a).then(result=>result.items[0])
  expect(await listed()).toMatchObject({session_state:'unknown',session_state_reason:'activity_stale'})
  await db.query('UPDATE chat_sessions SET output_at=$2 WHERE id=$1',[w.session.id,new Date(Date.now()-10_000).toISOString()])
  expect(await listed()).toMatchObject({session_state:'busy',session_state_reason:null})
})

it('retires the stalled notice once the recipient reads the mention',async()=>{
  const leader=await register('leader'),w=await worker()
  const message=await send(leader,w)
  await ops.chat.processStalledDeliveries(Date.now()+601_000)
  expect(await stalled()).toHaveLength(1)
  await db.query('UPDATE chat_deliveries SET read_at=now() WHERE message_id=$1',[message.id])
  const inbox=await ops.call('chat_inbox',{session_key:leader.key},'mcp',leader.a)
  expect(inbox.items.filter((i:any)=>i.cause==='delivery_stalled')).toHaveLength(0)
  expect((await stalled())[0].cancelled_at).toBeTruthy()
})

it('raises no stalled notice for transports the Hub does not wake or for delivered mentions',async()=>{
  const leader=await register('leader'),w=await worker('claude_rewake')
  await send(leader,w)
  await ops.chat.processStalledDeliveries(Date.now()+601_000)
  expect(await stalled()).toHaveLength(0)
  await db.query("UPDATE chat_sessions SET capability='hub_fleet' WHERE id=$1",[w.session.id])
  await db.query('UPDATE chat_deliveries SET notified_at=now() WHERE recipient_id=$1',[w.session.id])
  await ops.chat.processStalledDeliveries(Date.now()+601_000)
  expect(await stalled()).toHaveLength(0)
})

it('extends a busy interval with recent output but never revives a closed or silent row',()=>{
  const now=Date.parse('2026-10-30T18:00:00.000Z'),iso=(ms:number)=>new Date(now-ms).toISOString()
  const row={state:'busy',event_at:iso(300_000),lease_until:iso(-60_000),closed_at:null,removed_at:null}
  expect(sessionStatus({...row,output_at:null},now)).toMatchObject({state:'unknown',state_reason:'activity_stale'})
  expect(sessionStatus({...row,output_at:iso(30_000)},now)).toMatchObject({state:'busy',state_reason:null,state_observed_at:row.event_at})
  expect(sessionStatus({...row,output_at:iso(120_000)},now)).toMatchObject({state:'unknown',state_reason:'activity_stale'})
  expect(sessionStatus({...row,output_at:iso(30_000),closed_at:iso(10_000)},now).state).toBe('offline')
  expect(sessionStatus({...row,output_at:iso(30_000),lease_until:iso(1_000)},now)).toMatchObject({state:'unknown',state_reason:'connection_stale'})
  expect(sessionStatus({...row,state:'idle',output_at:iso(30_000)},now).state).toBe('idle')
})

it('persists output evidence only for busy rows with the same open turn, at most every thirty seconds',async()=>{
  const busy=await worker('hub_fleet','busy'),first=new Date(Date.now()-5_000).toISOString(),later=new Date().toISOString()
  const openTurn=(turn:string)=>db.query('INSERT INTO chat_turns(session_id,turn_id,opened_at,last_event_at,channel_id) VALUES($1,$2,$3,$3,$4)',[busy.session.id,turn,new Date(Date.now()-60_000).toISOString(),busy.channel.id])
  const activity=async()=>(await db.query('SELECT output_at,event_at FROM chat_sessions WHERE id=$1',[busy.session.id]))[0]
  const f=fleet();f.activityAt.mockResolvedValue({at:first,turn_id:'turn-b'})
  const dispatcher=start(f)
  await dispatcher.tick()
  expect((await activity()).output_at).toBeNull()
  await openTurn('turn-a');await db.query("UPDATE chat_turns SET terminal_at=now() WHERE turn_id='turn-a'")
  await dispatcher.tick()
  expect((await activity()).output_at).toBeNull()
  await openTurn('turn-b')
  const eventAt=(await activity()).event_at
  await dispatcher.tick()
  expect((await activity()).output_at).toBe(first)
  f.activityAt.mockResolvedValue({at:later,turn_id:'turn-b'});await dispatcher.tick()
  expect((await activity()).output_at).toBe(first)
  expect((await activity()).event_at).toBe(eventAt)
  await db.query("UPDATE chat_sessions SET state='idle',output_at=NULL WHERE id=$1",[busy.session.id])
  const idleFleet=fleet();idleFleet.activityAt.mockResolvedValue({at:later,turn_id:'turn-b'})
  await start(idleFleet).tick()
  expect((await activity()).output_at).toBeNull()
})

it('counts only assistant and tool output as work in the activity buffer',()=>{
  const buffer=new FleetActivityBuffer('prompt')
  expect(buffer.lastWorkAt).toBeUndefined()
  buffer.add('user','instrucción');buffer.add('system','aviso')
  expect(buffer.lastWorkAt).toBeUndefined()
  buffer.stream('a','assistant','texto')
  const afterAssistant=buffer.lastWorkAt
  expect(afterAssistant).toBeTypeOf('number')
  buffer.stream('b','tool','salida',true)
  expect(buffer.lastWorkAt!).toBeGreaterThanOrEqual(afterAssistant!)
  const settled=buffer.lastWorkAt
  buffer.stream('b','tool','salida repetida',true)
  expect(buffer.lastWorkAt).toBe(settled)
})
