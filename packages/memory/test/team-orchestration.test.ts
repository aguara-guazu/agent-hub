import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { mkdtemp,mkdir,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryService } from '../src/service.js'
import { LocalChat } from '../src/local-chat.js'
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

beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'hub-team-'));db=new MemoryDatabase(join(dir,'memory.sqlite'));await db.migrate();store=new MemoryStore(db,dir);chat=new LocalChat(store)})
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
  expect((await chat.call('chat_work_list',{session_key:master.key,thread_id:prepared.root_thread_id},master.agent)).items[0].session_id).toBe(child.session.id)
  await expect(chat.call('chat_work_list',{session_key:sameChannel.key,thread_id:prepared.root_thread_id},sameChannel.agent)).rejects.toMatchObject({statusCode:403})
  const linkedVersion=(await chat.call('chat_inbox',{session_key:child.key},child.agent)).team.guidance_version
  const outsider=await session('outsider')
  await expect(chat.call('chat_send',{session_key:outsider.key,thread_id:prepared.root_thread_id,text:'Intrusión',request_id:'outsider'},outsider.agent)).rejects.toMatchObject({statusCode:403})
  await expect(chat.call('chat_send',{session_key:master.key,thread_id:prepared.root_thread_id,text:'Mención ajena',mentions:[outsider.session.id],request_id:'outsider-mention'},master.agent)).rejects.toMatchObject({statusCode:400})
  await teams.call('team_close',{session_key:master.key,plan_id:prepared.id,digest:prepared.digest,reason:'Fin del equipo'},master.agent)
  expect((await db.query('SELECT cancelled_at FROM chat_deliveries WHERE message_id=$1',[report.id]))[0].cancelled_at).toBeTruthy()
  const closedContext=(await chat.call('chat_inbox',{session_key:child.key},child.agent)).team
  expect(closedContext.linked_team).toBeNull()
  expect(closedContext.guidance_version).not.toBe(linkedVersion)
  await expect(chat.call('chat_work_update',{...work,request_id:'after-close',expected_version:1,event:'progress'},child.agent)).rejects.toMatchObject({statusCode:403})
  await expect(chat.call('chat_work_list',{session_key:child.key,thread_id:prepared.root_thread_id},child.agent)).rejects.toMatchObject({statusCode:403})
  await expect(chat.call('chat_send',{session_key:child.key,thread_id:prepared.root_thread_id,text:'Después del cierre',request_id:'closed-team'},child.agent)).rejects.toMatchObject({statusCode:403})
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
  const backup=JSON.parse(await readBackup(store,(await exportMemory(store)).id));expect(backup.schema_version).toBe(13)
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
