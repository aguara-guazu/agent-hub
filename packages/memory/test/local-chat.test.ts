import { existingChannel } from './helpers/chat-channel.js'
import { migrations } from '../src/migrations.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryOperations } from '../src/operations.js'
import { MemoryAI } from '../src/ai.js'
import { Vault,defaultAI } from '../src/config.js'
import { chatFolder } from '../src/local-chat.js'
import { LocalChatRuntime } from '../src/local-chat-runtime.js'
import { exportMemory,readBackup,restoreMemory } from '../src/backup.js'
import type { AgentContext } from '../src/agents.js'

let dir:string, db:MemoryDatabase, store:MemoryStore, ops:MemoryOperations, projectId:string
const git = (...args:string[]) => execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
const worktree = (name:string) => {const path=join(dir,name);git('worktree','add','-qb',name,path);return path}
const author = (name:string, path=dir):AgentContext => ({ agent_id:'same-installed-client', session_id:`native:${name.padEnd(64,'0')}`, cli_kind:'codex_cli', client:'Codex', cwd:path })
beforeEach(async()=> {
  dir=await mkdtemp(join(tmpdir(),'hub-chat-')); git('init','-q','-b','main');git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgSign=false','commit','--allow-empty','-qm','seed'); db=new MemoryDatabase(join(dir,'memory.sqlite')); await db.migrate()
  store=new MemoryStore(db,dir); ops=new MemoryOperations(store,new MemoryAI(async()=>defaultAI,new Vault(dir)))
  const p=await ops.call('create_entity',{kind:'project',title:'Test',data:{folders:[dir]}}); projectId=p.id
})
afterEach(async()=> { await db.close(); await rm(dir,{recursive:true,force:true}) })
async function register(name:string, event='Stop', path=dir) {
  const a=author(name,path), k=randomUUID()
  const r=await ops.chat.lifecycle(a,{session_key:k,native_id:name,event,at:new Date().toISOString()})
  const folder=await chatFolder(path);r.channel.path=folder.root
  await db.query('UPDATE chat_channels SET path=$2 WHERE id=$1',[r.channel.id,folder.root])
  await existingChannel(ops.chat,r,folder.root)
  const named=await ops.call('chat_set_nick',{session_key:k,nickname:`Cometa ${name}`},'mcp',a)
  return {a,k,...r,session:named.session}
}
async function send(from:Awaited<ReturnType<typeof register>>, to:Awaited<ReturnType<typeof register>>, text='Revisá suma', thread_id?:string) {
  return await ops.call('chat_send',{session_key:from.k,...(thread_id ? {thread_id}:{channel_id:from.channel.id,title:'Revisión'}),text,mentions:[to.session.id],request_id:randomUUID()},'mcp',from.a)
}
it('conserva el hash legado de request_id cuando no usa hilo de equipo',async()=> {
  const a=await register('author'),b=await register('reader'),request_id='legacy-retry'
  const input={session_key:a.k,channel_id:a.channel.id,title:'Legacy',text:'Mensaje durable',mentions:[b.session.id],request_id}
  const message=await ops.call('chat_send',input,'mcp',a.a)
  const legacy=JSON.stringify({thread:null,channel:a.channel.id,title:'Legacy',task:null,text:'Mensaje durable',reply:null,mentions:[b.session.id]})
  expect((await db.query('SELECT request_hash FROM chat_messages WHERE id=$1',[message.id]))[0].request_hash).toBe(createHash('sha256').update(legacy).digest('hex'))
  expect((await ops.call('chat_send',input,'mcp',a.a)).id).toBe(message.id)
})
it('avisa al líder con autoría Agent Hub sólo al cerrar un turno sin chat actual',async()=> {
  const leader=await register('leader'),member=await register('member')
  const start=new Date(Date.now()+1000),stop=new Date(start.getTime()+10)
  await ops.chat.lifecycle(member.a,{session_key:member.k,native_id:'member',event:'UserPromptSubmit',at:start.toISOString(),turn_id:'turn-1'})
  await ops.chat.lifecycle(member.a,{session_key:member.k,native_id:'member',event:'Stop',at:stop.toISOString(),turn_id:'turn-1'})
  await ops.chat.processTurnAlerts(stop.getTime()+2000,0)
  const alert=(await db.query('SELECT * FROM chat_status_notices WHERE session_id=$1',[member.session.id]))[0]
  expect(alert.text).toContain('missed the report deadline')
  expect((await ops.call('chat_inbox',{session_key:leader.k},'mcp',leader.a)).items.find((item:any)=>item.id===alert.id)).toMatchObject({author_source:'hub',thread_id:null})
  expect(await db.query('SELECT * FROM chat_threads')).toHaveLength(0)
  await ops.call('chat_ack',{session_key:leader.k,message_id:alert.id},'mcp',leader.a)
  await ops.chat.processTurnAlerts(stop.getTime()+3000,0)
  expect(await db.query('SELECT * FROM chat_status_notices WHERE session_id=$1',[member.session.id])).toHaveLength(1)
})
it('sólo un chat_send exitoso del turno actual suprime su aviso',async()=> {
  const leader=await register('leader'),member=await register('member')
  const old=new Date(Date.now()+1000),start=new Date(old.getTime()+20),stop=new Date(start.getTime()+10)
  await send(member,leader,'mensaje anterior')
  await ops.chat.lifecycle(member.a,{session_key:member.k,native_id:'member',event:'BeforeAgent',at:start.toISOString(),turn_id:'turn-current'})
  await ops.chat.lifecycle(member.a,{session_key:member.k,native_id:'member',event:'Stop',at:stop.toISOString(),turn_id:'turn-current'})
  await ops.chat.processTurnAlerts(stop.getTime()+2000,0)
  expect(await db.query('SELECT * FROM chat_status_notices WHERE session_id=$1',[member.session.id])).toHaveLength(1)
  const next=new Date(stop.getTime()+20),done=new Date(next.getTime()+10)
  await ops.chat.lifecycle(member.a,{session_key:member.k,native_id:'member',event:'BeforeAgent',at:next.toISOString(),turn_id:'turn-chat'})
  await send(member,leader,'mensaje actual')
  await ops.chat.lifecycle(member.a,{session_key:member.k,native_id:'member',event:'Stop',at:done.toISOString(),turn_id:'turn-chat'})
  await ops.chat.processTurnAlerts(done.getTime()+2000,0)
  expect(await db.query('SELECT * FROM chat_status_notices WHERE session_id=$1',[member.session.id])).toHaveLength(1)
})
it('descarta el cierre silencioso anterior cuando ya empezó el turno siguiente',async()=> {
  const leader=await register('leader'),member=await register('member'),at=Date.now()+1000
  await ops.chat.lifecycle(member.a,{session_key:member.k,native_id:'member',event:'BeforeAgent',at:new Date(at).toISOString(),turn_id:'one'})
  await ops.chat.lifecycle(member.a,{session_key:member.k,native_id:'member',event:'Stop',at:new Date(at+10).toISOString(),turn_id:'one'})
  await ops.chat.lifecycle(member.a,{session_key:member.k,native_id:'member',event:'BeforeAgent',at:new Date(at+20).toISOString(),turn_id:'two'})
  await ops.chat.processTurnAlerts(at+2000,0)
  expect(await db.query('SELECT * FROM chat_status_notices WHERE session_id=$1 AND turn_id=$2',[member.session.id,'one'])).toHaveLength(0)
  expect((await ops.call('chat_inbox',{session_key:leader.k},'mcp',leader.a)).total).toBe(0)
})
it('lee chat_read incrementalmente por sesión sin saltar páginas ni mensajes sin mención',async()=> {
  const a=await register('author'),b=await register('reader'),c=await register('other')
  const first=await send(a,b,'uno')
  const second=await ops.call('chat_send',{session_key:a.k,thread_id:first.thread_id,text:'dos sin mención',mentions:[],request_id:randomUUID()},'mcp',a.a)
  const third=await send(a,b,'tres',first.thread_id)

  const page1=await ops.call('chat_read',{session_key:b.k,thread_id:first.thread_id,limit:1},'mcp',b.a)
  expect(page1.items.map((m:any)=>m.id)).toEqual([first.id]);expect(page1.read).toEqual({unread_only:true,remaining:2,next_offset:0})
  // An out-of-order offset only consumes what it actually returns; offset zero still finds the skipped message.
  const jumped=await ops.call('chat_read',{session_key:b.k,thread_id:first.thread_id,limit:1,offset:1},'mcp',b.a)
  expect(jumped.items.map((m:any)=>m.id)).toEqual([third.id]);expect(jumped.read).toEqual({unread_only:true,remaining:1,next_offset:0})
  const skipped=await ops.call('chat_read',{session_key:b.k,thread_id:first.thread_id,limit:10,offset:0},'mcp',b.a)
  expect(skipped.items.map((m:any)=>m.id)).toEqual([second.id]);expect(skipped.read.next_offset).toBeNull()
  expect((await ops.call('chat_read',{session_key:b.k,thread_id:first.thread_id},'mcp',b.a)).items).toEqual([])

  // Receipts are isolated: another session sees the complete unread stream.
  const other=await ops.call('chat_read',{session_key:c.k,thread_id:first.thread_id,limit:10},'mcp',c.a)
  expect(other.items.map((m:any)=>m.id)).toEqual([first.id,second.id,third.id])
  expect(await db.query('SELECT session_id,message_id FROM chat_read_receipts WHERE session_id=$1 ORDER BY message_id',[b.session.id])).toHaveLength(3)
})
it('inbox shares only returned mention receipts with incremental chat_read, while anonymous history is read-only',async()=> {
  const a=await register('author'),b=await register('reader'),c=await register('historian')
  const mentioned=await send(a,b,'mención')
  const plain=await ops.call('chat_send',{session_key:a.k,thread_id:mentioned.thread_id,text:'sin mención',mentions:[],request_id:randomUUID()},'mcp',a.a)
  const inbox=await ops.call('chat_inbox',{session_key:b.k,limit:1},'mcp',b.a)
  expect(inbox.items.map((m:any)=>m.id)).toEqual([mentioned.id])
  const incremental=await ops.call('chat_read',{session_key:b.k,thread_id:mentioned.thread_id},'mcp',b.a)
  expect(incremental.items.map((m:any)=>m.id)).toEqual([plain.id])
  await expect(ops.call('chat_read',{thread_id:mentioned.thread_id,unread_only:true})).rejects.toThrow('requiere session_key')
  const historical=await ops.call('chat_read',{thread_id:mentioned.thread_id,unread_only:false})
  expect(historical.items.map((m:any)=>m.id)).toEqual([mentioned.id,plain.id])
  const identifiedHistory=await ops.call('chat_read',{session_key:c.k,thread_id:mentioned.thread_id,unread_only:false},'mcp',c.a)
  expect(identifiedHistory.items.map((m:any)=>m.id)).toEqual([mentioned.id,plain.id])
  expect((await ops.call('chat_read',{session_key:c.k,thread_id:mentioned.thread_id},'mcp',c.a)).items).toEqual([])
  expect((await db.query('SELECT * FROM chat_read_receipts WHERE session_id=$1',[b.session.id]))).toHaveLength(2)
})
it('serializa lectores concurrentes de una misma sesión sin duplicar la página',async()=> {
  const a=await register('author'),b=await register('reader'),message=await send(a,b)
  const [one,two]=await Promise.all([
    ops.call('chat_read',{session_key:b.k,thread_id:message.thread_id,limit:1},'mcp',b.a),
    ops.call('chat_read',{session_key:b.k,thread_id:message.thread_id,limit:1},'mcp',b.a),
  ])
  expect([one,two].flatMap((page:any)=>page.items.map((item:any)=>item.id))).toEqual([message.id])
  expect(await db.query('SELECT * FROM chat_read_receipts WHERE session_id=$1 AND message_id=$2',[b.session.id,message.id])).toHaveLength(1)
})
it('no emite cambios por historial anónimo, y sí por una lectura identificada que cambia recibos',async()=> {
  const a=await register('author'),b=await register('reader'),message=await send(a,b)
  const changed=vi.fn();ops.chat.events.on('change',changed)
  await ops.call('chat_read',{thread_id:message.thread_id})
  expect(changed).not.toHaveBeenCalled()
  await ops.call('chat_read',{session_key:b.k,thread_id:message.thread_id},'mcp',b.a)
  expect(changed).toHaveBeenCalledTimes(1)
  await ops.call('chat_read',{session_key:b.k,thread_id:message.thread_id},'mcp',b.a)
  expect(changed).toHaveBeenCalledTimes(1)
})
it('persiste recibos de chat_read al reabrir la base',async()=> {
  const a=await register('author'),b=await register('reader'),message=await send(a,b)
  await ops.call('chat_read',{session_key:b.k,thread_id:message.thread_id},'mcp',b.a)
  await db.close();db=new MemoryDatabase(join(dir,'memory.sqlite'));await db.migrate()
  store=new MemoryStore(db,dir);ops=new MemoryOperations(store,new MemoryAI(async()=>defaultAI,new Vault(dir)))
  expect(await db.query('SELECT session_id,message_id FROM chat_read_receipts WHERE session_id=$1 AND message_id=$2',[b.session.id,message.id])).toHaveLength(1)
  expect((await ops.call('chat_read',{session_key:b.k,thread_id:message.thread_id},'mcp',b.a)).items).toEqual([])
})
it('migra y restaura lecturas históricas de menciones como recibos incrementales',async()=> {
  const a=await register('author'),b=await register('reader'),message=await send(a,b)
  await db.query('UPDATE chat_deliveries SET read_at=now() WHERE message_id=$1 AND recipient_id=$2',[message.id,b.session.id])
  const backup=JSON.parse(await readBackup(store,(await exportMemory(store)).id))
  backup.schema_version=14;delete backup.tables.chat_read_receipts
  const restoredDir=join(dir,'receipt-restore'),restored=new MemoryDatabase(join(restoredDir,'memory.sqlite'));await restored.migrate()
  try {
    await restoreMemory(new MemoryStore(restored,restoredDir),backup)
    expect(await restored.query('SELECT * FROM chat_read_receipts WHERE session_id=$1 AND message_id=$2',[b.session.id,message.id])).toHaveLength(1)
  } finally { await restored.close() }
})
it('asigna identidades por sesión, normaliza rutas y reanuda sin perder el canal',async()=> {
  const a=await register('one'),b=await register('two')
  expect(a.session.id).not.toBe(b.session.id);expect(a.channel.id).toBe(b.channel.id);expect(a.channel.project_id).toBe(projectId)
  const alias=join(dir,'alias');await symlink(dir,alias)
  const again=await ops.chat.lifecycle(a.a,{session_key:a.k,native_id:'one',event:'SessionStart',at:new Date().toISOString()})
  expect(again.session.id).toBe(a.session.id);expect(again.session.nickname).toBe(a.session.nickname)
  const c=await register('three','Stop',alias);expect(c.channel.id).toBe(a.channel.id);expect(c.channel.project_id).toBe(projectId)
  expect((await ops.call('chat_agents',{})).items).toHaveLength(3)
  expect(JSON.stringify(await ops.call('chat_agents',{}))).not.toContain(a.k)
})
it('sólo el destinatario consume lectura; humanos observan y no pueden escribir ni atender',async()=> {
  const a=await register('a'),b=await register('b'),c=await register('c'), m=await send(a,b)
  const human=await ops.call('chat_read',{thread_id:m.thread_id});expect(human.items[0].mentions[0].read_at).toBeNull()
  await ops.call('chat_read',{thread_id:m.thread_id,session_key:c.k},'mcp',c.a)
  expect((await ops.chat.pending(b.session.id))).toHaveLength(1)
  for (const [op,input] of [['chat_set_nick',{nickname:'Intruso'}],['chat_join',{}],['chat_ack',{message_id:m.id}],['chat_resolve',{thread_id:m.thread_id,state:'resolved'}],['chat_send',{thread_id:m.thread_id,text:'human',request_id:'x'}]] as const)
    await expect(ops.call(op,input)).rejects.toMatchObject({statusCode:403})
  await expect(ops.call('chat_ack',{message_id:m.id,session_key:c.k},'mcp',c.a)).rejects.toMatchObject({statusCode:403})
  const inbox=await ops.call('chat_inbox',{session_key:b.k},'mcp',b.a);expect(inbox.items[0].text).toBe('Revisá suma')
  expect(await ops.chat.pending(b.session.id)).toHaveLength(0)
  expect((await ops.call('chat_read',{thread_id:m.thread_id})).items[0].mentions[0]).toMatchObject({read_at:expect.any(String),handled_at:null})
  await ops.call('chat_ack',{message_id:m.id,session_key:b.k},'mcp',b.a)
  expect((await ops.call('chat_inbox',{session_key:b.k},'mcp',b.a)).total).toBe(0)
})
it('filtra cerrados, expulsados y pendientes antes de contar y paginar el roster',async()=> {
  const member=await register('remaining'),closed=await register('closed')
  await ops.chat.lifecycle(closed.a,{session_key:closed.k,native_id:'closed',event:'SessionEnd',at:new Date().toISOString()})
  const pending=author('pending'),key=randomUUID()
  await ops.chat.lifecycle(pending,{session_key:key,native_id:'pending',event:'SessionStart',at:new Date().toISOString()})
  for(let i=0;i<41;i++) {
    await db.query(`INSERT INTO chat_sessions(id,agent_id,key_hash,label,nickname,cli_kind,channel_id,state,event_at,last_seen_at,removed_at,closed_at)
      VALUES($1,'test-client',$2,'Expulsado','Expulsado','codex_cli',$3,'offline',$4,$4,$4,$4)`,
      [`removed-${i}`,randomUUID(),member.channel.id,'2099-01-01T00:00:00.000Z'])
  }
  expect(await ops.call('chat_agents',{channel_id:member.channel.id,limit:40})).toMatchObject({
    total:1,items:[expect.objectContaining({id:member.session.id})],
  })
  expect(await ops.call('chat_agents',{channel_id:member.channel.id,include_closed:true})).toMatchObject({total:2})
  expect(await ops.call('chat_agents',{channel_id:member.channel.id,include_pending:true})).toMatchObject({total:1})
  expect(await ops.call('chat_agents',{channel_id:member.channel.id,include_removed:true,limit:40})).toMatchObject({total:43})
  expect((await ops.call('chat_agents',{channel_id:member.channel.id,include_removed:true,limit:40,offset:40})).items).toHaveLength(3)
})
it('conserva orden y páginas del roster aunque cambie la actividad o venza el lease',async()=>{
  const a=await register('a'),b=await register('b'),c=await register('c')
  for(const [member,created] of [[a,'2000-01-01'],[b,'2000-01-02'],[c,'2000-01-02']] as const)
    await db.query('UPDATE chat_sessions SET created_at=$2 WHERE id=$1',[member.session.id,created])
  const expected=[a.session.id,...[b.session.id,c.session.id].sort()]
  await db.query("UPDATE chat_sessions SET last_seen_at='2099-01-01',lease_until='2000-01-01' WHERE id=$1",[a.session.id])
  expect((await ops.call('chat_agents',{limit:2})).items.map((s:any)=>s.id)).toEqual(expected.slice(0,2))
  await db.query("UPDATE chat_sessions SET last_seen_at='2100-01-01' WHERE id=$1",[expected[2]])
  expect((await ops.call('chat_agents',{limit:2,offset:2})).items.map((s:any)=>s.id)).toEqual(expected.slice(2))
  expect((await ops.call('chat_agents',{})).total).toBe(3)
})
it('aísla canales y claves incluso con el mismo cliente instalado; no adivina una sesión',async()=> {
  const a=await register('a');worktree('other'); const b=await register('b','Stop',join(dir,'other'))
  await expect(send(a,b)).rejects.toThrow('mención')
  await expect(ops.call('chat_inbox',{session_key:a.k},'mcp',{...b.a,agent_id:'another-client'})).rejects.toThrow('Registrate')
  await expect(ops.call('chat_inbox',{},'mcp',{...a.a,session_id:'ambiguous-gateway'})).rejects.toThrow('Registrate')
  expect((await ops.call('chat_threads',{})).total).toBe(0) // Failed send also rolls back its new thread.
})
it('deduplica envío concurrente, conserva historial cerrado y busca por texto/autor',async()=> {
  const a=await register('a'),b=await register('b')
  const input={session_key:a.k,channel_id:a.channel.id,title:'Revisar',text:'Error: a - b',mentions:[b.session.id],request_id:'same-retry'}
  const [m,n]=await Promise.all([ops.call('chat_send',input,'mcp',a.a),ops.call('chat_send',input,'mcp',a.a)])
  expect(m.id).toBe(n.id)
  await expect(ops.call('chat_send',{...input,text:'different'},'mcp',a.a)).rejects.toThrow('request_id')
  await ops.chat.lifecycle(a.a,{session_key:a.k,native_id:'a',event:'SessionEnd',at:new Date().toISOString()})
  const result=await ops.call('chat_threads',{project_id:projectId,query:'a - b',author_id:a.session.id})
  expect(result.total).toBe(1);expect(result.items[0].messages).toBe(1)
  expect((await ops.call('chat_agents',{channel_id:a.channel.id,include_closed:true})).items.find((s:any)=>s.id===a.session.id).state).toBe('offline')
  await db.close();db=new MemoryDatabase(join(dir,'memory.sqlite'));await db.migrate()
  const persisted=await db.query('SELECT text FROM chat_messages WHERE id=$1',[m.id]);expect(persisted[0]!.text).toBe(input.text)
})
it('sólo SessionStart explícito revive una sesión cerrada, nunca hooks tardíos',async()=> {
  const a=await register('a');const end=new Date(Date.now()+10).toISOString()
  await ops.chat.lifecycle(a.a,{session_key:a.k,native_id:'a',event:'SessionEnd',at:end})
  await ops.chat.lifecycle(a.a,{session_key:a.k,native_id:'a',event:'Heartbeat',at:new Date().toISOString()})
  await ops.chat.lifecycle(a.a,{session_key:a.k,native_id:'a',event:'Stop',at:'2000-01-01T00:00:00.000Z'})
  for(const event of ['Watch','Stop','PreToolUse','UserPromptSubmit'])
    await ops.chat.lifecycle(a.a,{session_key:a.k,native_id:'a',event,at:new Date(Date.now()+1000).toISOString()})
  expect((await ops.call('chat_agents',{})).total).toBe(0)
  expect((await ops.call('chat_agents',{include_closed:true})).items[0].state).toBe('offline')
  await ops.chat.lifecycle(a.a,{session_key:a.k,native_id:'a',event:'SessionStart',at:new Date(Date.now()+2000).toISOString()})
  expect((await ops.call('chat_agents',{})).items[0]).toMatchObject({id:a.session.id,state:'idle'})
})
it('un PID y listener vivos no sostienen busy cuando se perdió Stop; no inventa cierre ni aviso',async()=>{
  const leader=await register('leader'),a=await register('stale','UserPromptSubmit'),runtime=new LocalChatRuntime(ops.chat,vi.fn(),()=>true,async()=>({parent:1,started:'birth',command:'claude'}))
  const thread=await send(leader,a),work={session_key:a.k,thread_id:thread.thread_id,work_id:'verify',summary:'Verificar cambio'}
  await ops.call('chat_work_update',{...work,event:'started',request_id:'start',expected_version:0},'mcp',a.a)
  await ops.call('chat_work_update',{...work,event:'waiting',waiting_for:'agent',request_id:'wait',expected_version:1},'mcp',a.a)
  const old=new Date(Date.now()-120_000).toISOString()
  await db.query('UPDATE chat_sessions SET event_at=$2,process_id=123,process_started=$3 WHERE id=$1',[a.session.id,old,'birth'])
  for(const event of ['Watch','Heartbeat'])await ops.chat.lifecycle({...a.a,cli_kind:'claude_code'},{session_key:a.k,native_id:'stale',event,at:new Date().toISOString()})
  await runtime.tick()
  const listed=(await ops.call('chat_agents',{active_only:true})).items.find((s:any)=>s.id===a.session.id)
  expect(listed).toMatchObject({state:'unknown',state_reason:'activity_stale',connection_state:'online',state_observed_at:old})
  expect((await ops.call('chat_join',{session_key:a.k},'mcp',a.a)).session.state).toBe('unknown')
  const tracked=(await ops.call('chat_work_list',{session_key:leader.k,thread_id:thread.thread_id},'mcp',leader.a)).items[0]
  expect(tracked).toMatchObject({status:'waiting',waiting_for:'agent',session_state:'unknown',session_state_reason:'activity_stale',connection_state:'online'})
  expect((await db.query('SELECT state,event_at FROM chat_sessions WHERE id=$1',[a.session.id]))[0]).toEqual({state:'busy',event_at:old})
  expect((await db.query('SELECT terminal_at FROM chat_turns WHERE session_id=$1',[a.session.id]))[0].terminal_at).toBeNull()
  expect(await db.query('SELECT * FROM chat_status_notices')).toHaveLength(0)
  const active=await ops.chat.lifecycle(a.a,{session_key:a.k,native_id:'stale',event:'PreToolUse',at:new Date().toISOString()})
  expect(active.session).toMatchObject({state:'busy',state_reason:null})
  const stopped=await ops.chat.lifecycle(a.a,{session_key:a.k,native_id:'stale',event:'Stop',at:new Date().toISOString()})
  expect(stopped.session.state).toBe('idle')
  await runtime.close()
})
it('notifica por evento, reintenta fallos y no vuelve a despertar lo ya leído',async()=> {
  const a=await register('a'),b=await register('b'),m=await send(a,b)
  const queue=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined), runtime=new LocalChatRuntime(ops.chat,queue)
  await runtime.tick();expect(queue).toHaveBeenCalledTimes(1)
  expect((await db.query('SELECT * FROM chat_deliveries'))[0]).toMatchObject({attempts:1,read_at:null,notified_at:null})
  await runtime.tick();expect(queue).toHaveBeenCalledTimes(1)
  await db.query("UPDATE chat_deliveries SET next_attempt_at='2000-01-01T00:00:00.000Z'")
  await runtime.tick();expect(queue).toHaveBeenCalledTimes(2);expect(queue.mock.calls[1]![0]).toBe('b')
  expect(queue.mock.calls[1]![1]).toContain(m.id);expect(queue.mock.calls[1]![1]).not.toContain('Revisá suma')
  await ops.call('chat_inbox',{session_key:b.k},'mcp',b.a)
  await db.query("UPDATE chat_deliveries SET next_attempt_at='2000-01-01T00:00:00.000Z'")
  await runtime.tick();expect(queue).toHaveBeenCalledTimes(2);await runtime.close()
})
it('el listener Claude entrega una vez, sin marcar lectura ni ejecutar texto',async()=> {
  const a=await register('a'),b=await register('b'),runtime=new LocalChatRuntime(ops.chat)
  const pending=runtime.wait(b.session.id); const m=await send(a,b)
  const result=await pending;expect(result.messages).toEqual([m.id]);expect(await ops.chat.pending(b.session.id)).toHaveLength(1)
  const abort=new AbortController();const wait=runtime.wait(b.session.id,abort.signal);abort.abort();expect((await wait).messages).toEqual([])
  await runtime.close()
})
it.each([['opencode','opencode_prompt'],['gemini_cli','acp_prompt'],['kiro','acp_prompt'],['antigravity','antigravity_stream']])('el listener de %s conserva identidad y no despierta mientras está ocupado',async(kind,transport)=>{
  const a=await register('sender'),b=await register('receiver'),m=await send(a,b)
  await db.query('UPDATE chat_sessions SET cli_kind=$2,capability=$3 WHERE id=$1',[b.session.id,kind,'next_turn'])
  const input={session_key:b.k,native_id:'receiver',event:'Watch',transport,at:new Date().toISOString()}
  const watching=await ops.chat.lifecycle({...b.a,cli_kind:kind!},input)
  expect(watching.session.capability).toBe(transport)
  await ops.chat.lifecycle(b.a,{...input,event:'UserPromptSubmit'})
  const runtime=new LocalChatRuntime(ops.chat),controller=new AbortController()
  const pending=runtime.wait(b.session.id,controller.signal)
  await new Promise(r=>setTimeout(r,20))
  expect((await db.query('SELECT attempts FROM chat_deliveries WHERE message_id=$1',[m.id]))[0].attempts).toBe(0)
  await ops.chat.lifecycle(b.a,{...input,event:'Stop',at:new Date().toISOString()})
  expect((await pending).messages).toEqual([m.id])
  expect((await db.query('SELECT read_at,handled_at FROM chat_deliveries WHERE message_id=$1',[m.id]))[0]).toMatchObject({read_at:null,handled_at:null})
  await runtime.close()
})
it('pagina sin perder menciones y separa leído/atendido',async()=> {
  const a=await register('a'),b=await register('b');await send(a,b,'first');await send(a,b,'second')
  expect((await ops.call('chat_inbox',{session_key:b.k,unread_only:true,limit:1},'mcp',b.a)).items[0].text).toBe('first')
  expect((await ops.call('chat_inbox',{session_key:b.k,unread_only:true,limit:1},'mcp',b.a)).items[0].text).toBe('second')
  expect((await ops.call('chat_inbox',{session_key:b.k},'mcp',b.a)).total).toBe(2)
})
it('respalda el historial sin transportar claves ni procesos activos',async()=> {
  const a=await register('a'),b=await register('b');await send(a,b)
  const backup=JSON.parse(await readBackup(store,(await exportMemory(store)).id))
  expect(backup.tables.chat_messages).toHaveLength(1)
  expect(backup.tables.chat_sessions[0]).toMatchObject({nickname:a.session.nickname,state:'offline',native_id:null,lease_until:null})
  const other=join(dir,'restored');const restored=new MemoryDatabase(join(other,'memory.sqlite'));await restored.migrate()
  try { await restoreMemory(new MemoryStore(restored,other),backup);expect((await restored.query('SELECT * FROM chat_messages')).length).toBe(1);expect((await restored.query('SELECT nickname FROM chat_sessions WHERE id=$1',[a.session.id]))[0].nickname).toBe(a.session.nickname) } finally {await restored.close()}
})
it('refleja una carpeta asociada a un proyecto después del registro',async()=> {
  await db.query("UPDATE entities SET data='{}' WHERE id=$1",[projectId])
  const a=await register('a');expect(a.channel.project_id).toBeNull()
  await db.query('UPDATE entities SET data=$2 WHERE id=$1',[projectId,JSON.stringify({folders:[dir]})])
  expect((await ops.call('chat_channels',{project_id:projectId})).items[0].id).toBe(a.channel.id)
})
it('el reemplazo de un listener deja salir al anterior y respeta el apagado de política',async()=> {
  const a=await register('a'),b=await register('b'),runtime=new LocalChatRuntime(ops.chat,vi.fn(),()=>false)
  await send(a,b);await runtime.tick();expect((await db.query('SELECT attempts FROM chat_deliveries'))[0]!.attempts).toBe(0)
  expect(await runtime.wait(b.session.id)).toMatchObject({closed:true,messages:[]});await runtime.close()
  const listeners=new LocalChatRuntime(ops.chat), abort=new AbortController()
  await ops.call('chat_inbox',{session_key:b.k},'mcp',b.a)
  const first=listeners.wait(b.session.id,undefined,'2026-01-01T00:00:00.000Z')
  const second=listeners.wait(b.session.id,abort.signal,'2026-01-02T00:00:00.000Z')
  expect(await first).toMatchObject({closed:true,messages:[]})
  expect(await listeners.wait(b.session.id,undefined,'2026-01-01T00:00:00.000Z')).toMatchObject({closed:true})
  abort.abort();await second;await listeners.close()
})

it('exige un nick elegido por la propia sesión y conserva la identidad al redefinirlo',async()=> {
  const a=author('new'),k=randomUUID()
  const r=await ops.chat.lifecycle(a,{session_key:k,native_id:'new',event:'SessionStart',at:new Date().toISOString()})
  expect(r.session).toMatchObject({nickname:null,needs_nickname:true,label:'Sin nick todavía'})
  expect((await ops.call('chat_agents',{})).total).toBe(0)
  await expect(ops.call('chat_inbox',{session_key:k},'mcp',a)).rejects.toMatchObject({statusCode:409})
  expect((await ops.call('chat_join',{session_key:k},'mcp',a)).session.needs_nickname).toBe(true)
  await expect(ops.call('chat_send',{session_key:k,channel_id:r.channel.id,title:'Hola',text:'Mensaje',request_id:'first'},'mcp',a)).rejects.toMatchObject({statusCode:409})
  await expect(ops.call('chat_work_update',{session_key:k,thread_id:randomUUID(),work_id:'claim',event:'started',summary:'Claim',request_id:'claim',expected_version:0},'mcp',a)).rejects.toThrow('nick')
  const named=await ops.call('chat_set_nick',{session_key:k,nickname:'  Bruma   Azul  '},'mcp',a)
  expect(named.session).toMatchObject({id:r.session.id,label:'Bruma Azul',nickname:'Bruma Azul',needs_nickname:false})
  const opened=await ops.call('chat_create_channel',{session_key:k,name:'Hola'},'mcp',a)
  const message=await ops.call('chat_send',{session_key:k,channel_id:opened.channel.id,title:'Hola',text:'Mensaje',request_id:'first'},'mcp',a)
  await ops.call('chat_set_nick',{session_key:k,nickname:'Ñandú 🌿'},'mcp',a)
  expect((await ops.call('chat_read',{thread_id:message.thread_id})).items[0]).toMatchObject({author_id:r.session.id,author_label:'Ñandú 🌿'})
  await expect(ops.call('chat_set_nick',{session_key:k,nickname:'Intruso'},'mcp',{...a,agent_id:'other'})).rejects.toMatchObject({statusCode:409})
  await expect(ops.call('chat_set_nick',{nickname:'Intruso'},'mcp',author('unregistered'))).rejects.toMatchObject({statusCode:409})
  for(const nickname of [randomUUID(),'native:abcdef','Invisible\u200b','Línea\nnueva'])
    await expect(ops.call('chat_set_nick',{session_key:k,nickname},'mcp',a)).rejects.toThrow()
})
it('reserva nicks de forma atómica en todo el Hub, sin distinguir mayúsculas ni formas Unicode',async()=> {
  const a=await register('a');worktree('other');const b=await register('b','Stop',join(dir,'other'))
  const results=await Promise.allSettled([
    ops.call('chat_set_nick',{session_key:a.k,nickname:'Bruma'},'mcp',a.a),
    ops.call('chat_set_nick',{session_key:b.k,nickname:'ＢＲＵＭＡ'},'mcp',b.a),
  ])
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
  expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{statusCode:409}})
  const winner=results[0].status==='fulfilled'?a:b, loser=winner===a?b:a
  await ops.chat.lifecycle(winner.a,{session_key:winner.k,native_id:'winner',event:'SessionEnd',at:new Date().toISOString()})
  await expect(ops.call('chat_set_nick',{session_key:loser.k,nickname:'bruma'},'mcp',loser.a)).rejects.toMatchObject({statusCode:409})
  await db.close();db=new MemoryDatabase(join(dir,'memory.sqlite'));await db.migrate()
  expect((await db.query("SELECT id FROM chat_sessions WHERE nickname_key='bruma'"))[0].id).toBe(winner.session.id)
})

it('migra identidades anteriores sin inventar nicks ni perder conversaciones',async()=> {
  const a=await register('a'),b=await register('b'),m=await send(a,b)
  await db.query('DROP INDEX chat_sessions_nickname')
  await db.query('ALTER TABLE chat_sessions DROP COLUMN nickname_key')
  await db.query('ALTER TABLE chat_sessions DROP COLUMN nickname')
  await db.query("UPDATE chat_sessions SET label='Codex · abc123'")
  await db.query('DELETE FROM schema_versions WHERE version=$1',[migrations.findIndex(m=>m.includes('ADD COLUMN nickname TEXT'))+1])
  await db.migrate()
  expect((await ops.call('chat_agents',{})).total).toBe(0)
  expect((await ops.call('chat_agents',{include_pending:true})).items).toHaveLength(2)
  expect((await ops.call('chat_read',{thread_id:m.thread_id})).items[0]).toMatchObject({id:m.id,author_id:a.session.id})
  await ops.call('chat_set_nick',{session_key:a.k,nickname:'Lumbre'},'mcp',a.a)
  expect((await ops.call('chat_read',{thread_id:m.thread_id})).items[0].author_label).toBe('Lumbre')
})

it('crea canales independientes, conserva identidad y cierra sólo el canal pedido',async()=> {
  const first=author('first'),second=author('second'),ka=randomUUID(),kb=randomUUID()
  const a=await ops.chat.lifecycle(first,{session_key:ka,native_id:'first',event:'SessionStart',at:new Date().toISOString()})
  const b=await ops.chat.lifecycle(second,{session_key:kb,native_id:'second',event:'SessionStart',at:new Date().toISOString()})
  expect(a.channel.id).not.toBe(b.channel.id)
  expect(a.channel.activated_at).toBeNull()
  expect((await ops.call('chat_channels',{})).total).toBe(0)
  await ops.call('chat_set_nick',{session_key:ka,nickname:'Brisa'},'mcp',first)
  await ops.call('chat_set_nick',{session_key:kb,nickname:'Faro'},'mcp',second)
  await expect(ops.call('chat_send',{session_key:ka,channel_id:a.channel.id,title:'Sin canal',text:'No',request_id:'pending'},'mcp',first)).rejects.toThrow('no tiene un canal activo')
  const [one,two]=await Promise.all([
    ops.call('chat_create_channel',{session_key:ka,task_key:'TASK',name:'Primero'},'mcp',first),
    ops.call('chat_create_channel',{session_key:kb,task_key:'TASK',name:'Segundo'},'mcp',second),
  ])
  expect(one.channel.id).not.toBe(two.channel.id)
  expect(one.session).toMatchObject({id:a.session.id,role:'leader'})
  expect(two.session).toMatchObject({id:b.session.id,role:'leader'})
  expect((await ops.call('chat_channels',{})).total).toBe(2)
  expect((await ops.call('chat_create_channel',{session_key:ka,task_key:'TASK'},'mcp',first)).channel.id).toBe(one.channel.id)
  const message=await ops.call('chat_send',{session_key:ka,channel_id:one.channel.id,title:'Trabajo',text:'Historia',request_id:'message'},'mcp',first)
  await ops.call('chat_close_channel',{session_key:ka},'mcp',first)
  expect((await ops.call('chat_channels',{channel_id:one.channel.id})).items[0].read_only).toBe(true)
  expect((await ops.call('chat_channels',{channel_id:two.channel.id})).items[0].read_only).toBe(false)
  await expect(ops.call('chat_join',{session_key:ka},'mcp',first)).rejects.toThrow('cerrado')
  expect((await ops.call('chat_read',{thread_id:message.thread_id})).items[0].text).toBe('Historia')
  const backup=JSON.parse(await readBackup(store,(await exportMemory(store)).id))
  expect(backup.schema_version).toBe(23)
  const restored=new MemoryDatabase(join(dir,'restored','memory.sqlite'));await restored.migrate()
  try {
    await restoreMemory(new MemoryStore(restored,join(dir,'restored')),backup)
    expect((await restored.query('SELECT text FROM chat_messages WHERE id=$1',[message.id]))[0].text).toBe('Historia')
    expect(await restored.query('PRAGMA foreign_key_check')).toEqual([])
  } finally {await restored.close()}
})
it('separa worktrees del mismo repositorio, agrupa subcarpetas y conserva canal al cambiar branch',async()=> {
  const a=await register('main'),path=worktree('feature'),b=await register('feature','Stop',path)
  await mkdir(join(path,'src'))
  const c=await register('nested','Stop',join(path,'src'))
  expect(a.channel.id).not.toBe(b.channel.id);expect(c.channel.id).toBe(b.channel.id)
  expect(b.channel.project_id).toBe(projectId)
  expect((await ops.call('chat_channels',{})).items.every((c:any)=>!c.read_only)).toBe(true)
  await expect(send(a,b)).rejects.toThrow('mención')
  execFileSync('git',['-C',path,'switch','--detach','-q'])
  const d=await register('detached','Stop',path)
  expect(d.channel.id).toBe(b.channel.id);expect(d.channel.branch).toBe(b.channel.branch)
  expect((await ops.call('chat_channels',{})).total).toBe(2)
})
it('conserva el historial y permite chat después de eliminar el worktree',async()=> {
  const path=worktree('temporary'),a=await register('a','Stop',path),b=await register('b','Stop',path),m=await send(a,b)
  git('worktree','remove',path)
  expect((await ops.call('chat_channels',{})).items[0]).toMatchObject({id:a.channel.id,read_only:false})
  expect((await ops.call('chat_read',{thread_id:m.thread_id})).items[0].text).toBe('Revisá suma')
  expect((await send(a,b,'Otro',m.thread_id)).thread_id).toBe(m.thread_id)
  await ops.call('chat_resolve',{session_key:a.k,thread_id:m.thread_id,state:'resolved'},'mcp',a.a)
})
it('el canal existente sigue disponible cuando cambia su carpeta',async()=> {
  const a=await register('a'),b=await register('b'),m=await send(a,b),sub=join(dir,'legacy')
  await mkdir(sub);await db.query('UPDATE chat_channels SET path=$2 WHERE id=$1',[a.channel.id,sub])
  expect((await ops.call('chat_channels',{})).items[0].read_only).toBe(false)
  await send(a,b)
  expect((await ops.call('chat_read',{thread_id:m.thread_id})).items).toHaveLength(1)
})

it('un worktree externo hereda el proyecto del repositorio principal',async()=> {
  const path=await mkdtemp(join(tmpdir(),'hub-chat-external-'))
  try {
    git('worktree','add','-qb','external',path)
    const a=await register('external','Stop',path)
    expect(a.channel.project_id).toBe(projectId)
    expect((await ops.call('chat_channels',{project_id:projectId})).items[0].id).toBe(a.channel.id)
  } finally {git('worktree','remove','--force',path);await rm(path,{recursive:true,force:true})}
})

it('un Git no disponible es un fallo reintentable, no un falso rechazo del worktree',async()=> {
  vi.stubEnv('PATH','')
  try {await expect(chatFolder(dir)).rejects.toMatchObject({statusCode:503})}
  finally {vi.unstubAllEnvs()}
  expect((await chatFolder(dir)).branch).toBe('main')
})


it('separa espacios de Orca sobre una carpeta sin Git y conserva el canal con gateways anteriores',async()=> {
  const plain=await mkdtemp(join(tmpdir(),'hub-orca-'))
  try {
    const one=`folder:${randomUUID()}`,two=`folder:${randomUUID()}`
    const registerSpace=async(name:string,space:string,path=plain)=>{
      const a={...author(name,path),orca_workspace_id:space},k=randomUUID()
      const r=await ops.chat.lifecycle(a,{session_key:k,native_id:name,event:'SessionStart',at:new Date().toISOString()})
      const named=await ops.call('chat_set_nick',{session_key:k,nickname:`Nube ${name}`},'mcp',a)
      return {a,k,...r,session:named.session}
    }
    const a=await registerSpace('a',one),b=await registerSpace('b',two)
    await mkdir(join(plain,'src'))
    const c=await registerSpace('c',one,join(plain,'src'))
    expect(a.channel.path).toBe(b.channel.path)
    expect(a.channel.id).not.toBe(b.channel.id)
    expect(c.channel.id).not.toBe(a.channel.id)
    const opened=await ops.call('chat_create_channel',{session_key:a.k,name:'Orca'},'mcp',a.a)
    a.channel=opened.channel
    const m=await ops.call('chat_send',{session_key:a.k,channel_id:a.channel.id,title:'Orca',text:'Historia',request_id:'orca-message'},'mcp',a.a)
    await expect(send(a,b)).rejects.toThrow('mención')
    const old=await ops.call('chat_join',{session_key:a.k},'mcp',author('a',plain))
    expect(old.channel.id).toBe(a.channel.id)
    expect(old.session.nickname).toBe('Nube a')
    const resumed=await ops.chat.lifecycle({...a.a,cwd:join(plain,'src')},{session_key:a.k,native_id:'a',event:'SessionStart',at:new Date().toISOString()})
    expect(resumed.channel.id).toBe(a.channel.id)
    expect((await ops.call('chat_read',{thread_id:m.thread_id})).items).toHaveLength(1)
    expect((await ops.call('chat_channels',{})).items.every((x:any)=>x.read_only===false)).toBe(true)
    await rm(plain,{recursive:true,force:true})
    await ops.call('chat_send',{session_key:a.k,thread_id:m.thread_id,text:'Sin carpeta',request_id:'no-folder'},'mcp',a.a)
    expect((await ops.call('chat_read',{thread_id:m.thread_id})).items).toHaveLength(2)
  } finally {await rm(plain,{recursive:true,force:true})}
})

it('migra canales por ruta sin cambiar IDs, mensajes ni recibos',async()=> {
  const a=await register('a'),b=await register('b'),m=await send(a,b)
  const receipts=await db.query('SELECT * FROM chat_deliveries')
  await db.query('DROP INDEX chat_channels_orca')
  await db.query('ALTER TABLE chat_channels DROP COLUMN orca_workspace_id')
  await db.query('UPDATE chat_channels SET scope_key=path')
  await db.query('ALTER TABLE chat_channels DROP COLUMN path')
  await db.query('ALTER TABLE chat_channels RENAME COLUMN scope_key TO path')
  await db.query('DELETE FROM schema_versions WHERE version=$1',[migrations.findIndex(m=>m.includes('RENAME COLUMN path TO scope_key'))+1])
  await db.query('DELETE FROM schema_versions WHERE version=$1',[migrations.findIndex(m=>m.includes('DROP INDEX chat_channels_orca'))+1])
  await db.migrate()
  expect((await db.query('SELECT * FROM chat_channels'))[0]).toMatchObject({id:a.channel.id,path:a.channel.path,scope_key:`git:${a.channel.path}`,orca_workspace_id:null})
  expect(await db.query('SELECT * FROM chat_deliveries')).toEqual(receipts)
  expect((await ops.call('chat_read',{thread_id:m.thread_id})).items[0].id).toBe(m.id)
  const space=`folder:${randomUUID()}`
  await db.query('UPDATE chat_channels SET scope_key=$2,orca_workspace_id=$3,name=$4 WHERE id=$1',[a.channel.id,`orca:${space}`,space,'EGA-333 & EGA-334'])
  expect((await ops.call('chat_join',{session_key:a.k},'mcp',a.a)).channel.name).toBe('EGA-333 & EGA-334')
  const fresh=await ops.chat.register({...author('c'),orca_workspace_id:space},randomUUID())
  expect(fresh.channel.id).not.toBe(a.channel.id)
  expect(fresh.channel.activated_at).toBeNull()
})

it.each(['folder','worktree','uncached','missing'] as const)('descarta un espacio Orca heredado de otro proyecto (%s)',async kind=>{
  const other=await mkdtemp(dir+'-other-')
  try {
    const workspace=kind==='folder'?`folder:${randomUUID()}`:`${randomUUID()}::${kind==='missing'?join(dir,'missing'):dir}`
    if(kind!=='uncached' && kind!=='missing')await ops.chat.register({...author('owner'),orca_workspace_id:workspace},randomUUID())
    const wrong=await ops.chat.register({...author('outside',other),orca_workspace_id:workspace},randomUUID())
    expect(wrong.channel).toMatchObject({path:await realpath(other),kind:'virtual',orca_workspace_id:null})
    expect(wrong.channel.path).not.toBe(dir)
    // A valid owner remains in its original channel; the stale ID was not repointed.
    if(kind==='folder' || kind==='worktree') {
      const owner=await ops.chat.register({...author('owner-again'),orca_workspace_id:workspace},randomUUID())
      expect(owner.channel.path).toBe(await realpath(dir))
      expect(owner.channel.id).not.toBe(wrong.channel.id)
    }
  } finally {await rm(other,{recursive:true,force:true})}
})

it('un ID Orca ajeno no desplaza el canal Git real, y admite subcarpetas y symlinks válidos',async()=>{
  const elsewhere=await mkdtemp(join(tmpdir(),'hub-orca-other-'))
  try {
    const stale=`${randomUUID()}::${elsewhere}`
    const ordinary=await register('git-owner')
    const actual=await ops.chat.register({...author('git-new'),orca_workspace_id:stale},randomUUID())
    expect(actual.channel.id).not.toBe(ordinary.channel.id)
    expect(actual.channel.orca_workspace_id).toBeNull()
    const workspace=`${randomUUID()}::${dir}`
    const root=await ops.chat.register({...author('space'),orca_workspace_id:workspace},randomUUID())
    await mkdir(join(dir,'src'))
    await symlink(dir,join(elsewhere,'alias'),'dir')
    for(const path of [join(dir,'src'),join(elsewhere,'alias','src')]) {
      const nested=await ops.chat.register({...author(randomUUID(),path),orca_workspace_id:workspace},randomUUID())
      expect(nested.channel.id).not.toBe(root.channel.id)
      expect(nested.channel.orca_workspace_id).toBe(workspace)
    }
  } finally {await rm(elsewhere,{recursive:true,force:true})}
})


it('restaura respaldos v6 anteriores a la identidad de espacio',async()=> {
  const a=await register('a'),b=await register('b');await send(a,b)
  const backup=JSON.parse(await readBackup(store,(await exportMemory(store)).id))
  backup.schema_version=6
  for(const c of backup.tables.chat_channels){delete c.scope_key;delete c.orca_workspace_id}
  const other=join(dir,'restore-v6'),restored=new MemoryDatabase(join(other,'memory.sqlite'));await restored.migrate()
  try {
    await restoreMemory(new MemoryStore(restored,other),backup)
    expect((await restored.query('SELECT * FROM chat_channels'))[0]).toMatchObject({id:a.channel.id,path:a.channel.path,scope_key:`git:${a.channel.path}`})
    expect(await restored.query('SELECT id FROM chat_messages')).toHaveLength(1)
    expect(await restored.query('PRAGMA foreign_key_check')).toEqual([])
  }finally{await restored.close()}
})

it('despierta Codex idle con lease vencido y sin PID propio, pero no una sesión cerrada',async()=>{
  const a=await register('a'),b=await register('b');await send(a,b)
  await db.query("UPDATE chat_sessions SET lease_until='2000-01-01T00:00:00.000Z',process_id=NULL WHERE id=$1",[b.session.id])
  const queue=vi.fn().mockResolvedValue(undefined),runtime=new LocalChatRuntime(ops.chat,queue)
  await runtime.tick();expect(queue).toHaveBeenCalledTimes(1)
  await db.query("UPDATE chat_deliveries SET next_attempt_at='2000-01-01T00:00:00.000Z'")
  await db.query("UPDATE chat_sessions SET closed_at=now() WHERE id=$1",[b.session.id])
  await runtime.tick();expect(queue).toHaveBeenCalledTimes(1);await runtime.close()
})

it('el host Orca no es un transporte: Kiro requiere su conexión nativa',async()=>{
  const workspace=`folder:${randomUUID()}`,a=author('kiro')
  const key=randomUUID(),who={...a,cli_kind:'kiro',orca_workspace_id:workspace,
    orca_terminal:{handle:`term_${randomUUID()}`,incarnation_id:'i',runtime_id:'r',workspace_id:workspace,process_id:process.pid,process_started:'birth'}}
  const registered=await ops.chat.register(who,key)
  expect(registered.session.capability).toBe('next_turn')
  const connected=await ops.chat.lifecycle(who,{session_key:key,native_id:'kiro',event:'Watch',transport:'acp_prompt',at:new Date().toISOString()})
  expect(connected.session.id).toBe(registered.session.id)
  expect(connected.session.capability).toBe('acp_prompt')
})

it.each([undefined,`folder:${randomUUID()}`])('el nick no activa canales ni incorpora otras terminales (%s)',async workspace=>{
  const passive=async(name:string)=> {
    const a={...author(name),...(workspace?{orca_workspace_id:workspace}:{})},key=randomUUID()
    return {a,key,...await ops.chat.lifecycle(a,{session_key:key,native_id:name,event:'SessionStart',at:new Date().toISOString()})}
  }
  const first=await passive('early'),second=await passive('leader')
  const queue=vi.fn().mockResolvedValue(undefined),runtime=new LocalChatRuntime(ops.chat,queue)
  try {
    await ops.call('chat_set_nick',{session_key:second.key,nickname:'Faro'},'mcp',second.a)
    const named=await ops.chat.lifecycle(second.a,{session_key:second.key,native_id:'leader',event:'UserPromptSubmit',at:new Date().toISOString()})
    expect(named.team.leader_id).toBeNull()
    await runtime.tick();expect(queue).not.toHaveBeenCalled()
    const opened=await ops.call('chat_create_channel',{session_key:second.key,name:'Equipo'},'mcp',second.a)
    expect(opened.team.leader_id).toBe(second.session.id)
    await runtime.tick();expect(queue).not.toHaveBeenCalled()
    expect((await ops.chat.team(first.channel.id)).leader_id).toBeNull()
    expect((await db.query('SELECT team_seen FROM chat_sessions WHERE id=$1',[first.session.id]))[0].team_seen).toBe(false)
    expect((await ops.call('chat_agents',{channel_id:opened.channel.id})).total).toBe(1)
  } finally {await runtime.close()}
})

it('sólo el líder reconocido expulsa dentro de su canal; conserva historial y cancela pendientes sin inventar lecturas',async()=>{
 const leader=await register('leader'),member=await register('member'),other=await register('other','Stop',worktree('other'))
 const message=await send(leader,member),input={channel_id:leader.channel.id,participant_id:member.session.id,reason:'La persona pidió retirar este agente'}
 await expect(ops.call('chat_kick',{...input,session_key:member.k},'mcp',member.a)).rejects.toThrow('Sólo el líder')
 await expect(ops.call('chat_kick',{...input,session_key:other.k},'mcp',other.a)).rejects.toThrow('Sólo el líder')
 await expect(ops.call('chat_kick',{...input,participant_id:other.session.id,session_key:leader.k},'mcp',leader.a)).rejects.toThrow('no pertenece')
 await expect(ops.call('chat_kick',{...input,participant_id:leader.session.id,session_key:leader.k},'mcp',leader.a)).rejects.toThrow('sí mismo')
 await expect(ops.call('chat_kick',input,'human')).rejects.toThrow('Sólo el líder')
 const result=await ops.call('chat_kick',{...input,session_key:leader.k},'mcp',leader.a)
 expect(result.session).toMatchObject({state:'removed',removed_by:`agent:${leader.session.id}`,removal_reason:input.reason,nickname:member.session.nickname})
 expect(result.team.leader_id).toBe(leader.session.id)
 const again=await ops.call('chat_kick',{...input,reason:'Reintento',session_key:leader.k},'mcp',leader.a)
 expect(again.session.removed_at).toBe(result.session.removed_at);expect(again.session.removal_reason).toBe(input.reason)
 const history=await ops.call('chat_read',{thread_id:message.thread_id})
 expect(history.items[0].mentions[0]).toMatchObject({read_at:null,handled_at:null,error:'Destinatario expulsado del canal'})
 expect(history.items[0].mentions[0].cancelled_at).toBeTruthy()
 expect((await ops.call('chat_agents',{channel_id:leader.channel.id,active_only:true})).items.some((s:any)=>s.id===member.session.id)).toBe(false)
 expect((await ops.call('chat_agents',{channel_id:leader.channel.id})).items.some((s:any)=>s.id===member.session.id)).toBe(false)
 expect((await ops.call('chat_agents',{channel_id:leader.channel.id,include_removed:true})).items.find((s:any)=>s.id===member.session.id).state).toBe('removed')
 await expect(send(leader,member,'No debería enviarse')).rejects.toThrow('expulsada')
})
it('la expulsión sobrevive hooks, claves nuevas y reconexiones de la misma conversación',async()=>{
 const leader=await register('leader'),member=await register('member')
 await ops.chat.kick({channel_id:member.channel.id,participant_id:member.session.id,reason:'Retiro manual'},{user_id:'local-owner'})
 for(const event of ['SessionStart','UserPromptSubmit','Stop','Watch','Heartbeat']) {
  await expect(ops.chat.lifecycle(member.a,{session_key:member.k,native_id:'member',event,at:new Date().toISOString()})).rejects.toMatchObject({statusCode:410})
 }
 await expect(ops.chat.lifecycle(member.a,{session_key:randomUUID(),native_id:'member',event:'SessionStart',at:new Date().toISOString()})).rejects.toMatchObject({statusCode:410})
 for(const args of [{session_key:member.k},{}, {session_key:randomUUID(),path:worktree('escaped')}])await expect(ops.call('chat_join',args,'mcp',member.a)).rejects.toMatchObject({statusCode:410})
 for(const [op,args] of [['chat_inbox',{}],['chat_set_nick',{nickname:'Otro nick'}],['chat_channels',{}],['chat_threads',{}]])await expect(ops.call(String(op),{...args,session_key:member.k},'mcp',member.a)).rejects.toMatchObject({statusCode:410})
 expect((await ops.call('chat_join',{session_key:leader.k},'mcp',leader.a)).session.id).toBe(leader.session.id)
 // A fresh conversation on the same installed client is a distinct participant, not an account ban.
 expect((await register('fresh')).session.state).toBe('idle')
})
it('también vincula sesiones MCP sin identidad nativa para impedir reingreso sin clave',async()=>{
 const a={...author('fallback'),session_id:randomUUID()},pending=await ops.call('chat_join',{},'mcp',a)
 await ops.call('chat_set_nick',{session_key:pending.session_key,nickname:'Fallback'},'mcp',a)
 const joined=await ops.call('chat_join',{session_key:pending.session_key},'mcp',a)
 await ops.chat.kick({channel_id:joined.channel.id,participant_id:joined.session.id,reason:'Retiro manual'},{user_id:'local-owner'})
 await expect(ops.call('chat_join',{},'mcp',a)).rejects.toMatchObject({statusCode:410})
})
it('la persona puede expulsar al líder y la siguiente activación habilitada elige al coordinador',async()=>{
 const leader=await register('leader'),member=await register('member')
 const input={channel_id:leader.channel.id,participant_id:leader.session.id,reason:'Cambio solicitado por la persona'}
 await expect(ops.chat.kick({...input,project_id:randomUUID()},{user_id:'local-owner'})).rejects.toMatchObject({statusCode:404})
 const result=await ops.chat.kick(input,{user_id:'local-owner'})
 expect(result.team.leader_id).toBeNull();expect(result.session.removed_by).toBe('user:local-owner')
 expect((await ops.call('chat_join',{session_key:member.k},'mcp',member.a)).team.leader_id).toBe(member.session.id)
})
it('cierra la escucha pendiente y no vuelve a entregar ni incorporar a una sesión expulsada',async()=>{
 const leader=await register('leader'),member=await register('member'),queue=vi.fn()
 const runtime=new LocalChatRuntime(ops.chat,queue)
 const waiting=runtime.wait(member.session.id)
 await new Promise(r=>setTimeout(r,20))
 await ops.chat.kick({channel_id:member.channel.id,participant_id:member.session.id,reason:'Retiro manual'},{user_id:'local-owner'})
 expect(await waiting).toMatchObject({closed:true,messages:[]})
 await runtime.tick();expect(queue).not.toHaveBeenCalled();await runtime.close()
 expect((await ops.call('chat_join',{session_key:leader.k},'mcp',leader.a)).team.leader_id).toBe(leader.session.id)
})
it('respalda expulsión y cancelaciones y mantiene el bloqueo después de restaurar',async()=>{
 const leader=await register('leader'),member=await register('member');await send(leader,member)
 await ops.chat.kick({channel_id:member.channel.id,participant_id:member.session.id,reason:'Retiro manual'},{user_id:'owner'})
 const backup=JSON.parse(await readBackup(store,(await exportMemory(store)).id)),path=join(dir,'removed-restore'),restored=new MemoryDatabase(join(path,'memory.sqlite'));await restored.migrate()
 try {
  const target=new MemoryStore(restored,path);await restoreMemory(target,backup)
  expect((await restored.query('SELECT * FROM chat_sessions WHERE id=$1',[member.session.id]))[0]).toMatchObject({removal_reason:'Retiro manual',removed_by:'user:owner',gateway_session_id:null})
  expect((await restored.query('SELECT * FROM chat_deliveries'))[0].cancelled_at).toBeTruthy()
  const service=new MemoryOperations(target,new MemoryAI(async()=>defaultAI,new Vault(path)))
  await expect(service.call('chat_join',{},'mcp',member.a)).rejects.toMatchObject({statusCode:410})
 }finally{await restored.close()}
})
it('serializa un envío concurrente con expulsión: no quedan entregas activas después de retirar',async()=>{
 const leader=await register('leader'),member=await register('member')
 const results=await Promise.allSettled([send(leader,member),ops.chat.kick({channel_id:member.channel.id,participant_id:member.session.id,reason:'Retiro concurrente'},{user_id:'owner'})])
 expect(results[1].status).toBe('fulfilled')
 expect(await db.query('SELECT * FROM chat_deliveries WHERE recipient_id=$1 AND cancelled_at IS NULL',[member.session.id])).toHaveLength(0)
 await expect(send(member,leader)).rejects.toMatchObject({statusCode:410})
})


it('entrega guía recuperable en join y metadatos compactos en inbox; la versión cambia con el líder',async()=>{
  const a=await register('a'),b=await register('b')
  const first=await ops.call('chat_join',{session_key:b.k},'mcp',b.a)
  expect(first.team).toMatchObject({scope:'channel',channel_id:b.channel.id,linked_team:null,guidance:expect.any(String),guidance_version:expect.any(String)})
  const inbox=await ops.call('chat_inbox',{session_key:b.k},'mcp',b.a)
  expect(inbox.team.guidance).toBeUndefined()
  expect(inbox.team.guidance_version).toBe(first.team.guidance_version)
  // Compaction/reconnect explicitly re-fetches the same guidance; no per-process cache.
  expect((await ops.call('chat_join',{session_key:b.k},'mcp',b.a)).team.guidance).toBe(first.team.guidance)
  await ops.chat.kick({channel_id:a.channel.id,participant_id:a.session.id,reason:'Cambio de líder solicitado'},{user_id:'owner'})
  const changed=await ops.call('chat_inbox',{session_key:b.k},'mcp',b.a)
  expect(changed.team.leader_id).toBe(b.session.id)
  expect(changed.team.guidance_version).not.toBe(first.team.guidance_version)
})
it('recupera referencias bajo demanda sin perder operaciones del catálogo ni sus argumentos',async()=>{
  const reference=await ops.call('skill_reference',{section:'memory-tools'})
  expect(reference.text).toContain('memory_chat_work_update')
  const orchestration=await ops.call('skill_reference',{section:'team-orchestration'})
  expect(orchestration.text).toContain('memory_team_launch')
  expect(orchestration.text).toContain('digest')
  const entry=await ops.call('skill_reference',{section:'local-collaboration'})
  expect(entry.text).toContain('team-orchestration')
  expect(entry.text.length).toBeLessThan(16000)
  await expect(ops.call('skill_reference',{section:'../../private'})).rejects.toThrow()
})
it('conserva progreso explícito separado de heartbeat, Stop, esperas y reintentos',async()=>{
  const a=await register('a'),b=await register('b'),m=await send(a,b)
  const start={session_key:a.k,thread_id:m.thread_id,work_id:'fix-login',request_id:'start',expected_version:0,event:'started',summary:'Corregir login'}
  const initial=await ops.call('chat_work_update',start,'mcp',a.a)
  expect(initial).toMatchObject({version:1,status:'active',last_progress_at:null,report_message_id:null})
  const progress={...start,event:'progress',summary:'Regresión reproducida',expected_version:1,request_id:'progress'}
  const updated=await ops.call('chat_work_update',progress,'mcp',a.a)
  expect(updated).toMatchObject({version:2,last_progress_at:expect.any(String)})
  const wait={...start,event:'waiting',waiting_for:'permission',summary:'Espero aprobación',expected_version:2,request_id:'wait'}
  expect(await ops.call('chat_work_update',wait,'mcp',a.a)).toMatchObject({version:3,status:'waiting',waiting_for:'permission'})
  // A late retry returns its original receipt without overwriting a subsequent wait.
  expect(await ops.call('chat_work_update',progress,'mcp',a.a)).toEqual(updated)
  await expect(ops.call('chat_work_update',{...progress,summary:'Otro evento'},'mcp',a.a)).rejects.toMatchObject({statusCode:409})
  await expect(ops.call('chat_work_update',{...progress,request_id:'stale'},'mcp',a.a)).rejects.toMatchObject({statusCode:409})
  for(const event of ['Heartbeat','Stop'])await ops.chat.lifecycle(a.a,{session_key:a.k,native_id:'a',event,at:new Date().toISOString()})
  const listed=await ops.call('chat_work_list',{session_key:b.k,thread_id:m.thread_id},'mcp',b.a)
  expect(listed.items[0]).toMatchObject({version:3,status:'waiting',waiting_for:'permission',last_progress_at:updated.last_progress_at,report_message_id:null,session_state:'idle'})
  expect(JSON.stringify(listed)).not.toContain(a.k)
})
it('finalización exige un reporte propio del mismo hilo y no simula lectura del destinatario',async()=>{
  const a=await register('a'),b=await register('b'),m=await send(a,b)
  const start={session_key:a.k,thread_id:m.thread_id,work_id:'fix',request_id:'start',expected_version:0,event:'started',summary:'Trabajo'}
  await ops.call('chat_work_update',start,'mcp',a.a)
  const complete={...start,event:'completed',summary:'Terminado',expected_version:1,request_id:'done'}
  await expect(ops.call('chat_work_update',complete,'mcp',a.a)).rejects.toThrow()
  const other=await send(b,a,'Reporte de otra sesión',m.thread_id)
  await expect(ops.call('chat_work_update',{...complete,report_message_id:other.id},'mcp',a.a)).rejects.toMatchObject({statusCode:400})
  const wrongThread=await send(a,b,'Otro trabajo')
  await expect(ops.call('chat_work_update',{...complete,report_message_id:wrongThread.id},'mcp',a.a)).rejects.toMatchObject({statusCode:400})
  const report=await send(a,b,'Pruebas pasaron; detalle del resultado',m.thread_id)
  const done=await ops.call('chat_work_update',{...complete,report_message_id:report.id},'mcp',a.a)
  expect(done).toMatchObject({status:'completed',report_receipt:'persisted',report_message_id:report.id,reported_at:expect.any(String)})
  const delivery=(await db.query('SELECT read_at,handled_at FROM chat_deliveries WHERE message_id=$1',[report.id]))[0]
  expect(delivery).toMatchObject({read_at:null,handled_at:null})
  await expect(ops.call('chat_work_update',{...start,event:'progress',expected_version:2,request_id:'reopen'},'mcp',a.a)).rejects.toMatchObject({statusCode:409})
  const exported=await exportMemory(store),backup=JSON.parse(await readBackup(store,exported.id))
  expect(backup.tables.chat_work_state).toHaveLength(1)
  const target=join(dir,'restore-work'),restored=new MemoryDatabase(join(target,'memory.sqlite'));await restored.migrate()
  try {
    await restoreMemory(new MemoryStore(restored,target),backup)
    expect((await restored.query('SELECT status,report_message_id FROM chat_work_state'))[0]).toMatchObject({status:'completed',report_message_id:report.id})
    expect((await restored.query('SELECT count(*) AS n FROM chat_work_events'))[0].n).toBe(2)
    expect(await restored.query('PRAGMA foreign_key_check')).toEqual([])
  } finally {await restored.close()}
})
it('rechaza acceso a estados ajenos fuera del canal y claves de otra sesión',async()=>{
  const a=await register('a'),b=await register('b'),m=await send(a,b),outside=await register('outside','Stop',worktree('outside'))
  await expect(ops.call('chat_work_list',{session_key:outside.k,thread_id:m.thread_id},'mcp',outside.a)).rejects.toMatchObject({statusCode:403})
  await expect(ops.call('chat_work_update',{session_key:outside.k,thread_id:m.thread_id,work_id:'x',request_id:'x',expected_version:0,event:'started',summary:'Ajeno'},'mcp',outside.a)).rejects.toMatchObject({statusCode:403})
  await expect(ops.call('chat_work_list',{session_key:a.k,thread_id:m.thread_id},'mcp',{...outside.a,agent_id:'foreign-client'})).rejects.toThrow('Registrate')
})

it('global disable suppresses runtime work and resumes delivery when re-enabled', async () => {
  const leader = await register('toggle-leader'), member = await register('toggle-member')
  await db.query("UPDATE chat_sessions SET capability='codex_queue',team_seen=1 WHERE id=$1", [member.session.id])
  await send(leader, member)
  let enabled = false
  const queue = vi.fn(async () => {}), inspect = vi.fn(async () => undefined)
  const runtime = new LocalChatRuntime(ops.chat, queue, () => true, inspect, () => enabled)
  await runtime.tick()
  expect(queue).not.toHaveBeenCalled()
  expect(inspect).not.toHaveBeenCalled()
  expect((await db.query('SELECT attempts FROM chat_deliveries WHERE recipient_id=$1', [member.session.id]))[0].attempts).toBe(0)
  enabled = true
  await runtime.tick()
  expect(queue).toHaveBeenCalledTimes(1)
  await runtime.close()
})

async function managedMember() {
  const leader=await register('fleet-leader'),member=await register('fleet-member','Stop',worktree('fleet-worker'))
  const thread=await ops.call('chat_send',{session_key:leader.k,channel_id:leader.channel.id,title:'Plan de flota',text:'Plan aprobado',mentions:[],request_id:randomUUID()},'mcp',leader.a)
  const plan=randomUUID(),id=randomUUID()
  await db.query(`INSERT INTO chat_team_plans(id,master_channel_id,root_thread_id,created_by,objective,parent,base_revision,plan,digest,state)
    VALUES($1,$2,$3,$4,'Fixture','{}','base','{}',$5,'active')`,[plan,leader.channel.id,thread.thread_id,leader.session.id,randomUUID()])
  await db.query(`INSERT INTO chat_team_members(id,team_id,ordinal,worktree_name,cli,model,role,task,prompt,state,session_id,channel_id)
    VALUES($1,$2,0,'worker','codex_cli','fixture','worker','task','prompt','joined',$3,$4)`,[id,plan,member.session.id,member.channel.id])
  return {leader,member,plan,thread}
}
it('native fleet completion beats late hooks and privately alerts the master after grace',async()=>{
  const {leader,member}=await managedMember(),at=Date.now()+1000
  await ops.chat.managedLifecycle(member.session.id,'UserPromptSubmit',new Date(at).toISOString(),'native-turn')
  await ops.chat.managedLifecycle(member.session.id,'Stop',new Date(at+10).toISOString(),'native-turn')
  await ops.chat.lifecycle(member.a,{session_key:member.k,native_id:'fleet-member',event:'PreToolUse',at:new Date(at+20).toISOString(),transport:'codex_queue'})
  await ops.chat.lifecycle(member.a,{session_key:member.k,native_id:'fleet-member',event:'Watch',at:new Date(at+30).toISOString(),transport:'codex_queue'})
  expect((await db.query('SELECT state,capability,event_at FROM chat_sessions WHERE id=$1',[member.session.id]))[0]).toEqual({state:'idle',capability:'hub_fleet',event_at:new Date(at+10).toISOString()})
  await ops.chat.processTurnAlerts(at+20,100)
  expect(await db.query('SELECT * FROM chat_status_notices')).toHaveLength(0)
  await ops.chat.processTurnAlerts(at+200,100)
  expect((await db.query('SELECT recipient_id,session_id FROM chat_status_notices'))[0]).toEqual({recipient_id:leader.session.id,session_id:member.session.id})
  expect(await db.query('SELECT * FROM chat_threads')).toHaveLength(1)
})
it('old native completion cannot close a newer fleet turn and revoked teams cannot become busy',async()=>{
  const {member,plan}=await managedMember(),at=Date.now()+1000
  await ops.chat.managedLifecycle(member.session.id,'UserPromptSubmit',new Date(at).toISOString(),'one')
  await ops.chat.managedLifecycle(member.session.id,'UserPromptSubmit',new Date(at+10).toISOString(),'two')
  await ops.chat.managedLifecycle(member.session.id,'Stop',new Date(at+20).toISOString(),'one')
  expect((await db.query('SELECT state FROM chat_sessions WHERE id=$1',[member.session.id]))[0].state).toBe('busy')
  await db.query("UPDATE chat_team_plans SET state='cancelled' WHERE id=$1",[plan])
  await ops.chat.managedLifecycle(member.session.id,'SessionEnd',new Date(at+30).toISOString(),'two')
  await ops.chat.managedLifecycle(member.session.id,'UserPromptSubmit',new Date(at+40).toISOString(),'three')
  expect((await db.query('SELECT state FROM chat_sessions WHERE id=$1',[member.session.id]))[0].state).toBe('offline')
  expect(await db.query("SELECT * FROM chat_turns WHERE session_id=$1 AND turn_id='three'",[member.session.id])).toHaveLength(0)
})
it('managed notifications use the owned transport and never a native queue or async re-wake',async()=>{
  const {leader,member,thread}=await managedMember(),at=Date.now()+1000
  await ops.chat.managedLifecycle(member.session.id,'UserPromptSubmit',new Date(at).toISOString(),'one')
  await ops.chat.managedLifecycle(member.session.id,'Stop',new Date(at+10).toISOString(),'one')
  await db.query('UPDATE chat_sessions SET team_seen=1 WHERE id=$1',[member.session.id])
  await send(leader,member,'Reportá tu estatus en el Hub',thread.thread_id)
  const queue=vi.fn(),wake=vi.fn(async()=>true)
  const runtime=new LocalChatRuntime(ops.chat,queue,()=>true,async()=>undefined,()=>true,{wake,connected:async()=>true})
  expect(await runtime.wait(member.session.id)).toEqual({closed:true,messages:[]})
  await runtime.tick()
  expect(wake).toHaveBeenCalledWith(member.session.id,expect.stringContaining('memory_chat_inbox'))
  expect(queue).not.toHaveBeenCalled()
  expect((await db.query('SELECT event_at FROM chat_sessions WHERE id=$1',[member.session.id]))[0].event_at).toBe(new Date(at+10).toISOString())
  await runtime.close()
})
it('queues a mention once while Codex is busy without marking it read or changing activity',async()=>{
  const leader=await register('sender'),recipient=await register('busy-codex'),at=new Date(Date.now()+1000).toISOString()
  await ops.chat.lifecycle(recipient.a,{session_key:recipient.k,native_id:'busy-codex',event:'UserPromptSubmit',at,turn_id:'busy'})
  const message=await send(leader,recipient,'Hallazgo que cambia la implementación')
  const queue=vi.fn(async()=>{})
  const runtime=new LocalChatRuntime(ops.chat,queue,()=>true,async()=>undefined)
  await runtime.tick();await runtime.tick()
  expect(queue).toHaveBeenCalledTimes(1)
  expect(queue).toHaveBeenCalledWith('busy-codex',expect.stringContaining(message.id))
  const delivery=(await db.query('SELECT * FROM chat_deliveries WHERE message_id=$1',[message.id]))[0]
  expect(delivery.notified_at).toBeTruthy();expect(delivery.read_at).toBeNull();expect(delivery.handled_at).toBeNull()
  expect((await db.query('SELECT state,event_at FROM chat_sessions WHERE id=$1',[recipient.session.id]))[0]).toEqual({state:'busy',event_at:at})
  await runtime.close()
})
it('does not replay an uncertain native steer receipt but retains the unread message',async()=>{
  const {leader,member,thread}=await managedMember(),at=new Date(Date.now()+1000).toISOString()
  await ops.chat.managedLifecycle(member.session.id,'UserPromptSubmit',at,'busy')
  const message=await send(leader,member,'Cambio de dirección',thread.thread_id)
  const wake=vi.fn(async()=>{throw Object.assign(new Error('fleet_steer_unconfirmed'),{retryable:false})})
  const runtime=new LocalChatRuntime(ops.chat,vi.fn(),()=>true,async()=>undefined,()=>true,{wake,connected:async()=>true})
  await runtime.tick();await runtime.tick()
  expect(wake).toHaveBeenCalledTimes(1)
  const delivery=(await db.query('SELECT * FROM chat_deliveries WHERE message_id=$1',[message.id]))[0]
  expect(delivery.attempts).toBe(5);expect(delivery.read_at).toBeNull();expect(delivery.error).toContain('incierta')
  await runtime.close()
})
it('routes native questions before join once to the offline master without creating threads',async()=>{
  const {leader,member,plan}=await managedMember(),generation=randomUUID(),questionId=randomUUID()
  const id=(await db.query('SELECT id FROM chat_team_members WHERE team_id=$1',[plan]))[0].id
  const questions=[{id:questionId,questions:[{id:'target',header:'Destino',question:'¿Qué entorno?',options:[{label:'dev',description:'Prueba'}]}]}]
  await db.query("UPDATE chat_team_members SET state='accepted',session_id=NULL,channel_id=NULL,runtime=$2 WHERE id=$1",[id,JSON.stringify({provider:'hub',generation,state:'waiting_input',questions})])
  await db.query("UPDATE chat_sessions SET state='offline',closed_at=now() WHERE id=$1",[leader.session.id])
  await ops.chat.managedQuestions(id,questions,generation);await ops.chat.managedQuestions(id,questions,generation)
  const deliveries=await db.query('SELECT m.text,d.recipient_id FROM chat_deliveries d JOIN chat_messages m ON m.id=d.message_id WHERE m.request_id LIKE $1',['fleet-question:%'])
  expect(deliveries).toHaveLength(1);expect(deliveries[0].recipient_id).toBe(leader.session.id)
  expect(deliveries[0].text).toContain(questionId);expect(deliveries[0].text).toContain('memory_team_answer')
  expect(await db.query('SELECT * FROM chat_threads')).toHaveLength(1)
  expect((await ops.call('chat_agents',{channel_id:leader.channel.id},'mcp',leader.a)).items.some((item:any)=>item.cli_kind==='hub')).toBe(false)
  await db.query("UPDATE chat_team_plans SET state='cancelled' WHERE id=$1",[plan])
  await ops.chat.managedQuestions(id,[{...questions[0]!,id:randomUUID()}],generation)
  expect(await db.query('SELECT * FROM chat_messages WHERE request_id LIKE $1',['fleet-question:%'])).toHaveLength(1)
  expect(member.session.id).toBeTruthy()
})

it('la salida confirmada del PID retira el roster y hooks tardíos no lo reincorporan',async()=>{
  const a=await register('terminated'),runtime=new LocalChatRuntime(ops.chat,vi.fn(),()=>true,async()=>null)
  await db.query('UPDATE chat_sessions SET process_id=123,process_started=$2 WHERE id=$1',[a.session.id,'birth'])
  await runtime.tick()
  for(const event of ['Watch','Heartbeat','Stop','PreToolUse'])
    await ops.chat.lifecycle(a.a,{session_key:a.k,native_id:'terminated',event,at:new Date(Date.now()+1000).toISOString()})
  expect((await ops.call('chat_agents',{})).total).toBe(0)
  expect((await ops.call('chat_agents',{include_closed:true})).items[0]).toMatchObject({id:a.session.id,state:'offline'})
  await runtime.close()
})
it('SessionEnd nativo retira la flota sin permitir eventos tardíos ni perder su aviso privado',async()=>{
  const {leader,member}=await managedMember(),at=Date.now()+1000
  await ops.chat.managedLifecycle(member.session.id,'UserPromptSubmit',new Date(at).toISOString(),'one')
  await ops.chat.managedLifecycle(member.session.id,'SessionEnd',new Date(at+10).toISOString(),'one')
  for(const event of ['Stop','UserPromptSubmit','RequestUserInput'])
    await ops.chat.managedLifecycle(member.session.id,event,new Date(at+20).toISOString(),'two')
  expect((await ops.call('chat_agents',{channel_id:member.channel.id})).total).toBe(0)
  await ops.chat.processTurnAlerts(at+200,100)
  expect((await db.query('SELECT recipient_id,session_id FROM chat_status_notices'))[0]).toEqual({recipient_id:leader.session.id,session_id:member.session.id})
})

it('un pedido conserva destinatarios y requiere respuesta vinculada, sin ACK ni cierre prematuros',async()=>{
 const a=await register('requester'),b=await register('operator'),c=await register('observer')
 const request=await ops.call('chat_send',{session_key:a.k,channel_id:a.channel.id,title:'Validación',text:'Devolvé evidencia',mentions:[b.session.id,c.session.id],response_required:true,request_id:'request'},'mcp',a.a)
 await ops.call('chat_inbox',{session_key:b.k},'mcp',b.a)
 await expect(ops.call('chat_ack',{session_key:b.k,message_id:request.id},'mcp',b.a)).rejects.toMatchObject({statusCode:409})
 await expect(ops.call('chat_resolve',{session_key:a.k,thread_id:request.thread_id,state:'resolved'},'mcp',a.a)).rejects.toMatchObject({statusCode:409})
 const replyInput={session_key:b.k,thread_id:request.thread_id,reply_to:request.id,text:'Evidencia comprobada',request_id:'response'}
 const reply=await ops.call('chat_send',replyInput,'mcp',b.a)
 expect((await ops.call('chat_inbox',{session_key:a.k},'mcp',a.a)).items.some((m:any)=>m.id===reply.id)).toBe(true)
 const receipts=await db.query('SELECT * FROM chat_deliveries WHERE message_id=$1 ORDER BY recipient_id',[request.id])
 expect(receipts.find(r=>r.recipient_id===b.session.id)).toMatchObject({response_message_id:reply.id,handled_at:expect.any(String)})
 expect(receipts.find(r=>r.recipient_id===c.session.id)).toMatchObject({response_message_id:null,handled_at:null})
 expect((await ops.call('chat_send',replyInput,'mcp',b.a)).id).toBe(reply.id)
 expect((await ops.call('chat_threads',{channel_id:a.channel.id},'mcp',a.a)).items[0]).toMatchObject({pending_responses:1,awaiting_labels:c.session.label})
})
it('un pedido sin responder genera un solo aviso privado y la respuesta lo cancela',async()=>{
 const a=await register('requester'),b=await register('operator')
 const request=await ops.call('chat_send',{session_key:a.k,channel_id:a.channel.id,title:'Browser',text:'Necesito el resultado',mentions:[b.session.id],response_required:true,request_id:'request'},'mcp',a.a)
 await ops.call('chat_inbox',{session_key:b.k},'mcp',b.a)
 const later=Date.now()+360000
 await ops.chat.processResponseAlerts(later)
 await ops.chat.processResponseAlerts(later+1000)
 const notices=await db.query("SELECT * FROM chat_status_notices WHERE cause='response_due'")
 expect(notices).toHaveLength(1)
 expect(notices[0]).toMatchObject({recipient_id:a.session.id,work_thread_id:request.thread_id})
 expect((await ops.call('chat_inbox',{session_key:a.k},'mcp',a.a)).items.some((m:any)=>m.id===notices[0].id)).toBe(true)
 await ops.call('chat_send',{session_key:b.k,thread_id:request.thread_id,reply_to:request.id,text:'Estoy bloqueado: falta sesión de prueba.',request_id:'blocked'},'mcp',b.a)
 expect((await db.query('SELECT cancelled_at FROM chat_status_notices WHERE id=$1',[notices[0].id]))[0].cancelled_at).toBeTruthy()
 await ops.call('chat_resolve',{session_key:a.k,thread_id:request.thread_id,state:'resolved'},'mcp',a.a)
 expect(await db.query('SELECT * FROM chat_threads')).toHaveLength(1)
})
it('rechaza pedidos sin destinatario sin dejar un hilo vacío',async()=>{
 const a=await register('requester')
 await expect(ops.call('chat_send',{session_key:a.k,channel_id:a.channel.id,title:'Sin destinatario',text:'Responder',response_required:true,request_id:'invalid'},'mcp',a.a)).rejects.toMatchObject({statusCode:400})
 expect(await db.query('SELECT * FROM chat_threads')).toHaveLength(0)
})

it('el listener no pide registro de una conexión pasiva sin nick',async()=>{
  const a=author('passive-listener'),key=randomUUID()
  const registered=await ops.chat.lifecycle(a,{session_key:key,native_id:'passive-listener',event:'SessionStart',at:new Date().toISOString()})
  const runtime=new LocalChatRuntime(ops.chat),controller=new AbortController()
  const waiting=runtime.wait(registered.session.id,controller.signal)
  const timer=setTimeout(()=>controller.abort(),50)
  try {
    expect(await waiting).not.toHaveProperty('bootstrap')
    expect((await db.query('SELECT bootstrap_attempts FROM chat_sessions WHERE id=$1',[registered.session.id]))[0].bootstrap_attempts).toBe(0)
  } finally {clearTimeout(timer);await runtime.close()}
})
