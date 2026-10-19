import {execFileSync} from 'node:child_process'
/** Isolated production Hub + real gateways/native hooks. Never edits the user's CLI settings. */
import assert from 'node:assert/strict'
import staticPlugin from '@fastify/static'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { buildApp } from '../packages/core/dist/app.js'
import { ensureLocalOwner } from '../packages/core/dist/local.js'
import { createAccessToken } from '../packages/core/dist/security.js'
import { DaemonState } from '../packages/daemon/dist/state.js'
import { planMemoryHooks } from '../packages/daemon/dist/adapters/memory-hooks.js'
import { applyChanges } from '../packages/daemon/dist/adapters/atomic.js'
import { gatewayEndpoint } from '../packages/daemon/dist/adapters/base.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root=resolve(import.meta.dirname,'..'),directory=await mkdtemp(join(tmpdir(),'hub-local-chat-e2e-'))
const workspace=join(directory,'workspace'),state=new DaemonState(join(directory,'state'));await mkdir(workspace);execFileSync('git',['init','-q','-b','main',workspace])
const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r))
const base=`http://127.0.0.1:${port}`
process.env.AGENTHUB_MEMORY_DIR=join(directory,'memory');process.env.AGENTHUB_MEMORY_WORKER='0'
const app=buildApp({settings:{localMode:true,starterCatalog:false,databasePath:join(directory,'hub.db'),oauthRedirectUrl:`${base}/api/oauth/callback`,consoleDist:join(root,'frontend/dist')}})
const token=await createAccessToken(app.settings,ensureLocalOwner(app.store).id)
await app.fastify.register(staticPlugin,{root:join(root,'frontend/dist'),prefix:'/',wildcard:false})
await app.fastify.listen({port,host:'127.0.0.1'})
const clients=[]
let browser
async function request(path,body,auth=token,expected=200,method='POST') {
  const res=await globalThis.fetch(`${base}/api/${path}`,{method,headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
  assert.equal(res.status,expected,`${path}: ${await (res.status===expected?Promise.resolve(''):res.text())}`);return res.status===204?null:await res.json()
}
const memory=(operation,input={},expected=200)=>request('memory/call',{operation,input},token,expected)
try {
  console.log('Checking production HTTP and MCP…')
  const project=await memory('create_entity',{kind:'project',title:'Colaboración local · revisión de suma',data:{folders:[workspace]}})
  const enrolled=await request('machines/enroll',{hostname:`local-chat-e2e-${randomUUID()}`,os:process.platform,daemon_version:'test'})
  state.saveCredentials({controlPlaneUrl:base,machineId:enrolled.machine.id,userEmail:'local',token:enrolled.token})
  await request(`machines/${enrolled.machine.id}/agents`,{agents:['claude_code','codex_cli'].map(cli_kind=>({cli_kind,cli_version:'test',config_path:''}))},enrolled.token)
  const agents=app.store.agentsOfMachine(enrolled.machine.id)
  const endpoints={}
  for(const agent of agents) {
    const snapshot=await request(`policy/snapshot/${agent.id}`,undefined,enrolled.token,200,'GET')
    state.saveSnapshot(snapshot)
    const endpoint=gatewayEndpoint({command:process.execPath,args:[join(root,'packages/daemon/dist/cli.js'),'gateway','--agent',agent.id,'--state-dir',state.root]})
    endpoints[agent.cli_kind]=endpoint
    const home=join(directory,agent.cli_kind);await mkdir(home)
    const [changes,drift]=planMemoryHooks(snapshot,endpoint,home);assert.equal(drift.length,0);assert.equal(applyChanges(changes).drift.length,0)
  }
  const joinClient=async(kind,space='',nickname=kind==='claude_code'?'Junco':'Bruma')=> {
    const e=endpoints[kind],client=new Client({name:`test-${kind}`,version:'1'})
    await client.connect(new StdioClientTransport({command:e.command,args:e.args,cwd:workspace,stderr:'ignore',env:{...process.env,ORCA_WORKTREE_ID:space}}));clients.push(client)
    const call=async(name,args)=> {
      const result=await client.callTool({name:`memory_${name}`,arguments:args});assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text)
    }
    const who=await call('chat_join',{path:workspace})
    await call('chat_set_nick',{session_key:who.session_key,nickname})
    return {call,who}
  }
  const a=await joinClient('claude_code'),b=await joinClient('codex_cli')
  const posted=await a.call('chat_send',{session_key:a.who.session_key,channel_id:a.who.channel.id,title:'Revisión de suma',text:'Revisar add(a,b). El resultado actual es a - b.',mentions:[b.who.session.id],request_id:'review-1'})
  const observed=await memory('chat_read',{thread_id:posted.thread_id});assert.equal(observed.items[0].mentions[0].read_at,null)
  await memory('chat_send',{thread_id:posted.thread_id,text:'No permitido',request_id:'human'},403)
  await b.call('chat_inbox',{session_key:b.who.session_key})
  await b.call('chat_send',{session_key:b.who.session_key,thread_id:posted.thread_id,text:'Hallazgo: debe sumar. Caso 2 + 3 devuelve -1.',mentions:[a.who.session.id],request_id:'review-2'})
  await b.call('chat_ack',{session_key:b.who.session_key,message_id:posted.id})
  console.log('Checking observer UI…')
  const req=createRequire(join(root,'frontend/package.json')),{chromium}=req('playwright')
  browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1500,height:1000}})
  await page.addInitScript(t=>globalThis.localStorage.setItem('agenthub.token',t),token)
  const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto(`${base}/#/projects/${project.id}?tab=collaboration&channel=${a.who.channel.id}&thread=${posted.thread_id}`)
  await page.getByRole('heading',{name:'Colaboración',exact:true}).waitFor()
  await page.getByRole('article',{name:'Conversación del hilo'}).getByText('Hallazgo: debe sumar. Caso 2 + 3 devuelve -1.',{exact:true}).waitFor()
  assert.equal(await page.getByRole('article',{name:'Conversación del hilo'}).getByText('Junco',{exact:true}).count(),1)
  assert.equal(await page.locator('.local-chat-threads').count(),0)
  await page.screenshot({path:join(directory,'collaboration-desktop.png'),fullPage:true})
  await page.getByRole('button',{name:'Volver al canal'}).click()
  await page.getByRole('button',{name:'Abrir hilo: Revisión de suma'}).waitFor()
  assert.equal(await page.locator('.local-chat-detail').count(),0)
  await page.screenshot({path:join(directory,'collaboration-channel.png'),fullPage:true})
  await page.getByRole('button',{name:'Abrir hilo: Revisión de suma'}).click()
  await page.getByRole('article',{name:'Conversación del hilo'}).waitFor()
  await page.goBack()
  await page.getByRole('button',{name:'Abrir hilo: Revisión de suma'}).waitFor()
  await page.goForward()
  await page.getByRole('article',{name:'Conversación del hilo'}).waitFor()
  assert.equal((await memory('chat_read',{thread_id:posted.thread_id})).items[1].mentions[0].read_at,null)

  await page.setViewportSize({width:900,height:844});await page.screenshot({path:join(directory,'collaboration-narrow.png'),fullPage:true})
  assert.equal(await page.locator('.local-chat').evaluate(el=>el.scrollWidth>el.clientWidth),false,'horizontal overflow')
  await page.setViewportSize({width:1500,height:1000})
  await page.getByRole('button',{name:'Volver al canal'}).click()
  await page.getByRole('button',{name:'Expulsar a Bruma',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Expulsar a Bruma'})
  await dialog.getByRole('button',{name:'Confirmar expulsión'}).click()
  await page.getByText('Expulsado por la persona desde la UI',{exact:true}).waitFor()
  await page.screenshot({path:join(directory,'collaboration-removed.png'),fullPage:true})
  const denied=await clients[1].callTool({name:'memory_chat_join',arguments:{session_key:b.who.session_key}})
  assert.equal(denied.isError,true,'An expelled participant cannot rejoin')
  const historical=await memory('chat_read',{thread_id:posted.thread_id})
  assert.equal(historical.items.length,2,'Removal preserves both messages')
  assert.deepEqual(errors,[]);await browser.close()
  console.log('Checking distinct Orca spaces through real MCP gateways…')
  const space=`folder:${randomUUID()}`
  const c=await joinClient('claude_code',space,'Ceibo de prueba'),d=await joinClient('codex_cli',space,'Sauce de prueba')
  const e=await joinClient('codex_cli',`folder:${randomUUID()}`,'Luna de prueba')
  assert.equal(c.who.channel.id,d.who.channel.id)
  assert.notEqual(c.who.channel.id,e.who.channel.id)
  assert.equal(c.who.channel.path,e.who.channel.path)
  assert.notEqual(c.who.channel.id,a.who.channel.id)
  const scopedMessage=await c.call('chat_send',{session_key:c.who.session_key,channel_id:c.who.channel.id,title:'Espacio separado',text:'Mensaje para el mismo espacio',mentions:[d.who.session.id],request_id:'space-review'})
  assert.equal((await d.call('chat_inbox',{session_key:d.who.session_key})).items[0].id,scopedMessage.id)
  assert.equal((await e.call('chat_inbox',{session_key:e.who.session_key})).total,0)
  assert.equal((await c.call('chat_join',{session_key:c.who.session_key})).channel.id,c.who.channel.id)
  const quote=s=>`'${s.replaceAll("'",`'"'"'`)}'`
  for(const kind of ['claude_code','codex_cli']) {
    const e=endpoints[kind],home=join(directory,kind)
    if(kind==='claude_code') {
      const mcp=join(home,'mcp.json');await writeFile(mcp,JSON.stringify({mcpServers:{hub:{command:e.command,args:e.args}}}),{mode:0o600})
      await writeFile(join(directory,'claude.sh'),`#!/bin/sh\ncd ${quote(workspace)}\nexec claude --setting-sources '' --strict-mcp-config --mcp-config ${quote(mcp)} --settings ${quote(join(home,'.claude/settings.json'))} --allowedTools 'mcp__hub__memory_chat_*'\n`,{mode:0o700})
    } else {
      const hooks=JSON.parse(await (await import('node:fs/promises')).readFile(join(home,'.codex/hooks.json'),'utf8')).hooks
      const cfg=[`mcp_servers={hub={command=${JSON.stringify(e.command)},args=${JSON.stringify(e.args)},default_tools_approval_mode="approve"}}`]
      for(const [event,groups]of Object.entries(hooks))cfg.push(`hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(groups[0].hooks[0].command)},timeout=10}]}]`)
      await writeFile(join(directory,'codex.sh'),`#!/bin/sh\ncd ${quote(workspace)}\nexec codex --no-alt-screen --dangerously-bypass-hook-trust -s read-only -a never ${cfg.map(c=>`-c ${quote(c)}`).join(' ')}\n`,{mode:0o700})
    }
  }
  await writeFile(join(workspace,'add.mjs'),'export const add = (a,b) => a-b;\n')
  await writeFile(join(directory,'result.json'),JSON.stringify({base,directory,workspace,project_id:project.id,thread_id:posted.thread_id,checks:['real stdio gateways','session identity','agent-only posting','read receipts','UI desktop/narrow','no browser errors','Orca space isolation with real gateways']}),{mode:0o600})
  console.log(JSON.stringify({base,directory,project_id:project.id,checks:'passed'}))
  if(process.argv.includes('--serve')) {
    console.log('Isolated Hub ready for native CLI launchers. Stop with SIGTERM.')
    await new Promise(r=>{process.once('SIGINT',r);process.once('SIGTERM',r)})
  }
} finally {await browser?.close();await Promise.allSettled(clients.map(c=>c.close()));await app.fastify.close();app.db.close()}
