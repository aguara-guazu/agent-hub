import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { z } from 'zod'
import { check, parse } from './contracts.js'
import type { AgentContext } from './agents.js'
import type { LocalChat } from './local-chat.js'
import { hash } from './store.js'
import type { Sql } from './database.js'
import type { ExtractionCli } from './cli-extraction.js'
import type { UsageQuotas } from './usage-quotas.js'

export interface TeamCatalog {
  catalog(): Promise<unknown>
  validate(cli: ExtractionCli, model: string, effort?: string): Promise<unknown>
}
export interface TeamWorkspace { id: string; path: string; repo_id: string; head: string }
export interface TeamLaunchReceipt { handle: string; kind: string; operation_id?: string; prompt_outcome: string }
export interface TeamOrca {
  preflight?(members:Array<{cli:ExtractionCli;model:string;effort?:string}>):Promise<void>
  workspace(id: string): Promise<TeamWorkspace>
  create(parent: TeamWorkspace, name: string): Promise<TeamWorkspace>
  launch(workspace: TeamWorkspace, member: { cli: ExtractionCli; model: string; effort?: string; prompt: string }): Promise<TeamLaunchReceipt>
}

const session = { session_key: z.string().min(32).max(200).optional() }
const identifier = z.string().uuid()
const revision = z.string().regex(/^[a-f0-9]{40,64}$/i)
const cli = z.enum(['kiro','claude_code','codex_cli'])
const member = z.object({
  worktree_name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  cli,
  model: z.string().trim().min(1).max(300),
  effort: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).optional(),
  role: z.string().trim().min(1).max(200),
  task: z.string().trim().min(1).max(2000),
  prompt: z.string().trim().min(1).max(16000),
}).strict()
const prepareInput = z.object({ ...session, objective:z.string().trim().min(1).max(2000), base_revision:revision,
  members:z.array(member).min(1).max(20) }).strict().refine(value=>new Set(value.members.map(item=>item.worktree_name)).size===value.members.length,
    'Cada miembro necesita un nombre de worktree distinto')
const launchInput = z.object({ ...session, plan_id:identifier, digest:z.string().length(64).regex(/^[a-f0-9]+$/),
  human_instruction:z.string().trim().min(1).max(4000) }).strict()
const statusInput = z.object({ ...session, plan_id:identifier }).strict()
const joinInput = z.object({ ...session, invitation:z.string().min(32).max(500) }).strict()
const closeInput = z.object({ ...session, plan_id:identifier, digest:z.string().length(64).regex(/^[a-f0-9]+$/),
  reason:z.string().trim().min(1).max(1000) }).strict()

export const teamDefinitions = {
  team_catalog: ['Consultar el catálogo real de CLI, modelos, esfuerzos y capacidades de lanzamiento. Un modelo listado no prueba cuota ni acceso.', z.object(session).strict()],
  team_prepare: ['Preparar como líder activo de un worktree Orca un plan inmutable de equipo. No crea worktrees ni agentes y devuelve el digest exacto para la elección de la persona.', prepareInput],
  team_launch: ['Lanzar el plan exacto elegido por la persona. Requiere plan_id, digest sin cambios y referencia textual a la instrucción humana declarada por el líder; conserva permisos nativos y nunca degrada modelo o esfuerzo.', launchInput],
  team_status: ['Consultar plan, efectos persistidos, incorporaciones y resultados inciertos sin exponer invitaciones ni claves.', statusInput],
  team_join: ['Consumir una invitación de equipo de un solo uso desde el worktree y la CLI asignados. Conserva la session_key, canal y liderazgo propios.', joinInput],
  team_close: ['Cerrar como líder el plan exacto, revocar invitaciones, ACL y entregas pendientes. Conserva procesos, worktrees, recibos e historial; no hace rollback destructivo.', closeInput],
} satisfies Record<string,[string,z.ZodType]>
export const teamReadOperations = ['team_catalog','team_status']

const invitationHash = (token:string) => createHash('sha256').update(token).digest('hex')
const activePlan = (state:string) => !['paused','cancelled','completed'].includes(state)
const publicError = (phase:'workspace'|'launch') => phase==='workspace'
  ? 'No se confirmó la creación del worktree. El resultado es incierto; inspeccioná Orca antes de continuar.'
  : 'No se confirmó el lanzamiento del agente. El resultado es incierto; reconciliá el recibo antes de continuar.'

export class TeamOrchestration {
  private recovery?:Promise<void>
  constructor(readonly chat:LocalChat, private readonly catalog:TeamCatalog, private readonly orca:TeamOrca,
    private readonly usage?:Pick<UsageQuotas,'forCli'>) {}
  private get db() { return this.chat.db }

  async call(operation:string, raw:unknown, agent?:AgentContext):Promise<any> {
    const definition=teamDefinitions[operation as keyof typeof teamDefinitions]
    check(definition,'Operación de equipo inexistente',404)
    const input=parse(definition[1] as z.ZodType,raw ?? {}) as any
    const who=await this.chat.identity(agent,input.session_key)
    check(!who.closed_at,'La sesión de colaboración está cerrada',403)
    if(operation==='team_catalog')return this.catalogView(who)
    if(operation==='team_prepare')return this.prepare(input,who)
    if(operation==='team_launch')return this.launch(input,who)
    if(operation==='team_status')return this.status(input.plan_id,who)
    if(operation==='team_join')return this.join(input.invitation,who,agent!)
    if(operation==='team_close')return this.close(input,who)
    throw new Error('unreachable')
  }

  private async catalogView(who:Record<string,any>) {
    const value=await this.catalog.catalog(),channel=(await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[who.channel_id]))[0]
    let launch_context:{orca_workspace_id:string|null;available:boolean;reason?:string}={orca_workspace_id:channel?.orca_workspace_id ?? null,available:false,
      reason:'Esta sesión no pertenece a un worktree Orca activo.'}
    if(channel?.orca_workspace_id && !channel.closed_at) {
      try {
        const workspace=await this.orca.workspace(channel.orca_workspace_id)
        launch_context=workspace.id===channel.orca_workspace_id ? {orca_workspace_id:workspace.id,available:true}
          : {orca_workspace_id:channel.orca_workspace_id,available:false,reason:'Orca devolvió otro worktree.'}
      } catch {launch_context={orca_workspace_id:channel.orca_workspace_id,available:false,reason:'Orca no confirmó este worktree; el catálogo sigue disponible.'}}
    }
    if(!value || typeof value!=='object' || Array.isArray(value))return {catalog:value,launch_context}
    const catalog=value as Record<string,any>
    const clis=await Promise.all((Array.isArray(catalog.clis)?catalog.clis:[]).map(async(entry:Record<string,any>)=>{
      if(!entry.launchable)return entry
      if(!launch_context.available)return {...entry,launchable:false,launch_reason:launch_context.reason}
      const model=Array.isArray(catalog.models)?catalog.models.find((item:Record<string,any>)=>item.cli===entry.id):undefined
      if(!model || !['kiro','claude_code','codex_cli'].includes(entry.id))return {...entry,launchable:false,launch_reason:'No hay un modelo seleccionable para esta CLI.'}
      try {
        await this.orca.preflight?.([{cli:entry.id as ExtractionCli,model:model.id}])
        return entry
      } catch {return {...entry,launchable:false,launch_reason:'El adaptador no confirmó los requisitos de lanzamiento de esta CLI en la plataforma actual.'}}
    }))
    const models=await Promise.all((Array.isArray(catalog.models)?catalog.models:[]).map(async(model:Record<string,any>)=>({
      ...model,usage:await this.quota(model.cli,model.id)})))
    return {...catalog,clis,models,launch_context}
  }

  private quota(cli:string,model:string) {
    return this.usage?.forCli(cli,model) ?? Promise.resolve({status:'unknown' as const,reason:'no_observation',pools:[]})
  }
  private async checkQuota(members:Record<string,any>[]) {
    for(const item of members) {
      const usage=await this.quota(item.cli,item.model)
      check(!['exhausted','cooldown'].includes(usage.status),
        `La cuota observada de ${item.cli} / ${item.model} impide lanzar ahora. Consultá usage_status para revisar ventana y reinicio; el plan conserva sus worktrees y recibos.`,409)
    }
  }

  private async master(who:Record<string,any>) {
    const channel=(await this.db.query(`SELECT c.* FROM chat_channels c JOIN chat_sessions s ON s.id=$1 AND s.channel_id=c.id
      WHERE c.id=$2 AND s.closed_at IS NULL AND s.removed_at IS NULL`,[who.id,who.channel_id]))[0]
    check(channel && !channel.closed_at && channel.orca_workspace_id && channel.leader_id===who.id,
      'Sólo el líder activo de un worktree Orca puede preparar o lanzar equipos',403)
    return channel
  }

  private async validateMembers(members:Record<string,any>[],who:Record<string,any>) {
    const validated=[]
    for(const item of members) {
      await this.master(who)
      validated.push(await this.catalog.validate(item.cli,item.model,item.effort))
    }
    return validated
  }

  private async preflight(members:Record<string,any>[],who:Record<string,any>) {
    if(!this.orca.preflight)return
    await this.master(who)
    await this.orca.preflight(members.map(item=>({cli:item.cli,model:item.model,...(item.effort?{effort:item.effort}:{})})))
    await this.master(who)
  }

  private async prepare(input:z.infer<typeof prepareInput>,who:Record<string,any>) {
    const channel=await this.master(who)
    const parent=await this.orca.workspace(channel.orca_workspace_id)
    await this.master(who)
    check(parent.id===channel.orca_workspace_id && parent.head===input.base_revision,
      'El worktree master o su revisión no coinciden con la propuesta',409)
    await this.master(who)
    const catalog=await this.catalog.catalog()
    await this.master(who)
    const validations=await this.validateMembers(input.members,who)
    await this.preflight(input.members,who)
    const planId=randomUUID(),members=input.members.map((item,index)=>({id:randomUUID(),ordinal:index,...item,capabilities:validations[index]}))
    const usage=await Promise.all(input.members.map(async item=>({worktree_name:item.worktree_name,cli:item.cli,model:item.model,...await this.quota(item.cli,item.model)})))
    const document={schema_version:1,id:planId,objective:input.objective,master_channel_id:channel.id,created_by:who.id,
      parent,base_revision:input.base_revision,catalog,members,usage,
      usage_guidance:'Observación de cuotas, no reserva ni garantía de terminar. Unknown o datos vencidos requieren planificar con incertidumbre; varios agentes comparten saldo.'}
    const digest=hash(document)
    return this.db.transaction(async sql=>{
      const root=(await sql.query('INSERT INTO chat_threads(id,channel_id,title,created_by) VALUES($1,$2,$3,$4) RETURNING *',
        [randomUUID(),channel.id,`Equipo: ${input.objective.slice(0,180)}`,who.id]))[0]!
      await sql.query(`INSERT INTO chat_team_plans(id,master_channel_id,root_thread_id,created_by,objective,parent,base_revision,plan,digest,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'prepared')`,[planId,channel.id,root.id,who.id,input.objective,JSON.stringify(parent),input.base_revision,JSON.stringify(document),digest])
      for(const item of members)await sql.query(`INSERT INTO chat_team_members(id,team_id,ordinal,worktree_name,cli,model,effort,role,task,prompt,capabilities,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'prepared')`,[item.id,planId,item.ordinal,item.worktree_name,item.cli,item.model,item.effort ?? null,item.role,item.task,item.prompt,JSON.stringify(item.capabilities ?? null)])
      await this.event(sql,planId,null,'prepared',who.id,channel.id,root.id,{digest})
      return this.view(planId,who,sql)
    })
  }

  private async launch(input:z.infer<typeof launchInput>,who:Record<string,any>) {
    await this.master(who)
    const plan=(await this.db.query('SELECT * FROM chat_team_plans WHERE id=$1',[input.plan_id]))[0]
    check(plan && plan.created_by===who.id && plan.master_channel_id===who.channel_id,'El plan no pertenece a este líder',403)
    check(plan.digest===input.digest,'El digest no coincide con el plan inmutable elegido',409)
    if(plan.state!=='prepared')return this.view(plan.id,who)
    const document=plan.plan as Record<string,any>,parent=plan.parent as TeamWorkspace
    await this.validateMembers(document.members,who)
    await this.preflight(document.members,who)
    await this.checkQuota(document.members)
    await this.master(who)
    const current=await this.orca.workspace(parent.id)
    await this.master(who)
    check(current.id===parent.id && current.repo_id===parent.repo_id && current.path===parent.path && current.head===plan.base_revision,
      'El worktree master cambió desde la propuesta; prepará y elegí un plan nuevo',409)
    const claimed=await this.db.transaction(async sql=>{
      const rows=await sql.query(`UPDATE chat_team_plans SET state='launching',human_instruction=$3,launched_by=$2,launch_started_at=now(),updated_at=now()
        WHERE id=$1 AND state='prepared' RETURNING id`,[plan.id,who.id,input.human_instruction])
      if(rows.length)await this.event(sql,plan.id,null,'launching',who.id,who.channel_id,plan.root_thread_id,{digest:plan.digest})
      return rows.length>0
    })
    if(!claimed)return this.view(plan.id,who)
    const members=await this.db.query('SELECT * FROM chat_team_members WHERE team_id=$1 ORDER BY ordinal,id',[plan.id])
    try {
      for(const item of members)if(!await this.launchMember(plan,item,parent,who))break
    } catch(error) {
      // Authority can disappear while Orca is working. Preserve every receipt,
      // revoke pending invitations and do not leave a stopped run "launching".
      await this.db.transaction(async sql=>{
        await sql.query("UPDATE chat_team_plans SET state='paused',updated_at=now() WHERE id=$1 AND state='launching'",[plan.id])
        await sql.query('UPDATE chat_team_members SET invitation_hash=NULL,invitation_expires_at=NULL WHERE team_id=$1',[plan.id])
      })
      throw error
    }
    await this.refreshPlan(plan.id)
    return this.view(plan.id,who)
  }

  private async launchActive(plan:Record<string,any>,who:Record<string,any>) {
    await this.master(who)
    return Boolean((await this.db.query("SELECT id FROM chat_team_plans WHERE id=$1 AND state='launching' AND created_by=$2",[plan.id,who.id]))[0])
  }

  private recoveryReceipt(error:unknown) {
    const safe=(value:unknown) => typeof value==='string' && value.length>0 && value.length<=4000 ? value : undefined
    return {operation_id:safe((error as {operation_id?:unknown})?.operation_id),launch_handle:safe((error as {launch_handle?:unknown})?.launch_handle)}
  }

  private async launchMember(plan:Record<string,any>,member:Record<string,any>,parent:TeamWorkspace,who:Record<string,any>):Promise<boolean> {
    if(!await this.launchActive(plan,who))return false
    await this.checkQuota([member])
    const token=randomBytes(32).toString('base64url'),expires=new Date(Date.now()+30*60_000).toISOString()
    const intent=await this.db.query(`UPDATE chat_team_members SET state='workspace_intent',invitation_hash=$2,invitation_expires_at=$3,updated_at=now()
      WHERE id=$1 AND state='prepared' AND EXISTS(SELECT 1 FROM chat_team_plans t WHERE t.id=team_id AND t.state='launching') RETURNING id`,
      [member.id,invitationHash(token),expires])
    if(!intent.length)return false
    await this.event(this.db,plan.id,member.id,'workspace_intent',who.id,who.channel_id,plan.root_thread_id,{worktree_name:member.worktree_name})
    if(!await this.launchActive(plan,who))return false
    let workspace:TeamWorkspace
    try {
      workspace=await this.orca.create(parent,member.worktree_name)
      check(workspace.repo_id===parent.repo_id && workspace.head===plan.base_revision && workspace.id!==parent.id,
        'Orca devolvió un worktree hijo distinto del plan',502)
    } catch(error) {await this.unknown(plan,member,'workspace',who,error);return true}
    await this.db.query(`UPDATE chat_team_members SET state=CASE WHEN state='closed' THEN state ELSE 'workspace_created' END,
      workspace_id=$2,workspace_path=$3,workspace_repo_id=$4,workspace_head=$5,updated_at=now() WHERE id=$1`,
      [member.id,workspace.id,workspace.path,workspace.repo_id,workspace.head])
    await this.event(this.db,plan.id,member.id,'workspace_created',who.id,who.channel_id,plan.root_thread_id,{workspace_id:workspace.id,head:workspace.head})
    if(!await this.launchActive(plan,who))return false
    await this.checkQuota([member])
    const launching=await this.db.query(`UPDATE chat_team_members SET state='launch_intent',updated_at=now() WHERE id=$1 AND state='workspace_created'
      AND EXISTS(SELECT 1 FROM chat_team_plans t WHERE t.id=team_id AND t.state='launching') RETURNING id`,[member.id])
    if(!launching.length)return false
    const prompt=`${member.prompt}

Agent Hub: incorporación autorizada al equipo ${plan.id}. Conservá tu identidad y canal. Usá memory_team_join con invitation=${token}. La invitación vence y se consume una sola vez.`
    let receipt:TeamLaunchReceipt
    try {receipt=await this.orca.launch(workspace,{cli:member.cli,model:member.model,...(member.effort?{effort:member.effort}:{}),prompt})}
    catch(error) {await this.unknown(plan,member,'launch',who,error);return true}
    await this.db.query(`UPDATE chat_team_members SET state=CASE WHEN state IN ('joined','closed') THEN state ELSE 'accepted' END,
      launch_handle=$2,launch_kind=$3,operation_id=$4,prompt_outcome=$5,error=NULL,updated_at=now() WHERE id=$1`,
      [member.id,receipt.handle,receipt.kind,receipt.operation_id ?? null,receipt.prompt_outcome])
    await this.event(this.db,plan.id,member.id,'launch_receipt',who.id,who.channel_id,plan.root_thread_id,
      {kind:receipt.kind,prompt_outcome:receipt.prompt_outcome,operation_id:receipt.operation_id ?? null})
    return true
  }

  private async unknown(plan:Record<string,any>,member:Record<string,any>,phase:'workspace'|'launch',who:Record<string,any>,cause:unknown) {
    const error=publicError(phase),receipt=this.recoveryReceipt(cause)
    await this.db.query(`UPDATE chat_team_members SET state=CASE WHEN state IN ('joined','closed') THEN state ELSE 'unknown' END,
      error=$2,operation_id=COALESCE($3,operation_id),launch_handle=COALESCE($4,launch_handle),updated_at=now() WHERE id=$1`,
      [member.id,error,receipt.operation_id ?? null,receipt.launch_handle ?? null])
    await this.event(this.db,plan.id,member.id,'unknown',who.id,who.channel_id,plan.root_thread_id,{phase,...receipt})
  }

  private async refreshPlan(planId:string) {
    const states=(await this.db.query('SELECT state,count(*) AS count FROM chat_team_members WHERE team_id=$1 GROUP BY state',[planId]))
    const count=(state:string)=>Number(states.find(item=>item.state===state)?.count ?? 0)
    const total=states.reduce((sum,item)=>sum+Number(item.count),0),accepted=count('accepted')+count('joined'),unknown=count('unknown')
    const state=accepted===total?'launched':accepted>0?'partial':unknown>0?'uncertain':'launching'
    await this.db.query("UPDATE chat_team_plans SET state=$2,launched_at=now(),updated_at=now() WHERE id=$1 AND state='launching'",[planId,state])
  }

  private async close(input:z.infer<typeof closeInput>,who:Record<string,any>) {
    await this.master(who)
    const plan=(await this.db.query('SELECT * FROM chat_team_plans WHERE id=$1',[input.plan_id]))[0]
    check(plan && plan.created_by===who.id && plan.master_channel_id===who.channel_id,'El plan no pertenece a este líder',403)
    check(plan.digest===input.digest,'El digest no coincide con el plan inmutable',409)
    return this.db.transaction(async sql=>{
      const changed=await sql.query(`UPDATE chat_team_plans SET state='cancelled',close_reason=$3,closed_at=now(),updated_at=now()
        WHERE id=$1 AND created_by=$2 AND state NOT IN ('cancelled','completed') RETURNING id`,[plan.id,who.id,input.reason])
      if(changed.length) {
        await sql.query(`UPDATE chat_team_members SET state=CASE WHEN state='joined' THEN state ELSE 'closed' END,
          invitation_hash=NULL,invitation_expires_at=NULL,updated_at=now() WHERE team_id=$1`,[plan.id])
        await sql.query(`UPDATE chat_deliveries SET cancelled_at=now(),error='Equipo cerrado por su líder' WHERE handled_at IS NULL AND cancelled_at IS NULL
          AND message_id IN (SELECT id FROM chat_messages WHERE thread_id=$1)`,[plan.root_thread_id])
        await this.event(sql,plan.id,null,'cancelled',who.id,who.channel_id,plan.root_thread_id,{reason:input.reason})
      }
      return this.view(plan.id,who,sql)
    })
  }

  /** Called once by the daemon owner before exposing chat or notifications. Worker services must not recover live launches. */
  initialize() {
    this.recovery ??= this.db.transaction(async sql=>{
      await sql.query(`UPDATE chat_team_members SET state='unknown',error='El Hub se reinició con un efecto pendiente; reconciliá Orca antes de continuar.',updated_at=now()
        WHERE state IN ('workspace_intent','workspace_created','launch_intent')`)
      await sql.query(`UPDATE chat_deliveries SET cancelled_at=now(),error='Equipo pausado tras reinicio' WHERE handled_at IS NULL AND cancelled_at IS NULL
        AND message_id IN (SELECT m.id FROM chat_messages m JOIN chat_team_plans t ON t.root_thread_id=m.thread_id WHERE t.state='launching')`)
      await sql.query(`UPDATE chat_team_members SET invitation_hash=NULL,invitation_expires_at=NULL
        WHERE team_id IN (SELECT id FROM chat_team_plans WHERE state='launching')`)
      await sql.query("UPDATE chat_team_plans SET state='paused',updated_at=now() WHERE state='launching'")
    })
    return this.recovery
  }

  private async join(token:string,who:Record<string,any>,agent:AgentContext) {
    const digest=invitationHash(token),member=(await this.db.query(`SELECT m.*,t.digest,t.state AS team_state,t.master_channel_id,t.root_thread_id,t.created_by
      FROM chat_team_members m JOIN chat_team_plans t ON t.id=m.team_id WHERE m.invitation_hash=$1`,[digest]))[0]
    check(member && !member.invitation_used_at && Date.parse(member.invitation_expires_at)>Date.now(),'Invitación inexistente, vencida o ya consumida',409)
    check(activePlan(member.team_state) && ['accepted','launch_intent','unknown'].includes(member.state),'El equipo no admite incorporaciones en este estado',409)
    check(member.cli===agent.cli_kind,'La invitación pertenece a otra CLI',403)
    check(agent.orca_workspace_id===member.workspace_id,'La identidad Orca no coincide con el worktree asignado',403)
    const channel=(await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[who.channel_id]))[0]
    check(channel && !channel.closed_at && channel.orca_workspace_id===member.workspace_id,'La invitación pertenece a otro worktree de Orca',403)
    const actual=await realpath(agent.cwd ?? '').catch(()=>null),expected=await realpath(member.workspace_path).catch(()=>null)
    check(actual && expected && actual===expected,'La sesión no está en la carpeta real del worktree asignado',403)
    return this.db.transaction(async sql=>{
      const current=(await sql.query(`SELECT m.id,t.state AS team_state,master.leader_id,leader.closed_at AS leader_closed,leader.removed_at AS leader_removed
        FROM chat_team_members m JOIN chat_team_plans t ON t.id=m.team_id JOIN chat_channels master ON master.id=t.master_channel_id
        JOIN chat_sessions leader ON leader.id=t.created_by
        JOIN chat_sessions participant ON participant.id=$3
        JOIN chat_channels child ON child.id=participant.channel_id
        WHERE m.id=$1 AND m.invitation_hash=$2 AND m.invitation_used_at IS NULL AND m.invitation_expires_at>now()
        AND master.closed_at IS NULL AND participant.closed_at IS NULL AND participant.removed_at IS NULL
        AND child.closed_at IS NULL AND child.orca_workspace_id=m.workspace_id`,[member.id,digest,who.id]))[0]
      check(current && activePlan(current.team_state) && current.leader_id===member.created_by && !current.leader_closed && !current.leader_removed,
        'El líder master o el equipo ya no están vigentes',409)
      const used=await sql.query(`UPDATE chat_team_members SET state='joined',invitation_used_at=now(),invitation_hash=NULL,session_id=$2,channel_id=$3,updated_at=now()
        WHERE id=$1 AND invitation_used_at IS NULL AND invitation_hash=$4 RETURNING *`,[member.id,who.id,who.channel_id,digest])
      check(used.length,'La invitación ya fue consumida',409)
      await this.event(sql,member.team_id,member.id,'joined',who.id,who.channel_id,member.root_thread_id,{})
      return {team_id:member.team_id,member_id:member.id,root_thread_id:member.root_thread_id,master_channel_id:member.master_channel_id,
        master_session_id:member.created_by,session:{id:who.id,channel_id:who.channel_id},state:'joined',
        guidance:'El master coordina desde root_thread_id. El líder de tu canal hijo conserva su rol local y no reemplaza al master.'}
    })
  }

  private async status(planId:string,who:Record<string,any>,sql:Sql=this.db) {
    const plan=(await sql.query('SELECT * FROM chat_team_plans WHERE id=$1',[planId]))[0]
    check(plan,'Plan de equipo inexistente',404)
    const allowed=plan.created_by===who.id || (await sql.query("SELECT id FROM chat_team_members WHERE team_id=$1 AND session_id=$2 AND state='joined'",[planId,who.id])).length>0
    check(allowed,'La sesión no pertenece a este equipo',403)
    return this.view(planId,who,sql)
  }

  private async view(planId:string,who:Record<string,any>,sql:Sql=this.db) {
    const plan=(await sql.query('SELECT * FROM chat_team_plans WHERE id=$1',[planId]))[0]
    check(plan,'Plan de equipo inexistente',404)
    check(plan.created_by===who.id || (await sql.query("SELECT id FROM chat_team_members WHERE team_id=$1 AND session_id=$2 AND state='joined'",[planId,who.id])).length>0,
      'La sesión no pertenece a este equipo',403)
    const members=await sql.query(`SELECT id,ordinal,worktree_name,cli,model,effort,role,task,capabilities,state,workspace_id,workspace_path,workspace_repo_id,workspace_head,
      launch_handle,launch_kind,operation_id,prompt_outcome,error,invitation_expires_at,invitation_used_at,session_id,channel_id,created_at,updated_at
      FROM chat_team_members WHERE team_id=$1 ORDER BY ordinal,id`,[planId])
    return {id:plan.id,digest:plan.digest,objective:plan.objective,state:plan.state,master_channel_id:plan.master_channel_id,
      root_thread_id:plan.root_thread_id,created_by:plan.created_by,parent:plan.parent,base_revision:plan.base_revision,plan:plan.plan,
      launch:{started_at:plan.launch_started_at,accepted_at:plan.launched_at,instruction_declared:Boolean(plan.human_instruction)},
      close:{at:plan.closed_at,reason:plan.close_reason},members}
  }

  private async event(sql:Sql,teamId:string,memberId:string|null,type:string,
    actor:string,sourceChannel:string,targetThread:string,payload:Record<string,unknown>) {
    await sql.query(`INSERT INTO chat_team_events(id,team_id,member_id,type,actor_session_id,source_channel_id,target_thread_id,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),teamId,memberId,type,actor,sourceChannel,targetThread,JSON.stringify(payload)])
  }
}
