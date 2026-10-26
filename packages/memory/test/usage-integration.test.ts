import { existingChannel } from './helpers/chat-channel.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { nativeSession } from '@agenthub/gateway'
import { MemoryService } from '../src/service.js'
import { registerUsageRoutes } from '../src/usage-routes.js'
import { LocalChatRuntime } from '../src/local-chat-runtime.js'

let dir:string,service:MemoryService,app:ReturnType<typeof Fastify>,enabled:boolean
beforeEach(async()=>{
  dir=await mkdtemp(join(tmpdir(),'hub-usage-integration-'));enabled=true
  service=new MemoryService(dir,'http://127.0.0.1/callback');service.usageEnabled=()=>enabled
  app=Fastify();registerUsageRoutes(app,service,{directory:dir,baseUrl:'http://127.0.0.1',authorize:async()=>({id:'owner'}),
    authorizeUsageAgent:async(_request,id)=>{if(!id.startsWith('client-'))throw Object.assign(new Error('forbidden'),{statusCode:403});return {cli_kind:'codex_cli'}},
    authorizeChatAgent:async(_request,id)=>{if(!id.startsWith('client-'))throw Object.assign(new Error('forbidden'),{statusCode:403});return {cli_kind:'codex_cli'}},usageAgentEnabled:()=>enabled})
})
afterEach(async()=>{await app.close();await service.close();await rm(dir,{recursive:true,force:true})})
async function session(name:string,agentId=`client-${name}`,workspace?:string) {
  const {operations}=await service.get(),key=randomUUID(),agent={...nativeSession(agentId,'codex_cli',name,dir),orca_workspace_id:workspace ?? `${randomUUID()}::${dir}`}
  const joined=await operations.chat.lifecycle(agent,{session_key:key,native_id:name,event:'SessionStart',at:new Date().toISOString()})
  await existingChannel(operations.chat,joined,agent.orca_workspace_id)
  await operations.chat.call('chat_set_nick',{session_key:key,nickname:`Usage ${name}`},agent)
  return {agent,key,...joined,payload:{agent_id:agentId,native_id:name,session_key:key}}
}
async function observation(s:Awaited<ReturnType<typeof session>>,used=100,account='a'.repeat(64)) {
  const sampled=new Date().toISOString(),bound=await app.inject({method:'POST',url:'/api/memory/usage/native',payload:{...s.payload,action:'bind',provider:'openai',account_ref:account,sample_started_at:sampled}})
  expect(bound.statusCode).toBe(200)
  return {binding:bound.json().binding,observation:{cli:'codex_cli',provider:'openai',account_ref:account,pool_id:'codex',observed_at:sampled,
    expires_at:new Date(Date.now()+60000).toISOString(),source:{kind:'native',adapter:'codex-app-server'},windows:[{id:'five_hour',unit:'percent',used,limit:100,resets_at:new Date(Date.now()+3600000).toISOString()}]}}
}
const report=(s:Awaited<ReturnType<typeof session>>,payload:Record<string,unknown>)=>app.inject({method:'POST',url:'/api/memory/usage/native',payload:{...s.payload,action:'observe',...payload}})

it('ingresa sólo observaciones del cliente/sesión/source autenticados y respeta OFF',async()=>{
  const s=await session('leader'),payload=await observation(s,20)
  expect((await report(s,payload)).json()).toMatchObject({accepted:true,snapshot:{status:'available'}})
  expect((await report(s,{...payload,binding:{...payload.binding,binding_id:'client-other'}})).statusCode).toBe(403)
  expect((await report({...s,payload:{...s.payload,native_id:'other'}},payload)).statusCode).toBe(403)
  expect((await report(s,{...payload,observation:{...payload.observation,source:{kind:'native',adapter:'claude-statusline'}}})).statusCode).toBe(400)
  enabled=false;expect((await report(s,payload)).statusCode).toBe(403)
  const {operations}=await service.get()
  await expect(operations.call('usage_ingest',payload,'mcp',s.agent)).rejects.toMatchObject({statusCode:404})
})
it('avisa al líder una sola vez sin crear agentes y la UI no consume sus avisos',async()=>{
  const leader=await session('leader'),worker=await session('worker','client-worker',leader.agent.orca_workspace_id)
  const payload=await observation(worker),{operations,db}=await service.get()
  expect((await report(worker,payload)).json().accepted).toBe(true)
  expect((await report(worker,payload)).json().accepted).toBe(false)
  expect((await operations.usageNotices.pending(leader.session.id))).toHaveLength(1)
  expect((await db.query('SELECT count(*) AS n FROM chat_sessions'))[0].n).toBe(2)
  expect((await operations.call('usage_status',{})).notices).toEqual([])
  expect((await operations.usageNotices.pending(leader.session.id))).toHaveLength(1)
  const queue=vi.fn(async()=>{}),runtime=new LocalChatRuntime(operations.chat,queue)
  await db.query('UPDATE chat_sessions SET team_seen=1 WHERE id=$1',[leader.session.id])
  await runtime.tick();expect(queue).toHaveBeenCalledWith('leader',expect.stringContaining('memory_usage_status'))
  await runtime.tick();expect(queue).toHaveBeenCalledTimes(1)
  const status=await operations.call('usage_status',{session_key:leader.key},'mcp',leader.agent)
  expect(status.notices).toHaveLength(1);expect(status.clis.find((c:any)=>c.cli==='codex_cli').status).toBe('exhausted')
  expect(await operations.usageNotices.pending(leader.session.id)).toEqual([])
  await runtime.close()
})
it('revoca avisos de líder anterior y los oculta cuando la herramienta está OFF',async()=>{
  const leader=await session('leader'),worker=await session('worker','client-worker',leader.agent.orca_workspace_id)
  await report(worker,await observation(worker));const {operations,db}=await service.get()
  enabled=false;expect(await operations.usageNotices.pending(leader.session.id)).toEqual([])
  enabled=true;await db.query('UPDATE chat_channels SET leader_id=$2 WHERE id=$1',[leader.channel.id,worker.session.id])
  expect(await operations.usageNotices.pending(leader.session.id)).toEqual([])
  expect(await operations.usageNotices.claim(leader.session.id)).toEqual([])
})
it('guarda observación y avisos en una sola transacción para permitir reintento tras fallo',async()=>{
  const leader=await session('leader'),payload=await observation(leader),{operations,db}=await service.get()
  const fail=vi.spyOn(operations.usageNotices,'publish').mockRejectedValueOnce(new Error('simulated storage failure'))
  expect((await report(leader,payload)).statusCode).toBe(500)
  expect((await db.query('SELECT count(*) AS n FROM usage_quota_transitions'))[0].n).toBe(0)
  expect(await operations.usage.list()).toEqual([])
  fail.mockRestore()
  expect((await report(leader,payload)).json().accepted).toBe(true)
  expect(await operations.usageNotices.pending(leader.session.id)).toHaveLength(1)
})
it('separa perfiles del mismo cliente y no asigna a una cuenta nueva el saldo de otra',async()=>{
  const s=await session('profiles'),first=await observation(s,20)
  await report(s,first)
  const bound=await app.inject({method:'POST',url:'/api/memory/usage/native',payload:{...s.payload,action:'bind',provider:'openai',account_ref:'b'.repeat(64),profile_ref:'c'.repeat(64),sample_started_at:new Date().toISOString()}})
  expect(bound.statusCode).toBe(200);expect(bound.json().binding.binding_id).toBe('client-profiles:profile:'+'c'.repeat(64))
  const {operations}=await service.get()
  expect(await operations.usage.forCli('codex_cli')).toMatchObject({status:'unknown',reason:'ambiguous_account'})
  const next={...first, binding:bound.json().binding,observation:{...first.observation,account_ref:'b'.repeat(64),observed_at:new Date().toISOString()}}
  expect((await report(s,next)).json().accepted).toBe(true)
  expect((await report(s,{...next,binding:{...next.binding,binding_id:'client-foreign:profile:'+'c'.repeat(64)}})).statusCode).toBe(403)
})
it('entrega al master de un equipo vinculado y revoca la entrega al cerrar el equipo',async()=>{
  const master=await session('master'),child=await session('child'),{operations,db}=await service.get()
  const team=randomUUID(),thread=randomUUID()
  await db.query('INSERT INTO chat_threads(id,channel_id,title,created_by) VALUES($1,$2,$3,$4)',[thread,master.channel.id,'Equipo',master.session.id])
  await db.query(`INSERT INTO chat_team_plans(id,master_channel_id,root_thread_id,created_by,objective,parent,base_revision,plan,digest,state)
    VALUES($1,$2,$3,$4,'Quota test','{}',$5,'{}',$6,'active')`,[team,master.channel.id,thread,master.session.id,'a'.repeat(40),'b'.repeat(64)])
  await db.query(`INSERT INTO chat_team_members(id,team_id,ordinal,worktree_name,cli,model,role,task,prompt,capabilities,state,session_id,channel_id)
    VALUES($1,$2,0,'child','codex_cli','real-model','implementer','task','prompt','{}','joined',$3,$4)`,[randomUUID(),team,child.session.id,child.channel.id])
  await report(child,await observation(child))
  expect(await operations.usageNotices.pending(master.session.id)).toHaveLength(1)
  // Notices persisted by the previous single-team format retain their revocation rules.
  await db.query("UPDATE usage_quota_notices SET payload=json_remove(payload,'$.routing') WHERE recipient_id=$1",[master.session.id])
  expect(await operations.usageNotices.pending(master.session.id)).toHaveLength(1)
  await db.query("UPDATE chat_team_plans SET state='cancelled' WHERE id=$1",[team])
  expect(await operations.usageNotices.pending(master.session.id)).toEqual([])
  expect(await operations.usageNotices.claim(master.session.id)).toEqual([])
})

it('conserva un único aviso mientras alguno de los equipos asociados del master siga activo',async()=>{
  const master=await session('multi-master'),childA=await session('multi-child-a','client-shared'),childB=await session('multi-child-b','client-shared')
  const {operations,db}=await service.get(),teams:string[]=[]
  for(const child of [childA,childB]){
    const team=randomUUID(),thread=randomUUID();teams.push(team)
    await db.query('INSERT INTO chat_threads(id,channel_id,title,created_by) VALUES($1,$2,$3,$4)',[thread,master.channel.id,'Equipo de cuota',master.session.id])
    await db.query(`INSERT INTO chat_team_plans(id,master_channel_id,root_thread_id,created_by,objective,parent,base_revision,plan,digest,state)
      VALUES($1,$2,$3,$4,'Quota test','{}',$5,'{}',$6,'active')`,[team,master.channel.id,thread,master.session.id,'a'.repeat(40),randomUUID()])
    await db.query(`INSERT INTO chat_team_members(id,team_id,ordinal,worktree_name,cli,model,role,task,prompt,capabilities,state,session_id,channel_id)
      VALUES($1,$2,0,'child','codex_cli','real-model','implementer','task','prompt','{}','joined',$3,$4)`,[randomUUID(),team,child.session.id,child.channel.id])
  }
  const payload=await observation(childA)
  expect((await report(childA,payload)).json().accepted).toBe(true)
  expect((await report(childA,payload)).json().accepted).toBe(false)
  const pending=await operations.usageNotices.pending(master.session.id)
  expect(pending).toHaveLength(1)
  expect(pending[0].payload.routing).toEqual({direct_channel:false,team_ids:[...teams].sort()})
  expect((await db.query('SELECT count(*) AS n FROM usage_quota_notices WHERE recipient_id=$1',[master.session.id]))[0].n).toBe(1)
  // Close precisely the legacy first-team field, exposing the previous loss of the other association.
  const first=(await db.query('SELECT team_id FROM usage_quota_notices WHERE recipient_id=$1',[master.session.id]))[0].team_id
  await db.query("UPDATE chat_team_plans SET state='cancelled' WHERE id=$1",[first])
  expect(await operations.usageNotices.pending(master.session.id)).toHaveLength(1)
  expect(await operations.usageNotices.claim(master.session.id)).toHaveLength(1)
  await db.query("UPDATE chat_team_plans SET state='cancelled' WHERE created_by=$1",[master.session.id])
  expect(await operations.usageNotices.pending(master.session.id)).toEqual([])
  expect(await operations.usageNotices.claim(master.session.id)).toEqual([])
})

it('captura del cliente instalado funciona sin sesiones y rechaza fuente o cliente ajenos',async()=>{
  const sampled=new Date().toISOString(),agent_id='client-installed',account_ref='a'.repeat(64)
  const bind=await app.inject({method:'POST',url:'/api/memory/usage/installed',payload:{agent_id,action:'bind',provider:'openai',account_ref,profile_ref:'d'.repeat(64),sample_started_at:sampled}})
  expect(bind.statusCode).toBe(200)
  const binding=bind.json().binding
  const observation={cli:'codex_cli',provider:'openai',pool_id:'codex',account_ref,model_scope:'all',observed_at:sampled,expires_at:new Date(Date.now()+60000).toISOString(),source:{kind:'native',adapter:'codex-app-server'},windows:[{id:'primary',unit:'percent',used:23,limit:100}],complete:true}
  const report=(patch:Record<string,unknown>={})=>app.inject({method:'POST',url:'/api/memory/usage/installed',payload:{agent_id,action:'observe',binding,observation,...patch}})
  expect((await report()).json()).toMatchObject({accepted:true,snapshot:{status:'available'}})
  expect((await report({agent_id:'client-other'})).statusCode).toBe(403)
  expect((await report({agent_id:'foreign'})).statusCode).toBe(403)
  expect((await report({observation:{...observation,source:{kind:'native',adapter:'claude-control'}}})).statusCode).toBe(400)
  const {operations,db}=await service.get()
  expect((await db.query('SELECT count(*) AS n FROM chat_sessions'))[0].n).toBe(0)
  expect((await operations.call('usage_status',{cli:'codex_cli'})).clis[0]).toMatchObject({status:'available',pools:[{observation:{windows:[{used:23}]}}]})
  enabled=false;expect((await report()).statusCode).toBe(403)
})
