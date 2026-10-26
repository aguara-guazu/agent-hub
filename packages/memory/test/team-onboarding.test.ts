import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { LocalChat } from '../src/local-chat.js'
import { HubTeamRuntime } from '../src/team-hub.js'
import { TeamOrchestration } from '../src/team-orchestration.js'
import type { AgentContext } from '../src/agents.js'

let dir:string,folder:string,db:MemoryDatabase,chat:LocalChat,backend:HubTeamRuntime,teams:TeamOrchestration
const members=[{worktree_name:'implementation',cli:'claude_code',model:'test-model',role:'Implementación',task:'Resolver ticket',prompt:'CONTEXTO PRIVADO DEL EQUIPO'}]
beforeEach(async()=>{
  dir=await realpath(await mkdtemp(join(tmpdir(),'hub-onboarding-')));folder=join(dir,'context');await mkdir(folder)
  db=new MemoryDatabase(join(dir,'memory.sqlite'));await db.migrate();chat=new LocalChat(new MemoryStore(db,dir))
  backend=new HubTeamRuntime(chat,join(dir,'runtime'))
  vi.spyOn(backend,'preflight').mockResolvedValue()
  vi.spyOn(backend,'launch').mockImplementation(async(_workspace,member)=>({handle:member.member_id!,kind:'hub_process',prompt_outcome:'input-accepted'}))
  vi.spyOn(backend,'stop').mockImplementation(async handle=>{
    const row=(await db.query('SELECT runtime FROM chat_team_members WHERE launch_handle=$1',[handle]))[0]
    if(row)await db.query('UPDATE chat_team_members SET runtime=$2 WHERE launch_handle=$1',[handle,JSON.stringify({...row.runtime,state:'stopped'})])
    return {state:'stopped'} as any
  })
  teams=new TeamOrchestration(chat,{catalog:async()=>({clis:[{id:'claude_code',launchable:true}],models:[{cli:'claude_code',id:'test-model'}]}),validate:async()=>({launchable:true})},backend)
})
afterEach(async()=>{await backend.close();await db.close();await rm(dir,{recursive:true,force:true});vi.restoreAllMocks()})
async function session(path=folder,named=true,workspace?:string) {
  const agent:AgentContext={agent_id:'client',session_id:`native:${randomUUID()}`,cli_kind:'claude_code',client:'Claude',cwd:path,...(workspace?{orca_workspace_id:workspace}:{})},key=randomUUID()
  const internal=await chat.lifecycle(agent,{session_key:key,native_id:agent.session_id,event:'SessionStart',at:new Date().toISOString()})
  if(named)await chat.call('chat_set_nick',{session_key:key,nickname:randomUUID().slice(0,15)},agent)
  return {agent,key,...internal}
}
async function prepare(master:Awaited<ReturnType<typeof session>>,extra:{task_key?:string;[key:string]:unknown}={}) {
  const current=(await db.query('SELECT c.* FROM chat_channels c JOIN chat_sessions s ON s.channel_id=c.id WHERE s.id=$1',[master.session.id]))[0]
  if(!current.activated_at) {
    const opened=await chat.call('chat_create_channel',{session_key:master.key,task_key:extra.task_key ?? 'test-task'},master.agent)
    master.channel=opened.channel;master.session=opened.session
  }
  return teams.call('team_prepare',{session_key:master.key,objective:'Armar equipo',members,...extra},master.agent)
}
it('withholds every collaboration read and enrollment field until a unique nickname succeeds',async()=>{
  const leader=await session();await prepare(leader)
  const thread=await chat.call('chat_send',{session_key:leader.key,channel_id:leader.channel.id,title:'SECRET CHANNEL TOPIC',text:'SECRET MESSAGE',request_id:randomUUID()},leader.agent)
  const pending=await session(folder,false)
  // Existing channel membership is explicit fixture state, never inferred from the folder.
  await db.query('UPDATE chat_sessions SET channel_id=$2 WHERE id=$1',[pending.session.id,leader.channel.id])
  const delivery=await chat.call('chat_send',{session_key:leader.key,thread_id:thread.thread_id,text:'UNREAD MESSAGE',mentions:[pending.session.id],request_id:randomUUID()},leader.agent)
  const registered=await chat.call('chat_join',{session_key:pending.key},pending.agent)
  expect(registered).toEqual({session:{id:pending.session.id,needs_nickname:true},session_key:pending.key,registration_required:true,next_action:'memory_chat_set_nick'})
  expect(chat.enrollmentView(pending)).not.toHaveProperty('channel')
  const occupied=(await db.query('SELECT nickname FROM chat_sessions WHERE id=$1',[leader.session.id]))[0].nickname
  await expect(chat.call('chat_set_nick',{session_key:pending.key,nickname:occupied},pending.agent)).rejects.toThrow('Ese nick ya pertenece')
  for(const [operation,input] of [
    ['chat_channels',{}],['chat_agents',{}],['chat_threads',{}],['chat_read',{thread_id:thread.thread_id}],
    ['chat_inbox',{session_key:pending.key}],['chat_work_list',{thread_id:thread.thread_id}],
  ] as const)await expect(chat.call(operation,input,pending.agent)).rejects.toThrow('Registrate')
  await expect(teams.call('team_catalog',{session_key:pending.key},pending.agent)).rejects.toThrow('Registrate')
  expect(await db.query('SELECT * FROM chat_read_receipts WHERE session_id=$1',[pending.session.id])).toHaveLength(0)
  expect((await db.query('SELECT read_at,handled_at FROM chat_deliveries WHERE message_id=$1',[delivery.id]))[0]).toMatchObject({read_at:null,handled_at:null})
  await chat.call('chat_set_nick',{session_key:pending.key,nickname:'Independent choice'},pending.agent)
  expect(await chat.call('chat_join',{session_key:pending.key},pending.agent)).toHaveProperty('channel.id',leader.channel.id)
  expect((await chat.call('chat_read',{thread_id:thread.thread_id,session_key:pending.key},pending.agent)).items[0].text).toBe('SECRET MESSAGE')
})
it('prepares and launches from a non Git folder with durable virtual spaces and staged worker context',async()=>{
  const master=await session()
  const catalog=await teams.call('team_catalog',{session_key:master.key},master.agent)
  expect(catalog.launch_context).toMatchObject({available:false,workspace:{kind:'virtual'},readiness:{activation_required:true,task_channel_available:true}})
  const plan=await prepare(master)
  expect(plan.parent).toMatchObject({kind:'virtual',path:folder})
  expect(plan.base_revision).toBe('virtual')
  await expect(access(join(folder,'.git'))).rejects.toThrow()
  const launched=await teams.approveByHuman(plan.id,plan.digest,'owner')
  expect(launched.progress).toMatchObject({workspaces_created:1,processes_accepted:1,joined:0})
  const slot=launched.members[0]
  const child=await backend.workspace(slot.workspace_id)
  expect(child).toMatchObject({kind:'virtual',source_path:folder,repo_id:plan.parent.repo_id})
  expect(child.path).not.toBe(folder)
  expect(child.path).not.toContain('implementation')
  const prompt=vi.mocked(backend.launch).mock.calls[0]![1].prompt
  expect(prompt).not.toContain(members[0]!.prompt);expect(prompt).not.toContain(folder)
  const worker=await session(child.path)
  const invitation=/invitation=([A-Za-z0-9_-]+)/.exec(prompt)![1]
  const joined=await teams.call('team_join',{session_key:worker.key,invitation},worker.agent)
  expect(joined).toMatchObject({prompt:members[0]!.prompt,source_workspace:{path:folder},master_session_id:master.session.id})
  expect(joined.authorization).toMatchObject({source:'owner_ui',approved_by_user_id:'owner',digest:plan.digest,assignment:{prompt:members[0]!.prompt}})
  expect(joined.peers[0]).toMatchObject({id:slot.id,session_id:worker.session.id,role:members[0]!.role})
  const report=await chat.call('chat_send',{session_key:worker.key,thread_id:plan.root_thread_id,text:'Incorporado',mentions:[master.session.id],request_id:randomUUID()},worker.agent)
  expect(report.thread_id).toBe(plan.root_thread_id)
  const restarted=new HubTeamRuntime(chat,join(dir,'runtime'))
  expect(await restarted.workspace(child.id)).toEqual(child);await restarted.close()
  await expect(access(join(child.path,'.git'))).rejects.toThrow()
})
it('keeps the coordinator in its folder while using a nested Git repository, pinned in the approved plan',async()=>{
  const repo=join(folder,'service');await mkdir(repo)
  execFileSync('git',['init','-q',repo])
  execFileSync('git',['-C',repo,'-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgSign=false','commit','--allow-empty','-qm','seed'])
  const master=await session(),plan=await prepare(master,{task_key:'NESTED-REPO',repository_path:repo})
  expect(plan.parent.path).toBe(repo);expect(plan.base_revision).toMatch(/^[a-f0-9]{40}$/)
  expect((await chat.call('chat_join',{session_key:master.key},master.agent)).channel.path).toBe(folder)
  await expect(teams.approveByHuman(plan.id,'0'.repeat(64),'owner')).rejects.toThrow('digest')
  const result=await teams.approveByHuman(plan.id,plan.digest,'owner')
  expect(result.members[0].workspace_repo_id).toBe(plan.parent.repo_id)
  expect(result.members[0].workspace_head).toBe(plan.base_revision)
})
it('recovers leadership explicitly, revokes previous teams, stops workers and rejects a stale selection',async()=>{
  const master=await session(),plan=await prepare(master)
  await teams.approveByHuman(plan.id,plan.digest,'owner')
  const next=await session()
  await db.query('UPDATE chat_sessions SET channel_id=$2 WHERE id=$1',[next.session.id,master.channel.id]);next.channel=master.channel
  await db.query("UPDATE chat_sessions SET closed_at=now(),state='offline' WHERE id=$1",[master.session.id])
  const catalog=await teams.call('team_catalog',{session_key:next.key},next.agent)
  expect(catalog.launch_context.readiness.blockers[0].code).toBe('coordinator_required')
  const input={channel_id:next.channel.id,participant_id:next.session.id,expected_leader_id:master.session.id}
  const result=await chat.designateCoordinator(input,'owner')
  await teams.stopTransferredPlans(result.affected_plans)
  expect(backend.stop).toHaveBeenCalledTimes(1)
  expect((await teams.humanPlan(plan.id)).state).toBe('paused')
  expect((await db.query('SELECT invitation_hash,state FROM chat_team_members WHERE team_id=$1',[plan.id]))[0]).toMatchObject({invitation_hash:null,state:'closed'})
  await expect(chat.designateCoordinator(input,'owner')).rejects.toThrow('cambió')
  await expect(teams.approveByHuman(plan.id,plan.digest,'owner')).rejects.toThrow('no está disponible')
  expect((await prepare(next)).created_by).toBe(next.session.id)
})
it('persists the backend preference and reports independent readiness failures together',async()=>{
  const master=await session();await prepare(master);const member=await session()
  await db.query('UPDATE chat_sessions SET channel_id=$2 WHERE id=$1',[member.session.id,master.channel.id])
  await teams.setPreference('native')
  const result=await teams.call('team_catalog',{session_key:member.key,repository_path:join(dir,'missing')},member.agent)
  expect(result.launch_context.preferred_backend).toBe('native')
  expect(result.launch_context.readiness.blockers.map((b:{code:string})=>b.code)).toEqual(['coordinator_required','workspace_unavailable'])
})

it('opens a task channel from an Orca folder without inheriting its offline leader and survives hooks and retries',async()=>{
  const workspace=`folder:${randomUUID()}`
  const previous=await session(folder,true,workspace),master=await session(folder,true,workspace)
  const previousChannel=await chat.call('chat_create_channel',{session_key:previous.key,task_key:'PREVIOUS'},previous.agent);previous.channel=previousChannel.channel
  await db.query("UPDATE chat_sessions SET closed_at=now(),state='offline' WHERE id=$1",[previous.session.id])
  const catalog=await teams.call('team_catalog',{session_key:master.key},master.agent)
  expect(catalog.launch_context.readiness).toMatchObject({task_channel_available:true,coordinator_offline:false})
  expect(catalog.launch_context.readiness.blockers[0].next_action).toContain('memory_chat_create_channel')
  const create=()=>chat.call('chat_create_channel',{session_key:master.key,task_key:'EGA-349',name:'EGA-349'},master.agent)
  const [opened,retry]=await Promise.all([create(),create()])
  expect(retry.channel.id).toBe(opened.channel.id)
  expect(opened.channel).toMatchObject({name:'EGA-349',kind:'virtual',leader_id:master.session.id,path:folder,virtual_path:null,orca_workspace_id:workspace})
  expect(opened.channel.id).not.toBe(previous.channel.id)
  expect(opened.session).toMatchObject({id:master.session.id,role:'leader',needs_nickname:false})
  expect(opened.session_key).toBe(master.key)
  expect((await db.query('SELECT leader_id FROM chat_channels WHERE id=$1',[previous.channel.id]))[0].leader_id).toBe(previous.session.id)
  expect((await chat.lifecycle(master.agent,{session_key:master.key,native_id:master.agent.session_id,event:'SessionStart',at:new Date().toISOString()})).channel.id).toBe(opened.channel.id)
  expect((await session(folder,true,workspace)).channel.id).not.toBe(previous.channel.id)
  expect((await teams.call('team_catalog',{session_key:master.key},master.agent)).launch_context.available).toBe(true)
  const plan=await prepare(master,{task_key:'EGA-349'})
  expect(plan.master_channel_id).toBe(opened.channel.id)
  expect((await teams.approveByHuman(plan.id,plan.digest,'owner')).progress.processes_accepted).toBe(1)
  await expect(chat.call('chat_create_channel',{session_key:master.key,task_key:'ANOTHER'},master.agent)).rejects.toThrow('ya participa')
  expect((await create()).channel.id).toBe(opened.channel.id)
})
it('allows independent teams in the same non Git folder and retains the original team',async()=>{
  const previous=await session(),oldPlan=await prepare(previous),master=await session()
  const plan=await prepare(master,{task_key:'NEW-TASK'})
  expect(plan.master_channel_id).not.toBe(oldPlan.master_channel_id)
  expect((await teams.humanPlan(oldPlan.id)).state).toBe(oldPlan.state)
  expect((await db.query('SELECT leader_id FROM chat_channels WHERE id=$1',[previous.channel.id]))[0].leader_id).toBe(previous.session.id)
  const another=await session()
  const separate=await prepare(another,{task_key:'NEW-TASK'})
  expect(separate.master_channel_id).not.toBe(plan.master_channel_id)
  await expect(chat.call('chat_send',{session_key:master.key,channel_id:previous.channel.id,title:'No access',text:'test',request_id:randomUUID()},master.agent)).rejects.toThrow()
})
it('requires a nickname but creates task channels in Git repositories',async()=>{
  const pending=await session(folder,false)
  await expect(chat.call('chat_create_channel',{session_key:pending.key,task_key:'TASK'},pending.agent)).rejects.toThrow('Registrate')
  expect(await db.query("SELECT id FROM chat_channels WHERE scope_key LIKE 'task:%'")).toHaveLength(0)
  const repo=join(dir,'git');await mkdir(repo);execFileSync('git',['init','-q',repo])
  const master=await session(repo)
  const opened=await chat.call('chat_create_channel',{session_key:master.key,task_key:'TASK'},master.agent)
  expect(opened.channel.leader_id).toBe(master.session.id)
  expect(await db.query("SELECT id FROM chat_channels WHERE scope_key LIKE 'task:%'")).toHaveLength(1)
})

it('prepares a task-keyed Git team after ready catalog, preserving channel and creating real worktrees',async()=>{
  execFileSync('git',['init','-q',folder])
  execFileSync('git',['-C',folder,'-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgSign=false','commit','--allow-empty','-qm','seed'])
  const head=execFileSync('git',['-C',folder,'rev-parse','HEAD'],{encoding:'utf8'}).trim()
  const master=await session(),other=await session()
  const catalog=await teams.call('team_catalog',{session_key:master.key},master.agent)
  expect(catalog.launch_context.readiness).toMatchObject({ready:false,task_channel_available:true})
  const plan=await prepare(master,{task_key:'TV-APP',members:[members[0],{...members[0],worktree_name:'remote-control'}]})
  expect(plan).toMatchObject({master_channel_id:master.channel.id,base_revision:head,plan:{task_key:'TV-APP'}})
  expect(plan.parent.kind).not.toBe('virtual')
  expect((await chat.call('chat_threads',{channel_id:master.channel.id})).items.find((t:any)=>t.id===plan.root_thread_id).title).toBe('Equipo: TV-APP')
  expect(await db.query("SELECT id FROM chat_channels WHERE scope_key LIKE 'task:%'")).toHaveLength(1)
  // A task label cannot give a member another coordinator's authority.
  await expect(teams.call('team_prepare',{session_key:other.key,task_key:'OTHER',objective:'Otro',members},other.agent)).rejects.toThrow('líder activo')
  const launched=await teams.approveByHuman(plan.id,plan.digest,'owner')
  expect(launched.progress.processes_accepted).toBe(2)
  for(const member of launched.members) {
    expect(member.workspace_head).toBe(head)
    expect(member.workspace_id).toMatch(/^hub:/)
    expect(execFileSync('git',['-C',member.workspace_path,'rev-parse','HEAD'],{encoding:'utf8'}).trim()).toBe(head)
    expect(member.workspace_path).not.toBe(folder)
  }
})

it('launches from the chosen commit even when the source is on another task and the branch reference advances',async()=>{
  const repo=join(folder,'service');await mkdir(repo)
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim()
  git('init','-q')
  git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgSign=false','commit','--allow-empty','-qm','develop')
  const chosen=git('rev-parse','HEAD')
  git('update-ref','refs/remotes/origin/develop',chosen)
  git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgSign=false','commit','--allow-empty','-qm','another task')
  const sourceHead=git('rev-parse','HEAD'),sourceBranch=git('branch','--show-current')
  const master=await session()
  const plan=await prepare(master,{task_key:'CHOSEN-BASE',repository_path:repo,base_revision:chosen})
  expect(plan.parent.head).toBe(sourceHead)
  expect(plan.base_revision).toBe(chosen)
  expect(plan.plan.base_revision).toBe(chosen)
  const list=await chat.call('chat_threads',{channel_id:plan.master_channel_id})
  expect(list.items.find((t:any)=>t.id===plan.root_thread_id)).toMatchObject({title:'Equipo: CHOSEN-BASE',team_plan_id:plan.id,team_plan_state:'prepared'})
  expect((await chat.call('chat_read',{thread_id:plan.root_thread_id})).thread.team_plan_id).toBe(plan.id)
  git('update-ref','refs/remotes/origin/develop',sourceHead)
  const launched=await teams.approveByHuman(plan.id,plan.digest,'owner')
  expect(launched.progress.processes_accepted).toBe(1)
  expect(launched.members[0].workspace_head).toBe(chosen)
  expect((await backend.workspace(launched.members[0].workspace_id)).head).toBe(chosen)
  expect(git('rev-parse','HEAD')).toBe(sourceHead)
  expect(git('branch','--show-current')).toBe(sourceBranch)
  await expect(prepare(master,{repository_path:repo,base_revision:'f'.repeat(40)})).rejects.toThrow('no es un commit disponible')
  expect(await db.query('SELECT id FROM chat_team_plans')).toHaveLength(1)
})

it('moves a channel to trash, revokes its team, frees its folder and restores history without reviving sessions',async()=>{
  const master=await session(),plan=await prepare(master)
  await teams.approveByHuman(plan.id,plan.digest,'owner')
  const message=await chat.call('chat_send',{session_key:master.key,thread_id:plan.root_thread_id,text:'history to retain',request_id:randomUUID()},master.agent)
  const other=await session()
  const input={channel_id:master.channel.id,reason:'Prueba terminada'}
  await expect(chat.call('chat_delete_channel',{...input,session_key:other.key},other.agent)).rejects.toThrow('Sólo el líder')
  const result=await chat.call('chat_delete_channel',{...input,session_key:master.key},master.agent)
  expect(await teams.stopTransferredPlans(result.affected_plans)).toEqual({uncertain_members:[]})
  expect(backend.stop).toHaveBeenCalledTimes(1)
  expect((await teams.humanPlan(plan.id)).state).toBe('cancelled')
  expect((await chat.call('chat_channels',{})).items).toHaveLength(0)
  expect((await chat.call('chat_threads',{})).items).toHaveLength(0)
  expect((await chat.call('chat_agents',{include_closed:true})).items).toHaveLength(0)
  await expect(chat.call('chat_read',{thread_id:plan.root_thread_id})).rejects.toThrow('papelera')
  expect((await chat.call('chat_channels',{deleted:true})).items[0].id).toBe(master.channel.id)
  expect((await chat.call('chat_delete_channel',{...input,session_key:master.key},master.agent)).affected_plans).toEqual([])
  await expect(chat.call('chat_join',{session_key:master.key},master.agent)).rejects.toThrow('eliminado')
  const fresh=await session()
  expect(fresh.channel.id).not.toBe(master.channel.id)
  await chat.restoreChannel(master.channel.id)
  expect((await chat.call('chat_read',{thread_id:plan.root_thread_id})).items[0].id).toBe(message.id)
  expect((await chat.call('chat_channels',{channel_id:master.channel.id})).items[0].read_only).toBe(true)
  expect((await db.query('SELECT closed_at FROM chat_sessions WHERE id=$1',[master.session.id]))[0].closed_at).toBeTruthy()
  expect((await teams.humanPlan(plan.id)).state).toBe('cancelled')
  await access(folder)
})
it('reports uncertain worker stops when the owner deletes a channel instead of claiming success',async()=>{
  const master=await session(),plan=await prepare(master)
  const launched=await teams.approveByHuman(plan.id,plan.digest,'owner')
  vi.mocked(backend.stop).mockRejectedValue(new Error('unconfirmed'))
  const result=await chat.deleteChannel({channel_id:master.channel.id,reason:'Retirar equipo'},{user_id:'owner'})
  expect((await teams.stopTransferredPlans(result.affected_plans)).uncertain_members).toEqual([launched.members[0].id])
  expect((await db.query('SELECT runtime FROM chat_team_members WHERE team_id=$1',[plan.id]))[0].runtime.state).toBe('unknown')
  vi.mocked(backend.stop).mockResolvedValue({state:'stopped'} as any)
  const retry=await chat.deleteChannel({channel_id:master.channel.id,reason:'Reconciliar detención'},{user_id:'owner'})
  expect(retry.affected_plans).toEqual([plan.id])
  expect((await teams.stopTransferredPlans(retry.affected_plans)).uncertain_members).toEqual([])
})

it('presents one task channel, the whole roster and durable work threads; routes peer topics into the team',async()=>{
  const master=await session()
  const plan=await prepare(master,{members:[members[0],{...members[0],worktree_name:'operator',role:'Operador'}]})
  const launched=await teams.approveByHuman(plan.id,plan.digest,'owner')
  const workers=[]
  for(const slot of launched.members) {
    const worker=await session(slot.workspace_path)
    const prompt=vi.mocked(backend.launch).mock.calls.find(call=>call[1].member_id===slot.id)![1].prompt
    const invitation=/invitation=([A-Za-z0-9_-]+)/.exec(prompt)![1]
    const receipt=await teams.call('team_join',{session_key:worker.key,invitation},worker.agent)
    expect(receipt.work_thread_id).toBe(slot.work_thread_id)
    workers.push({...worker,receipt})
  }
  const channels=await chat.call('chat_channels',{})
  expect(channels.items).toHaveLength(1)
  expect(channels.items[0]).toMatchObject({id:plan.master_channel_id,team_plan_id:plan.id})
  expect((await chat.call('chat_channels',{include_workers:true})).items).toHaveLength(3)
  const roster=await chat.call('chat_agents',{channel_id:plan.master_channel_id},master.agent)
  expect(roster.items).toHaveLength(3)
  expect(roster.items.filter((a:any)=>a.role==='team_member')).toHaveLength(2)
  const [dev,operator]=workers
  const request=await chat.call('chat_send',{session_key:dev!.key,channel_id:dev!.channel.id,title:'Comprobar navegador',text:'Revisar la pantalla y devolver evidencia',mentions:[operator!.session.id],request_id:'operator-request'},dev!.agent)
  const inbox=await chat.call('chat_inbox',{session_key:operator!.key},operator!.agent)
  expect(inbox.items.some((m:any)=>m.id===request.id)).toBe(true)
  const response=await chat.call('chat_send',{session_key:operator!.key,thread_id:request.thread_id,text:'Pantalla verificada; evidencia disponible',mentions:[dev!.session.id],request_id:'operator-response'},operator!.agent)
  const threads=await chat.call('chat_threads',{channel_id:plan.master_channel_id})
  expect(threads.items).toHaveLength(4)
  expect(threads.items.find((t:any)=>t.id===request.thread_id)).toMatchObject({channel_id:plan.master_channel_id,team_root_thread_id:plan.root_thread_id,messages:2,team_plan_id:plan.id})
  const detail=await teams.humanPlan(plan.id)
  expect(detail.members[1].last_report).toMatchObject({id:response.id,thread_id:request.thread_id})
  expect(detail.members[1].work).toBeNull() // A message/process is not proof of completed work.
  const child=await chat.call('chat_channels',{channel_id:operator!.channel.id})
  expect(child.items[0].parent_channel_id).toBe(plan.master_channel_id)
  // Old child conversations remain discoverable from the parent after upgrading.
  const legacy=randomUUID()
  await db.query('INSERT INTO chat_threads(id,channel_id,title,created_by) VALUES($1,$2,$3,$4)',[legacy,operator!.channel.id,'Historial previo',operator!.session.id])
  expect((await chat.call('chat_threads',{channel_id:plan.master_channel_id})).items.some((t:any)=>t.id===legacy)).toBe(true)
  await teams.call('team_close',{session_key:master.key,plan_id:plan.id,digest:plan.digest,reason:'Entrega terminada'},master.agent)
  for(const worker of workers)await db.query("UPDATE chat_sessions SET closed_at=now(),state='offline',lease_until=NULL WHERE id=$1",[worker.session.id])
  expect((await chat.call('chat_agents',{channel_id:plan.master_channel_id},master.agent)).items).toHaveLength(1)
  const history=await chat.call('chat_agents',{channel_id:plan.master_channel_id,include_team_history:true},master.agent)
  expect(history.items).toHaveLength(3)
  expect(history.items.filter((a:any)=>a.team_id).every((a:any)=>a.state==='offline' && a.team_state==='cancelled' && a.work_thread_id)).toBe(true)
  expect((await chat.call('chat_agents',{channel_id:plan.master_channel_id,include_team_history:true,active_only:true},master.agent)).items).toHaveLength(1)
  // Revoked membership remains visible for observation without restoring access.
  await db.query("UPDATE chat_team_members SET state='closed' WHERE team_id=$1",[plan.id])
  expect((await chat.call('chat_agents',{channel_id:plan.master_channel_id,include_team_history:true},master.agent)).items).toHaveLength(3)
  await expect(chat.call('chat_send',{session_key:dev!.key,thread_id:plan.root_thread_id,text:'No access',request_id:randomUUID()},dev!.agent)).rejects.toThrow()
})

it.each([undefined,'TASK'])('preparing never creates or activates a channel (task_key=%s)',async task_key=>{
  const master=await session(),before=await db.query('SELECT * FROM chat_channels')
  await expect(teams.call('team_prepare',{session_key:master.key,objective:'Sin canal',members,...(task_key?{task_key}:{})},master.agent)).rejects.toThrow('líder activo')
  expect(await db.query('SELECT * FROM chat_channels')).toEqual(before)
  expect(await db.query('SELECT * FROM chat_team_plans')).toEqual([])
  expect(backend.launch).not.toHaveBeenCalled()
})

it('creates successive named channels on one session without depending on its source folder',async()=>{
  const master=await session()
  const first=await chat.call('chat_create_channel',{session_key:master.key,name:'Primero'},master.agent)
  await rm(folder,{recursive:true})
  const second=await chat.call('chat_create_channel',{session_key:master.key,name:'Segundo'},master.agent)
  expect(second.channel.id).not.toBe(first.channel.id)
  expect(second.session.id).toBe(first.session.id)
  expect(second.channel.path).toBe(first.channel.path)
  expect((await chat.call('chat_create_channel',{session_key:master.key,name:'Segundo'},master.agent)).channel.id).toBe(second.channel.id)
  await expect(chat.call('chat_create_channel',{session_key:master.key,name:'Primero'},master.agent)).rejects.toThrow('reintento viejo')
  expect((await chat.lifecycle(master.agent,{session_key:master.key,native_id:master.agent.session_id,event:'SessionStart',at:new Date().toISOString()})).channel.id).toBe(second.channel.id)
  const catalog=await teams.call('team_catalog',{session_key:master.key},master.agent)
  expect(catalog.launch_context.readiness.blockers.map((b:any)=>b.code)).toContain('workspace_unavailable')
  expect((await chat.call('chat_channels',{})).items.every((c:any)=>!c.read_only)).toBe(true)
})

it('keeps an independent Git channel for each session sharing an Orca workspace',async()=>{
  execFileSync('git',['init','-q',folder])
  const workspace=`${randomUUID()}::${folder}`
  const one=await session(folder,true,workspace),two=await session(folder,true,workspace)
  expect(one.channel.id).not.toBe(two.channel.id)
  const first=await chat.call('chat_create_channel',{session_key:one.key,task_key:'SAME'},one.agent)
  const second=await chat.call('chat_create_channel',{session_key:two.key,task_key:'SAME'},two.agent)
  expect(first.channel.id).not.toBe(second.channel.id)
  expect(first.channel.orca_workspace_id).toBe(workspace)
  expect(second.channel.orca_workspace_id).toBe(workspace)
  expect(first.team.leader_id).toBe(one.session.id)
  expect(second.team.leader_id).toBe(two.session.id)
  expect((await chat.call('chat_channels',{})).items).toHaveLength(2)
})
