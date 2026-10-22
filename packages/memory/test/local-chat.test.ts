import { migrations } from '../src/migrations.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, symlink } from 'node:fs/promises'
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
  expect(alert.text).toContain('pasó el plazo de reporte')
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
it('excluye expulsados antes de contar y paginar, conservando miembros offline e historial',async()=> {
  const member=await register('remaining')
  await ops.chat.lifecycle(member.a,{session_key:member.k,native_id:'remaining',event:'SessionEnd',at:new Date().toISOString()})
  for(let i=0;i<41;i++) {
    await db.query(`INSERT INTO chat_sessions(id,agent_id,key_hash,label,cli_kind,channel_id,state,event_at,last_seen_at,removed_at,closed_at)
      VALUES($1,'test-client',$2,'Expulsado','codex_cli',$3,'offline',$4,$4,$4,$4)`,
      [`removed-${i}`,randomUUID(),member.channel.id,'2099-01-01T00:00:00.000Z'])
  }
  expect(await ops.call('chat_agents',{channel_id:member.channel.id,limit:40})).toMatchObject({
    total:1,items:[expect.objectContaining({id:member.session.id,state:'offline'})],
  })
  expect(await ops.call('chat_agents',{channel_id:member.channel.id,include_removed:true,limit:40})).toMatchObject({total:42})
  expect((await ops.call('chat_agents',{channel_id:member.channel.id,include_removed:true,limit:40,offset:40})).items).toHaveLength(2)
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
  expect((await ops.call('chat_agents',{channel_id:a.channel.id})).items.find((s:any)=>s.id===a.session.id).state).toBe('offline')
  await db.close();db=new MemoryDatabase(join(dir,'memory.sqlite'));await db.migrate()
  const persisted=await db.query('SELECT text FROM chat_messages WHERE id=$1',[m.id]);expect(persisted[0]!.text).toBe(input.text)
})
it('no revive una sesión cerrada por heartbeat ni por un evento viejo',async()=> {
  const a=await register('a');const end=new Date(Date.now()+10).toISOString()
  await ops.chat.lifecycle(a.a,{session_key:a.k,native_id:'a',event:'SessionEnd',at:end})
  await ops.chat.lifecycle(a.a,{session_key:a.k,native_id:'a',event:'Heartbeat',at:new Date().toISOString()})
  await ops.chat.lifecycle(a.a,{session_key:a.k,native_id:'a',event:'Stop',at:'2000-01-01T00:00:00.000Z'})
  expect((await ops.call('chat_agents',{})).items[0].state).toBe('offline')
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
  await expect(ops.call('chat_send',{session_key:k,channel_id:r.channel.id,title:'Hola',text:'Mensaje',request_id:'first'},'mcp',a)).rejects.toMatchObject({statusCode:409})
  const named=await ops.call('chat_set_nick',{session_key:k,nickname:'  Bruma   Azul  '},'mcp',a)
  expect(named.session).toMatchObject({id:r.session.id,label:'Bruma Azul',nickname:'Bruma Azul',needs_nickname:false})
  const message=await ops.call('chat_send',{session_key:k,channel_id:r.channel.id,title:'Hola',text:'Mensaje',request_id:'first'},'mcp',a)
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
  expect((await ops.call('chat_agents',{})).items.every((s:any)=>s.needs_nickname && s.label==='Sin nick todavía')).toBe(true)
  expect((await ops.call('chat_read',{thread_id:m.thread_id})).items[0]).toMatchObject({id:m.id,author_id:a.session.id})
  await ops.call('chat_set_nick',{session_key:a.k,nickname:'Lumbre'},'mcp',a.a)
  expect((await ops.call('chat_read',{thread_id:m.thread_id})).items[0].author_label).toBe('Lumbre')
})

it('activa y cierra canales virtuales sólo de forma explícita, sin robar liderazgo ni migrar sesiones',async()=> {
  const plain=await mkdtemp(join(tmpdir(),'hub-chat-plain-')),bare=await mkdtemp(join(tmpdir(),'hub-chat-bare-'))
  try {
    const alias=join(dir,'plain-alias');await symlink(plain,alias)
    const first=author('plain-a',plain),second=author('plain-b',alias),ka=randomUUID(),kb=randomUUID()
    const a=await ops.chat.lifecycle(first,{session_key:ka,native_id:'plain-a',event:'SessionStart',at:new Date().toISOString()})
    const b=await ops.chat.lifecycle(second,{session_key:kb,native_id:'plain-b',event:'SessionStart',at:new Date().toISOString()})
    expect(a.channel).toMatchObject({id:b.channel.id,kind:'virtual',project_id:null,activated_at:null,closed_at:null})
    expect(a.team.leader_id).toBeNull()
    expect((await ops.call('chat_channels',{})).total).toBe(0)
    expect((await ops.call('chat_agents',{unassigned:true})).total).toBe(0)
    await ops.call('chat_join',{session_key:ka},'mcp',first)
    const prior=Date.now()
    await ops.chat.lifecycle(first,{session_key:ka,native_id:'plain-a',event:'UserPromptSubmit',at:new Date(prior+1).toISOString()})
    await ops.chat.lifecycle(first,{session_key:ka,native_id:'plain-a',event:'Stop',at:new Date(prior+2).toISOString()})
    await ops.chat.lifecycle(second,{session_key:kb,native_id:'plain-b',event:'BeforeAgent',at:new Date(prior+3).toISOString()})
    await ops.chat.lifecycle(second,{session_key:kb,native_id:'plain-b',event:'AfterAgent',at:new Date(prior+4).toISOString()})
    expect((await db.query('SELECT team_seen FROM chat_sessions WHERE channel_id=$1',[a.channel.id])).every(row=>!row.team_seen)).toBe(true)
    expect((await ops.chat.team(a.channel.id)).leader_id).toBeNull()
    const namedA=await ops.call('chat_set_nick',{session_key:ka,nickname:'Brisa'},'mcp',first)
    const namedB=await ops.call('chat_set_nick',{session_key:kb,nickname:'Faro'},'mcp',second)
    await expect(ops.call('chat_send',{session_key:kb,channel_id:b.channel.id,title:'Silencioso',text:'No',request_id:'pending'},'mcp',second)).rejects.toThrow('no pidió crear')

    const active=await ops.call('chat_create_channel',{session_key:kb,name:'Sala efímera'},'mcp',second)
    expect(active.channel).toMatchObject({id:b.channel.id,name:'Sala efímera',kind:'virtual',project_id:null,leader_id:namedB.session.id,closed_at:null})
    expect(active.channel.activated_at).toBeTruthy()
    expect(active.session.role).toBe('leader')
    expect((await ops.call('chat_channels',{})).items[0]).toMatchObject({id:b.channel.id,read_only:false})
    expect((await ops.call('chat_channels',{unassigned:true,limit:1}))).toMatchObject({total:1,items:[expect.objectContaining({id:b.channel.id})]})
    expect((await ops.call('chat_agents',{unassigned:true,limit:1}))).toMatchObject({total:2,items:[expect.any(Object)]})
    await expect(ops.call('chat_create_channel',{session_key:ka},'mcp',first)).rejects.toThrow('primer creador')
    const runtime=new LocalChatRuntime(ops.chat)
    expect(await runtime.wait(namedA.session.id)).toMatchObject({bootstrap:true})
    const message=await ops.call('chat_send',{session_key:kb,channel_id:b.channel.id,title:'Trabajo',text:'Listo',mentions:[namedA.session.id],request_id:'active'},'mcp',second)
    expect((await ops.call('chat_threads',{unassigned:true,limit:1}))).toMatchObject({total:1,items:[expect.objectContaining({id:message.thread_id})]})
    await expect(ops.call('chat_close_channel',{session_key:ka},'mcp',first)).rejects.toThrow('líder')
    const closed=await ops.call('chat_close_channel',{session_key:kb},'mcp',second)
    expect(closed.channel.closed_at).toBeTruthy()
    expect(closed.team.leader_offline).toBe(true)
    expect((await db.query('SELECT state,closed_at,lease_until FROM chat_sessions WHERE channel_id=$1',[b.channel.id])).every(row=>row.state==='offline' && row.closed_at && row.lease_until===null)).toBe(true)
    expect((await ops.call('chat_agents',{channel_id:b.channel.id,active_only:true})).total).toBe(0)
    expect((await db.query('SELECT cancelled_at,error FROM chat_deliveries WHERE message_id=$1',[message.id]))[0]).toMatchObject({cancelled_at:expect.any(String),error:'Canal virtual cerrado'})
    expect((await ops.call('chat_channels',{channel_id:b.channel.id})).items[0]).toMatchObject({read_only:true})
    expect(await runtime.wait(namedA.session.id)).toMatchObject({closed:true,messages:[]})
    await runtime.close()
    await expect(ops.call('chat_send',{session_key:kb,thread_id:message.thread_id,text:'Después',request_id:'closed'},'mcp',second)).rejects.toMatchObject({statusCode:403})
    await expect(ops.call('chat_join',{session_key:kb},'mcp',second)).rejects.toThrow('cerrado')
    expect((await ops.call('chat_read',{thread_id:message.thread_id})).items[0].text).toBe('Listo')

    const third=author('plain-c',plain),fourth=author('plain-d',alias),kc=randomUUID(),kd=randomUUID()
    const c=await ops.chat.lifecycle(third,{session_key:kc,native_id:'plain-c',event:'SessionStart',at:new Date().toISOString()})
    const d=await ops.chat.lifecycle(fourth,{session_key:kd,native_id:'plain-d',event:'SessionStart',at:new Date().toISOString()})
    expect(c.channel.id).not.toBe(b.channel.id)
    expect(d.channel.id).toBe(c.channel.id)
    expect(c.channel.activated_at).toBeNull()
    const race=await Promise.allSettled([
      ops.call('chat_create_channel',{session_key:kc,name:'Siguiente'},'mcp',third),
      ops.call('chat_create_channel',{session_key:kd,name:'Competidor'},'mcp',fourth),
    ])
    const created=race.filter((result):result is PromiseFulfilledResult<any>=>result.status==='fulfilled')
    expect(created).toHaveLength(1)
    expect(race.filter(result=>result.status==='rejected')).toHaveLength(1)
    const future=created[0]!.value
    expect(future.channel).toMatchObject({leader_id:future.session.id,kind:'virtual',closed_at:null})
    expect((await ops.call('chat_channels',{})).total).toBe(2)
    const oldMemberships=await db.query('SELECT id,channel_id FROM chat_sessions WHERE id IN ($1,$2) ORDER BY id',[namedA.session.id,namedB.session.id])
    expect(oldMemberships.every(row=>row.channel_id===b.channel.id)).toBe(true)

    const backup=JSON.parse(await readBackup(store,(await exportMemory(store)).id))
    expect(backup.schema_version).toBe(20)
    expect(backup.tables.chat_channels.find((channel:any)=>channel.id===future.channel.id)).toMatchObject({closed_at:null,virtual_path:a.channel.path})
    const restorePath=join(plain,'restore'),restored=new MemoryDatabase(join(restorePath,'memory.sqlite'));await restored.migrate()
    try {
      const restoredStore=new MemoryStore(restored,restorePath)
      await restoreMemory(restoredStore,backup)
      const restoredChannels=await restored.query("SELECT * FROM chat_channels WHERE kind='virtual' ORDER BY created_at")
      expect(restoredChannels).toHaveLength(2)
      expect(restoredChannels[0]).toMatchObject({id:b.channel.id,closed_at:expect.any(String),virtual_path:null})
      expect(restoredChannels[1]).toMatchObject({id:future.channel.id,closed_at:expect.any(String),activated_at:expect.any(String),virtual_path:null})
      expect((await restored.query('SELECT text FROM chat_messages WHERE id=$1',[message.id]))[0].text).toBe('Listo')
      const restoredOps=new MemoryOperations(restoredStore,new MemoryAI(async()=>defaultAI,new Vault(restorePath)))
      const fresh=author('restored',plain),freshKey=randomUUID()
      const pending=await restoredOps.chat.lifecycle(fresh,{session_key:freshKey,native_id:'restored',event:'SessionStart',at:new Date().toISOString()})
      expect(pending.channel).toMatchObject({kind:'virtual',activated_at:null,closed_at:null})
      expect(restoredChannels.some(channel=>channel.id===pending.channel.id)).toBe(false)
      const recreated=await restoredOps.call('chat_create_channel',{session_key:freshKey},'mcp',fresh)
      expect(recreated.channel).toMatchObject({id:pending.channel.id,leader_id:pending.session.id,closed_at:null})
    } finally {await restored.close()}

    await expect(ops.chat.register({...third,cwd:join(plain,'missing')},randomUUID())).rejects.toMatchObject({statusCode:409})
    execFileSync('git',['init','--bare','-q',bare])
    await expect(ops.chat.register(author('bare',bare),randomUUID())).rejects.toMatchObject({statusCode:409})
  } finally { await rm(plain,{recursive:true,force:true});await rm(bare,{recursive:true,force:true}) }
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
  expect(d.channel.id).toBe(b.channel.id);expect(d.channel.branch).toBeNull()
  expect((await ops.call('chat_channels',{})).total).toBe(2)
})
it('conserva el historial de un worktree eliminado y rechaza nuevas escrituras allí',async()=> {
  const path=worktree('temporary'),a=await register('a','Stop',path),b=await register('b','Stop',path),m=await send(a,b)
  git('worktree','remove',path)
  expect((await ops.call('chat_channels',{})).items[0]).toMatchObject({id:a.channel.id,read_only:true})
  expect((await ops.call('chat_read',{thread_id:m.thread_id})).items[0].text).toBe('Revisá suma')
  await expect(send(a,b,'Otro',m.thread_id)).rejects.toMatchObject({statusCode:409})
  await expect(ops.call('chat_resolve',{session_key:a.k,thread_id:m.thread_id,state:'resolved'},'mcp',a.a)).rejects.toMatchObject({statusCode:409})
})
it('las carpetas de canales antiguos quedan históricas aunque ahora estén dentro de un worktree',async()=> {
  const a=await register('a'),b=await register('b'),m=await send(a,b),sub=join(dir,'legacy')
  await mkdir(sub);await db.query('UPDATE chat_channels SET path=$2 WHERE id=$1',[a.channel.id,sub])
  expect((await ops.call('chat_channels',{})).items[0].read_only).toBe(true)
  await expect(send(a,b)).rejects.toMatchObject({statusCode:409})
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
    expect(c.channel.id).toBe(a.channel.id)
    const m=await send(a,c)
    await expect(send(a,b)).rejects.toThrow('mención')
    const old=await ops.call('chat_join',{session_key:a.k},'mcp',author('a',plain))
    expect(old.channel.id).toBe(a.channel.id)
    expect(old.session.nickname).toBe('Nube a')
    const resumed=await ops.chat.lifecycle({...a.a,cwd:join(plain,'src')},{session_key:a.k,native_id:'a',event:'SessionStart',at:new Date().toISOString()})
    expect(resumed.channel.id).toBe(a.channel.id)
    expect((await ops.call('chat_read',{thread_id:m.thread_id})).items).toHaveLength(1)
    expect((await ops.call('chat_channels',{})).items.every((x:any)=>x.read_only===false)).toBe(true)
    await rm(plain,{recursive:true,force:true})
    await expect(send(a,c)).rejects.toMatchObject({statusCode:409})
    expect((await ops.call('chat_read',{thread_id:m.thread_id})).items).toHaveLength(1)
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
  await db.migrate()
  expect((await db.query('SELECT * FROM chat_channels'))[0]).toMatchObject({id:a.channel.id,path:a.channel.path,scope_key:`git:${a.channel.path}`,orca_workspace_id:null})
  expect(await db.query('SELECT * FROM chat_deliveries')).toEqual(receipts)
  expect((await ops.call('chat_read',{thread_id:m.thread_id})).items[0].id).toBe(m.id)
  const space=`folder:${randomUUID()}`
  await db.query('UPDATE chat_channels SET scope_key=$2,orca_workspace_id=$3,name=$4 WHERE id=$1',[a.channel.id,`orca:${space}`,space,'EGA-333 & EGA-334'])
  expect((await ops.call('chat_join',{session_key:a.k},'mcp',a.a)).channel.name).toBe('EGA-333 & EGA-334')
  const fresh=await ops.chat.register({...author('c'),orca_workspace_id:space},randomUUID())
  expect(fresh.channel.id).toBe(a.channel.id)
  expect(fresh.channel.name).toBe('EGA-333 & EGA-334')
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

it('registra terminales pasivas sin elegir líder; el primer pedido humano incorpora a sus compañeras',async()=>{
  const passive=async(name:string,path=dir)=> {
    const a=author(name,path),key=randomUUID()
    const r=await ops.chat.lifecycle(a,{session_key:key,native_id:name,event:'SessionStart',at:new Date().toISOString()})
    return {a,key,...r}
  }
  const first=await passive('early'),second=await passive('leader'),_third=await passive('third')
  const other=await passive('other',worktree('elsewhere'))
  expect(first.team.leader_id).toBeNull()
  const queue=vi.fn().mockResolvedValue(undefined),runtime=new LocalChatRuntime(ops.chat,queue)
  await runtime.tick();expect(queue).not.toHaveBeenCalled()
  const leader=await ops.chat.lifecycle(second.a,{session_key:second.key,native_id:'leader',event:'UserPromptSubmit',at:new Date().toISOString()})
  expect(leader.session.role).toBe('leader')
  await runtime.tick();expect(queue.mock.calls.map(c=>c[0]).sort()).toEqual(['early','third'])
  await runtime.tick();expect(queue).toHaveBeenCalledTimes(2)
  const joined=await ops.call('chat_join',{session_key:first.key},'mcp',first.a)
  expect(joined.team.leader_id).toBe(second.session.id);expect(joined.session.role).toBe('member')
  expect(joined.team.guidance).toContain('sin pedir que la persona repita')
  await db.query("UPDATE chat_sessions SET bootstrap_sent_at='2000-01-01T00:00:00.000Z'")
  await runtime.tick();expect(queue).toHaveBeenCalledTimes(3);expect(queue).toHaveBeenLastCalledWith('third',expect.any(String))
  expect((await ops.chat.team(other.channel.id)).leader_id).toBeNull()
  await ops.chat.lifecycle(second.a,{session_key:second.key,native_id:'leader',event:'SessionEnd',at:new Date().toISOString()})
  await ops.call('chat_inbox',{session_key:first.key},'mcp',first.a)
  expect((await ops.chat.team(first.channel.id))).toMatchObject({leader_id:second.session.id,leader_offline:true})
  await runtime.close()
})

it('la incorporación por conexión nativa funciona también con metadatos de Orca y no consume menciones',async()=>{
  const workspace=`folder:${randomUUID()}`,a={...author('leader'),orca_workspace_id:workspace}
  const leader=await ops.chat.register(a,randomUUID())
  const b={...author('newcomer'),cli_kind:'kiro',orca_workspace_id:workspace},key=randomUUID()
  const newcomer=await ops.chat.lifecycle(b,{session_key:key,native_id:'kiro',event:'SessionStart',transport:'acp_prompt',at:new Date().toISOString()})
  const runtime=new LocalChatRuntime(ops.chat)
  expect(await runtime.wait(newcomer.session.id)).toMatchObject({bootstrap:true,messages:[]})
  expect((await ops.chat.team(leader.channel.id)).leader_id).toBe(leader.session.id)
  const named=await ops.call('chat_set_nick',{session_key:key,nickname:'Luciérnaga'},'mcp',b)
  expect(named.session.role).toBe('member')
  expect((await db.query('SELECT team_seen FROM chat_sessions WHERE id=$1',[newcomer.session.id]))[0].team_seen).toBe(true)
  await runtime.close()
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
 const a={...author('fallback'),session_id:randomUUID()},joined=await ops.call('chat_join',{},'mcp',a)
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
  expect(entry.text.length).toBeLessThan(14000)
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
