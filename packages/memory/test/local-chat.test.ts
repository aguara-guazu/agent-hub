import { migrations } from '../src/migrations.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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

it('rechaza carpetas comunes, repositorios bare y rutas inexistentes sin crear canales',async()=> {
  const plain=await mkdtemp(join(tmpdir(),'hub-chat-plain-'))
  try {
    const a=author('plain',plain)
    await expect(ops.chat.register(a,randomUUID())).rejects.toMatchObject({statusCode:409})
    await expect(ops.chat.register({...a,cwd:join(plain,'missing')},randomUUID())).rejects.toMatchObject({statusCode:409})
    execFileSync('git',['init','--bare','-q',plain])
    await expect(ops.chat.register(a,randomUUID())).rejects.toMatchObject({statusCode:409})
    expect((await ops.call('chat_channels',{})).total).toBe(0)
  } finally { await rm(plain,{recursive:true,force:true}) }
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
 expect((await ops.call('chat_agents',{channel_id:leader.channel.id})).items.find((s:any)=>s.id===member.session.id).state).toBe('removed')
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
