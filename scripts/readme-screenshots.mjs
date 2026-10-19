/** Real production UI and SQLite, isolated synthetic data; never opens personal Hub state. */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createRequire,syncBuiltinESMExports} from 'node:module'
import os from 'node:os'
// Synthetic host metadata within this isolated process only.
os.hostname=()=> 'Estación de demostración'
syncBuiltinESMExports()
import {randomUUID} from 'node:crypto'
import staticPlugin from '@fastify/static'
import {MemoryService} from '../packages/memory/dist/service.js'
import {seedDemo} from '../packages/memory/dist/demo.js'
import {buildApp} from '../packages/core/dist/app.js'
import {ensureLocalOwner} from '../packages/core/dist/local.js'
import {createAccessToken} from '../packages/core/dist/security.js'
const root=resolve(import.meta.dirname,'..'),directory=await mkdtemp('/tmp/agenthub-demo-')
const destination=join(root,'docs/screenshots'),workspace=join(directory,'soporte'),second=join(directory,'portal')
await mkdir(destination,{recursive:true})
for(const path of [workspace,second]){await mkdir(path);execFileSync('git',['init','-q','-b',path===workspace?'feat/busqueda':'feat/accesos',path])}
process.env.AGENTHUB_MEMORY_DIR=join(directory,'memory');process.env.AGENTHUB_MEMORY_WORKER='0'
const service=new MemoryService(process.env.AGENTHUB_MEMORY_DIR,'http://127.0.0.1/oauth')
let app,browser
try {
 const {store,operations:ops}=await service.get(),demo=await seedDemo(store),project=demo.projects[0]
 await ops.call('update_entity',{id:project,data:{folders:[workspace,second],description:'Asistente de soporte: decisiones, pruebas y revisiones en un mismo lugar.'}})
 for(const [title,status] of [['Revisar los permisos de búsqueda','in_progress'],['Validar respuestas con soporte','todo'],['Conectar el historial de tickets','done']])await ops.call('save_task',{project_id:project,title,status,origin:'meeting',source_entity_id:demo.meeting})
 const register=async(nick,kind,path=workspace)=>{
  const a={agent_id:randomUUID(),session_id:`native:${randomUUID()}`,cli_kind:kind,client:kind,cwd:path},key=randomUUID()
  const who=await ops.chat.lifecycle(a,{session_key:key,native_id:a.session_id,event:'Stop',at:new Date().toISOString(),transport:'tui_prompt'})
  await ops.call('chat_set_nick',{session_key:key,nickname:nick},'demo',a)
  return {a,key,...who}
 }
 const leader=await register('Faro','claude_code'),reviewer=await register('Brisa','codex_cli'),researcher=await register('Junco','kiro');await register('Lumbre','gemini_cli',second)
 const send=(from,title,text,mentions=[],thread_id)=>ops.call('chat_send',{session_key:from.key,...(thread_id?{thread_id}:{channel_id:from.channel.id,title}),text,mentions,request_id:randomUUID()},'demo',from.a)
 const thread=await send(leader,'Revisión · permisos de búsqueda','Brisa, revisá que la búsqueda respete los permisos del proyecto. Junco, contrastá los casos con lo acordado en la reunión.',[reviewer.session.id,researcher.session.id])
 await ops.call('chat_inbox',{session_key:reviewer.key},'demo',reviewer.a)
 await send(reviewer,'','Encontré un caso: al cambiar de proyecto quedaba visible un resultado anterior. Agregué el escenario a la revisión; falta limpiar la selección al cambiar de canal.',[leader.session.id],thread.thread_id)
 await ops.call('chat_ack',{session_key:reviewer.key,message_id:thread.id},'demo',reviewer.a)
 await send(researcher,'','Confirmado con la reunión: cada proyecto debe mostrar únicamente sus propias fuentes. Dejé los criterios de aceptación vinculados a la transcripción.',[],thread.thread_id)
 const done=await send(leader,'Integración del historial de tickets','Integración validada. Las fuentes y los identificadores originales se conservan para volver a la evidencia.')
 await ops.call('chat_resolve',{session_key:leader.key,thread_id:done.thread_id,state:'resolved'},'demo',leader.a)
 await send(researcher,'Pruebas de aceptación con soporte','Pendiente coordinar la revisión del martes. Los casos de prueba ya están en la memoria del proyecto.')
 await service.close()
 app=buildApp({settings:{localMode:true,starterCatalog:false,databasePath:join(directory,'hub.db'),consoleDist:join(root,'frontend/dist')}})
 await app.fastify.register(staticPlugin,{root:join(root,'frontend/dist'),prefix:'/',wildcard:false})
 await app.fastify.listen({port:0,host:'127.0.0.1'})
 const base=`http://127.0.0.1:${app.fastify.server.address().port}`,token=await createAccessToken(app.settings,ensureLocalOwner(app.store).id)
 const {chromium}=createRequire(join(root,'frontend/package.json'))('playwright');browser=await chromium.launch()
 const page=await browser.newPage({viewport:{width:1440,height:1040},deviceScaleFactor:1,colorScheme:'dark',locale:'es-AR'})
 await page.addInitScript(t=>globalThis.localStorage.setItem('agenthub.token',t),token)
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 const capture=async(file,url,selector)=>{await page.goto(`${base}/#${url}`);await page.locator(selector).first().waitFor();await page.evaluate(()=>globalThis.document.fonts.ready);if(file==='collaboration.png'){await page.getByRole('button',{name:'Abrir hilo: Revisión · permisos de búsqueda',exact:true}).waitFor();await page.locator('.local-chat-channel-name').first().waitFor();await page.locator('.local-chat').scrollIntoViewIfNeeded()}await page.screenshot({path:join(destination,file),animations:'disabled'})}
 await capture('projects.png',`/projects/${project}`,'.memory-project-tabs')
 await capture('collaboration.png',`/projects/${project}?tab=collaboration&channel=${leader.channel.id}`,'.local-chat-threads')
 await capture('memory.png',`/memory/entities/${demo.meeting}`,'.memory-utterance')
 assert.deepEqual(errors,[])
 console.log(`Saved three production UI screenshots with demo data to ${destination}`)
} finally {await browser?.close();await app?.fastify.close();app?.db.close();await service.close();await rm(directory,{recursive:true,force:true})}
