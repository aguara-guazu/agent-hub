import {execFileSync} from 'node:child_process'
/** Native transport checks against an isolated production Hub. No personal settings are changed.
 * --kiro: real authenticated Kiro + MCP receipt (uses the configured model).
 * --opencode: real OpenCode + local deterministic model endpoint (no paid inference).
 * --gemini /path/to/gemini: real Gemini ACP + its built-in fake-response generator.
 */
import assert from 'node:assert/strict'
import {Buffer} from 'node:buffer'
import {setTimeout} from 'node:timers'
const {fetch,AbortController}=globalThis
import {mkdtemp,mkdir,writeFile,appendFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {randomUUID} from 'node:crypto'
import {buildApp} from '../packages/core/dist/app.js'
import {ensureLocalOwner} from '../packages/core/dist/local.js'
import {createAccessToken} from '../packages/core/dist/security.js'
import {DaemonState} from '../packages/daemon/dist/state.js'
import {NativeChatClient} from '../packages/daemon/dist/local-chat-client.js'
import {ChatProtocol} from '../packages/daemon/dist/chat-protocol.js'
import {ConnectedChatSession} from '../packages/daemon/dist/chat-terminal.js'
import {planMemoryHooks} from '../packages/daemon/dist/adapters/memory-hooks.js'
import {applyChanges} from '../packages/daemon/dist/adapters/atomic.js'
import {gatewayEndpoint} from '../packages/daemon/dist/adapters/base.js'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
// Neither the host identity nor its terminal-control executable may be required.
for(const key of Object.keys(process.env))if(key.startsWith('ORCA_'))delete process.env[key]
const root=resolve(import.meta.dirname,'..'),directory=await mkdtemp(join(tmpdir(),'hub-chat-transports-'))
const workspace=join(directory,'workspace');await mkdir(workspace);execFileSync('git',['init','-q','-b','main',workspace])
process.env.AGENTHUB_MEMORY_DIR=join(directory,'memory');process.env.AGENTHUB_MEMORY_WORKER='0'
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r))
const base=`http://127.0.0.1:${port}`
const app=buildApp({settings:{localMode:true,starterCatalog:false,databasePath:join(directory,'hub.db'),oauthRedirectUrl:`${base}/api/oauth/callback`}})
const token=await createAccessToken(app.settings,ensureLocalOwner(app.store).id)
await app.fastify.listen({port,host:'127.0.0.1'})
const state=new DaemonState(join(directory,'state'))
const cleanups=[],checks=[],agents={}
const request=async(path,body,auth=token,method='POST')=>{
 const r=await fetch(`${base}/api/${path}`,{method,headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
 assert.ok(r.ok,`${path}: ${r.status} ${r.ok?'':await r.text()}`);return r.status===204?null:r.json()
}
const memory=(operation,input={})=>request('memory/call',{operation,input})
const until=async(fn,timeout=90000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,100))}throw new Error('Timed out waiting for native delivery')}
const endpoint=agent=>({command:process.execPath,args:[join(root,'packages/daemon/dist/cli.js'),'gateway','--agent',agent.id,'--state-dir',state.root]})
const snapshot=agent=>state.loadSnapshot(agent.id)
const mcp=agent=>({name:'hub',...endpoint(agent),env:[{name:'ELECTRON_RUN_AS_NODE',value:'1'}]})
try{
 const enrollment=await request('machines/enroll',{hostname:`transport-${randomUUID()}`,os:process.platform,daemon_version:'test'})
 state.saveCredentials({controlPlaneUrl:base,machineId:enrollment.machine.id,userEmail:'local',token:enrollment.token})
 await request(`machines/${enrollment.machine.id}/agents`,{agents:['claude_code','codex_cli','kiro','opencode','gemini_cli','antigravity'].map(cli_kind=>({cli_kind,cli_version:'test',config_path:''}))},enrollment.token)
 for(const a of app.store.agentsOfMachine(enrollment.machine.id)){agents[a.cli_kind]=a;state.saveSnapshot(await request(`policy/snapshot/${a.id}`,undefined,enrollment.token,'GET'))}
 const sender=new Client({name:'transport-test-sender',version:'1'});await sender.connect(new StdioClientTransport({...endpoint(agents.codex_cli),cwd:workspace,stderr:'ignore'}));cleanups.push(()=>sender.close())
 const call=async(name,args)=>{const result=await sender.callTool({name:`memory_${name}`,arguments:args});assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text)}
 const who=await call('chat_join',{path:workspace})
 await call('chat_set_nick',{session_key:who.session_key,nickname:'Mensajero'})
 const send=recipient=>call('chat_send',{session_key:who.session_key,channel_id:who.channel.id,title:'Native delivery',text:'Leé esta nota y respondé en este hilo con TRANSPORT_OK. No menciones a nadie. Después marcá este mensaje atendido.',mentions:[recipient],request_id:randomUUID()})
 const log=(name,text)=>{void appendFile(join(directory,`${name}.log`),text)}

 if(process.argv.includes('--tui-contracts')) {
  const {default:pty}=await import('@lydell/node-pty')
  const bin=join(directory,'tui-bin');await mkdir(bin)
  const fixture=`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const name=path.basename(process.argv[1]),args=process.argv.slice(2),log=process.env.TUI_FIXTURE_LOG;
const record=x=>fs.appendFileSync(log,JSON.stringify(x)+'\\n');record({args,tty:process.stdin.isTTY,env:!!process.env.AGENTHUB_TUI_KEY});
let draft='',permission=true,busy=false,turns=0;
const prompts={claude:'❯',codex:'›',gemini:'> Type your message',opencode:'Ask anything…',agy:'>', 'kiro-cli':'›  ask a question or describe a task ↵'};
function draw(){process.stdout.write('\\x1b[2J\\x1b[18;1H'+(permission?'Permission required: allow once?':busy?'Thinking · esc to interrupt':draft?'› '+draft:prompts[name]));}
process.stdin.setRawMode(true);process.stdin.resume();draw();
process.stdin.on('data',chunk=>{const value=String(chunk);record({input:value});if(value==='\\x03')process.exit(0);if(permission){if(value==='\\r'){permission=false;draw()}return}
 if(value==='\\x1b'){draft='';draw();return}
 const clean=value.replace(/\\x1b\\[20[01]~/g,'');
 if(clean==='\\r'){record({prompt:draft});draft='';busy=true;draw();setTimeout(()=>{busy=false;record({turn:++turns});draw()},200);return}
 draft+=clean;draw();
});`
  for(const name of ['claude','codex','gemini','kiro-cli','opencode','agy'])await writeFile(join(bin,name),fixture,{mode:0o700})
  const {readFile}=await import('node:fs/promises')
  for(const kind of ['claude_code','codex_cli','gemini_cli','kiro','opencode','antigravity']) {
   const home=join(directory,`${kind}-tui`);await mkdir(home)
   const [changes,drift]=planMemoryHooks(snapshot(agents[kind]),gatewayEndpoint(endpoint(agents[kind])),home);assert.deepEqual(drift,[]);applyChanges(changes)
   const launcher=changes.find(c=>/agenthub-(claude|codex|gemini|kiro|opencode|agy)$/.test(c.path)).path
   const logPath=join(directory,`${kind}-tui.jsonl`),flags=['--model','fixture model','--effort','high',...(kind==='kiro'?['--trust-all-tools']:[])]
   const child=pty.spawn(launcher,flags,{name:'xterm-256color',cols:120,rows:24,cwd:workspace,env:{...process.env,PATH:`${bin}:${process.env.PATH}`,TUI_FIXTURE_LOG:logPath}})
   let closed=false;child.onExit(()=>{closed=true});child.onData(()=>{});cleanups.push(async()=>{if(!closed)child.kill()})
   const rows=async()=>{try{return (await readFile(logPath,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x))}catch{return []}}
   const first=await until(async()=> (await rows())[0]);assert.equal(first.tty,true);assert.equal(first.env,true)
   assert.deepEqual(first.args,kind==='kiro'?['chat','--tui',...flags]:flags)
   const registration=await until(async()=> (await memory('chat_agents',{channel_id:who.channel.id})).items.find(x=>x.id!==who.session.id&&x.cli_kind===kind&&x.state!=='offline'))
   await new Promise(r=>setTimeout(r,1500));assert.equal((await rows()).filter(x=>x.input).length,0,'No notification may answer a permission dialog')
   child.write('\r') // explicit fixture user permission
   await until(async()=> (await rows()).some(x=>x.turn===1)) // Hub team bootstrap on idle native composer
   child.write('Borrador de la persona')
   const message=await send(registration.id)
   await new Promise(r=>setTimeout(r,1700))
   assert.equal((await rows()).filter(x=>x.prompt).length,1,'Never submit a human draft')
   child.write('\x1b') // user discards their draft
   await until(async()=> (await rows()).some(x=>x.turn===2))
   const prompts=(await rows()).filter(x=>x.prompt).map(x=>x.prompt)
   assert.ok(prompts[1].includes('menciones locales pendientes'));assert.ok(!prompts[1].includes('Borrador'))
   const receipt=(await memory('chat_read',{thread_id:message.thread_id})).items[0].mentions[0]
   assert.ok(receipt.notified_at);assert.equal(receipt.read_at,null)
   child.write('Borrador antes de expulsión')
   await send(registration.id)
   await call('chat_kick',{session_key:who.session_key,channel_id:who.channel.id,participant_id:registration.id,reason:'La persona solicita retirarlo durante la prueba'})
   child.write('\x1b')
   await new Promise(r=>setTimeout(r,1800))
   assert.equal((await rows()).filter(x=>x.prompt).length,2,'A removed session must not receive a queued notification')
   assert.equal(closed,false,'Removal must not kill the native terminal')
   child.resize(100,30);child.write('\x03');await until(()=>closed,10000)
   await until(async()=> (await memory('chat_agents',{channel_id:who.channel.id})).items.find(x=>x.id===registration.id)?.state==='removed')
   checks.push({kind,check:'removal cancels waiting delivery without killing CLI; native PTY launcher, exact flags, automatic bootstrap, permission/draft deferral, wake, resize, exit'})
   console.log(JSON.stringify(checks.at(-1)))
  }
 }

 if(process.argv.includes('--kiro-tui')) {
  const {default:pty}=await import('@lydell/node-pty'),{default:xterm}=await import('@xterm/headless')
  const agent=agents.kiro,home=join(directory,'native-kiro');await mkdir(home);await mkdir(join(workspace,'.kiro/agents'),{recursive:true})
  await writeFile(join(workspace,'.kiro/agents/hub-tui.json'),JSON.stringify({name:'hub-tui',description:'Isolated native TUI test',tools:['@hub'],allowedTools:['@hub/memory_chat_*','@hub/use_skill'],resources:[],hooks:{},includeMcpJson:false,mcpServers:{hub:{...endpoint(agent),env:{ELECTRON_RUN_AS_NODE:'1'}}},prompt:'Prueba aislada de colaboración. Usá exclusivamente herramientas de chat de hub y use_skill para leer local-collaboration. No leas memorias ni archivos personales. Al incorporarte elegí tu nick y leé inbox; después quedá disponible. Al recibir la tarea TRANSPORT_OK respondé en su hilo y confirmá atención.'}))
  const [changes]=planMemoryHooks(snapshot(agent),gatewayEndpoint(endpoint(agent)),home);applyChanges(changes)
  const launcher=changes.find(c=>c.path.endsWith('agenthub-kiro')).path,screen=new xterm.Terminal({cols:130,rows:40,allowProposedApi:true})
  const child=pty.spawn(launcher,['--agent','hub-tui','--trust-all-tools','--model','gpt-5.6-sol','--effort','high'],{name:'xterm-256color',cols:130,rows:40,cwd:workspace,env:process.env})
  let closed=false;child.onExit(()=>{closed=true});child.onData(d=>{screen.write(d);log('kiro-tui-raw',d)})
  cleanups.push(async()=>{if(!closed)child.kill();screen.dispose()})
  const registration=await until(async()=> (await memory('chat_agents',{channel_id:who.channel.id})).items.find(x=>x.id!==who.session.id&&x.cli_kind==='kiro'&&x.state!=='offline'))
  const named=await until(async()=>{const a=(await memory('chat_agents',{channel_id:who.channel.id})).items.find(x=>x.id===registration.id);return a?.nickname&&a.state==='idle'?a:false},180000)
  const message=await send(registration.id)
  await until(async()=>{const r=await memory('chat_read',{thread_id:message.thread_id});return r.items.some(x=>x.text.includes('TRANSPORT_OK'))&&r.items[0].mentions[0].handled_at},180000)
  const b=screen.buffer.active;await writeFile(join(directory,'kiro-tui-screen.txt'),Array.from({length:screen.rows},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)??'').join('\n'))
  child.kill();await until(()=>closed,10000)
  checks.push({kind:'kiro',nickname:named.nickname,check:'real full native TUI, user model/effort/trust flags, automatic bootstrap, real MCP read/reply/ack'})
  console.log(JSON.stringify(checks.at(-1)))
 }
 if(process.argv.includes('--contracts') || process.argv.length===2){
  const bin=join(directory,'bin');await mkdir(bin)
  const orcaAttempt=join(directory,'unexpected-orca-call')
  await writeFile(join(bin,'orca'),`#!/bin/sh\necho forbidden >> '${orcaAttempt}'\nexit 99\n`,{mode:0o700})
  const fixture=`#!/usr/bin/env node
const {createInterface}=require('node:readline'),{randomUUID}=require('node:crypto');
const native=randomUUID(),codex=process.argv[1].endsWith('codex'),agy=process.argv[1].endsWith('agy'),send=x=>console.log(JSON.stringify(x));let turn=0;
if(agy)send({event:'init',conversation_id:native});
createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);
 if(agy){send({event:'step_update',step_update:{text_delta:'FIXTURE_TURN_'+(++turn)+' '+native}});return send({event:'result',result:{conversation_id:native,status:'SUCCESS'}})}
 if(p.method==='initialize')return send({id:p.id,result:{agentCapabilities:{loadSession:true}}});
 if(codex&&p.method==='thread/start')return send({id:p.id,result:{thread:{id:native}}});
 if(codex&&p.method==='turn/start'){const t={id:'turn-'+(++turn),status:'completed'};send({id:p.id,result:{turn:t}});send({method:'turn/started',params:{threadId:native,turn:t}});send({method:'item/agentMessage/delta',params:{threadId:native,delta:'FIXTURE_TURN_'+turn+' '+native}});return send({method:'turn/completed',params:{threadId:native,turn:t}})}
 if(p.method==='session/new')return send({id:p.id,result:{sessionId:native}});
 if(p.method==='session/prompt'){send({method:'session/update',params:{sessionId:native,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'FIXTURE_TURN_'+(++turn)+' '+native}}}});return send({id:p.id,result:{stopReason:'end_turn'}})}
});`
  for(const name of ['codex','gemini','kiro-cli','agy'])await writeFile(join(bin,name),fixture,{mode:0o700})
  for(const kind of ['codex_cli','gemini_cli','kiro','antigravity']){
   const home=join(directory,`${kind}-launcher`);await mkdir(home)
   const [changes,drift]=planMemoryHooks(snapshot(agents[kind]),gatewayEndpoint(endpoint(agents[kind])),home)
   assert.deepEqual(drift,[]);applyChanges(changes)
   const launcher=changes.find(c=>/agenthub-(codex|gemini|kiro|agy)$/.test(c.path))?.path
   assert.ok(launcher,'POSIX launcher contract; on Windows use PowerShell fixture runner')
   const child=spawn(process.execPath,[join(root,'packages/daemon/dist/cli.js'),'chat-protocol','--agent',agents[kind].id,'--state-dir',state.root],{cwd:workspace,env:{...process.env,PATH:`${bin}:${process.env.PATH}`},stdio:'pipe'})
   let output='';child.stdout.on('data',c=>{output+=c;log(`${kind}-terminal`,String(c))});child.stderr.on('data',c=>log(`${kind}-terminal`,String(c)))
   let closed=false;child.once('close',()=>{closed=true})
   cleanups.push(async()=>{if(closed)return;child.kill();await new Promise(r=>child.once('close',r))})
   const registration=await until(async()=> (await memory('chat_agents',{channel_id:who.channel.id})).items.find(x=>x.id!==who.session.id&&x.cli_kind===kind&&x.state!=='offline'))
   await until(()=>output.includes('FIXTURE_TURN_1'))
   const message=await send(registration.id)
   await until(()=>output.includes('FIXTURE_TURN_2'))
   const receipt=(await memory('chat_read',{thread_id:message.thread_id})).items[0].mentions[0]
   assert.ok(receipt.notified_at);assert.equal(receipt.read_at,null,'Transport must not fabricate model reading')
   const current=(await memory('chat_agents',{channel_id:who.channel.id})).items.find(x=>x.id===registration.id)
   assert.ok(['codex_appserver','acp_prompt','antigravity_stream'].includes(current.capability))
   child.stdin.write('Primera tarea humana después del aviso\n')
   await until(()=>output.includes('FIXTURE_TURN_3'))
   child.stdin.end();await until(()=>closed,10000)
   await until(async()=> (await memory('chat_agents',{channel_id:who.channel.id})).items.find(x=>x.id===registration.id)?.state==='offline')
   checks.push({kind,check:'explicit protocol client + automatic onboarding without human input + broker wake + protocol fixture + EOF cleanup'})
   console.log(JSON.stringify(checks.at(-1)))
  }
  const {existsSync}=await import('node:fs');assert.equal(existsSync(orcaAttempt),false,'Must not invoke Orca')
 }
 if(process.argv.includes('--kiro') || process.argv.includes('--gemini')){
  for(const kind of ['kiro','gemini_cli']){
   if(!process.argv.includes(kind==='kiro'?'--kiro':'--gemini'))continue
   let command,args,env={...process.env},isFixture=kind==='gemini_cli'
   if(kind==='kiro'){
    await mkdir(join(workspace,'.kiro/agents'),{recursive:true})
    await writeFile(join(workspace,'.kiro/agents/hub-transport.json'),JSON.stringify({name:'hub-transport',description:'Isolated Hub transport probe',tools:['@hub'],allowedTools:['@hub/memory_chat_join','@hub/memory_chat_set_nick','@hub/memory_chat_inbox','@hub/memory_chat_read','@hub/memory_chat_send','@hub/memory_chat_ack','@hub/use_skill'],resources:[],hooks:{},includeMcpJson:false,mcpServers:{hub:{...endpoint(agents.kiro),env:{ELECTRON_RUN_AS_NODE:'1'}}},prompt:'Atendé mensajes de colaboración local. Usá exclusivamente las herramientas de chat. No leas otras memorias ni archivos.'}))
    command='kiro-cli';args=['acp','--agent','hub-transport','--agent-engine','v2']
   }else{
    command=process.argv[process.argv.indexOf('--gemini')+1];assert.ok(command&&!command.startsWith('--'),'--gemini needs an executable path')
    const file=join(directory,'gemini-responses.jsonl'),resp=text=>({candidates:[{content:{role:'model',parts:[{text}]},finishReason:'STOP'}]})
    await writeFile(file,Array.from({length:20},()=>[{method:'generateContentStream',response:[resp('FIXTURE_TURN_OK')]},{method:'generateContent',response:resp('{"next_speaker":"user","complexity_reasoning":"fixture","complexity_score":1}')},{method:'countTokens',response:{totalTokens:10}}]).flat().map(x=>JSON.stringify(x)).join('\n'))
    args=['--acp','--fake-responses-non-strict',file];env={...env,GEMINI_CLI_HOME:join(directory,'gemini-home'),GEMINI_API_KEY:'local-fixture-not-a-real-key'}
   }
   const outputs=[]
   const protocol=new ChatProtocol('acp',command,args,workspace,t=>{outputs.push(t);log(kind,t)},async params=>{
    const title=params.toolCall?.title ?? ''
    const allowed=/memory_chat_(join|set_nick|inbox|read|send|ack)|use_skill/.test(title),option=params.options?.find(o=>o.kind==='allow_once')
    return allowed&&option?{outcome:{outcome:'selected',optionId:option.optionId}}:{outcome:{outcome:'cancelled'}}
   },env);cleanups.push(()=>protocol.close())
   protocol.child.stdout.on('data',c=>log(kind+'-wire',String(c)))
   const native=await protocol.start(workspace,[mcp(agents[kind])])
   const broker=new NativeChatClient(state,agents[kind].id,native,workspace,'acp_prompt'),registration=await broker.start()
   const session=new ConnectedChatSession(protocol,broker),controller=new AbortController();cleanups.push(async()=>{controller.abort();await session.close()})
   const before=outputs.join('').length;let turns=0
   const listener=broker.listen(async text=>{turns++;await session.submit(text,true)},controller.signal);void listener.catch(e=>log(kind,e.message))
   await until(()=>turns>=1)
   await until(async()=> (await memory('chat_agents',{channel_id:who.channel.id})).items.find(x=>x.id===registration.session.id)?.state==='idle')
   const message=await send(registration.session.id)
   if(isFixture)await until(()=>turns===2&&outputs.join('').slice(before).includes('FIXTURE_TURN_OK'))
   else await until(async()=>{const r=await memory('chat_read',{thread_id:message.thread_id});return r.items.some(x=>x.text.includes('TRANSPORT_OK'))&&r.items[0].mentions[0].handled_at})
   if(!isFixture) {
    const named=(await memory('chat_agents',{channel_id:who.channel.id})).items.find(x=>x.id===registration.session.id)
    assert.ok(named.nickname && !named.needs_nickname,'native agent must choose its own nick before posting')
    console.log(JSON.stringify({kind,nickname:named.nickname,check:'self-chosen nickname through MCP'}))
   }
   assert.equal(protocol.sessionId,native);assert.equal(turns,2)
   controller.abort();await listener;await session.close()
   checks.push({kind,native,check:isFixture?'native ACP wake; deterministic responses':'native ACP wake; real MCP inbox, reply, acknowledgement'})
   console.log(JSON.stringify(checks.at(-1)))
  }
 }
 if(process.argv.includes('--opencode')){
  let modelCalls=0
  const model=createServer(async(req,res)=>{
   const chunks=[];for await(const chunk of req)chunks.push(chunk)
   const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');modelCalls++
   const messages=body.messages ?? [],last=messages.at(-1),context=messages.map(x=>typeof x.content==='string'?x.content:JSON.stringify(x.content)).join('\n')
   const tool=body.tools?.find(x=>x.function?.name.endsWith('memory_chat_inbox'))?.function.name,key=/session_key es ([a-f0-9]{64})/.exec(context)?.[1]
   const wake=last?.role==='user'&&JSON.stringify(last).includes('menciones locales pendientes')
   const delta=wake&&tool&&key?{tool_calls:[{index:0,id:`call_${modelCalls}`,type:'function',function:{name:tool,arguments:JSON.stringify({session_key:key})}}]}:{content:wake?'WAKE_NO_TOOL':last?.role==='tool'?'WAKE_READ':'READY'}
   if(body.stream){res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({id:`r${modelCalls}`,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:`r${modelCalls}`,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`)}
   else {res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'r',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,message:{role:'assistant',content:'READY'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}))}
  });await new Promise(r=>model.listen(0,'127.0.0.1',r));cleanups.push(()=>new Promise(r=>model.close(r)))
  const home=join(directory,'opencode');await mkdir(home)
  const [changes,drift]=planMemoryHooks(snapshot(agents.opencode),gatewayEndpoint(endpoint(agents.opencode)),home);assert.deepEqual(drift,[]);applyChanges(changes)
  const config={model:'fixture/fixture',small_model:'fixture/fixture',provider:{fixture:{npm:'@ai-sdk/openai-compatible',name:'Fixture',options:{baseURL:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'local-fixture'},models:{fixture:{name:'Fixture',limit:{context:32000,output:1000}}}}},mcp:{hub:{type:'local',command:[process.execPath,...endpoint(agents.opencode).args],environment:{ELECTRON_RUN_AS_NODE:'1'}}},permission:{'*':'deny',hub_memory_chat_inbox:'allow'}}
  await writeFile(join(home,'.config/opencode/opencode.json'),JSON.stringify(config))
  const child=spawn('opencode',['serve','--port','0','--hostname','127.0.0.1'],{cwd:workspace,env:{...process.env,XDG_CONFIG_HOME:join(home,'.config'),XDG_DATA_HOME:join(home,'data'),XDG_STATE_HOME:join(home,'state')},stdio:['ignore','pipe','pipe']})
  let output='';child.stdout.on('data',c=>{output+=c;log('opencode',String(c))});child.stderr.on('data',c=>{output+=c;log('opencode',String(c))})
  cleanups.push(async()=>{if(child.exitCode!==null)return;child.kill();await new Promise(r=>child.once('close',r))})
  const url=await until(()=>/http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0],30000)
  const oc=async(path,body)=>{const r=await fetch(`${url}${path}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(r.ok,await r.clone().text());return r.status===204?null:r.json()}
  const native=await oc('/session',{})
  await oc(`/session/${native.id}/message`,{parts:[{type:'text',text:'Reply READY.'}]})
  const recipient=await until(async()=> (await memory('chat_agents',{channel_id:who.channel.id})).items.find(x=>x.cli_kind==='opencode'))
  const message=await send(recipient.id)
  await until(async()=>{const r=await memory('chat_read',{thread_id:message.thread_id});return r.items[0].mentions[0].read_at})
  const history=await oc(`/session/${native.id}/message`)
  assert.ok(history.some(x=>x.parts?.some(p=>p.type==='text'&&p.text.includes('menciones locales pendientes'))))
  checks.push({kind:'opencode',native:native.id,modelCalls,check:'native plugin wake + MCP inbox; deterministic local provider'})
  console.log(JSON.stringify(checks.at(-1)))
 }
 assert.ok(checks.length,'Pass --kiro, --opencode or --gemini /path/to/gemini')
 await writeFile(join(directory,'result.json'),JSON.stringify({directory,checks},null,2));console.log(JSON.stringify({directory,passed:checks.length}))
}finally{for(const cleanup of cleanups.reverse())await cleanup().catch(()=>{});await app.fastify.close();app.db.close()}
