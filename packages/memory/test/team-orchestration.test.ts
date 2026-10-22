import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { mkdtemp,mkdir,rm,realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryService } from '../src/service.js'
import { LocalChat } from '../src/local-chat.js'
import { LocalWatchdog } from '../src/local-watchdog.js'
import { TeamOrchestration,type TeamCatalog,type TeamOrca,type TeamWorkspace } from '../src/team-orchestration.js'
import { exportMemory,readBackup,restoreMemory } from '../src/backup.js'
import type { AgentContext } from '../src/agents.js'

let dir:string,db:MemoryDatabase,store:MemoryStore,chat:LocalChat
const head='a'.repeat(40)
const author=(name:string,path:string,workspace:string,cli='kiro'):AgentContext=>({agent_id:`client-${name}`,session_id:`native:${name.padEnd(64,'0')}`,
  cli_kind:cli,client:cli,cwd:path,orca_workspace_id:workspace})

class Catalog implements TeamCatalog {
  catalog=vi.fn(async()=>({generated_at:'2026-10-20T00:00:00.000Z',clis:[{id:'kiro',launchable:true}],models:[{cli:'kiro',id:'modelo-real'}]}))
  validate=vi.fn(async(cli:string,model:string,effort?:string)=>({cli,model,effort,launchable:true,source:'cli_reported',observed_at:'2026-10-20T00:00:00.000Z'}))
}
class Orca implements TeamOrca {
  preflight=vi.fn(async(_members:Array<{cli:string;model:string;effort?:string}>)=>{})
  spaces=new Map<string,TeamWorkspace>()
  prompts=new Map<string,string>()
  create=vi.fn(async(parent:TeamWorkspace,name:string)=>{
    const path=join(dir,name);await mkdir(path,{recursive:true});const value={id:`${randomUUID()}::${path}`,path,repo_id:parent.repo_id,head:parent.head}
    this.spaces.set(value.id,value);return value
  })
  launch=vi.fn(async(workspace:TeamWorkspace,member:{prompt:string})=>{
    this.prompts.set(workspace.id,member.prompt);return {handle:`handle-${this.prompts.size}`,kind:'terminal',operation_id:`op-${this.prompts.size}`,prompt_outcome:'input-accepted'}
  })
  workspace=vi.fn(async(id:string)=>{const value=this.spaces.get(id);if(!value)throw new Error('missing');return value})
}

beforeEach(async()=>{dir=await realpath(await mkdtemp(join(tmpdir(),'hub-team-')));db=new MemoryDatabase(join(dir,'memory.sqlite'));await db.migrate();store=new MemoryStore(db,dir);chat=new LocalChat(store)})
afterEach(async()=>{await db.close();await rm(dir,{recursive:true,force:true})})

async function session(name:string,path=dir,workspace=`${randomUUID()}::${path}`,cli='kiro') {
  await mkdir(path,{recursive:true});const agent=author(name,path,workspace,cli),key=randomUUID()
  const registered=await chat.lifecycle(agent,{session_key:key,native_id:name,event:'SessionStart',at:new Date().toISOString()})
  const named=await chat.call('chat_set_nick',{session_key:key,nickname:`Agente ${name}`},agent)
  return {agent,key,workspace,...registered,session:named.session}
}
function members(count=2){return Array.from({length:count},(_,index)=>({worktree_name:`member-${index+1}`,cli:'kiro' as const,model:'modelo-real',effort:'high',
  role:index?'revisor':'implementador',task:`Tarea ${index+1}`,prompt:`Atendé la tarea ${index+1}`}))}
function invitation(prompt:string){const token=/invitation=([A-Za-z0-9_-]+)/.exec(prompt)?.[1];if(!token)throw new Error('missing invitation');return token}

it('enruta cierres silenciosos al master offline en privado sin crear hilos y revoca los avisos al cerrar el equipo',async()=>{
  const master=await session('master'),orca=new Orca()
  orca.spaces.set(master.workspace,{id:master.workspace,path:dir,repo_id:'repo',head})
  const teams=new TeamOrchestration(chat,new Catalog(),orca)
  const plan=await teams.call('team_prepare',{session_key:master.key,objective:'Avisos de turno',base_revision:head,members:members(1)},master.agent)
  const launched=await teams.call('team_launch',{session_key:master.key,plan_id:plan.id,digest:plan.digest,human_instruction:'Lanzar equipo de prueba'},master.agent)
  const slot=launched.members[0],child=await session('child',slot.workspace_path,slot.workspace_id)
  await teams.call('team_join',{session_key:child.key,invitation:invitation(orca.prompts.get(slot.workspace_id)!)},child.agent)
  // A separate child leader must not receive a revoked or offline master's alerts.
  const localLeader=await session('local-leader',slot.workspace_path,slot.workspace_id)
  await db.query('UPDATE chat_channels SET leader_id=$2 WHERE id=$1',[child.channel.id,localLeader.session.id])
  const t=Date.now()+1000
  const event=(name:string,at:number,turn_id:string)=>chat.lifecycle(child.agent,{session_key:child.key,native_id:'child',event:name,at:new Date(at).toISOString(),turn_id})
  await db.query("UPDATE chat_sessions SET closed_at=now(),state='offline' WHERE id=$1",[master.session.id])
  await event('BeforeAgent',t,'one');await event('Stop',t+10,'one')
  await chat.processTurnAlerts(t+2000,0)
  const first=(await db.query('SELECT * FROM chat_status_notices WHERE session_id=$1',[child.session.id]))[0]
  expect(first).toMatchObject({recipient_id:master.session.id,work_thread_id:plan.root_thread_id})
  expect(await db.query('SELECT * FROM chat_threads')).toHaveLength(1)
  await chat.lifecycle(master.agent,{session_key:master.key,native_id:'master',event:'SessionStart',at:new Date().toISOString()})
  const inbox=await chat.call('chat_inbox',{session_key:master.key},master.agent)
  expect(inbox.items.find((item:any)=>item.id===first.id)).toMatchObject({kind:'status_notice',author_source:'hub',thread_id:null})
  await teams.call('team_close',{session_key:master.key,plan_id:plan.id,digest:plan.digest,reason:'Finalizó el equipo'},master.agent)
  const notices=await db.query('SELECT * FROM chat_status_notices WHERE session_id=$1',[child.session.id])
  expect(notices).toHaveLength(1)
  expect(notices.every(d=>d.cancelled_at)).toBe(true)
  expect(notices.some(d=>d.recipient_id===localLeader.session.id)).toBe(false)
  // New work under the revoked membership cannot silently acquire the local leader as coordinator.
  await event('BeforeAgent',t+60,'revoked');await event('Stop',t+70,'revoked')
  await chat.processTurnAlerts(t+5000,0)
  expect(await db.query('SELECT * FROM chat_status_notices WHERE session_id=$1',[child.session.id])).toHaveLength(1)
})

it('incluye cuota en propuesta y bloquea agotamiento antes de crear efectos, revalidando al lanzar',async()=>{
  const master=await session('quota-master'),catalog=new Catalog(),orca=new Orca()
  orca.spaces.set(master.workspace,{id:master.workspace,path:dir,repo_id:'repo',head})
  let exhausted=true
  const usage={forCli:vi.fn(async()=>({status:exhausted?'exhausted' as const:'available' as const,pools:[]}))}
  const teams=new TeamOrchestration(chat,catalog,orca,usage)
  const prepared=await teams.call('team_prepare',{session_key:master.key,objective:'Cuotas',base_revision:head,members:members(1)},master.agent)
  expect(prepared.plan.usage[0].status).toBe('exhausted')
  const input={session_key:master.key,plan_id:prepared.id,digest:prepared.digest,human_instruction:'Lanzá este equipo'}
  await expect(teams.call('team_launch',input,master.agent)).rejects.toMatchObject({statusCode:409})
  expect(orca.create).not.toHaveBeenCalled();expect(orca.launch).not.toHaveBeenCalled()
  exhausted=false
  await teams.call('team_launch',input,master.agent)
  expect(orca.launch).toHaveBeenCalledTimes(1)
})
it('conserva el worktree y pausa si la cuota se agota entre creación y lanzamiento',async()=>{
  const master=await session('quota-race'),catalog=new Catalog(),orca=new Orca()
  orca.spaces.set(master.workspace,{id:master.workspace,path:dir,repo_id:'repo',head})
  const usage={forCli:vi.fn(async()=>({status:orca.create.mock.calls.length?'exhausted' as const:'available' as const,pools:[]}))}
  const teams=new TeamOrchestration(chat,catalog,orca,usage)
  const plan=await teams.call('team_prepare',{session_key:master.key,objective:'Race',base_revision:head,members:members(1)},master.agent)
  await expect(teams.call('team_launch',{session_key:master.key,plan_id:plan.id,digest:plan.digest,human_instruction:'Lanzá'},master.agent)).rejects.toMatchObject({statusCode:409})
  const result=await teams.call('team_status',{session_key:master.key,plan_id:plan.id},master.agent)
  expect(result.state).toBe('paused');expect(result.members[0].workspace_id).toBeTruthy()
  expect(orca.create).toHaveBeenCalledTimes(1);expect(orca.launch).not.toHaveBeenCalled()
})
it('expone desconocido en catálogo sin inventar cuota ni impedir un plan autorizado',async()=>{
  const master=await session('quota-unknown'),catalog=new Catalog(),orca=new Orca()
  orca.spaces.set(master.workspace,{id:master.workspace,path:dir,repo_id:'repo',head})
  const teams=new TeamOrchestration(chat,catalog,orca,{forCli:async()=>({status:'unknown',reason:'no_observation',pools:[]})})
  const listed=await teams.call('team_catalog',{session_key:master.key},master.agent)
  expect(listed.models[0].usage).toMatchObject({status:'unknown',reason:'no_observation'})
  const plan=await teams.call('team_prepare',{session_key:master.key,objective:'Unknown',base_revision:head,members:members(1)},master.agent)
  await teams.call('team_launch',{session_key:master.key,plan_id:plan.id,digest:plan.digest,human_instruction:'Lanzá el equipo con la información disponible'},master.agent)
  expect(orca.launch).toHaveBeenCalledTimes(1)
})

it('prepara un plan inmutable sólo como líder Orca y no crea efectos externos',async()=>{
  const master=await session('master'),foreign=await session('foreign'),catalog=new Catalog(),orca=new Orca()
  orca.spaces.set(master.workspace,{id:master.workspace,path:dir,repo_id:'repo',head})
  orca.spaces.set(foreign.workspace,{id:foreign.workspace,path:dir,repo_id:'repo',head})
  const teams=new TeamOrchestration(chat,catalog,orca)
  const plan=await teams.call('team_prepare',{session_key:master.key,objective:'Implementar feature',base_revision:head,members:members()},master.agent)
  expect(plan).toMatchObject({state:'prepared',created_by:master.session.id,master_channel_id:master.channel.id,base_revision:head})
  expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);expect(plan.members).toHaveLength(2);expect(plan.plan.catalog).toMatchObject({clis:[{id:'kiro',launchable:true}],models:[{cli:'kiro',id:'modelo-real'}]})
  expect(catalog.validate).toHaveBeenCalledTimes(2);expect(orca.preflight).toHaveBeenCalledTimes(1);expect(orca.create).not.toHaveBeenCalled();expect(orca.launch).not.toHaveBeenCalled()
  await expect(teams.call('team_prepare',{session_key:foreign.key,objective:'Ajeno',base_revision:head,members:members(1)},foreign.agent)).resolves.toBeTruthy()
  await chat.db.query('UPDATE chat_channels SET leader_id=$2 WHERE id=$1',[master.channel.id,foreign.session.id])
  await expect(teams.call('team_prepare',{session_key:master.key,objective:'Sin liderazgo',base_revision:head,members:members(1)},master.agent)).rejects.toMatchObject({statusCode:403})
  expect((await db.query('SELECT count(*) AS n FROM chat_team_plans'))[0].n).toBe(2)
})

it('lanza una vez el plan exacto, revalida catálogo/padre y no degrada modelo ni esfuerzo',async()=>{
  const master=await session('master'),catalog=new Catalog(),orca=new Orca(),parent={id:master.workspace,path:dir,repo_id:'repo',head};orca.spaces.set(parent.id,parent)
  const teams=new TeamOrchestration(chat,catalog,orca),prepared=await teams.call('team_prepare',{session_key:master.key,objective:'Equipo',base_revision:head,members:members()},master.agent)
  await expect(teams.call('team_launch',{session_key:master.key,plan_id:prepared.id,digest:'0'.repeat(64),human_instruction:'La persona eligió este plan'},master.agent)).rejects.toMatchObject({statusCode:409})
  const input={session_key:master.key,plan_id:prepared.id,digest:prepared.digest,human_instruction:'La persona eligió expresamente este plan y digest'}
  const [one,two]=await Promise.all([teams.call('team_launch',input,master.agent),teams.call('team_launch',input,master.agent)])
  expect([one.state,two.state].every(state=>['launching','launched'].includes(state))).toBe(true)
  expect([one.state,two.state]).toContain('launched');expect(orca.create).toHaveBeenCalledTimes(2);expect(orca.launch).toHaveBeenCalledTimes(2)
  expect(catalog.validate.mock.calls.length).toBeGreaterThanOrEqual(4);expect(catalog.validate.mock.calls.length).toBeLessThanOrEqual(6)
  expect(orca.preflight.mock.calls.length).toBeGreaterThanOrEqual(2);expect(orca.preflight.mock.calls.length).toBeLessThanOrEqual(3)
  for(const call of orca.launch.mock.calls)expect(call[1]).toMatchObject({cli:'kiro',model:'modelo-real',effort:'high'})
  const repeated=await teams.call('team_launch',input,master.agent);expect(repeated.state).toBe('launched');expect(orca.create).toHaveBeenCalledTimes(2)
  expect(repeated.members.every((item:any)=>item.launch_handle && item.operation_id)).toBe(true)
  const text=JSON.stringify(repeated);for(const prompt of orca.prompts.values())expect(text).not.toContain(invitation(prompt))
})

it('marca fallos parciales e intención incierta sin reintentar ni persistir errores externos',async()=>{
  const master=await session('master'),catalog=new Catalog(),orca=new Orca(),parent={id:master.workspace,path:dir,repo_id:'repo',head};orca.spaces.set(parent.id,parent)
  orca.create.mockImplementationOnce(async()=>{throw Object.assign(new Error('SECRET failure'),{operation_id:'op-recover-safe',launch_handle:'handle-recover-safe'})})
  const teams=new TeamOrchestration(chat,catalog,orca),prepared=await teams.call('team_prepare',{session_key:master.key,objective:'Parcial',base_revision:head,members:members()},master.agent)
  const input={session_key:master.key,plan_id:prepared.id,digest:prepared.digest,human_instruction:'Orden explícita'}
  const result=await teams.call('team_launch',input,master.agent)
  expect(result.state).toBe('partial');expect(result.members.map((item:any)=>item.state).sort()).toEqual(['accepted','unknown'])
  expect(JSON.stringify(result)).not.toContain('SECRET');expect(result.members.find((item:any)=>item.state==='unknown')).toMatchObject({operation_id:'op-recover-safe',launch_handle:'handle-recover-safe'});expect(orca.create).toHaveBeenCalledTimes(2)
  await teams.call('team_launch',input,master.agent);expect(orca.create).toHaveBeenCalledTimes(2)
})

it('consume invitación one-shot sólo desde workspace/CLI asignados y conserva identidades/canales',async()=>{
  const master=await session('master'),catalog=new Catalog(),orca=new Orca(),parent={id:master.workspace,path:dir,repo_id:'repo',head};orca.spaces.set(parent.id,parent)
  const teams=new TeamOrchestration(chat,catalog,orca),prepared=await teams.call('team_prepare',{session_key:master.key,objective:'Join',base_revision:head,members:members(1)},master.agent)
  const launched=await teams.call('team_launch',{session_key:master.key,plan_id:prepared.id,digest:prepared.digest,human_instruction:'Orden explícita'},master.agent)
  const assigned=launched.members[0],token=invitation(orca.prompts.get(assigned.workspace_id)!),wrong=await session('wrong')
  await expect(teams.call('team_join',{session_key:wrong.key,invitation:token},wrong.agent)).rejects.toMatchObject({statusCode:403})
  const child=await session('child',assigned.workspace_path,assigned.workspace_id)
  await expect(teams.call('team_join',{session_key:child.key,invitation:token},{...child.agent,orca_workspace_id:`${randomUUID()}::${assigned.workspace_path}`})).rejects.toMatchObject({statusCode:403})
  await db.query('UPDATE chat_channels SET leader_id=$2 WHERE id=$1',[master.channel.id,wrong.session.id])
  await expect(teams.call('team_join',{session_key:child.key,invitation:token},child.agent)).rejects.toMatchObject({statusCode:409})
  await db.query('UPDATE chat_channels SET leader_id=$2 WHERE id=$1',[master.channel.id,master.session.id])
  const joined=await teams.call('team_join',{session_key:child.key,invitation:token},child.agent)
  expect(joined).toMatchObject({team_id:prepared.id,member_id:assigned.id,root_thread_id:prepared.root_thread_id,master_session_id:master.session.id,session:{id:child.session.id,channel_id:child.channel.id}})
  expect(joined.guidance).toContain('master coordina desde root_thread_id')
  const context=await chat.call('chat_inbox',{session_key:child.key},child.agent)
  expect(context.team).toMatchObject({scope:'channel',leader_id:child.session.id,linked_team:{team_id:prepared.id,master_leader_id:master.session.id,root_thread_id:prepared.root_thread_id}})
  expect(context.team.guidance).toBeUndefined()
  await expect(teams.call('team_join',{session_key:child.key,invitation:token},child.agent)).rejects.toMatchObject({statusCode:409})
  expect((await db.query('SELECT channel_id FROM chat_sessions WHERE id=$1',[master.session.id]))[0].channel_id).toBe(master.channel.id)
  expect((await db.query('SELECT channel_id FROM chat_sessions WHERE id=$1',[child.session.id]))[0].channel_id).toBe(child.channel.id)
  expect((await chat.team(master.channel.id)).leader_id).toBe(master.session.id);expect((await chat.team(child.channel.id)).leader_id).toBe(child.session.id)
})

it('limita chat cross-channel al hilo raíz y a miembros vinculados con procedencia real',async()=>{
  const master=await session('master'),catalog=new Catalog(),orca=new Orca(),parent={id:master.workspace,path:dir,repo_id:'repo',head};orca.spaces.set(parent.id,parent)
  const teams=new TeamOrchestration(chat,catalog,orca),prepared=await teams.call('team_prepare',{session_key:master.key,objective:'Relay',base_revision:head,members:members(1)},master.agent)
  const sameChannel=await session('same-channel',dir,master.workspace)
  await expect(chat.call('chat_send',{session_key:sameChannel.key,thread_id:prepared.root_thread_id,text:'No soy miembro',request_id:'same-channel-outsider'},sameChannel.agent)).rejects.toMatchObject({statusCode:403})
  const launched=await teams.call('team_launch',{session_key:master.key,plan_id:prepared.id,digest:prepared.digest,human_instruction:'Orden explícita'},master.agent)
  const assigned=launched.members[0],child=await session('child',assigned.workspace_path,assigned.workspace_id),token=invitation(orca.prompts.get(assigned.workspace_id)!)
  await teams.call('team_join',{session_key:child.key,invitation:token},child.agent)
  const report=await chat.call('chat_send',{session_key:child.key,thread_id:prepared.root_thread_id,text:'Resultado desde hijo',mentions:[master.session.id],request_id:'child-report'},child.agent)
  const reply=await chat.call('chat_send',{session_key:master.key,thread_id:prepared.root_thread_id,text:'Siguiente paso',mentions:[child.session.id],request_id:'master-reply'},master.agent)
  expect((await chat.call('chat_read',{thread_id:prepared.root_thread_id})).items.map((item:any)=>item.author_id)).toEqual([child.session.id,master.session.id])
  const event=(await db.query("SELECT * FROM chat_team_events WHERE type='chat_message' AND payload->>'message_id'=$1",[report.id]))[0]
  expect(event).toMatchObject({actor_session_id:child.session.id,source_channel_id:child.channel.id,target_thread_id:prepared.root_thread_id})
  expect(reply).toBeTruthy()
  const work={session_key:child.key,thread_id:prepared.root_thread_id,work_id:'review',request_id:'work-start',expected_version:0,event:'started',summary:'Revisión'}
  await chat.call('chat_work_update',work,child.agent)
  const observer=new LocalWatchdog(chat)
  await observer.tick();await observer.close()
  expect((await db.query('SELECT snapshot FROM chat_watchdog_observations WHERE session_id=$1',[child.session.id]))[0].snapshot.recipientId).toBe(master.session.id)
  expect((await chat.call('chat_work_list',{session_key:master.key,thread_id:prepared.root_thread_id},master.agent)).items[0].session_id).toBe(child.session.id)
  await expect(chat.call('chat_work_list',{session_key:sameChannel.key,thread_id:prepared.root_thread_id},sameChannel.agent)).rejects.toMatchObject({statusCode:403})
  const linkedVersion=(await chat.call('chat_inbox',{session_key:child.key},child.agent)).team.guidance_version
  const outsider=await session('outsider')
  await expect(chat.call('chat_send',{session_key:outsider.key,thread_id:prepared.root_thread_id,text:'Intrusión',request_id:'outsider'},outsider.agent)).rejects.toMatchObject({statusCode:403})
  await expect(chat.call('chat_send',{session_key:master.key,thread_id:prepared.root_thread_id,text:'Mención ajena',mentions:[outsider.session.id],request_id:'outsider-mention'},master.agent)).rejects.toMatchObject({statusCode:400})
  await teams.call('team_close',{session_key:master.key,plan_id:prepared.id,digest:prepared.digest,reason:'Fin del equipo'},master.agent)
  await db.query('DELETE FROM chat_watchdog_observations')
  const afterClose=new LocalWatchdog(chat);await afterClose.tick();await afterClose.close()
  expect(await db.query('SELECT * FROM chat_watchdog_observations')).toHaveLength(0)
  expect((await db.query('SELECT cancelled_at FROM chat_deliveries WHERE message_id=$1',[report.id]))[0].cancelled_at).toBeTruthy()
  const closedContext=(await chat.call('chat_inbox',{session_key:child.key},child.agent)).team
  expect(closedContext.linked_team).toBeNull()
  expect(closedContext.guidance_version).not.toBe(linkedVersion)
  await expect(chat.call('chat_work_update',{...work,request_id:'after-close',expected_version:1,event:'progress'},child.agent)).rejects.toMatchObject({statusCode:403})
  await expect(chat.call('chat_work_list',{session_key:child.key,thread_id:prepared.root_thread_id},child.agent)).rejects.toMatchObject({statusCode:403})
  await expect(chat.call('chat_send',{session_key:child.key,thread_id:prepared.root_thread_id,text:'Después del cierre',request_id:'closed-team'},child.agent)).rejects.toMatchObject({statusCode:403})
})

it('crea hilos breves ligados al root de un equipo y conserva su ACL al cerrar o revocar',async()=>{
  const master=await session('master'),catalog=new Catalog(),orca=new Orca(),parent={id:master.workspace,path:dir,repo_id:'repo',head};orca.spaces.set(parent.id,parent)
  const teams=new TeamOrchestration(chat,catalog,orca),plan=await teams.call('team_prepare',{session_key:master.key,objective:'Hilos',base_revision:head,members:members(2)},master.agent)
  const launched=await teams.call('team_launch',{session_key:master.key,plan_id:plan.id,digest:plan.digest,human_instruction:'Orden explícita'},master.agent)
  const [firstAssignment,secondAssignment]=launched.members
  const first=await session('first',firstAssignment.workspace_path,firstAssignment.workspace_id),second=await session('second',secondAssignment.workspace_path,secondAssignment.workspace_id)
  await teams.call('team_join',{session_key:first.key,invitation:invitation(orca.prompts.get(firstAssignment.workspace_id)!)},first.agent)
  await teams.call('team_join',{session_key:second.key,invitation:invitation(orca.prompts.get(secondAssignment.workspace_id)!)},second.agent)
  const projectId=randomUUID(),otherProjectId=randomUUID(),taskId=randomUUID(),foreignTaskId=randomUUID()
  await db.query("INSERT INTO entities(id,kind,title,data) VALUES($1,'project','Proyecto','{}'),($2,'project','Otro','{}')",[projectId,otherProjectId])
  await db.query('UPDATE chat_channels SET project_id=$2 WHERE id=$1',[master.channel.id,projectId])
  await db.query("INSERT INTO tasks(id,project_id,kind,title,status,created_by,updated_by) VALUES($1,$2,'pending','Propia','todo','test','test'),($3,$4,'pending','Ajena','todo','test','test')",[taskId,projectId,foreignTaskId,otherProjectId])
  const one=await chat.call('chat_send',{session_key:first.key,team_root_thread_id:plan.root_thread_id,title:'API',text:'Abrir API',task_id:taskId,mentions:[master.session.id],request_id:'child-thread-one'},first.agent)
  const two=await chat.call('chat_send',{session_key:master.key,team_root_thread_id:plan.root_thread_id,title:'UI',text:'Abrir UI',mentions:[second.session.id],request_id:'master-thread-two'},master.agent)
  const threads=await db.query('SELECT id,channel_id,task_id,team_root_thread_id FROM chat_threads WHERE id IN ($1,$2) ORDER BY id',[one.thread_id,two.thread_id])
  expect(threads).toHaveLength(2);expect(threads.every(thread=>thread.channel_id===master.channel.id && thread.team_root_thread_id===plan.root_thread_id)).toBe(true)
  expect(threads.find(thread=>thread.id===one.thread_id).task_id).toBe(taskId)
  expect((await db.query('SELECT team_root_thread_id FROM chat_threads WHERE id=$1',[plan.root_thread_id]))[0].team_root_thread_id).toBeNull()
  await expect(chat.call('chat_send',{session_key:first.key,team_root_thread_id:plan.root_thread_id,title:'Ticket ajeno',text:'No',task_id:foreignTaskId,request_id:'foreign-task'},first.agent)).rejects.toMatchObject({statusCode:400})
  const beforeNested=Number((await db.query('SELECT count(*) AS n FROM chat_threads'))[0].n)
  await expect(chat.call('chat_send',{session_key:first.key,team_root_thread_id:one.thread_id,title:'Anidado',text:'No',request_id:'nested-thread'},first.agent)).rejects.toMatchObject({statusCode:400})
  expect(Number((await db.query('SELECT count(*) AS n FROM chat_threads'))[0].n)).toBe(beforeNested)
  await chat.call('chat_send',{session_key:second.key,thread_id:one.thread_id,text:'Respuesta miembro',mentions:[first.session.id],request_id:'second-reply'},second.agent)
  await chat.call('chat_send',{session_key:master.key,thread_id:two.thread_id,text:'Respuesta master',mentions:[first.session.id],request_id:'master-reply'},master.agent)
  await chat.call('chat_resolve',{session_key:first.key,thread_id:one.thread_id,state:'resolved'},first.agent)
  await chat.call('chat_resolve',{session_key:second.key,thread_id:one.thread_id,state:'open'},second.agent)
  await chat.call('chat_resolve',{session_key:master.key,thread_id:two.thread_id,state:'resolved'},master.agent)
  await expect(chat.call('chat_send',{session_key:first.key,team_root_thread_id:plan.root_thread_id,channel_id:first.channel.id,title:'Canal ajeno',text:'No',request_id:'wrong-channel'},first.agent)).rejects.toMatchObject({statusCode:400})
  const outsider=await session('outsider')
  await expect(chat.call('chat_send',{session_key:outsider.key,thread_id:one.thread_id,text:'Intrusión',request_id:'outside'},outsider.agent)).rejects.toMatchObject({statusCode:403})
  await expect(chat.call('chat_resolve',{session_key:outsider.key,thread_id:one.thread_id,state:'resolved'},outsider.agent)).rejects.toMatchObject({statusCode:403})
  const masterOutsider=await session('master-outsider',dir,master.workspace)
  expect(masterOutsider.channel.id).toBe(master.channel.id)
  await expect(chat.call('chat_resolve',{session_key:masterOutsider.key,thread_id:one.thread_id,state:'resolved'},masterOutsider.agent)).rejects.toMatchObject({statusCode:403})
  await expect(chat.call('chat_send',{session_key:outsider.key,team_root_thread_id:plan.root_thread_id,title:'No',text:'No',request_id:'outside-create'},outsider.agent)).rejects.toMatchObject({statusCode:403})
  const otherPlan=await teams.call('team_prepare',{session_key:master.key,objective:'Otro equipo',base_revision:head,members:members(1)},master.agent)
  const otherLaunch=await teams.call('team_launch',{session_key:master.key,plan_id:otherPlan.id,digest:otherPlan.digest,human_instruction:'Orden explícita'},master.agent)
  const otherAssignment=otherLaunch.members[0],other=await session('other-team',otherAssignment.workspace_path,otherAssignment.workspace_id)
  await teams.call('team_join',{session_key:other.key,invitation:invitation(orca.prompts.get(otherAssignment.workspace_id)!)},other.agent)
  await expect(chat.call('chat_send',{session_key:other.key,thread_id:one.thread_id,text:'Otro equipo',request_id:'other-team-thread'},other.agent)).rejects.toMatchObject({statusCode:403})
  await expect(chat.call('chat_send',{session_key:first.key,thread_id:one.thread_id,team_root_thread_id:plan.root_thread_id,text:'Retag',request_id:'retag'},first.agent)).rejects.toMatchObject({statusCode:400})
  expect((await db.query('SELECT channel_id FROM chat_sessions WHERE id IN ($1,$2)',[first.session.id,second.session.id])).map(row=>row.channel_id).sort()).toEqual([first.channel.id,second.channel.id].sort())
  await db.query('UPDATE chat_sessions SET removed_at=now() WHERE id=$1',[second.session.id])
  await expect(chat.call('chat_send',{session_key:second.key,thread_id:two.thread_id,text:'Revocado',request_id:'revoked-child-thread'},second.agent)).rejects.toMatchObject({statusCode:410})
  await teams.call('team_close',{session_key:master.key,plan_id:plan.id,digest:plan.digest,reason:'Fin'},master.agent)
  expect((await db.query('SELECT cancelled_at FROM chat_deliveries WHERE message_id=$1',[one.id]))[0].cancelled_at).toBeTruthy()
  await expect(chat.call('chat_send',{session_key:first.key,thread_id:one.thread_id,text:'Cerrado',request_id:'closed-child-thread'},first.agent)).rejects.toMatchObject({statusCode:403})
  await expect(chat.call('chat_resolve',{session_key:first.key,thread_id:one.thread_id,state:'resolved'},first.agent)).rejects.toMatchObject({statusCode:403})
  await expect(chat.call('chat_resolve',{session_key:master.key,thread_id:one.thread_id,state:'resolved'},master.agent)).rejects.toMatchObject({statusCode:403})
})

it('rechaza migrar una conversación nativa existente a otro canal',async()=>{
  const first=await session('same'),path=join(dir,'other');await mkdir(path);const workspace=`${randomUUID()}::${path}`,moved={...first.agent,cwd:path,orca_workspace_id:workspace}
  await expect(chat.lifecycle(moved,{session_key:randomUUID(),native_id:'same',event:'SessionStart',at:new Date().toISOString()})).rejects.toMatchObject({statusCode:409})
  expect((await db.query('SELECT channel_id FROM chat_sessions WHERE id=$1',[first.session.id]))[0].channel_id).toBe(first.channel.id)
})

it('mantiene el catálogo útil y declara disponibilidad Orca por sesión sin lanzar',async()=>{
  const master=await session('master'),catalog=new Catalog(),orca=new Orca(),parent={id:master.workspace,path:dir,repo_id:'repo',head};orca.spaces.set(parent.id,parent)
  const teams=new TeamOrchestration(chat,catalog,orca)
  expect(await teams.call('team_catalog',{session_key:master.key},master.agent)).toMatchObject({launch_context:{orca_workspace_id:master.workspace,available:true}})
  expect((await teams.call('team_catalog',{session_key:master.key},master.agent)).clis[0].launchable).toBe(true)
  orca.preflight.mockRejectedValueOnce(new Error('private launcher path'))
  const unavailable=await teams.call('team_catalog',{session_key:master.key},master.agent)
  expect(unavailable.clis[0].launchable).toBe(false);expect(unavailable.models).toHaveLength(1)
  expect(JSON.stringify(unavailable)).not.toContain('private launcher path')
  orca.spaces.delete(parent.id)
  expect((await teams.call('team_catalog',{session_key:master.key},master.agent)).clis[0].launchable).toBe(false)
  expect(await teams.call('team_catalog',{session_key:master.key},master.agent)).toMatchObject({launch_context:{orca_workspace_id:master.workspace,available:false}})
  const path=join(dir,'plain');await mkdir(path);const plain={agent_id:'plain',session_id:`native:${'plain'.padEnd(64,'0')}`,cli_kind:'kiro',client:'kiro',cwd:path},key=randomUUID()
  await chat.lifecycle(plain,{session_key:key,native_id:'plain',event:'SessionStart',at:new Date().toISOString()})
  expect(await teams.call('team_catalog',{session_key:key},plain)).toMatchObject({launch_context:{orca_workspace_id:null,available:false}})
  expect(orca.create).not.toHaveBeenCalled();expect(orca.launch).not.toHaveBeenCalled()
})

it('falla cerrado si el preflight de Orca rechaza la combinación antes de efectos',async()=>{
  const master=await session('master'),catalog=new Catalog(),orca=new Orca(),parent={id:master.workspace,path:dir,repo_id:'repo',head};orca.spaces.set(parent.id,parent)
  const teams=new TeamOrchestration(chat,catalog,orca),prepared=await teams.call('team_prepare',{session_key:master.key,objective:'Preflight',base_revision:head,members:members(1)},master.agent)
  orca.preflight.mockRejectedValueOnce(new Error('Kiro launcher unsupported'))
  await expect(teams.call('team_launch',{session_key:master.key,plan_id:prepared.id,digest:prepared.digest,human_instruction:'Orden'},master.agent)).rejects.toThrow('unsupported')
  expect(orca.create).not.toHaveBeenCalled();expect(orca.launch).not.toHaveBeenCalled()
  expect((await teams.call('team_status',{session_key:master.key,plan_id:prepared.id},master.agent)).state).toBe('prepared')
})

it('revalida liderazgo y sesión después de discovery y antes del primer efecto',async()=>{
  const master=await session('master'),catalog=new Catalog(),orca=new Orca(),parent={id:master.workspace,path:dir,repo_id:'repo',head};orca.spaces.set(parent.id,parent)
  const teams=new TeamOrchestration(chat,catalog,orca),prepared=await teams.call('team_prepare',{session_key:master.key,objective:'Revalidar',base_revision:head,members:members(1)},master.agent)
  catalog.validate.mockImplementationOnce(async()=>{await db.query('UPDATE chat_sessions SET removed_at=now() WHERE id=$1',[master.session.id]);return {launchable:true}})
  await expect(teams.call('team_launch',{session_key:master.key,plan_id:prepared.id,digest:prepared.digest,human_instruction:'Orden'},master.agent)).rejects.toMatchObject({statusCode:403})
  expect(orca.create).not.toHaveBeenCalled();expect(orca.launch).not.toHaveBeenCalled()
})

it('acepta join antes del recibo sin que accepted pise joined y conserva el handle',async()=>{
  const master=await session('master'),catalog=new Catalog(),orca=new Orca(),parent={id:master.workspace,path:dir,repo_id:'repo',head};orca.spaces.set(parent.id,parent)
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
  orca.launch.mockImplementationOnce(async(workspace,member)=>{orca.prompts.set(workspace.id,member.prompt);entered();await gate;return {handle:'race-handle',kind:'terminal',operation_id:'race-op',prompt_outcome:'handed-to-terminal'}})
  const teams=new TeamOrchestration(chat,catalog,orca),prepared=await teams.call('team_prepare',{session_key:master.key,objective:'Race join',base_revision:head,members:members(1)},master.agent)
  const pending=teams.call('team_launch',{session_key:master.key,plan_id:prepared.id,digest:prepared.digest,human_instruction:'Orden'},master.agent)
  await started
  const assigned=(await db.query('SELECT * FROM chat_team_members WHERE team_id=$1',[prepared.id]))[0],child=await session('child',assigned.workspace_path,assigned.workspace_id)
  await teams.call('team_join',{session_key:child.key,invitation:invitation(orca.prompts.get(assigned.workspace_id)!)},child.agent)
  release();const result=await pending
  expect(result.members[0]).toMatchObject({state:'joined',session_id:child.session.id,launch_handle:'race-handle',operation_id:'race-op'})
})

it('convierte workspace inválido en unknown en vez de continuar el launch',async()=>{
  const master=await session('master'),catalog=new Catalog(),orca=new Orca(),parent={id:master.workspace,path:dir,repo_id:'repo',head};orca.spaces.set(parent.id,parent)
  orca.create.mockImplementationOnce(async(base,name)=>{const path=join(dir,name);await mkdir(path);return {id:`${randomUUID()}::${path}`,path,repo_id:base.repo_id,head:'b'.repeat(40)}})
  const teams=new TeamOrchestration(chat,catalog,orca),prepared=await teams.call('team_prepare',{session_key:master.key,objective:'Workspace inválido',base_revision:head,members:members(1)},master.agent)
  const result=await teams.call('team_launch',{session_key:master.key,plan_id:prepared.id,digest:prepared.digest,human_instruction:'Orden'},master.agent)
  expect(result).toMatchObject({state:'uncertain',members:[expect.objectContaining({state:'unknown',workspace_id:null})]})
  expect(orca.launch).not.toHaveBeenCalled()
})

it('pausa intents encontrados al reiniciar y nunca reintenta efectos',async()=>{
  const master=await session('master'),catalog=new Catalog(),orca=new Orca(),parent={id:master.workspace,path:dir,repo_id:'repo',head};orca.spaces.set(parent.id,parent)
  const first=new TeamOrchestration(chat,catalog,orca),prepared=await first.call('team_prepare',{session_key:master.key,objective:'Recovery',base_revision:head,members:members(1)},master.agent)
  await db.query("UPDATE chat_team_plans SET state='launching' WHERE id=$1",[prepared.id]);await db.query("UPDATE chat_team_members SET state='launch_intent' WHERE team_id=$1",[prepared.id])
  const restarted=new TeamOrchestration(chat,catalog,orca);await restarted.initialize();const status=await restarted.call('team_status',{session_key:master.key,plan_id:prepared.id},master.agent)
  expect(status).toMatchObject({state:'paused',members:[expect.objectContaining({state:'unknown'})]})
  expect(orca.create).not.toHaveBeenCalled();expect(orca.launch).not.toHaveBeenCalled()
})

it('team_close gana la carrera, revoca pendientes y no inicia el siguiente slot',async()=>{
  const master=await session('master'),catalog=new Catalog(),orca=new Orca(),parent={id:master.workspace,path:dir,repo_id:'repo',head};orca.spaces.set(parent.id,parent)
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
  orca.launch.mockImplementationOnce(async(workspace,member)=>{orca.prompts.set(workspace.id,member.prompt);entered();await gate;return {handle:'closed-handle',kind:'terminal',operation_id:'closed-op',prompt_outcome:'handed-to-terminal'}})
  const teams=new TeamOrchestration(chat,catalog,orca),prepared=await teams.call('team_prepare',{session_key:master.key,objective:'Cerrar carrera',base_revision:head,members:members(2)},master.agent)
  const launching=teams.call('team_launch',{session_key:master.key,plan_id:prepared.id,digest:prepared.digest,human_instruction:'Orden'},master.agent);await started
  const closed=await teams.call('team_close',{session_key:master.key,plan_id:prepared.id,digest:prepared.digest,reason:'La persona canceló'},master.agent)
  expect(closed.state).toBe('cancelled');release();const result=await launching
  expect(result.state).toBe('cancelled');expect(orca.create).toHaveBeenCalledTimes(1);expect(orca.launch).toHaveBeenCalledTimes(1)
  expect(result.members[0]).toMatchObject({state:'closed',launch_handle:'closed-handle',operation_id:'closed-op'})
  expect(result.members[1]).toMatchObject({state:'closed',workspace_id:null,invitation_expires_at:null})
  expect(await import('node:fs/promises').then(fs=>fs.realpath(result.members[0].workspace_path))).toBeTruthy()
  const again=await teams.call('team_close',{session_key:master.key,plan_id:prepared.id,digest:prepared.digest,reason:'Reintento'},master.agent)
  expect(again.state).toBe('cancelled');expect((await db.query("SELECT count(*) AS n FROM chat_team_events WHERE team_id=$1 AND type='cancelled'",[prepared.id]))[0].n).toBe(1)
})

it('restaura planes activos pausados, invalida invitaciones y conserva eventos/procedencia',async()=>{
  const master=await session('master'),catalog=new Catalog(),orca=new Orca(),parent={id:master.workspace,path:dir,repo_id:'repo',head};orca.spaces.set(parent.id,parent)
  const teams=new TeamOrchestration(chat,catalog,orca),prepared=await teams.call('team_prepare',{session_key:master.key,objective:'Backup',base_revision:head,members:members(1)},master.agent)
  await teams.call('team_launch',{session_key:master.key,plan_id:prepared.id,digest:prepared.digest,human_instruction:'Orden explícita'},master.agent)
  const backup=JSON.parse(await readBackup(store,(await exportMemory(store)).id));expect(backup.schema_version).toBe(22)
  const target=join(dir,'restore'),restored=new MemoryDatabase(join(target,'memory.sqlite'));await restored.migrate()
  try {await restoreMemory(new MemoryStore(restored,target),backup)
    expect((await restored.query('SELECT state FROM chat_team_plans WHERE id=$1',[prepared.id]))[0].state).toBe('paused')
    expect((await restored.query('SELECT state,invitation_hash,invitation_expires_at FROM chat_team_members WHERE team_id=$1',[prepared.id]))[0]).toMatchObject({state:'paused',invitation_hash:null,invitation_expires_at:null})
    expect((await restored.query('SELECT count(*) AS n FROM chat_team_events WHERE team_id=$1',[prepared.id]))[0].n).toBeGreaterThan(0)
    expect(await restored.query('PRAGMA foreign_key_check')).toEqual([])
  } finally {await restored.close()}
})

it('pausa la ejecución y revoca invitaciones si el master cierra su sesión durante la creación',async()=>{
  const master=await session('master'),catalog=new Catalog(),orca=new Orca(),parent={id:master.workspace,path:dir,repo_id:'repo',head}
  orca.spaces.set(parent.id,parent)
  orca.create.mockImplementationOnce(async(base,name)=>{
    const path=join(dir,name);await mkdir(path)
    await db.query("UPDATE chat_sessions SET closed_at=now(),state='offline' WHERE id=$1",[master.session.id])
    return {id:`${randomUUID()}::${path}`,path,repo_id:base.repo_id,head}
  })
  const teams=new TeamOrchestration(chat,catalog,orca)
  const prepared=await teams.call('team_prepare',{session_key:master.key,objective:'Pérdida del master',base_revision:head,members:members(2)},master.agent)
  await expect(teams.call('team_launch',{session_key:master.key,plan_id:prepared.id,digest:prepared.digest,human_instruction:'Lanzar el plan'},master.agent))
    .rejects.toMatchObject({statusCode:403})
  expect(orca.create).toHaveBeenCalledTimes(1);expect(orca.launch).not.toHaveBeenCalled()
  expect((await db.query('SELECT state FROM chat_team_plans WHERE id=$1',[prepared.id]))[0].state).toBe('paused')
  expect((await db.query('SELECT invitation_hash FROM chat_team_members WHERE team_id=$1',[prepared.id])).every(row=>row.invitation_hash===null)).toBe(true)
})

it('revoca escritura cross-channel cuando el master está offline aunque conserve leader_id',async()=>{
  const master=await session('master'),catalog=new Catalog(),orca=new Orca(),parent={id:master.workspace,path:dir,repo_id:'repo',head}
  orca.spaces.set(parent.id,parent)
  const teams=new TeamOrchestration(chat,catalog,orca)
  const prepared=await teams.call('team_prepare',{session_key:master.key,objective:'Master offline',base_revision:head,members:members(1)},master.agent)
  const launched=await teams.call('team_launch',{session_key:master.key,plan_id:prepared.id,digest:prepared.digest,human_instruction:'Lanzar'},master.agent)
  const assigned=launched.members[0],child=await session('child',assigned.workspace_path,assigned.workspace_id)
  await teams.call('team_join',{session_key:child.key,invitation:invitation(orca.prompts.get(assigned.workspace_id)!)},child.agent)
  await db.query("UPDATE chat_sessions SET closed_at=now(),state='offline' WHERE id=$1",[master.session.id])
  await expect(chat.call('chat_send',{session_key:child.key,thread_id:prepared.root_thread_id,text:'No autorizado',request_id:'offline-master'},child.agent))
    .rejects.toMatchObject({statusCode:403})
})


it('sólo el servicio propietario recupera antes del primer chat y cancela despertares pendientes',async()=>{
  const master=await session('master'),catalog=new Catalog(),orca=new Orca(),parent={id:master.workspace,path:dir,repo_id:'repo',head}
  orca.spaces.set(parent.id,parent)
  const teams=new TeamOrchestration(chat,catalog,orca)
  const plan=await teams.call('team_prepare',{session_key:master.key,objective:'Recuperar antes del chat',base_revision:head,members:members(2)},master.agent)
  const launched=await teams.call('team_launch',{session_key:master.key,plan_id:plan.id,digest:plan.digest,human_instruction:'Lanzar'},master.agent)
  const assigned=launched.members[0],child=await session('child',assigned.workspace_path,assigned.workspace_id)
  await teams.call('team_join',{session_key:child.key,invitation:invitation(orca.prompts.get(assigned.workspace_id)!)},child.agent)
  const report=await chat.call('chat_send',{session_key:child.key,thread_id:plan.root_thread_id,text:'Pendiente',mentions:[master.session.id],request_id:'before-crash'},child.agent)
  await db.query("UPDATE chat_team_plans SET state='launching' WHERE id=$1",[plan.id])
  await db.query("UPDATE chat_team_members SET state='launch_intent' WHERE id=$1",[launched.members[1].id])
  const worker=new MemoryService(dir,'http://localhost/callback'),owner=new MemoryService(dir,'http://localhost/callback',fetch,undefined,true)
  try {
    const secondary=await worker.get()
    expect((await secondary.operations.teams!.call('team_status',{session_key:master.key,plan_id:plan.id},master.agent)).state).toBe('launching')
    const restarted=await owner.get()
    expect((await db.query('SELECT state FROM chat_team_plans WHERE id=$1',[plan.id]))[0].state).toBe('paused')
    expect((await db.query('SELECT cancelled_at FROM chat_deliveries WHERE message_id=$1',[report.id]))[0].cancelled_at).toBeTruthy()
    expect((await db.query('SELECT invitation_hash FROM chat_team_members WHERE team_id=$1',[plan.id])).every(row=>row.invitation_hash===null)).toBe(true)
    await expect(restarted.operations.chat.call('chat_send',{session_key:child.key,thread_id:plan.root_thread_id,text:'Después del reinicio',request_id:'chat-first'},child.agent)).rejects.toMatchObject({statusCode:403})
    await restarted.operations.teams!.initialize()
    expect((await db.query('SELECT state FROM chat_team_plans WHERE id=$1',[plan.id]))[0].state).toBe('paused')
  } finally {await worker.close();await owner.close()}
})

it('OFF oculta cuotas persistidas y evita lecturas y bloqueos indirectos por team_*',async()=>{
  const master=await session('quota-off'),catalog=new Catalog(),orca=new Orca()
  orca.spaces.set(master.workspace,{id:master.workspace,path:dir,repo_id:'repo',head})
  const usage={forCli:vi.fn(async()=>({status:'exhausted' as const,pools:[]}))}
  const teams=new TeamOrchestration(chat,catalog,orca,usage)
  const prepared=await teams.call('team_prepare',{session_key:master.key,objective:'OFF',base_revision:head,members:members(1)},master.agent)
  expect(prepared.plan.usage[0].status).toBe('exhausted')
  chat.usageEnabled=()=>false;usage.forCli.mockClear()
  const listed=await teams.call('team_catalog',{session_key:master.key},master.agent)
  expect(listed.models[0].usage).toMatchObject({status:'unknown',reason:'disabled',pools:[]})
  const status=await teams.call('team_status',{session_key:master.key,plan_id:prepared.id},master.agent)
  expect(status.plan).toMatchObject({usage:[],usage_redacted:true});expect(status.digest).toBe(prepared.digest)
  const next=await teams.call('team_prepare',{session_key:master.key,objective:'OFF new',base_revision:head,members:members(1)},master.agent)
  expect(next.plan.usage).toEqual([])
  const launched=await teams.call('team_launch',{session_key:master.key,plan_id:prepared.id,digest:prepared.digest,human_instruction:'Lanzar'},master.agent)
  expect(launched.plan.usage).toEqual([]);expect(orca.launch).toHaveBeenCalledTimes(1)
  expect(usage.forCli).not.toHaveBeenCalled()
  chat.usageEnabled=()=>true
  expect((await teams.call('team_status',{session_key:master.key,plan_id:prepared.id},master.agent)).plan.usage[0].status).toBe('exhausted')
})

class HubBackend extends Orca {
  readonly provider='hub' as const
  runtimes=new Map<string,{generation:string;state:string;updated_at:string;native_id:string|null;turn_id:string|null}>()
  stop=vi.fn(async(handle:string)=>{
    const runtime=this.runtimes.get(handle)
    if(runtime) {
      const stopped={...runtime,state:'stopped',updated_at:new Date().toISOString(),provider:'hub'}
      this.runtimes.set(handle,stopped)
      await db.query('UPDATE chat_team_members SET runtime=$2 WHERE launch_handle=$1',[handle,JSON.stringify(stopped)])
      return stopped
    }
    return undefined
  })
  answer=vi.fn(async(handle:string,_questionId:string,_answers:Record<string,{answers:string[]}>)=>{
    const runtime=this.runtimes.get(handle)
    if(runtime) {
      const next={...runtime,state:'busy',questions:[],provider:'hub',updated_at:new Date().toISOString()}
      this.runtimes.set(handle,next)
      await db.query('UPDATE chat_team_members SET runtime=$2 WHERE launch_handle=$1',[handle,JSON.stringify(next)])
    }
  })
  send=vi.fn(async(_handle:string,_text:string)=>{})
  interrupt=vi.fn(async(_handle:string)=>{})
  bind=vi.fn(async(_memberId:string,_sessionId:string)=>{})
  status=vi.fn(async(handle:string)=>this.runtimes.get(handle))
  override launch=vi.fn(async(workspace:TeamWorkspace,member:{prompt:string;authorize?:()=>Promise<void>})=>{
    await member.authorize?.()
    this.prompts.set(workspace.id,member.prompt)
    const handle=`hub-${randomUUID()}`,runtime={generation:randomUUID(),state:'idle',updated_at:new Date().toISOString(),native_id:null,turn_id:null}
    this.runtimes.set(handle,runtime)
    const memberId=(member as {member_id?:string}).member_id
    if(memberId)await db.query('UPDATE chat_team_members SET runtime=$2 WHERE id=$1',[memberId,JSON.stringify({...runtime,provider:'hub'})])
    return {handle,kind:'hub',prompt_outcome:'accepted',runtime}
  })
}
async function hubSession(name:string,path=dir) {
  await mkdir(path,{recursive:true})
  execFileSync('git',['init','-q',path])
  const agent=author(name,path,'unused');delete agent.orca_workspace_id
  const key=randomUUID(),registered=await chat.lifecycle(agent,{session_key:key,native_id:name,event:'SessionStart',at:new Date().toISOString()})
  const named=await chat.call('chat_set_nick',{session_key:key,nickname:`Agente ${name}`},agent)
  return {agent,key,...registered,session:named.session}
}
async function hubTeam(enabled=()=>true,usage?:any) {
  const master=await hubSession('hub-master'),backend=new HubBackend()
  backend.spaces.set(dir,{id:`hub:${Buffer.from(dir).toString('base64url')}`,path:dir,repo_id:'repo',head})
  backend.spaces.set(backend.spaces.get(dir)!.id,backend.spaces.get(dir)!)
  // Workspace resolution accepts the channel path and returns the canonical Hub identifier.
  const workspace=backend.workspace
  backend.workspace=vi.fn(async(id:string)=>id===dir?backend.spaces.get(dir)!:workspace(id))
  const teams=new TeamOrchestration(chat,new Catalog(),backend,usage,enabled)
  const plan=await teams.call('team_prepare',{session_key:master.key,objective:'Flota Hub',base_revision:head,members:members(1)},master.agent)
  const launched=await teams.call('team_launch',{session_key:master.key,plan_id:plan.id,digest:plan.digest,human_instruction:'Confirmo el plan editable de flota'},master.agent)
  return {master,backend,teams,plan,launched,slot:launched.members[0]}
}

it('prepara y lanza Hub sin metadatos Orca y vincula la incorporación por carpeta real',async()=>{
  const {master,backend,teams,plan,slot}=await hubTeam()
  expect(plan.plan.permissions).toBe('full_access')
  expect(plan.plan.planning_guidance).toContain('mezcla de CLI')
  const child=await hubSession('hub-worker',slot.workspace_path)
  const joined=await teams.call('team_join',{session_key:child.key,invitation:invitation(backend.prompts.get(slot.workspace_id)!)},child.agent)
  expect(joined.member_id).toBe(slot.id)
  expect(backend.bind).toHaveBeenCalledWith(slot.id,child.session.id)
  expect(master.agent.orca_workspace_id).toBeUndefined()
  expect(JSON.stringify(plan)).not.toContain('invitation=')
})

it('clear rota generación, identidad e invitación conservando worktree y CLI/modelo aprobados',async()=>{
  const {master,backend,teams,plan,slot}=await hubTeam()
  const oldToken=invitation(backend.prompts.get(slot.workspace_id)!)
  const child=await hubSession('first-worker',slot.workspace_path)
  await teams.call('team_join',{session_key:child.key,invitation:oldToken},child.agent)
  const control={session_key:master.key,plan_id:plan.id,member_id:slot.id,expected_generation:slot.runtime.generation}
  await teams.call('team_control',{...control,action:'edit',role:'QA',task:'Revisar cambio',prompt:'Validá la solución'},master.agent)
  const cleared=await teams.call('team_control',{...control,action:'clear'},master.agent)
  const next=cleared.members[0]
  expect(next).toMatchObject({workspace_id:slot.workspace_id,workspace_path:slot.workspace_path,role:'QA',task:'Revisar cambio',session_id:null,channel_id:null})
  expect(next.runtime.generation).not.toBe(slot.runtime.generation)
  expect(backend.stop).toHaveBeenCalledWith(slot.launch_handle)
  expect(backend.launch.mock.calls[1]![1]).toMatchObject({cli:slot.cli,model:slot.model,member_id:slot.id,resume_worktree:true})
  expect(backend.prompts.get(slot.workspace_id)).toContain('Validá la solución')
  const nextToken=invitation(backend.prompts.get(slot.workspace_id)!)
  expect(nextToken).not.toBe(oldToken)
  expect(JSON.stringify(cleared)).not.toContain(nextToken)
  await expect(teams.call('team_control',{...control,action:'send',text:'viejo'},master.agent)).rejects.toThrow('generación')
  await expect(teams.call('team_join',{session_key:child.key,invitation:oldToken},child.agent)).rejects.toThrow('Invitación')
})

it('serializa clear concurrentes y rechaza la segunda generación vencida',async()=>{
  const {master,backend,teams,plan,slot}=await hubTeam()
  const input={session_key:master.key,plan_id:plan.id,member_id:slot.id,expected_generation:slot.runtime.generation,action:'clear'}
  const results=await Promise.allSettled([teams.call('team_control',input,master.agent),teams.call('team_control',input,master.agent)])
  expect(results.map(item=>item.status)).toEqual(['fulfilled','rejected'])
  expect(backend.launch).toHaveBeenCalledTimes(2)
})

it('consulta sólo metadata, marca actividad vieja y no entrega outputs del backend',async()=>{
  const {master,backend,teams,plan,slot}=await hubTeam()
  backend.status.mockResolvedValue({...slot.runtime,state:'busy',updated_at:new Date(Date.now()-100_000).toISOString(),transcript:'PRIVATE'} as any)
  const status=await teams.call('team_status',{session_key:master.key,plan_id:plan.id},master.agent)
  expect(status.members[0].runtime).toMatchObject({generation:slot.runtime.generation,state:'unknown',activity_stale:true})
  expect(JSON.stringify(status)).not.toContain('PRIVATE')
  expect(backend.status).toHaveBeenCalledWith(slot.launch_handle)
})

it('revalida colaboración antes de efectos, permite stop/start y cierra sólo procesos Hub propios',async()=>{
  let enabled=true
  const {master,backend,teams,plan,slot}=await hubTeam(()=>enabled)
  const input={session_key:master.key,plan_id:plan.id,member_id:slot.id,expected_generation:slot.runtime.generation}
  enabled=false
  await expect(teams.call('team_control',{...input,action:'send',text:'Trabajo'},master.agent)).rejects.toThrow('deshabilitada')
  expect(backend.send).not.toHaveBeenCalled()
  enabled=true
  await teams.call('team_control',{...input,action:'interrupt'},master.agent)
  expect(backend.interrupt).toHaveBeenCalledWith(slot.launch_handle)
  await teams.call('team_control',{...input,action:'stop'},master.agent)
  const restarted=await teams.call('team_control',{...input,action:'start'},master.agent)
  expect(restarted.members[0].runtime.generation).not.toBe(slot.runtime.generation)
  await teams.call('team_close',{session_key:master.key,plan_id:plan.id,digest:plan.digest,reason:'Terminó'},master.agent)
  expect(backend.stop).toHaveBeenCalledWith(restarted.members[0].launch_handle)
  await expect(teams.call('team_control',{...input,expected_generation:restarted.members[0].runtime.generation,action:'send',text:'Trabajo'},master.agent)).rejects.toThrow('activo')
})

it('el reinicio de Hub conserva generación pero marca runtime desconocido sin relanzar',async()=>{
  const {backend,teams,slot}=await hubTeam()
  await teams.initialize()
  const persisted=(await db.query('SELECT runtime FROM chat_team_members WHERE id=$1',[slot.id]))[0]!
  expect(persisted.runtime).toMatchObject({generation:slot.runtime.generation,state:'unknown'})
  expect(backend.launch).toHaveBeenCalledTimes(1)
})

it('rechaza controles de participantes y cambios de modelo fuera de otro plan confirmado',async()=>{
  const {master,backend,teams,plan,slot}=await hubTeam()
  const child=await hubSession('unprivileged-worker',slot.workspace_path)
  await teams.call('team_join',{session_key:child.key,invitation:invitation(backend.prompts.get(slot.workspace_id)!)},child.agent)
  const input={plan_id:plan.id,member_id:slot.id,expected_generation:slot.runtime.generation}
  await expect(teams.call('team_control',{...input,session_key:child.key,action:'send',text:'Instrucción'},child.agent)).rejects.toThrow('pertenece')
  await expect(teams.call('team_control',{...input,session_key:master.key,action:'edit',model:'otro',task:'Cambio'},master.agent)).rejects.toThrow()
  expect(backend.send).not.toHaveBeenCalled()
})

it('revalida autoridad después de preflight y antes de detener o relanzar un worker',async()=>{
  let enabled=true
  const {master,backend,teams,plan,slot}=await hubTeam(()=>enabled)
  backend.preflight.mockImplementationOnce(async()=>{enabled=false})
  await expect(teams.call('team_control',{session_key:master.key,plan_id:plan.id,member_id:slot.id,
    expected_generation:slot.runtime.generation,action:'clear'},master.agent)).rejects.toThrow('deshabilitada')
  expect(backend.stop).not.toHaveBeenCalled()
  expect(backend.launch).toHaveBeenCalledTimes(1)
})

it('revoca acceso del participante a la conversación anterior después de clear',async()=>{
  const {master,backend,teams,plan,slot}=await hubTeam()
  const child=await hubSession('old-worker',slot.workspace_path)
  await teams.call('team_join',{session_key:child.key,invitation:invitation(backend.prompts.get(slot.workspace_id)!)},child.agent)
  await teams.call('team_control',{session_key:master.key,plan_id:plan.id,member_id:slot.id,
    expected_generation:slot.runtime.generation,action:'clear'},master.agent)
  await expect(teams.call('team_status',{session_key:child.key,plan_id:plan.id},child.agent)).rejects.toThrow('pertenece')
  const next=await hubSession('new-worker',slot.workspace_path)
  const joined=await teams.call('team_join',{session_key:next.key,invitation:invitation(backend.prompts.get(slot.workspace_id)!)},next.agent)
  expect(joined.session.id).toBe(next.session.id)
  expect(backend.bind).toHaveBeenLastCalledWith(slot.id,next.session.id)
})


it('conserva provider Hub al persistir recibos y status para que el backend reconozca su runtime',async()=>{
  const {master,backend,teams,plan,slot}=await hubTeam()
  const stored=async()=>(await db.query('SELECT runtime FROM chat_team_members WHERE id=$1',[slot.id]))[0]!.runtime
  expect(await stored()).toMatchObject({provider:'hub',generation:slot.runtime.generation})
  backend.status.mockImplementation(async()=>{
    const persisted=await stored()
    return persisted.provider==='hub'?persisted:undefined
  })
  const status=await teams.call('team_status',{session_key:master.key,plan_id:plan.id},master.agent)
  expect(status.members[0].runtime).toMatchObject({provider:'hub',state:'idle'})
  expect(await stored()).toMatchObject({provider:'hub',generation:slot.runtime.generation})
  await teams.call('team_control',{session_key:master.key,plan_id:plan.id,member_id:slot.id,
    expected_generation:slot.runtime.generation,action:'stop'},master.agent)
  expect(await stored()).toMatchObject({provider:'hub',state:'stopped'})
})


it('status no pisa un evento nativo posterior dentro de la misma generación',async()=>{
  const {master,backend,teams,plan,slot}=await hubTeam()
  const later={...slot.runtime,state:'busy',turn_id:'native-later-turn',updated_at:new Date().toISOString()}
  backend.status.mockImplementation(async()=>{
    await db.query('UPDATE chat_team_members SET runtime=$2 WHERE id=$1',[slot.id,JSON.stringify(later)])
    return {...slot.runtime,state:'idle'}
  })
  await teams.call('team_status',{session_key:master.key,plan_id:plan.id},master.agent)
  const stored=(await db.query('SELECT runtime FROM chat_team_members WHERE id=$1',[slot.id]))[0]!.runtime
  expect(stored).toMatchObject({state:'busy',turn_id:'native-later-turn',generation:slot.runtime.generation})
})

it('stop conserva unknown cuando el backend no confirma terminar el proceso',async()=>{
  const {master,backend,teams,plan,slot}=await hubTeam()
  backend.stop.mockImplementationOnce(async()=>{
    await db.query('UPDATE chat_team_members SET runtime=$2 WHERE id=$1',[slot.id,JSON.stringify({...slot.runtime,state:'unknown'})])
    return {...slot.runtime,state:'unknown'}
  })
  const result=await teams.call('team_control',{session_key:master.key,plan_id:plan.id,member_id:slot.id,
    expected_generation:slot.runtime.generation,action:'stop'},master.agent)
  expect(result.members[0].runtime.state).toBe('unknown')
})


it('autoriza nuevamente justo antes del spawn tras el preflight interno del backend',async()=>{
  let enabled=true,accepted=false
  const {master,backend,teams,plan,slot}=await hubTeam(()=>enabled)
  backend.launch.mockImplementationOnce(async(_workspace,member)=>{
    // Models the backend awaiting CLI/Git checks while the root collaboration gate changes.
    enabled=false
    await member.authorize?.()
    accepted=true
    throw new Error('No debe llegar al spawn')
  })
  await expect(teams.call('team_control',{session_key:master.key,plan_id:plan.id,member_id:slot.id,
    expected_generation:slot.runtime.generation,action:'clear'},master.agent)).rejects.toThrow('deshabilitada')
  expect(accepted).toBe(false)
})


it('revalida cuota si se agota durante los chequeos internos antes del spawn',async()=>{
  let exhausted=false,accepted=false
  const usage={forCli:vi.fn(async()=>({status:exhausted?'exhausted':'available',pools:[]}))}
  const {master,backend,teams,plan,slot}=await hubTeam(()=>true,usage)
  backend.launch.mockImplementationOnce(async(_workspace,member)=>{
    exhausted=true
    await member.authorize?.()
    accepted=true
    throw new Error('No debe llegar al spawn')
  })
  await expect(teams.call('team_control',{session_key:master.key,plan_id:plan.id,member_id:slot.id,
    expected_generation:slot.runtime.generation,action:'clear'},master.agent)).rejects.toThrow('cuota')
  expect(accepted).toBe(false)
})


it('no reemplaza un runtime cuyo apagado sigue desconocido ni adopta uno que perdió ownership',async()=>{
  const {master,backend,teams,plan,slot}=await hubTeam()
  const input={session_key:master.key,plan_id:plan.id,member_id:slot.id,expected_generation:slot.runtime.generation,action:'clear'}
  backend.stop.mockImplementationOnce(async()=>({...slot.runtime,state:'unknown'}))
  await expect(teams.call('team_control',input,master.agent)).rejects.toThrow('no se lanzará un reemplazo')
  expect(backend.launch).toHaveBeenCalledTimes(1)
  backend.stop.mockRejectedValueOnce(new Error('fleet_unknown_id'))
  await expect(teams.call('team_control',input,master.agent)).rejects.toThrow('ni se adoptarán procesos ajenos')
  expect(backend.launch).toHaveBeenCalledTimes(1)
  await db.query('UPDATE chat_team_members SET launch_handle=NULL,runtime=$2 WHERE id=$1',[slot.id,JSON.stringify({...slot.runtime,state:'unknown'})])
  await expect(teams.call('team_control',input,master.agent)).rejects.toThrow('proceso desconocido')
  expect(backend.launch).toHaveBeenCalledTimes(1)
})


async function waitingQuestion(team:Awaited<ReturnType<typeof hubTeam>>) {
  const questions=[{id:randomUUID(),questions:[{id:'choice',header:'Diseño',question:'¿Qué opción aplicar?',options:[{label:'A',description:'Cambio acotado'},{label:'B',description:'Refactor mayor'}]}]}]
  const runtime={...team.slot.runtime,state:'waiting_input',questions}
  team.backend.runtimes.set(team.slot.launch_handle,runtime)
  await db.query('UPDATE chat_team_members SET runtime=$2 WHERE id=$1',[team.slot.id,JSON.stringify(runtime)])
  return {runtime,questions,input:{session_key:team.master.key,plan_id:team.plan.id,member_id:team.slot.id,
    expected_generation:team.slot.runtime.generation,question_id:questions[0]!.id,answers:{choice:{answers:['A']}}}}
}

it('muestra preguntas nativas estructuradas y permite respuesta exacta sólo del master sin persistirla',async()=>{
  const team=await hubTeam(),pending=await waitingQuestion(team)
  const status=await team.teams.call('team_status',{session_key:team.master.key,plan_id:team.plan.id},team.master.agent)
  expect(status.members[0].runtime).toMatchObject({state:'waiting_input',questions:pending.questions})
  const secretAnswer='respuesta secreta sólo para el proceso'
  await team.teams.call('team_answer',{...pending.input,answers:{choice:{answers:[secretAnswer]}}},team.master.agent)
  expect(team.backend.answer).toHaveBeenCalledWith(team.slot.launch_handle,pending.input.question_id,{choice:{answers:[secretAnswer]}})
  const events=await db.query("SELECT payload FROM chat_team_events WHERE team_id=$1 AND type='answer'",[team.plan.id])
  expect(events).toHaveLength(1)
  expect(events[0]!.payload).toEqual({question_id:pending.input.question_id})
  expect(JSON.stringify(events)).not.toContain(secretAnswer)
  expect(JSON.stringify(await db.query('SELECT runtime FROM chat_team_members WHERE id=$1',[team.slot.id]))).not.toContain(secretAnswer)
  await expect(team.teams.call('team_answer',pending.input,team.master.agent)).rejects.toThrow('ya no está pendiente')
})

it('rechaza respuestas de otra generación, pregunta, sesión o estructura y estados desconocidos',async()=>{
  const team=await hubTeam(),pending=await waitingQuestion(team)
  const call=(patch:Record<string,unknown>)=>team.teams.call('team_answer',{...pending.input,...patch},team.master.agent)
  await expect(call({expected_generation:randomUUID()})).rejects.toThrow('generación')
  await expect(call({question_id:randomUUID()})).rejects.toThrow('ya no está pendiente')
  await expect(call({answers:{other:{answers:['A']}}})).rejects.toThrow('exactamente')
  await expect(call({method:'turn/start'})).rejects.toThrow()
  const child=await hubSession('answer-worker',team.slot.workspace_path)
  await expect(team.teams.call('team_answer',{...pending.input,session_key:child.key},child.agent)).rejects.toThrow('pertenece')
  team.backend.status.mockResolvedValueOnce({...pending.runtime,state:'unknown'})
  await expect(call({})).rejects.toThrow('desconocido')
  expect(team.backend.answer).not.toHaveBeenCalled()
})

it('revalida autoridad tras consultar la pregunta y antes de enviar la respuesta nativa',async()=>{
  let enabled=true
  const team=await hubTeam(()=>enabled),pending=await waitingQuestion(team)
  team.backend.status.mockImplementationOnce(async()=>{enabled=false;return pending.runtime})
  await expect(team.teams.call('team_answer',pending.input,team.master.agent)).rejects.toThrow('deshabilitada')
  expect(team.backend.answer).not.toHaveBeenCalled()
})

it('el bootstrap de workers exige join primero y enruta dudas al master por Hub',async()=>{
  const team=await hubTeam()
  const prompt=team.backend.prompts.get(team.slot.workspace_id)!
  expect(prompt).toContain('Primero usá memory_team_join')
  expect(prompt).toContain(`root_thread_id=${team.plan.root_thread_id}`)
  expect(prompt).toContain(`master_session_id=${team.master.session.id}`)
  expect(prompt).toContain('No abras preguntas directas a la persona')
})


it('responde preguntas nativas no bloqueantes cuyo turno sigue busy',async()=>{
  const team=await hubTeam(),pending=await waitingQuestion(team)
  const nonblocking={...pending.runtime,state:'busy'}
  team.backend.runtimes.set(team.slot.launch_handle,nonblocking)
  await db.query('UPDATE chat_team_members SET runtime=$2 WHERE id=$1',[team.slot.id,JSON.stringify(nonblocking)])
  await team.teams.call('team_answer',pending.input,team.master.agent)
  expect(team.backend.answer).toHaveBeenCalledWith(team.slot.launch_handle,pending.input.question_id,pending.input.answers)
})


it('conserva y responde hasta 32 requests nativas pendientes sin descartar el conjunto',async()=>{
  const team=await hubTeam(),pending=await waitingQuestion(team)
  const questions=Array.from({length:32},(_,index)=>({id:randomUUID(),questions:[{id:'choice',header:'Diseño',question:`Pregunta ${index+1}`}]}))
  const runtime={...pending.runtime,questions}
  team.backend.runtimes.set(team.slot.launch_handle,runtime)
  await db.query('UPDATE chat_team_members SET runtime=$2 WHERE id=$1',[team.slot.id,JSON.stringify(runtime)])
  const status=await team.teams.call('team_status',{session_key:team.master.key,plan_id:team.plan.id},team.master.agent)
  expect(status.members[0].runtime.questions).toEqual(questions)
  await team.teams.call('team_answer',{...pending.input,question_id:questions[31]!.id},team.master.agent)
  expect(team.backend.answer).toHaveBeenCalledWith(team.slot.launch_handle,questions[31]!.id,pending.input.answers)
})

it('impide operar la flota con una identidad pendiente de elegir nick',async()=>{
  const master=await session('unnamed-master'),orca=new Orca(),catalog=new Catalog()
  await db.query('UPDATE chat_sessions SET nickname=NULL,nickname_key=NULL WHERE id=$1',[master.session.id])
  const teams=new TeamOrchestration(chat,catalog,orca)
  await expect(teams.call('team_prepare',{session_key:master.key,objective:'Sin nombre',base_revision:head,members:members(1)},master.agent)).rejects.toMatchObject({statusCode:409})
  expect(orca.create).not.toHaveBeenCalled();expect(orca.launch).not.toHaveBeenCalled()
})
