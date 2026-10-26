/** Production HTTP/MCP upgrade smoke. Native model discovery; controlled Orca effects, no inference.
 * Usage: node scripts/test-team-orchestration-e2e.mjs /path/to/built/previous/checkout
 * Never edits personal profiles or starts agents. Requires a local Kiro model catalogue.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { buildApp } from '../packages/core/dist/app.js'
import { ensureLocalOwner } from '../packages/core/dist/local.js'
import { createAccessToken } from '../packages/core/dist/security.js'
import { DaemonState } from '../packages/daemon/dist/state.js'
import { planMemoryHooks } from '../packages/daemon/dist/adapters/memory-hooks.js'
import { planSkills, skillsRoot } from '../packages/daemon/dist/adapters/skills.js'
import { applyChanges } from '../packages/daemon/dist/adapters/atomic.js'
import { gatewayEndpoint } from '../packages/daemon/dist/adapters/base.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

assert.notEqual(process.platform,'win32','This smoke exercises the POSIX Kiro launcher')
assert.ok(process.argv[2],'Pass a built previous checkout to verify upgrade')
const root=resolve(import.meta.dirname,'..'),baseline=resolve(process.argv[2])
assert.notEqual(root,baseline)
const directory=await mkdtemp(join(tmpdir(),'hub-team-e2e-')),workspace=join(directory,'workspace')
await mkdir(workspace)
execFileSync('git',['init','-q','-b','main',workspace])
execFileSync('git',['-c','user.name=Team smoke','-c','user.email=smoke@example.invalid','commit','--allow-empty','-qm','fixture'],{cwd:workspace})
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8'}).trim()
const repo=randomUUID(),workspaceId=`${repo}::${workspace}`,fixtureFile=join(directory,'orca.json'),bin=join(directory,'bin')
await mkdir(bin)
const parent={id:workspaceId,path:workspace,repoId:repo,head,hostId:'local',identity:{executionHostId:'local'}}
await writeFile(fixtureFile,JSON.stringify({spaces:{[workspaceId]:parent},creates:0,launches:0,sends:0}),{mode:0o600})
const orca=join(bin,'orca-fixture')
await writeFile(orca,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const file=${JSON.stringify(fixtureFile)},data=JSON.parse(fs.readFileSync(file)),args=process.argv.slice(2);
const arg=name=>args[args.indexOf(name)+1],id=()=>arg('--worktree').replace(/^id:/,'');let result;
if(args[0]==='worktree' && args[1]==='show')result={worktree:data.spaces[id()]};
else if(args[0]==='worktree' && args[1]==='create'){
 const parent=data.spaces[arg('--parent-worktree').replace(/^id:/,'')],folder=path.join(path.dirname(parent.path),arg('--name'));
 fs.mkdirSync(folder,{recursive:true});const child={...parent,id:parent.repoId+'::'+folder,path:folder,parentWorktreeId:parent.id};
 data.spaces[child.id]=child;data.creates++;result={worktree:child};
}else if(args[0]==='terminal' && args[1]==='create'){data.launches++;result={terminal:{handle:'fixture-terminal'}};}
else if(args[0]==='terminal' && args[1]==='wait')result={wait:{satisfied:true}};
else if(args[0]==='terminal' && args[1]==='read')result={terminal:{tail:['› ask a question or describe a task ↵']}};
else if(args[0]==='terminal' && args[1]==='send'){data.sends++;data.prompt=arg('--text');result={send:{accepted:true}};}
else throw new Error('Unexpected Orca operation');
fs.writeFileSync(file,JSON.stringify(data),{mode:0o600});console.log(JSON.stringify({ok:true,result}));
`,{mode:0o700})
// Preflight sees an executable, but the controlled Orca runner never executes it.
await writeFile(join(bin,'agenthub-kiro'),'#!/bin/sh\nexit 99\n',{mode:0o700})
process.env.ORCA_CLI_COMMAND=orca
process.env.PATH=`${bin}:${process.env.PATH}`
process.env.AGENTHUB_MEMORY_DIR=join(directory,'memory')
process.env.AGENTHUB_MEMORY_WORKER='0'
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r))
const port=listener.address().port;await new Promise(r=>listener.close(r));const base=`http://127.0.0.1:${port}`
const settings={localMode:true,starterCatalog:false,databasePath:join(directory,'hub.db'),oauthRedirectUrl:`${base}/api/oauth/callback`}
const previous=await import(pathToFileURL(join(baseline,'packages/core/dist/app.js')).href)
let app=previous.buildApp({settings}),token,clients=[]
const state=new DaemonState(join(directory,'state'))
async function request(path,body,auth=token,method='POST'){
 const res=await globalThis.fetch(`${base}/api/${path}`,{method,headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
 assert.equal(res.status,200,`${path}: ${res.status===200?'':await res.text()}`);return res.json()
}
try {
 await app.fastify.listen({port,host:'127.0.0.1'})
 const owner=ensureLocalOwner(app.store);token=await createAccessToken(app.settings,owner.id)
 const skillId=app.store.setting('local_collaboration_skill_id'),oldSkill=app.store.skill(skillId)
 assert.ok(oldSkill && !oldSkill.body.includes('memory_team_catalog'),'Baseline must precede teams')
 const serverId=app.store.setting('memory_catalog_server_id'),oldTools=app.store.toolsOfServer(serverId)
 const denied=oldTools.find(t=>t.name==='get_entity');assert.ok(denied)
 app.store.insertRule({user_id:owner.id,agent_instance_id:null,resource_type:'mcp_tool',resource_id:denied.id,state:'off',reason:'Preserved upgrade preference'})
 const enrolled=await request('machines/enroll',{hostname:`team-smoke-${randomUUID()}`,os:process.platform,daemon_version:'smoke'})
 state.saveCredentials({controlPlaneUrl:base,machineId:enrolled.machine.id,userEmail:'local',token:enrolled.token})
 await request(`machines/${enrolled.machine.id}/agents`,{agents:['claude_code','codex_cli','kiro'].map(cli_kind=>({cli_kind,cli_version:'smoke',config_path:''}))},enrolled.token)
 const agents=app.store.agentsOfMachine(enrolled.machine.id)
 await app.fastify.close();app.db.close()
 app=buildApp({settings});await app.fastify.listen({port,host:'127.0.0.1'})
 token=await createAccessToken(app.settings,ensureLocalOwner(app.store).id)
 const skill=app.store.skill(skillId)
 assert.ok(skill.body.includes('memory_team_catalog'));assert.ok(skill.version>oldSkill.version)
 const endpoints={}
 for(const agent of agents){
  const snapshot=await request(`policy/snapshot/${agent.id}`,undefined,enrolled.token,'GET');state.saveSnapshot(snapshot)
  const memory=snapshot.servers.find(s=>s.id===serverId);assert.ok(memory)
  for(const name of ['team_catalog','team_prepare','team_launch','team_status','team_join','team_close'])assert.ok(memory.tools.some(t=>t.name===name),`${name} exposed after upgrade`)
  assert.ok(!memory.tools.some(t=>t.name==='get_entity'),'Existing OFF rule survived')
  const endpoint=gatewayEndpoint({command:process.execPath,args:[join(root,'packages/daemon/dist/cli.js'),'gateway','--agent',agent.id,'--state-dir',state.root]})
  endpoints[agent.cli_kind]=endpoint
  const home=join(directory,agent.cli_kind);await mkdir(home)
  const [changes,drift]=planMemoryHooks(snapshot,endpoint,home);assert.equal(drift.length,0);assert.equal(applyChanges(changes).drift.length,0)
  const [skillChanges,skillDrift]=planSkills(snapshot,home,[skillsRoot(agent.cli_kind,home)],{cliKind:agent.cli_kind})
  assert.equal(skillDrift.length,0);assert.equal(applyChanges(skillChanges).drift.length,0)
  assert.ok((await readFile(join(skillsRoot(agent.cli_kind,home),skill.slug,'SKILL.md'),'utf8')).includes('memory_team_catalog'))
 }
 async function client(kind,path,space,nick){
  const endpoint=endpoints[kind],mcp=new Client({name:`team-smoke-${nick}`,version:'1'})
  await mcp.connect(new StdioClientTransport({command:endpoint.command,args:endpoint.args,cwd:path,stderr:'ignore',env:{...process.env,ORCA_WORKTREE_ID:space}}));clients.push(mcp)
  const call=async(name,args={})=>{const result=await mcp.callTool({name:`memory_${name}`,arguments:args});assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text)}
  const enrollment=await call('chat_join',{path});assert.equal(enrollment.channel,undefined)
  await call('chat_set_nick',{session_key:enrollment.session_key,nickname:nick})
  const who=await call('chat_join',{session_key:enrollment.session_key})
  return {mcp,call,who}
 }
 const master=await client('codex_cli',workspace,workspaceId,'Master smoke'),key=master.who.session_key
 master.who=await master.call('chat_create_channel',{session_key:key,task_key:'team-smoke',name:'Equipo smoke'})
 const tools=await master.mcp.listTools();assert.ok(tools.tools.some(t=>t.name==='memory_team_launch'))
 const catalog=await master.call('team_catalog',{session_key:key})
 assert.ok(catalog.launch_context.available)
 const model=catalog.models.find(m=>m.cli==='kiro' && m.id==='gpt-5.6-sol');assert.ok(model,'Native Kiro Sol catalogue required')
 const plan=await master.call('team_prepare',{session_key:key,objective:'Smoke MCP de equipos',base_revision:head,members:[{worktree_name:'child-smoke',cli:'kiro',model:model.id,effort:'high',role:'exploration',task:'Confirmar incorporación',prompt:'Sólo confirmar incorporación, sin editar archivos.'}]})
 const prepared=JSON.parse(await readFile(fixtureFile,'utf8'));assert.equal(prepared.creates,0);assert.equal(prepared.launches,0)
 const args={session_key:key,plan_id:plan.id,digest:plan.digest,human_instruction:'Prueba controlada de release autorizada; ningún modelo ejecutado.'}
 const launched=await master.call('team_launch',args);await master.call('team_launch',args)
 const effects=JSON.parse(await readFile(fixtureFile,'utf8'));assert.equal(effects.creates,1);assert.equal(effects.launches,1);assert.equal(effects.sends,1)
 const assigned=launched.members[0],member=await client('kiro',assigned.workspace_path,assigned.workspace_id,'Miembro smoke')
 const invitation=/invitation=([A-Za-z0-9_-]+)/.exec(effects.prompt)?.[1];assert.ok(invitation)
 const joined=await member.call('team_join',{session_key:member.who.session_key,invitation});assert.equal(joined.master_session_id,master.who.session.id)
 const report=await member.call('chat_send',{session_key:member.who.session_key,thread_id:plan.root_thread_id,text:'Incorporado por MCP',mentions:[master.who.session.id],request_id:'smoke-report'})
 assert.ok((await master.call('chat_inbox',{session_key:key})).items.some(item=>item.id===report.id))
 const status=await master.call('team_status',{session_key:key,plan_id:plan.id});assert.equal(status.members[0].state,'joined');assert.ok(!JSON.stringify(status).includes(invitation))
 await master.call('team_close',{session_key:key,plan_id:plan.id,digest:plan.digest,reason:'Ensayo finalizado'})
 const rejected=await member.mcp.callTool({name:'memory_chat_send',arguments:{session_key:member.who.session_key,thread_id:plan.root_thread_id,text:'Después del cierre',request_id:'closed'}})
 assert.equal(rejected.isError,true)
 // Do not retain invitation plaintext in the evidence fixture.
 delete effects.prompt;await writeFile(fixtureFile,JSON.stringify(effects),{mode:0o600})
 const result={passed:true,directory,upgrade:{skill_id:skillId,previous_version:oldSkill.version,new_version:skill.version,off_rule_preserved:true},checks:['factory skill upgrade','skill materialized for Claude/Codex/Kiro','six tools exposed','real HTTP and stdio MCP','native Kiro catalogue','prepare without effects','idempotent launch','child join','cross-channel mention','close revokes access'],controlled:'Orca effects and child model; no inference or personal profile changes'}
 await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result))
} finally {await Promise.allSettled(clients.map(c=>c.close()));await app.fastify.close();app.db.close()}
