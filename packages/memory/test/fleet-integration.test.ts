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
it('runs an approved isolated fleet through join, completion, private notice, wake, clear and shutdown',async()=>{
  directory=await realpath(await mkdtemp(join(tmpdir(),'hub-fleet-integration-')))
  const repo=join(directory,'repo');await mkdir(repo)
  const git=(...args:string[])=>exec('git',['-C',repo,...args])
  await git('init','-q','-b','main');await git('-c','user.name=Test','-c','user.email=test@example.test','commit','--allow-empty','-qm','seed')
  const base=(await git('rev-parse','HEAD')).stdout.trim()
  const script=join(directory,'fake-cli.cjs')
  await writeFile(script,`const {createInterface}=require('node:readline');let n=0,turn;const out=p=>process.stdout.write(JSON.stringify(p)+'\\n');
  createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);
  if(p.method==='initialize')out({id:p.id,result:{}});
  if(p.method==='thread/start')out({id:p.id,result:{thread:{id:'native-'+process.pid}}});
  if(p.method==='turn/start'){turn='turn-'+(++n);out({id:p.id,result:{turn:{id:turn,status:'inProgress'}}});if(p.params.input[0].text==='ASK')setTimeout(()=>out({id:900+n,method:'item/tool/requestUserInput',params:{threadId:'native-'+process.pid,turnId:turn,questions:[{id:'env',header:'Entorno',question:'¿Dónde probar?',options:[{label:'dev',description:'Entorno de pruebas'}]}]}}),20);}
  if(p.method==='turn/steer')out({id:p.id,result:{turnId:turn}});
  if(p.method==='turn/interrupt'){out({id:p.id,result:{}});out({method:'turn/completed',params:{threadId:'native-'+process.pid,turn:{id:turn,status:'completed'}}});}
  });`)
  db=new MemoryDatabase(join(directory,'memory.sqlite'));await db.migrate()
  const chat=new LocalChat(new MemoryStore(db,directory));let enabled=true
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
  const opened=await chat.call('chat_create_channel',{session_key:master.key,name:'Fleet test'},master.agent)
  master.channel=opened.channel;master.session=opened.session
  const plan=await teams.call('team_prepare',{session_key:master.key,objective:'Prueba aislada',base_revision:base,
    members:[{worktree_name:'worker',cli:'codex_cli',model:'fixture',role:'implementador',task:'Prueba',prompt:'Usá Hub',rationale:'Fixture sin inferencia'}]},master.agent)
  expect(launcher).not.toHaveBeenCalled()
  expect(plan.plan.permissions).toBe('full_access')
  const launched=await teams.call('team_launch',{session_key:master.key,plan_id:plan.id,digest:plan.digest,human_instruction:'Confirmo este plan de prueba aislada'},master.agent)
  const member=launched.members[0]
  expect(member.runtime).toMatchObject({state:'busy'})
  const child=await session('Worker',member.workspace_path)
  const token=/invitation=([A-Za-z0-9_-]+)/.exec(launch.mock.calls[0]![1].prompt)![1]
  await teams.call('team_join',{session_key:child.key,invitation:token},child.agent)
  expect((await db.query('SELECT capability,state FROM chat_sessions WHERE id=$1',[child.session.id]))[0]).toEqual({capability:'hub_fleet',state:'busy'})
  await backend.interrupt(member.id)
  await expect.poll(async()=>(await backend.status(member.id))?.state).toBe('idle')
  await chat.lifecycle(child.agent,{session_key:child.key,native_id:'Worker',event:'PreToolUse',at:new Date().toISOString()})
  expect((await db.query('SELECT state FROM chat_sessions WHERE id=$1',[child.session.id]))[0].state).toBe('idle')
  await chat.processTurnAlerts(Date.now()+1000,0)
  expect((await db.query('SELECT recipient_id FROM chat_status_notices'))[0]?.recipient_id).toBe(master.session.id)
  expect(await db.query('SELECT id FROM chat_threads')).toHaveLength(2)
  await chat.call('chat_send',{session_key:master.key,thread_id:plan.root_thread_id,text:'Reportá tu estatus',mentions:[child.session.id],request_id:randomUUID()},master.agent)
  const queue=vi.fn()
  dispatcher=new LocalChatRuntime(chat,queue,()=>true,async()=>undefined,()=>enabled,{wake:(id,text)=>backend.wake(id,text),connected:async()=>true})
  await dispatcher.tick()
  expect(queue.mock.calls.every(call=>call[0]!=='Worker')).toBe(true)
  expect((await backend.status(member.id))?.state).toBe('busy')
  const previousTurn=(await backend.status(member.id))!.turn_id
  await chat.call('chat_send',{session_key:master.key,thread_id:plan.root_thread_id,text:'Hallazgo mientras trabajás',mentions:[child.session.id],request_id:randomUUID()},master.agent)
  await dispatcher.tick()
  expect((await backend.status(member.id))!.turn_id).toBe(previousTurn)
  await backend.interrupt(member.id)
  await expect.poll(async()=>(await backend.status(member.id))?.state).toBe('idle')
  const generation=(await backend.status(member.id))!.generation
  await teams.call('team_control',{session_key:master.key,plan_id:plan.id,member_id:member.id,expected_generation:generation,action:'send',text:'ASK'},master.agent)
  await expect.poll(async()=>(await backend.status(member.id))?.state).toBe('waiting_input')
  expect((await db.query('SELECT state FROM chat_sessions WHERE id=$1',[child.session.id]))[0].state).toBe('blocked')
  const pending=(await backend.status(member.id))!.questions![0]!
  const inbox=await chat.call('chat_inbox',{session_key:master.key},master.agent)
  expect(inbox.items.some((message:any)=>message.author_source==='hub' && message.text.includes(pending.id))).toBe(true)
  await teams.call('team_answer',{session_key:master.key,plan_id:plan.id,member_id:member.id,expected_generation:generation,question_id:pending.id,answers:{env:{answers:['staging-unique-answer-abc']}}},master.agent)
  expect((await backend.status(member.id))?.state).toBe('busy')
  expect((await db.query('SELECT state FROM chat_sessions WHERE id=$1',[child.session.id]))[0].state).toBe('busy')
  expect(JSON.stringify(await db.query('SELECT runtime FROM chat_team_members'))).not.toContain('staging-unique-answer-abc')
  expect(JSON.stringify(await db.query('SELECT payload FROM chat_team_events'))).not.toContain('staging-unique-answer-abc')
  await expect(teams.call('team_answer',{session_key:master.key,plan_id:plan.id,member_id:member.id,expected_generation:generation,question_id:pending.id,answers:{env:{answers:['dev']}}},master.agent)).rejects.toThrow()
  expect(await db.query('SELECT id FROM chat_threads')).toHaveLength(2)
  await exec('git',['-C',member.workspace_path,'-c','user.name=Test','-c','user.email=test@example.test','commit','--allow-empty','-qm','worker change'])
  const cleared=await teams.call('team_control',{session_key:master.key,plan_id:plan.id,member_id:member.id,expected_generation:generation,action:'clear'},master.agent)
  expect(cleared.members[0].runtime.generation).not.toBe(generation)
  expect(cleared.members[0].workspace_path).toBe(member.workspace_path)
  expect(cleared.members[0].runtime.state).toBe('busy')
  enabled=false;await backend.suspend()
  expect((await backend.status(member.id))?.state).toBe('stopped')
  await expect(teams.call('team_control',{session_key:master.key,plan_id:plan.id,member_id:member.id,expected_generation:cleared.members[0].runtime.generation,action:'start'},master.agent)).rejects.toThrow()
  expect(launcher).toHaveBeenCalledTimes(2)
},20000)
