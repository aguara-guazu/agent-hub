import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { migrations } from '../src/migrations.js'
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
async function alerts(who:Awaited<ReturnType<typeof register>>) { return db.query('SELECT * FROM chat_status_notices WHERE session_id=$1 ORDER BY created_at',[who.session.id]) }

const inbox=(who:Awaited<ReturnType<typeof register>>,input={})=>ops.call('chat_inbox',{session_key:who.key,...input},'mcp',who.a)
const send=(who:Awaited<ReturnType<typeof register>>,mentions:string[],request_id=randomUUID())=>ops.call('chat_send',{
  session_key:who.key,channel_id:who.channel.id,title:'Trabajo',text:'Estado del trabajo',mentions,request_id},'mcp',who.a)

it('espera 60 segundos, notifica sólo al líder y no crea mensajes ni hilos automáticos',async()=>{
  const leader=await register('leader'),member=await register('member'),other=await register('other'),t=Date.now()+1000
  await event(member,'BeforeAgent',t,'one');await event(member,'Stop',t+10,'one')
  await ops.chat.processTurnAlerts(t+60_009);expect(await alerts(member)).toHaveLength(0)
  await ops.chat.processTurnAlerts(t+60_010);await ops.chat.processTurnAlerts(t+120_000)
  expect(await alerts(member)).toHaveLength(1)
  expect(await db.query('SELECT * FROM chat_threads')).toHaveLength(0)
  expect(await db.query('SELECT * FROM chat_messages')).toHaveLength(0)
  const item=(await inbox(leader)).items[0]
  expect(item).toMatchObject({kind:'status_notice',author_source:'hub',thread_id:null,session_id:member.session.id})
  expect((await inbox(other)).items).toEqual([])
  await expect(ops.call('chat_ack',{session_key:other.key,message_id:item.id},'mcp',other.a)).rejects.toMatchObject({statusCode:403})
  await ops.call('chat_ack',{session_key:leader.key,message_id:item.id},'mcp',leader.a)
  expect((await inbox(leader)).items).toEqual([])
})

it.each(['before-stop','during-grace','after-notice'])('el reporte dirigido al coordinador suprime o retira el aviso: %s',async when=>{
  const leader=await register('leader'),member=await register('member'),t=Date.now()+1000
  await event(member,'BeforeAgent',t,'one')
  if(when==='before-stop')await send(member,[leader.session.id])
  await event(member,'Stop',t+10,'one')
  if(when==='during-grace')await send(member,[leader.session.id])
  await ops.chat.processTurnAlerts(t+61_000)
  if(when==='after-notice')await send(member,[leader.session.id])
  expect((await inbox(leader)).items.filter((i:any)=>i.kind==='status_notice')).toHaveLength(0)
  expect((await db.query('SELECT report_recipient_id FROM chat_turns WHERE session_id=$1',[member.session.id]))[0].report_recipient_id).toBe(leader.session.id)
})

it('un mensaje a un compañero, inbox o un envío fallido no sustituyen el reporte al master',async()=>{
  const leader=await register('leader'),member=await register('member'),peer=await register('peer'),t=Date.now()+1000
  await event(member,'BeforeAgent',t,'one')
  await send(member,[peer.session.id]);await inbox(member)
  await expect(ops.call('chat_send',{session_key:member.key,thread_id:randomUUID(),text:'falló',mentions:[leader.session.id],request_id:'failed'},'mcp',member.a)).rejects.toBeTruthy()
  await event(member,'Stop',t+10,'one');await ops.chat.processTurnAlerts(t+61_000)
  expect(await alerts(member)).toHaveLength(1)
  expect((await inbox(leader)).items[0].kind).toBe('status_notice')
})

it('no infiere turnos por heartbeat/cierre ni acepta cierres nativos ajenos o stale',async()=>{
  await register('leader');const member=await register('member'),t=Date.now()+1000
  await event(member,'Heartbeat',t);await event(member,'Stop',t+1)
  await ops.chat.processTurnAlerts(t+61_000);expect(await alerts(member)).toHaveLength(0)
  await event(member,'BeforeAgent',t+10,'one');await event(member,'Stop',t+20,'wrong')
  await event(member,'Stop',t-1,'one');await ops.chat.processTurnAlerts(t+62_000)
  expect(await alerts(member)).toHaveLength(0)
  await event(member,'Stop',t+30,'one');await ops.chat.processTurnAlerts(t+63_000)
  expect(await alerts(member)).toHaveLength(1)
})

it('una actividad nueva invalida el silencio anterior y agrupa cierres en un único aviso pendiente',async()=>{
  const leader=await register('leader'),member=await register('member'),t=Date.now()+1000
  await event(member,'BeforeAgent',t,'one');await event(member,'Stop',t+10,'one')
  await event(member,'BeforeAgent',t+20,'two');await ops.chat.processTurnAlerts(t+61_000)
  expect(await alerts(member)).toHaveLength(0)
  await event(member,'Stop',t+62_000,'two');await ops.chat.processTurnAlerts(t+122_000)
  expect((await alerts(member)).map(a=>a.turn_id)).toEqual(['two'])
  await event(member,'BeforeAgent',t+123_000,'three');await event(member,'Stop',t+123_010,'three')
  await ops.chat.processTurnAlerts(t+184_000)
  expect(await alerts(member)).toHaveLength(1) // bounded follow-up: no new wake within five minutes
  expect((await inbox(leader)).items).toEqual([]) // previous notice was superseded
  await ops.chat.processTurnAlerts(t+422_000)
  expect((await alerts(member)).map(a=>a.turn_id)).toEqual(['two','three']) // cooldown defers instead of losing the new report
})

it('respeta una espera explícita persistente y no avisa al propio líder',async()=>{
  const leader=await register('leader'),member=await register('member'),t=Date.now()+1000
  const thread=await send(leader,[member.session.id])
  await db.query("INSERT INTO chat_work_state(session_id,work_id,thread_id,status,summary,waiting_for,version,updated_at) VALUES($1,'wait',$2,'waiting','espera','permission',1,now())",[member.session.id,thread.thread_id])
  await event(member,'BeforeAgent',t,'one');await event(member,'Stop',t+10,'one')
  await event(leader,'BeforeAgent',t+20,'master');await event(leader,'Stop',t+30,'master')
  await ops.chat.processTurnAlerts(t+61_000)
  expect(await alerts(member)).toHaveLength(0);expect(await alerts(leader)).toHaveLength(0)
})

it.each([
  {name:'vivo',birth:'birth',observed:{parent:1,started:'birth',command:'test'},closed:false},
  {name:'desaparecido',birth:'birth',observed:null,closed:true},
  {name:'reutilizado',birth:'birth',observed:{parent:1,started:'another-birth',command:'other'},closed:true},
  {name:'sin inspección',birth:'birth',observed:undefined,closed:false},
  {name:'sin identidad de nacimiento',birth:null,observed:{parent:1,started:'birth',command:'test'},closed:false},
])('evidencia del proceso sin leer terminales: $name',async({birth,observed,closed})=>{
  await register('leader');const member=await register('member'),t=Date.now()+1000
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(t)
  await event(member,'BeforeAgent',t,'pid')
  await db.query('UPDATE chat_sessions SET process_id=123,process_started=$2 WHERE id=$1',[member.session.id,birth])
  const runtime=new LocalChatRuntime(ops.chat,async()=>{},()=>false,async()=>observed)
  await runtime.tick();await runtime.close();await ops.chat.processTurnAlerts(t+61_000)
  expect(await alerts(member)).toHaveLength(closed?1:0)
  if(closed)expect((await alerts(member))[0].cause).toBe('pid_exit')
})

it('entrega al líder al volver una sola vez; fallos de transporte sí permiten reintento',async()=>{
  const leader=await register('leader'),member=await register('member'),t=Date.now()+1000
  await db.query("UPDATE chat_sessions SET closed_at=now(),state='offline' WHERE id=$1",[leader.session.id])
  await event(member,'BeforeAgent',t,'one');await event(member,'Stop',t+10,'one');await ops.chat.processTurnAlerts(t+61_000)
  const queued=vi.fn().mockRejectedValueOnce(new Error('transport')).mockResolvedValue(undefined),runtime=new LocalChatRuntime(ops.chat,queued)
  try {
    await runtime.tick();expect(queued).not.toHaveBeenCalled()
    await event(leader,'SessionStart',t+20);await runtime.tick();expect(queued).toHaveBeenCalledTimes(1)
    await db.query('UPDATE chat_status_notices SET next_attempt_at=now()');await runtime.tick();expect(queued).toHaveBeenCalledTimes(2)
    await db.query('UPDATE chat_status_notices SET next_attempt_at=now()');await runtime.tick();expect(queued).toHaveBeenCalledTimes(2)
    expect((await ops.chat.pending(leader.session.id))).toHaveLength(1) // still available until actually read
    expect((await inbox(leader)).items).toHaveLength(1)
  } finally {await runtime.close()}
})

it('revoca avisos pendientes al cambiar la autoridad o expulsar la fuente',async()=>{
  const leader=await register('leader'),member=await register('member'),replacement=await register('replacement'),t=Date.now()+1000
  await event(member,'BeforeAgent',t,'one');await event(member,'Stop',t+10,'one');await ops.chat.processTurnAlerts(t+61_000)
  await db.query('UPDATE chat_channels SET leader_id=$2 WHERE id=$1',[leader.channel.id,replacement.session.id])
  expect((await inbox(leader)).items).toEqual([])
  expect((await alerts(member))[0].cancelled_at).toBeTruthy()
  await ops.chat.kick({channel_id:member.channel.id,participant_id:member.session.id,reason:'retiro'},{user_id:'test'})
  await expect(event(member,'Heartbeat',t+100)).rejects.toMatchObject({statusCode:410})
})

it('persiste dedupe tras reiniciar y restaura notificaciones históricas sin volver a entregarlas',async()=>{
  await register('leader');const member=await register('member'),t=Date.now()+1000
  await event(member,'BeforeAgent',t,'durable');await event(member,'Stop',t+10,'durable');await ops.chat.processTurnAlerts(t+61_000)
  await db.close();db=new MemoryDatabase(join(directory,'memory.sqlite'));await db.migrate()
  store=new MemoryStore(db,directory);ops=new MemoryOperations(store,new MemoryAI(async()=>defaultAI,new Vault(directory)))
  await event(member,'BeforeAgent',t+20,'durable');await ops.chat.processTurnAlerts(t+62_000)
  expect(await alerts(member)).toHaveLength(1)
  const backup=JSON.parse(await readBackup(store,(await exportMemory(store)).id)),target=join(directory,'restored'),restored=new MemoryDatabase(join(target,'memory.sqlite'))
  await restored.migrate()
  try {
    await restoreMemory(new MemoryStore(restored,target),backup)
    expect((await restored.query('SELECT cancelled_at FROM chat_status_notices'))[0].cancelled_at).toBeTruthy()
    expect(await restored.query('SELECT * FROM chat_turns WHERE alerted_at IS NULL')).toEqual([])
    expect(await restored.query('PRAGMA foreign_key_check')).toEqual([])
  } finally {await restored.close()}
})

it('migra los hilos automáticos antiguos sin ocultar conversaciones con respuestas reales',async()=>{
  const leader=await register('leader'),member=await register('member'),legacy=new MemoryDatabase(join(directory,'legacy.sqlite'))
  try {
    const privateNotices=migrations.findIndex(migration=>migration.includes('CREATE TABLE chat_status_notices'))
    expect(privateNotices).toBeGreaterThan(0)
    for(const migration of migrations.slice(0,privateNotices))await legacy.execute(migration)
    await legacy.transaction(async()=>{
      await legacy.query('PRAGMA defer_foreign_keys=ON')
    for(const table of ['chat_channels','chat_sessions'])for(const row of await db.query(`SELECT * FROM ${table}`)) {
      const keys=Object.keys(row);await legacy.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,keys.map(k=>row[k]))
    }
    })
    const hub=`hub:${leader.channel.id}`
    await legacy.query("INSERT INTO chat_sessions(id,agent_id,key_hash,label,cli_kind,channel_id,event_at) VALUES($1,'agenthub-system','legacy-key','Agent Hub','hub',$2,'2026-01-01T00:00:00.000Z')",[hub,leader.channel.id])
    const threads=[randomUUID(),randomUUID()]
    for(const [i,thread] of threads.entries()) {
      const message=randomUUID()
      await legacy.query("INSERT INTO chat_threads(id,channel_id,title,created_by) VALUES($1,$2,'Aviso Hub',$3)",[thread,leader.channel.id,hub])
      await legacy.query("INSERT INTO chat_messages(id,thread_id,author_id,text,request_id,request_hash) VALUES($1,$2,$3,'Aviso',$4,'hash')",[message,thread,hub,`old-${i}`])
      await legacy.query('INSERT INTO chat_deliveries(message_id,recipient_id) VALUES($1,$2)',[message,leader.session.id])
      await legacy.query("INSERT INTO chat_turn_alerts(id,session_id,turn_id,cause,recipient_id,message_id) VALUES($1,$2,$3,'normal',$4,$5)",[randomUUID(),member.session.id,`old-${i}`,leader.session.id,message])
    }
    await legacy.query("INSERT INTO chat_messages(id,thread_id,author_id,text,request_id,request_hash) VALUES($1,$2,$3,'Respuesta real','answer','hash')",[randomUUID(),threads[1],leader.session.id])
    for(const migration of migrations.slice(privateNotices))await legacy.execute(migration)
    expect((await legacy.query('SELECT archived_notice FROM chat_threads WHERE id=$1',[threads[0]]))[0].archived_notice).toBe(1)
    expect((await legacy.query('SELECT archived_notice FROM chat_threads WHERE id=$1',[threads[1]]))[0].archived_notice).toBe(0)
    expect(await legacy.query('SELECT * FROM chat_messages')).toHaveLength(3)
    expect((await legacy.query('SELECT cancelled_at FROM chat_deliveries')).every(d=>d.cancelled_at)).toBe(true)
    expect(await legacy.query('PRAGMA foreign_key_check')).toEqual([])
  } finally {await legacy.close()}
})

it('permite atender un aviso propio ya recibido aunque el trabajador retome antes del ack',async()=>{
  const leader=await register('leader'),member=await register('member'),t=Date.now()+1000
  await event(member,'BeforeAgent',t,'one');await event(member,'Stop',t+10,'one');await ops.chat.processTurnAlerts(t+61_000)
  const item=(await inbox(leader)).items[0]
  await event(member,'BeforeAgent',t+62_000,'resumed')
  await ops.call('chat_ack',{session_key:leader.key,message_id:item.id},'mcp',leader.a)
  expect((await alerts(member))[0]).toMatchObject({handled_at:expect.any(String),cancelled_at:expect.any(String)})
})

it('reintentar el reporte de un turno anterior no encubre un nuevo cierre sin reporte',async()=>{
  const leader=await register('leader'),member=await register('member'),t=Date.now()+1000
  await send(member,[leader.session.id],'old-report')
  await event(member,'BeforeAgent',t,'new')
  await send(member,[leader.session.id],'old-report')
  await event(member,'Stop',t+10,'new');await ops.chat.processTurnAlerts(t+61_000)
  expect(await alerts(member)).toHaveLength(1)
})

it('inbox pagina menciones y avisos sin filtrar ni marcar datos de otra identidad',async()=>{
  const leader=await register('leader'),member=await register('member'),t=Date.now()+1000
  const message=await send(member,[leader.session.id])
  await event(member,'BeforeAgent',t,'silent');await event(member,'Stop',t+10,'silent');await ops.chat.processTurnAlerts(t+61_000)
  const first=await inbox(leader,{unread_only:true,limit:1})
  expect(first.total).toBe(2);expect(first.items[0].id).toBe(message.id)
  const second=await inbox(leader,{unread_only:true,limit:1})
  expect(second.total).toBe(1);expect(second.items[0].kind).toBe('status_notice')
  expect((await inbox(leader,{unread_only:true})).items).toEqual([])
  expect((await inbox(leader)).items).toHaveLength(2) // reading does not acknowledge
  expect(await db.query('SELECT * FROM chat_read_receipts')).toHaveLength(1)
})

it('atribuye un envío en vuelo al turno observado sin encubrir el siguiente',async()=>{
  const leader=await register('leader'),member=await register('member'),t=Date.now()+1000
  await event(member,'BeforeAgent',t,'sending')
  let release!:()=>void,queued!:()=>void
  const barrier=new Promise<void>(resolve=>{release=resolve}),arrived=new Promise<void>(resolve=>{queued=resolve})
  const transaction=db.transaction.bind(db)
  const spy=vi.spyOn(db,'transaction').mockImplementationOnce(async operation=>{queued();await barrier;return transaction(operation)})
  const sending=send(member,[leader.session.id])
  try {
    await arrived;await event(member,'Stop',t+10,'sending');await event(member,'BeforeAgent',t+20,'next')
    release();await sending;await event(member,'Stop',t+30,'next');await ops.chat.processTurnAlerts(t+61_000)
    expect((await alerts(member)).map(a=>a.turn_id)).toEqual(['next'])
  } finally {release();spy.mockRestore();await sending}
})
