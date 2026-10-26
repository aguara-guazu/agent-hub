/** Real HTTP/MCP + Electron renderer usability scenario, isolated from personal Hub data.
 * Worker launch/discovery are controlled fixtures; no model inference or user processes run.
 * Run after npm run build: node scripts/test-collaboration-ux.mjs
 */
import assert from 'node:assert/strict'
import { URL } from 'node:url'
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import staticPlugin from '@fastify/static'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { MemoryDatabase } from '../packages/memory/dist/database.js'
import { MemoryStore } from '../packages/memory/dist/store.js'
import { LocalChat } from '../packages/memory/dist/local-chat.js'
import { HubTeamRuntime } from '../packages/memory/dist/team-hub.js'
import { TeamOrchestration } from '../packages/memory/dist/team-orchestration.js'
import { buildApp } from '../packages/core/dist/app.js'
import { ensureLocalOwner } from '../packages/core/dist/local.js'
import { createAccessToken } from '../packages/core/dist/security.js'
import electron from 'electron'

const root=resolve(import.meta.dirname,'..'),directory=await realpath(await mkdtemp(join(tmpdir(),'hub-collaboration-ux-')))
const memory=join(directory,'memory'),folder=join(directory,'workspace');await mkdir(memory);await mkdir(folder)
process.env.AGENTHUB_MEMORY_DIR=memory;process.env.AGENTHUB_MEMORY_WORKER='0'
const db=new MemoryDatabase(join(memory,'memory.sqlite'));await db.migrate()
const chat=new LocalChat(new MemoryStore(db,memory)),backend=new HubTeamRuntime(chat,memory)
const prompts=new Map()
backend.preflight=async()=>{}
backend.launch=async(_workspace,member)=>{prompts.set(member.member_id,member.prompt);return {handle:member.member_id,kind:'hub_process',prompt_outcome:'input-accepted'}}
const teams=new TeamOrchestration(chat,{catalog:async()=>({clis:[{id:'claude_code',launchable:true}],models:[{cli:'claude_code',id:'fixture-model'}]}),validate:async()=>({launchable:true})},backend)
async function session(path,nick) {
 const agent={agent_id:'ux-client',session_id:`native:${randomUUID()}`,cli_kind:'claude_code',client:'UX test',cwd:path},key=randomUUID()
 const enrolled=await chat.lifecycle(agent,{session_key:key,native_id:agent.session_id,event:'SessionStart',at:new Date().toISOString()})
 await chat.call('chat_set_nick',{session_key:key,nickname:nick},agent)
 return {agent,key,...enrolled}
}
const master=await session(folder,'Coordinación de prueba')
const opened=await chat.call('chat_create_channel',{session_key:master.key,task_key:'UX-TEAM',name:'Equipo de prueba UX'},master.agent)
master.channel=opened.channel;master.session=opened.session
const plan=await teams.call('team_prepare',{session_key:master.key,task_key:'UX-TEAM',objective:'Verificar equipo, reportes y navegación en una sola tarea',members:[
 {worktree_name:'codigo',role:'Implementación',task:'Corregir el comportamiento y pedir evidencia al operador.'},
 {worktree_name:'browser',role:'Operación de herramientas',task:'Recorrer el navegador y reportar evidencia directamente a implementación.'},
 {worktree_name:'revision',role:'Revisión',task:'Esperar el cambio de implementación antes de revisar.'},
].map(m=>({...m,cli:'claude_code',model:'fixture-model',prompt:'Escenario controlado de UX; no ejecutar comandos externos.'}))},master.agent)
const launched=await teams.approveByHuman(plan.id,plan.digest,'fixture-owner'),workers=[]
for(const [i,slot] of launched.members.entries()) {
 const worker=await session(slot.workspace_path,['Implementación de prueba','Operación de prueba','Revisión de prueba'][i])
 const invitation=/invitation=([A-Za-z0-9_-]+)/.exec(prompts.get(slot.id))[1]
 await teams.call('team_join',{session_key:worker.key,invitation},worker.agent)
 workers.push({...worker,slot})
}
await backend.close();await db.close()
const core=buildApp({settings:{localMode:true,starterCatalog:false,databasePath:join(directory,'hub.db')}})
await core.fastify.register(staticPlugin,{root:join(root,'frontend/dist'),prefix:'/',wildcard:false})
core.fastify.setNotFoundHandler((request,reply)=>request.url.startsWith('/api/')?reply.code(404).send({detail:'not found'}):reply.sendFile('index.html'))
await core.fastify.listen({host:'127.0.0.1',port:0})
const base=`http://127.0.0.1:${core.fastify.server.address().port}`,owner=ensureLocalOwner(core.store),token=await createAccessToken(core.settings,owner.id)
assert.equal((await globalThis.fetch(base+'/api/auth/me',{headers:{Authorization:'Bearer '+token}})).status,200)
const client=new Client({name:'collaboration-ux-agent',version:'1'})
try {
 const credential=await readFile(join(memory,'secrets/memory-mcp'),'utf8')
 await client.connect(new StreamableHTTPClientTransport(new URL(base+'/api/memory/mcp'),{requestInit:{headers:{Authorization:credential}}}))
 async function call(who,name,input={}) {
  const result=await client.callTool({name,arguments:{session_key:who.key,...input},_meta:{'agenthub/agent':who.agent}})
  assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text)
 }
 const [dev,operator,reviewer]=workers
 const channels=await call(master,'chat_channels');assert.equal(channels.total,1)
 const roster=await call(master,'chat_agents',{channel_id:plan.master_channel_id});assert.equal(roster.total,4)
 const start=await call(dev,'chat_work_update',{thread_id:dev.slot.work_thread_id,work_id:'implementation',event:'started',expected_version:0,summary:'Implementación iniciada',request_id:'start'})
 const ask=await call(dev,'chat_send',{channel_id:dev.channel.id,title:'Validar el navegador',text:'Operador: comprobá la pantalla y devolvé el resultado en este hilo.',mentions:[operator.session.id],response_required:true,request_id:'ask'})
 assert.equal((await call(operator,'chat_inbox')).items[0].id,ask.id)
 const reply=await call(operator,'chat_send',{thread_id:ask.thread_id,text:'Reproduje el caso. El formulario muestra los datos existentes. Evidencia: captura del navegador y pasos de reproducción.',reply_to:ask.id,request_id:'reply'})
 assert.equal((await call(dev,'chat_inbox')).items[0].id,reply.id)
 assert.equal((await call(dev,'chat_read',{thread_id:ask.thread_id,unread_only:false})).items[0].mentions[0].response_message_id,reply.id)
 await call(dev,'chat_send',{thread_id:ask.thread_id,text:'Confirmá también el estado vacío de la pantalla.',mentions:[operator.session.id],response_required:true,request_id:'followup'})
 await call(dev,'chat_send',{thread_id:dev.slot.work_thread_id,text:'Cambio preparado; la evidencia del operador confirma la corrección. Pendiente de revisión.',mentions:[master.session.id],request_id:'report'})
 await call(dev,'chat_work_update',{thread_id:dev.slot.work_thread_id,work_id:'implementation',event:'waiting',expected_version:start.version,waiting_for:'agent',summary:'Esperando revisión del cambio',request_id:'wait'})
 const r=await call(reviewer,'chat_work_update',{thread_id:reviewer.slot.work_thread_id,work_id:'review',event:'started',expected_version:0,summary:'Revisión asignada',request_id:'review-start'})
 await call(reviewer,'chat_work_update',{thread_id:reviewer.slot.work_thread_id,work_id:'review',event:'waiting',expected_version:r.version,waiting_for:'agent',summary:'Esperando el diff de implementación',request_id:'review-wait'})
 const threads=await call(master,'chat_threads',{channel_id:plan.master_channel_id});assert.equal(threads.total,5)
 assert.ok(threads.items.every(t=>t.channel_id===plan.master_channel_id))
 const config={base,token,directory,channel:plan.master_channel_id,plan:plan.id}
 const configPath=join(directory,'visual.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600})
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 const child=spawn(electron,[join(root,'scripts/test-collaboration-ux-renderer.cjs'),configPath],{env,stdio:['ignore','pipe','pipe']})
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d)
 const code=await new Promise(r=>child.once('exit',r));assert.equal(code,0,output)
 console.log(JSON.stringify({passed:true,directory,checks:['MCP roster includes coordinator and three workers','one visible task channel','peer request and reply delivered','work topics routed to shared channel','work waits persisted','real Electron clicks and screenshots at desktop and narrow widths'],controlled:'CLI discovery and worker launch fixtures; no model inference'},null,2))
} finally {await client.close();await core.fastify.close();core.db.close()}
