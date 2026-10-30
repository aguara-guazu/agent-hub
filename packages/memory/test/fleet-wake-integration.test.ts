import { afterEach,expect,it,vi } from 'vitest'
import { mkdtemp,mkdir,writeFile,rm,realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile,spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { LocalChat,sessionStatus } from '../src/local-chat.js'
import { LocalChatRuntime } from '../src/local-chat-runtime.js'
import { HubTeamRuntime } from '../src/team-hub.js'
import { TeamOrchestration,type TeamCatalog } from '../src/team-orchestration.js'
import type { AgentContext } from '../src/agents.js'
const exec=promisify(execFile)
let directory:string,db:MemoryDatabase,backend:HubTeamRuntime,dispatcher:LocalChatRuntime|undefined
afterEach(async()=>{await dispatcher?.close();await backend?.close();await db?.close();if(directory)await rm(directory,{recursive:true,force:true})})

it('wakes an idle hookless worker through the real process manager and reports its output as activity',async()=>{
  directory=await realpath(await mkdtemp(join(tmpdir(),'hub-fleet-wake-')))
  const repo=join(directory,'repo');await mkdir(repo)
  const git=(...args:string[])=>exec('git',['-C',repo,...args])
  await git('init','-q','-b','main');await git('-c','user.name=Test','-c','user.email=test@example.test','commit','--allow-empty','-qm','seed')
  const base=(await git('rev-parse','HEAD')).stdout.trim()
  const script=join(directory,'fake-cli.cjs')
  await writeFile(script,`const {createInterface}=require('node:readline');let n=0,turn;const out=p=>process.stdout.write(JSON.stringify(p)+'\\n');
  createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);
  if(p.method==='initialize')out({id:p.id,result:{}});
  if(p.method==='thread/start')out({id:p.id,result:{thread:{id:'native-'+process.pid}}});
  if(p.method==='turn/start'){turn='turn-'+(++n);out({id:p.id,result:{turn:{id:turn,status:'inProgress'}}});
    if(p.params.input[0].text==='EMIT')setTimeout(()=>out({method:'item/agentMessage/delta',params:{threadId:'native-'+process.pid,turnId:turn,itemId:'m1',delta:'trabajando'}}),20)
    if(p.params.input[0].text==='LATE')setTimeout(()=>out({method:'item/agentMessage/delta',params:{threadId:'native-'+process.pid,turnId:'turn-previous',itemId:'m0',delta:'tardío'}}),20)}
  if(p.method==='turn/steer')out({id:p.id,result:{turnId:turn}});
  if(p.method==='turn/interrupt'){out({id:p.id,result:{}});out({method:'turn/completed',params:{threadId:'native-'+process.pid,turn:{id:turn,status:'completed'}}});}
  });`)
  db=new MemoryDatabase(join(directory,'memory.sqlite'));await db.migrate()
  const chat=new LocalChat(new MemoryStore(db,directory));const enabled=true
  const launcher=vi.fn((_command,args,options)=>spawn(process.execPath,[script,...args],{...options,stdio:'pipe'}))
  backend=new HubTeamRuntime(chat,directory,()=>enabled,{launcher,requestTimeoutMs:1000,shutdownTimeoutMs:50,
    run:async(command,args,options)=>command==='git'?exec(command,args,options):{stdout:'--listen stdio'}})
  const launch=vi.spyOn(backend,'launch')
  const catalog:TeamCatalog={catalog:async()=>({models:[],clis:[]}),validate:async(cli,model,effort)=>({cli,model,effort})}
  const teams=new TeamOrchestration(chat,catalog,backend,undefined,()=>enabled)
  async function session(name:string,path:string) {
    const agent:AgentContext={agent_id:'test-client',session_id:`native:${randomUUID()}`,cli_kind:'codex_cli',client:'Codex',cwd:path},key=randomUUID()
    const registered=await chat.lifecycle(agent,{session_key:key,native_id:name,event:'SessionStart',at:new Date().toISOString()})
    await chat.call('chat_set_nick',{session_key:key,nickname:name},agent)
    return {agent,key,...registered}
  }
  const master=await session('Master',repo)
  const opened=await chat.call('chat_create_channel',{session_key:master.key,name:'Fleet wake'},master.agent)
  master.channel=opened.channel;master.session=opened.session
  const plan=await teams.call('team_prepare',{session_key:master.key,objective:'Prueba aislada',base_revision:base,
    members:[{worktree_name:'worker',cli:'codex_cli',model:'fixture',role:'implementador',task:'Prueba',prompt:'Usá Hub',rationale:'Fixture sin inferencia'}]},master.agent)
  const launched=await teams.call('team_launch',{session_key:master.key,plan_id:plan.id,digest:plan.digest,human_instruction:'Confirmo este plan de prueba aislada'},master.agent)
  const member=launched.members[0]
  const child=await session('Worker',member.workspace_path)
  const token=/invitation=([A-Za-z0-9_-]+)/.exec(launch.mock.calls[0]![1].prompt)![1]
  await teams.call('team_join',{session_key:child.key,invitation:token},child.agent)
  // Kiro has no hook that fills the id on the session row; the process manager is the only place that knows it.
  await db.query('UPDATE chat_sessions SET native_id=NULL WHERE id=$1',[child.session.id])
  const row=async()=>(await db.query('SELECT * FROM chat_sessions WHERE id=$1',[child.session.id]))[0]
  expect((await row()).native_id).toBeNull()

  expect(await backend.readiness(child.session.id)).toBe('mid_turn')
  await backend.interrupt(member.id)
  await expect.poll(async()=>(await backend.status(member.id))?.state).toBe('idle')
  expect(await backend.readiness(child.session.id)).toBe('idle')
  expect((await row()).state).toBe('idle')

  dispatcher=new LocalChatRuntime(chat,vi.fn(),()=>true,async()=>undefined,()=>enabled,{
    wake:(id,text)=>backend.wake(id,text),connected:async()=>true,
    readiness:id=>backend.readiness(id),activityAt:id=>backend.activityAt(id)})
  const previousTurn=(await backend.status(member.id))!.turn_id
  const sent=await chat.call('chat_send',{session_key:master.key,thread_id:plan.root_thread_id,text:'Decisión del líder',mentions:[child.session.id],request_id:randomUUID()},master.agent)
  await dispatcher.tick()
  const delivered=(await db.query('SELECT notified_at,attempts,error FROM chat_deliveries WHERE message_id=$1',[sent.id]))[0]
  expect(delivered.notified_at).toBeTruthy();expect(delivered.attempts).toBe(1);expect(delivered.error).toBeNull()
  expect((await backend.status(member.id))!.turn_id).not.toBe(previousTurn)
  expect((await backend.status(member.id))!.state).toBe('busy')

  await backend.interrupt(member.id)
  await expect.poll(async()=>(await backend.status(member.id))?.state).toBe('idle')
  expect(await backend.activityAt(child.session.id)).toBeUndefined()
  const generation=(await backend.status(member.id))!.generation
  await teams.call('team_control',{session_key:master.key,plan_id:plan.id,member_id:member.id,expected_generation:generation,action:'send',text:'EMIT'},master.agent)
  await expect.poll(async()=>backend.activityAt(child.session.id)).toBeTruthy()
  await expect.poll(async()=>{await dispatcher!.tick();return (await row()).output_at}).toBeTruthy()
  const busy=await row()
  expect(busy.state).toBe('busy')
  const silentFor=(ms:number)=>new Date(Date.parse(busy.event_at)-ms).toISOString()
  expect(sessionStatus({...busy,event_at:silentFor(600_000)}).state).toBe('busy')
  expect(sessionStatus({...busy,event_at:silentFor(600_000),output_at:null}).state).toBe('unknown')

  await backend.interrupt(member.id)
  await expect.poll(async()=>(await backend.status(member.id))?.state).toBe('idle')
  // A new turn starts without evidence, and a chunk tagged with another turn never counts as work of this one.
  await teams.call('team_control',{session_key:master.key,plan_id:plan.id,member_id:member.id,expected_generation:generation,action:'send',text:'LATE'},master.agent)
  await expect.poll(async()=>(await backend.status(member.id))?.state).toBe('busy')
  await new Promise(resolve=>setTimeout(resolve,150))
  expect(await backend.activityAt(child.session.id)).toBeUndefined()

  // A process taken between the readiness check and the send is a transient refusal; any other send failure is not.
  await backend.interrupt(member.id)
  await expect.poll(async()=>(await backend.status(member.id))?.state).toBe('idle')
  const send=vi.spyOn(backend,'send')
  send.mockRejectedValueOnce(new Error('fleet_not_idle'))
  await expect(backend.wake(child.session.id,'aviso')).rejects.toMatchObject({retryLater:true})
  send.mockRejectedValueOnce(new Error('fleet_steer_unconfirmed'))
  await expect(backend.wake(child.session.id,'aviso')).rejects.not.toMatchObject({retryLater:true})
  send.mockRestore()

  await backend.suspend()
  expect(await backend.readiness(child.session.id)).toBe('unowned')
},20000)
