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
import { exportMemory,readBackup,restoreMemory } from '../src/backup.js'
import { LocalChatRuntime } from '../src/local-chat-runtime.js'
import type { AgentContext } from '../src/agents.js'

let directory:string,db:MemoryDatabase,store:MemoryStore,ops:MemoryOperations
const git=(...args:string[])=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']})
const agent=(name:string):AgentContext=>({agent_id:`turn-alert-${name}`,session_id:`native:${name.padEnd(64,'0')}`,cli_kind:'codex_cli',client:'Codex',cwd:directory})
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'hub-turn-alert-'));git('init','-q','-b','main');git('-c','user.name=t','-c','user.email=t@invalid','-c','commit.gpgSign=false','commit','--allow-empty','-qm','seed');db=new MemoryDatabase(join(directory,'memory.sqlite'));await db.migrate();store=new MemoryStore(db,directory);ops=new MemoryOperations(store,new MemoryAI(async()=>defaultAI,new Vault(directory)))})
afterEach(async()=>{vi.useRealTimers();await db.close();await rm(directory,{recursive:true,force:true})})
async function register(name:string) { const a=agent(name),key=randomUUID();const r=await ops.chat.lifecycle(a,{session_key:key,native_id:name,event:'SessionStart',at:new Date().toISOString()});const named=await ops.call('chat_set_nick',{session_key:key,nickname:`Turn ${name}`},'mcp',a);return {a,key,...r,session:named.session} }
async function event(who:Awaited<ReturnType<typeof register>>,name:string,at:number,turn_id?:string) { return ops.chat.lifecycle(who.a,{session_key:who.key,native_id:who.session.id,event:name,at:new Date(at).toISOString(),...(turn_id?{turn_id}:{})}) }
async function alerts(who:Awaited<ReturnType<typeof register>>) { return db.query('SELECT * FROM chat_turn_alerts WHERE session_id=$1 ORDER BY created_at',[who.session.id]) }

it('no inventa turnos por heartbeat ni por cierre sin inicio; ignora hooks stale y fallback duplicado',async()=>{
  const leader=await register('leader'),member=await register('member'),t=Date.now()+10_000
  await event(member,'Heartbeat',t);await event(member,'Stop',t+1);await ops.chat.processTurnAlerts(t+5_000,0)
  expect(await alerts(member)).toHaveLength(0)
  await event(member,'BeforeAgent',t+10);await event(member,'BeforeAgent',t+11);await event(member,'Stop',t+20)
  await event(member,'Stop',t-1);await ops.chat.processTurnAlerts(t+5_000,0)
  expect(await alerts(member)).toHaveLength(1)
  expect((await ops.call('chat_inbox',{session_key:leader.key},'mcp',leader.a)).items).toHaveLength(1)
})

it('correlaciona cierre nativo, conserva dos cierres durante gracia y sólo el send actual suprime',async()=>{
  const leader=await register('leader'),member=await register('member'),t=Date.now()+10_000
  await event(member,'BeforeAgent',t,'one');await event(member,'Stop',t+10,'wrong') // mismatched close is ignored
  await event(member,'Stop',t+20,'one');await event(member,'BeforeAgent',t+30,'two');await event(member,'Stop',t+40,'two')
  await ops.chat.processTurnAlerts(t+2_000,0);expect(await alerts(member)).toHaveLength(2)
  await event(member,'BeforeAgent',t+50,'three');await event(member,'Stop',t+60,'three')
  const sent=await ops.call('chat_send',{session_key:member.key,channel_id:member.channel.id,title:'actual',text:'actual',mentions:[leader.session.id],request_id:'turn-send'},'mcp',member.a)
  expect(sent.id).toBeTruthy();await ops.chat.processTurnAlerts(t+3_000,0);expect(await alerts(member)).toHaveLength(2)
})

it('failed send e inbox no suprimen; replay aceptado sí, y espera sólo silencia cierre normal',async()=>{
  const leader=await register('leader'),member=await register('member'),t=Date.now()+10_000
  await event(member,'BeforeAgent',t,'failed');await expect(ops.call('chat_send',{session_key:member.key,thread_id:randomUUID(),text:'falló',request_id:'bad'},'mcp',member.a)).rejects.toBeTruthy()
  await ops.call('chat_inbox',{session_key:member.key},'mcp',member.a);await event(member,'Stop',t+1,'failed');await ops.chat.processTurnAlerts(t+2_000,0);expect(await alerts(member)).toHaveLength(1)
  await event(member,'BeforeAgent',t+3,'replay');const input={session_key:member.key,channel_id:member.channel.id,title:'replay',text:'ok',mentions:[leader.session.id],request_id:'replay'}
  await ops.call('chat_send',input,'mcp',member.a);await ops.call('chat_send',input,'mcp',member.a);await event(member,'Stop',t+4,'replay');await ops.chat.processTurnAlerts(t+3_000,0);expect(await alerts(member)).toHaveLength(1)
  await db.query("INSERT INTO chat_work_state(session_id,work_id,thread_id,status,summary,waiting_for,version,updated_at) VALUES($1,'wait',$2,'waiting','espera','permission',1,now())",[member.session.id,(await db.query('SELECT id FROM chat_threads LIMIT 1'))[0].id])
  await event(member,'BeforeAgent',t+5,'waiting')
  await db.query("UPDATE chat_work_state SET updated_at=$2 WHERE session_id=$1 AND work_id='wait'",[member.session.id,new Date(t+5).toISOString()])
  await event(member,'Stop',t+6,'waiting');await ops.chat.processTurnAlerts(t+4_000,0);expect(await alerts(member)).toHaveLength(1)
  await event(member,'BeforeAgent',t+7,'crash');await event(member,'StopFailure',t+8,'crash');await ops.chat.processTurnAlerts(t+5_000,0);expect(await alerts(member)).toHaveLength(2)
  await event(member,'BeforeAgent',t+9,'old-wait');await event(member,'Stop',t+10,'old-wait')
  await ops.chat.processTurnAlerts(t+6000,0);expect(await alerts(member)).toHaveLength(3)
})

it('preserva delivery de líder offline, descarta fuente expulsada y no reabre turnos al restaurar',async()=>{
  const leader=await register('leader'),member=await register('member'),t=Date.now()+10_000
  await db.query('UPDATE chat_sessions SET closed_at=now() WHERE id=$1',[leader.session.id]);await event(member,'BeforeAgent',t,'offline');await event(member,'Stop',t+1,'offline');await ops.chat.processTurnAlerts(t+2_000,0)
  const alert=(await alerts(member))[0];expect((await db.query('SELECT * FROM chat_deliveries WHERE message_id=$1 AND recipient_id=$2',[alert.message_id,leader.session.id]))).toHaveLength(1)
  await event(member,'BeforeAgent',t+3,'removed');await event(member,'Stop',t+4,'removed')
  await ops.chat.kick({channel_id:member.channel.id,participant_id:member.session.id,reason:'retiro'},{user_id:'test'})
  await expect(event(member,'Heartbeat',t+5)).rejects.toMatchObject({statusCode:410})
  await ops.chat.processTurnAlerts(t+3_000,0);expect(await alerts(member)).toHaveLength(1)
  const backup=JSON.parse(await readBackup(store,(await exportMemory(store)).id)),restored=new MemoryDatabase(join(directory,'restored.sqlite'));await restored.migrate()
  try { await restoreMemory(new MemoryStore(restored,join(directory,'restored')),backup);expect(await restored.query('SELECT * FROM chat_turns WHERE alerted_at IS NULL')).toHaveLength(0) } finally { await restored.close() }
})

it('no expone la sesión Hub como participante y distingue PID vivo de proceso desaparecido',async()=>{
  const leader=await register('leader'),member=await register('member'),t=Date.now()+10_000
  await event(member,'BeforeAgent',t,'pid');await db.query('UPDATE chat_sessions SET process_id=123,process_started=$2 WHERE id=$1',[member.session.id,'birth'])
  const alive=new LocalChatRuntime(ops.chat,async()=>{},()=>true,async()=>({started:'birth'} as any));await alive.tick();await alive.close()
  expect((await db.query('SELECT closed_at FROM chat_sessions WHERE id=$1',[member.session.id]))[0].closed_at).toBeNull()
  const gone=new LocalChatRuntime(ops.chat,async()=>{},()=>true,async()=>null);await gone.tick();await gone.close()
  expect((await db.query('SELECT closed_at FROM chat_sessions WHERE id=$1',[member.session.id]))[0].closed_at).toBeTruthy()
  await event(leader,'BeforeAgent',t+20,'hub');await event(leader,'Stop',t+21,'hub');await ops.chat.processTurnAlerts(t+3_000,0)
  expect((await ops.call('chat_agents',{})).items.some((item:any)=>item.label==='Agent Hub')).toBe(false)
})

it.each([
  {name:'vivo',birth:'birth',observed:{parent:1,started:'birth',command:'test'},closed:false},
  {name:'desaparecido',birth:'birth',observed:null,closed:true},
  {name:'reutilizado',birth:'birth',observed:{parent:1,started:'another-birth',command:'other'},closed:true},
  {name:'sin inspección',birth:'birth',observed:undefined,closed:false},
  {name:'sin identidad de nacimiento',birth:null,observed:{parent:1,started:'birth',command:'test'},closed:false},
])('sólo genera pid_exit con evidencia del proceso original: $name',async({birth,observed,closed})=>{
  await register('leader');const member=await register('member'),t=Date.now()+1000
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(t)
  await event(member,'BeforeAgent',t,'pid-observed')
  await db.query('UPDATE chat_sessions SET process_id=123,process_started=$2 WHERE id=$1',[member.session.id,birth])
  const runtime=new LocalChatRuntime(ops.chat,async()=>{},()=>false,async()=>observed)
  await runtime.tick();await runtime.close()
  await ops.chat.processTurnAlerts(t+2000)
  expect((await alerts(member)).length).toBe(closed?1:0)
  if(closed)expect((await alerts(member))[0].cause).toBe('pid_exit')
  else expect((await db.query('SELECT terminal_at FROM chat_turns WHERE session_id=$1',[member.session.id]))[0].terminal_at).toBeNull()
})

it('despierta al líder al volver, y cancela el aviso pendiente si cambia la autoridad',async()=>{
  const leader=await register('leader'),member=await register('member'),replacement=await register('replacement'),t=Date.now()+1000
  await db.query("UPDATE chat_sessions SET closed_at=now(),state='offline' WHERE id=$1",[leader.session.id])
  await event(member,'BeforeAgent',t,'offline');await event(member,'Stop',t+10,'offline')
  await ops.chat.processTurnAlerts(t+2000)
  const queued=vi.fn(async(_nativeId:string,_text:string)=>{}),runtime=new LocalChatRuntime(ops.chat,queued)
  try {
    await runtime.tick();expect(queued).not.toHaveBeenCalled()
    await event(leader,'SessionStart',t+20)
    await runtime.tick();expect(queued).toHaveBeenCalledTimes(1)
    expect(queued.mock.calls[0]?.[0]).toBe('leader')
    const alert=(await alerts(member))[0]
    await db.query('UPDATE chat_channels SET leader_id=$2 WHERE id=$1',[leader.channel.id,replacement.session.id])
    await db.query('UPDATE chat_deliveries SET next_attempt_at=now() WHERE message_id=$1',[alert.message_id])
    await runtime.tick();expect(queued).toHaveBeenCalledTimes(1)
    expect((await db.query('SELECT cancelled_at FROM chat_deliveries WHERE message_id=$1',[alert.message_id]))[0].cancelled_at).toBeTruthy()
    expect((await ops.call('chat_inbox',{session_key:leader.key},'mcp',leader.a)).items).toEqual([])
  } finally {await runtime.close()}
})

it('persiste dedupe tras reiniciar y restaura avisos históricos sin entrega ni autoría falsa',async()=>{
  await register('leader');const member=await register('member'),t=Date.now()+1000
  await event(member,'BeforeAgent',t,'durable');await event(member,'Stop',t+10,'durable')
  await ops.chat.processTurnAlerts(t+2000)
  await db.close();db=new MemoryDatabase(join(directory,'memory.sqlite'));await db.migrate()
  store=new MemoryStore(db,directory);ops=new MemoryOperations(store,new MemoryAI(async()=>defaultAI,new Vault(directory)))
  await event(member,'BeforeAgent',t+20,'durable');await event(member,'Stop',t+30,'durable')
  await ops.chat.processTurnAlerts(t+3000)
  expect(await alerts(member)).toHaveLength(1)
  expect((await db.query('SELECT state FROM chat_sessions WHERE id=$1',[member.session.id]))[0].state).toBe('idle')
  const backup=JSON.parse(await readBackup(store,(await exportMemory(store)).id)),target=join(directory,'restored'),restored=new MemoryDatabase(join(target,'memory.sqlite'))
  await restored.migrate()
  try {
    await restoreMemory(new MemoryStore(restored,target),backup)
    expect((await restored.query('SELECT cancelled_at FROM chat_deliveries'))[0].cancelled_at).toBeTruthy()
    expect((await restored.query("SELECT label FROM chat_sessions WHERE cli_kind='hub'"))[0].label).toBe('Agent Hub')
    expect(await restored.query('PRAGMA foreign_key_check')).toEqual([])
  } finally {await restored.close()}
})

it('la gracia espera el envío tardío, sin atribuir al turno anterior un envío del siguiente',async()=>{
  const leader=await register('leader'),member=await register('member'),t=Date.now()+1000
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(t)
  await event(member,'BeforeAgent',t,'silent');await event(member,'Stop',t+10,'silent')
  await ops.chat.processTurnAlerts(t+11)
  expect(await alerts(member)).toHaveLength(0)
  await event(member,'BeforeAgent',t+20,'speaks')
  const input={session_key:member.key,channel_id:member.channel.id,title:'Reporte',text:'Terminado',mentions:[leader.session.id],request_id:'speaks'}
  await ops.call('chat_send',input,'mcp',member.a);await event(member,'Stop',t+30,'speaks')
  await ops.chat.processTurnAlerts(t+2000)
  expect((await alerts(member)).map(a=>a.turn_id)).toEqual(['silent'])
  await event(member,'BeforeAgent',t+40,'replay-only')
  // Replaying a receipt from an earlier turn is still a successful chat_send in this turn.
  await ops.call('chat_send',input,'mcp',member.a);await event(member,'Stop',t+50,'replay-only')
  await ops.chat.processTurnAlerts(t+3000)
  expect(await alerts(member)).toHaveLength(1)
})

it('atribuye un envío en vuelo al turno observado al recibirlo, aunque otro empiece antes de persistir',async()=>{
  const leader=await register('leader'),member=await register('member'),t=Date.now()+1000
  await event(member,'BeforeAgent',t,'sending')
  let release!:()=>void,queued!:()=>void
  const barrier=new Promise<void>(resolve=>{release=resolve}),arrived=new Promise<void>(resolve=>{queued=resolve})
  const transaction=db.transaction.bind(db)
  const spy=vi.spyOn(db,'transaction').mockImplementationOnce(async operation=>{queued();await barrier;return transaction(operation)})
  const sending=ops.call('chat_send',{session_key:member.key,channel_id:member.channel.id,title:'En vuelo',text:'Resultado A',mentions:[leader.session.id],request_id:'inflight'},'mcp',member.a)
  try {
    await arrived
    await event(member,'Stop',t+10,'sending');await event(member,'BeforeAgent',t+20,'next')
    release();await sending
    await event(member,'Stop',t+30,'next');await ops.chat.processTurnAlerts(t+2000)
    expect((await alerts(member)).map(a=>a.turn_id)).toEqual(['next'])
  } finally {release();spy.mockRestore();await sending}
})
