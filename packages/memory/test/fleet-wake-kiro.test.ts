import { afterEach,expect,it,vi } from 'vitest'
import { mkdtemp,mkdir,writeFile,rm,realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile,spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { LocalChat } from '../src/local-chat.js'
import { LocalChatRuntime } from '../src/local-chat-runtime.js'
import { HubTeamRuntime } from '../src/team-hub.js'
import { TeamOrchestration,type TeamCatalog } from '../src/team-orchestration.js'
import type { AgentContext } from '../src/agents.js'
const exec=promisify(execFile)
let directory:string,db:MemoryDatabase,backend:HubTeamRuntime,dispatcher:LocalChatRuntime|undefined
afterEach(async()=>{await dispatcher?.close();await backend?.close();await db?.close();if(directory)await rm(directory,{recursive:true,force:true})})

it('serves a Kiro worker over ACP without hooks: output before the join, wake of an idle worker, team scope of the stalled notice',async()=>{
  directory=await realpath(await mkdtemp(join(tmpdir(),'hub-fleet-kiro-')))
  const repo=join(directory,'repo');await mkdir(repo)
  const git=(...args:string[])=>exec('git',['-C',repo,...args])
  await git('init','-q','-b','main');await git('-c','user.name=Test','-c','user.email=test@example.test','commit','--allow-empty','-qm','seed')
  const base=(await git('rev-parse','HEAD')).stdout.trim()
  // Scripted ACP agent: every prompt streams one chunk and then stays in flight until the client cancels it.
  const script=join(directory,'fake-kiro.cjs')
  await writeFile(script,`const {createInterface}=require('node:readline');let pending;const sid='kiro-'+process.pid;
  const out=p=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...p})+'\\n');
  createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);
  if(p.method==='initialize')out({id:p.id,result:{protocolVersion:1,agentCapabilities:{loadSession:false}}});
  if(p.method==='session/new')out({id:p.id,result:{sessionId:sid}});
  if(p.method==='session/prompt'){pending=p.id;setTimeout(()=>out({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'trabajando'}}}}),20)}
  if(p.method==='session/cancel'&&pending!==undefined){out({id:pending,result:{stopReason:'cancelled'}});pending=undefined}
  });`)
  db=new MemoryDatabase(join(directory,'memory.sqlite'));await db.migrate()
  const chat=new LocalChat(new MemoryStore(db,directory));const enabled=true
  const launcher=vi.fn((_command,args,options)=>spawn(process.execPath,[script,...args],{...options,stdio:'pipe'}))
  backend=new HubTeamRuntime(chat,directory,()=>enabled,{launcher,requestTimeoutMs:1000,shutdownTimeoutMs:50,
    run:async(command,args,options)=>command==='git'?exec(command,args,options):{stdout:'acp --model --trust-all-tools'}})
  const launch=vi.spyOn(backend,'launch')
  const catalog:TeamCatalog={catalog:async()=>({models:[],clis:[]}),validate:async(cli,model,effort)=>({cli,model,effort})}
  const teams=new TeamOrchestration(chat,catalog,backend,undefined,()=>enabled)
  const master:AgentContext={agent_id:'test-client',session_id:`native:${randomUUID()}`,cli_kind:'codex_cli',client:'Codex',cwd:repo},masterKey=randomUUID()
  await chat.lifecycle(master,{session_key:masterKey,native_id:'Master',event:'SessionStart',at:new Date().toISOString()})
  await chat.call('chat_set_nick',{session_key:masterKey,nickname:'Master'},master)
  const opened=await chat.call('chat_create_channel',{session_key:masterKey,name:'Kiro wake'},master)
  const plan=await teams.call('team_prepare',{session_key:masterKey,objective:'Prueba aislada',base_revision:base,
    members:[{worktree_name:'worker',cli:'kiro',model:'fixture',role:'implementador',task:'Prueba',prompt:'Usá Hub',rationale:'Fixture sin inferencia'}]},master)
  const launched=await teams.call('team_launch',{session_key:masterKey,plan_id:plan.id,digest:plan.digest,human_instruction:'Confirmo este plan de prueba aislada'},master)
  const member=launched.members[0]
  expect(member.runtime).toMatchObject({state:'busy'})

  // The chunk of the first prompt can arrive before the worker has registered: the manager keeps its timestamp for the current turn.
  await expect.poll(async()=>(await backend.status(member.id))?.state).toBe('busy')
  await expect.poll(()=>(backend as unknown as {manager:{activityAt(id:string):unknown}}).manager.activityAt(member.id)).toBeTruthy()

  // A hookless Kiro registers through the tools only: no lifecycle event ever stores its native id.
  const worker:AgentContext={agent_id:'kiro-client',session_id:`native:${randomUUID()}`,cli_kind:'kiro',client:'Kiro',cwd:member.workspace_path},workerKey=randomUUID()
  const joined=await chat.call('chat_join',{session_key:workerKey,path:member.workspace_path},worker)
  await chat.call('chat_set_nick',{session_key:workerKey,nickname:'KiroWorker'},worker)
  const token=/invitation=([A-Za-z0-9_-]+)/.exec(launch.mock.calls[0]![1].prompt)![1]
  await teams.call('team_join',{session_key:workerKey,invitation:token},worker)
  const sessionId=joined.session.id as string
  const row=async()=>(await db.query('SELECT * FROM chat_sessions WHERE id=$1',[sessionId]))[0]
  expect((await row()).native_id).toBeNull()
  expect((await row()).capability).toBe('hub_fleet')
  expect(await backend.readiness(sessionId)).toBe('busy')

  dispatcher=new LocalChatRuntime(chat,vi.fn(),()=>true,async()=>undefined,()=>enabled,{
    wake:(id,text)=>backend.wake(id,text),connected:async()=>true,
    readiness:id=>backend.readiness(id),activityAt:id=>backend.activityAt(id)})
  // The output seen before the join is adopted once the bound turn is open, so the list no longer degrades to unknown.
  await expect.poll(async()=>{await dispatcher!.tick();return (await row()).output_at}).toBeTruthy()

  // A mention for a busy Kiro cannot be delivered mid-turn: it waits without spending attempts.
  const early=await chat.call('chat_send',{session_key:masterKey,thread_id:plan.root_thread_id,text:'Mientras trabajás',mentions:[sessionId],request_id:randomUUID()},master)
  await dispatcher.tick()
  expect((await db.query('SELECT attempts,notified_at FROM chat_deliveries WHERE message_id=$1',[early.id]))[0]).toMatchObject({attempts:0,notified_at:null})

  // Once the worker is idle, the Hub wakes it although its row has no native id.
  await backend.interrupt(member.id)
  await expect.poll(async()=>(await backend.status(member.id))?.state).toBe('idle')
  expect(await backend.readiness(sessionId)).toBe('idle')
  const previousTurn=(await backend.status(member.id))!.turn_id
  await dispatcher.tick()
  const delivered=(await db.query('SELECT attempts,notified_at,error FROM chat_deliveries WHERE message_id=$1',[early.id]))[0]
  expect(delivered.notified_at).toBeTruthy();expect(delivered.attempts).toBe(1);expect(delivered.error).toBeNull()
  expect((await backend.status(member.id))!.state).toBe('busy')
  expect((await backend.status(member.id))!.turn_id).not.toBe(previousTurn)

  // Team scope: a mention that stays undelivered raises a notice for the coordinator, and leaving the team retires it.
  const late=await chat.call('chat_send',{session_key:masterKey,thread_id:plan.root_thread_id,text:'Otra decisión',mentions:[sessionId],request_id:randomUUID()},master)
  await chat.processStalledDeliveries(Date.now()+601_000)
  const notice=async()=>(await db.query("SELECT * FROM chat_status_notices WHERE cause='delivery_stalled' AND turn_id=$1",['stalled:'+late.id]))[0]
  expect(await notice()).toMatchObject({recipient_id:opened.session.id,session_id:sessionId})
  await db.query("UPDATE chat_team_members SET state='closed' WHERE session_id=$1",[sessionId])
  await chat.call('chat_inbox',{session_key:masterKey},master)
  expect((await notice()).cancelled_at).toBeTruthy()

  await backend.suspend()
  expect(await backend.readiness(sessionId)).toBe('unowned')
},20000)
