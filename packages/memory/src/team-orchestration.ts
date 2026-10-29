import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { check, parse, MemoryError } from './contracts.js'
import type { AgentContext } from './agents.js'
import type { LocalChat } from './local-chat.js'
import { hash } from './store.js'
import { deriveStandingPlan, DERIVED_APPROVAL_SOURCE, type ApprovedItem, type StoredDelegation } from './project-automation.js'
import type { Sql } from './database.js'
import type { ExtractionCli } from './cli-extraction.js'
import type { UsageQuotas } from './usage-quotas.js'

export interface TeamCatalog {
  catalog(): Promise<unknown>
  validate(cli: ExtractionCli, model: string, effort?: string): Promise<unknown>
}
import type { TeamWorkspace, TeamLaunchReceipt, TeamOrca, TeamRuntimeMetadata, TeamPendingQuestion, ActionProfile } from './team-orca.js'
export type { TeamWorkspace, TeamLaunchReceipt, TeamOrca, TeamRuntimeMetadata, TeamPendingQuestion, ActionProfile } from './team-orca.js'

/** Authenticated follow-up persisted by the decision store: one line of the reply, tied to an approved item's project, with its receipt, source and expiry. */
export interface DerivedFollowUp { project_id: string; ordinal: number; text: string; ref: string; source: 'channel_reply' | 'owner_ui'; expires_at: string }
export type FollowUpClaimResult = 'claimed' | 'already_claimed_by_same' | 'already_claimed_by_other' | 'not_found' | 'authority_unavailable'
/** Port to the private decision store and the run-profile issuer (area B). Only ids, kinds, digests and public summaries cross it, never approval codes. */
export interface DerivedPorts {
  approved(requestId: string): Promise<{ canonical_digest: string; items: Array<ApprovedItem & { state: string }>; follow_ups: DerivedFollowUp[] }>
  /** True only while the request is not revoked, superseded or expired and its artifact authority is verified and live. Anything else denies. */
  live(requestId: string): Promise<boolean>
  /** Consumes the project's follow-up once per (request, project); the same consumer may repeat the claim. Denies without live authority. */
  claimFollowUp(requestId: string, projectId: string, consumerRef: string): Promise<FollowUpClaimResult>
  /** Issues the `action` run identity for one member generation. Absent port or runtime means derived plans cannot launch. */
  actionProfile?(member: { plan_id: string; member_id: string; project_id: string; delegation_version: number }): Promise<ActionProfile>
  /** Revokes every principal handle issued for the plan; called on cancellation even when the stop of a process is uncertain. */
  revokeProfiles?(planId: string): Promise<void>
  automationsEnabled(): boolean
  ownerId(): string
}
const APPROVED_ITEM_STATES = ['approved', 'dispatching', 'succeeded']
const STOP_UNCONFIRMED = 'stop_unconfirmed'
const TERMINAL_RUNTIME = ['stopped', 'exited', 'failed']
/** A derived plan whose workers may still be running or whose stop was never confirmed keeps its slot and stays visible to later closes, whatever its logical state. */
const HOLDS_PROCESS = `EXISTS(SELECT 1 FROM chat_team_members m WHERE m.team_id=chat_team_plans.id AND m.launch_handle IS NOT NULL
  AND (m.error='${STOP_UNCONFIRMED}' OR COALESCE(json_extract(m.runtime,'$.state'),'unknown') NOT IN (${TERMINAL_RUNTIME.map(state=>`'${state}'`).join(',')})))`
const OPEN_DERIVED = `delegation_project_id IS NOT NULL AND (state NOT IN ('paused','cancelled','completed') OR ${HOLDS_PROCESS})`
const asObject = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value

const session = { session_key: z.string().min(32).max(200).optional() }
const identifier = z.string().uuid()
const revision = z.union([z.string().regex(/^[a-f0-9]{40,64}$/i),z.literal('virtual')])
const cli = z.enum(['kiro','claude_code','codex_cli'])
const member = z.object({
  worktree_name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  cli,
  model: z.string().trim().min(1).max(300),
  effort: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).optional(),
  rationale: z.string().trim().min(1).max(2000).optional(),
  role: z.string().trim().min(1).max(200),
  task: z.string().trim().min(1).max(2000),
  prompt: z.string().trim().min(1).max(16000),
}).strict()
const prepareInput = z.object({ ...session, objective:z.string().trim().min(1).max(2000), task_key:z.string().trim().min(1).max(200).optional(), base_revision:revision.optional(), repository_path:z.string().min(1).max(4000).optional(),
  members:z.array(member).min(1).max(20) }).strict().refine(value=>new Set(value.members.map(item=>item.worktree_name)).size===value.members.length,
    'Cada miembro necesita un nombre de worktree distinto')
const launchInput = z.object({ ...session, plan_id:identifier, digest:z.string().length(64).regex(/^[a-f0-9]+$/),
  human_instruction:z.string().trim().min(1).max(4000) }).strict()
const statusInput = z.object({ ...session, plan_id:identifier }).strict()
const joinInput = z.object({ ...session, invitation:z.string().min(32).max(500) }).strict()
const closeInput = z.object({ ...session, plan_id:identifier, digest:z.string().length(64).regex(/^[a-f0-9]+$/),
  reason:z.string().trim().min(1).max(1000) }).strict()

const questionSchema=z.object({id:z.string().min(1).max(200),header:z.string().max(300),question:z.string().min(1).max(8000),
  isOther:z.boolean().optional(),isSecret:z.boolean().optional(),options:z.array(z.object({label:z.string().max(500),description:z.string().max(2000)}).strict()).max(30).nullable().optional()}).strict()
const pendingQuestions=z.array(z.object({id:z.string().min(1).max(200),questions:z.array(questionSchema).min(1).max(20)}).strict()).max(32)
const answerInput=z.object({...session,plan_id:identifier,member_id:identifier,expected_generation:identifier,
  question_id:z.string().min(1).max(200),answers:z.record(z.string().min(1).max(200),z.object({answers:z.array(z.string().min(1).max(8000)).min(1).max(30)}).strict())
    .refine(value=>Object.keys(value).length>0 && Object.keys(value).length<=20,'Una respuesta requiere entre 1 y 20 preguntas'),
}).strict()
const controlInput = z.object({ ...session, plan_id:identifier, member_id:identifier, expected_generation:z.union([identifier,z.literal('none')]),
  action:z.enum(['start','stop','interrupt','send','clear','edit']), text:z.string().trim().min(1).max(16000).optional(),
  role:member.shape.role.optional(), task:member.shape.task.optional(), prompt:member.shape.prompt.optional(),
}).strict().superRefine((value,context)=>{
  if(value.action==='send' && !value.text)context.addIssue({code:'custom',message:'send requiere text'})
  if(value.action==='edit' && !value.role && !value.task && !value.prompt)context.addIssue({code:'custom',message:'edit requiere role, task o prompt'})
  if(value.action!=='edit' && (value.role || value.task || value.prompt))context.addIssue({code:'custom',message:'Los cambios de configuración requieren edit'})
  if(value.action!=='send' && value.text)context.addIssue({code:'custom',message:'text sólo se admite con send'})
})

export const teamDefinitions = {
  team_catalog: ['Comprobar preparación del equipo antes de investigar el ticket: identidad coordinadora, espacio Git o virtual, CLI y modelos. Devuelve readiness con bloqueos y acciones, y preferred_backend. repository_path permite elegir otro repositorio sin cambiar de sesión. Un modelo listado no prueba cuota ni acceso.', z.object({...session,repository_path:z.string().min(1).max(4000).optional()}).strict()],
  team_prepare: ['Preparar un plan inmutable. task_key etiqueta la tarea y conserva el canal y su coordinador. Requiere un canal activo creado con chat_create_channel(task_key,name) tras preguntar a la persona y obtener su autorización; preparar nunca crea ni activa canales. repository_path selecciona el repositorio de los trabajadores; base_revision admite el hash completo de cualquier commit local del repositorio, aunque difiera de HEAD; omitido usa HEAD o virtual. Proponer el plan editable y confirmar el plan exacto antes de lanzar. No crea procesos ni worktrees.', prepareInput],
  team_launch: ['Lanzar el plan exacto elegido por la persona. Requiere plan_id, digest sin cambios y referencia textual a la instrucción humana declarada por el líder; conserva permisos nativos y nunca degrada modelo o esfuerzo.', launchInput],
  team_answer: ['Responder como líder vigente una pregunta nativa pendiente de un worker Hub del plan activo. Requiere generación y question_id actuales; answers mapea los IDs de preguntas a {answers:[texto]}. Resolver con el contexto disponible o consultar a la persona y después responder al worker. Las respuestas no se guardan en eventos ni se envían a otro proceso.',answerInput],
  team_control: ['Controlar un miembro Hub del plan aprobado: start, stop, interrupt, send, clear o edit de role/task/prompt. Requiere la generación actual. clear inicia una conversación nueva conservando worktree; cambiar CLI/modelo exige preparar y confirmar otro plan. Devuelve sólo metadatos, nunca terminal, logs ni transcripciones.', controlInput],
  team_status: ['Consultar plan, efectos persistidos, incorporaciones y resultados inciertos sin exponer invitaciones ni claves.', statusInput],
  team_join: ['Consumir una invitación de equipo de un solo uso desde el worktree y la CLI asignados. Conserva la session_key, canal y liderazgo propios.', joinInput],
  team_close: ['Cerrar como líder el plan exacto, revocar invitaciones, ACL y entregas pendientes. Detiene los workers propios del Hub; conserva procesos Orca, worktrees, recibos e historial; no hace rollback destructivo.', closeInput],
} satisfies Record<string,[string,z.ZodType]>
export const teamReadOperations = ['team_catalog','team_status']

const invitationHash = (token:string) => createHash('sha256').update(token).digest('hex')
const activePlan = (state:string) => !['paused','cancelled','completed'].includes(state)
const publicError = (phase:'workspace'|'launch') => phase==='workspace'
  ? 'No se confirmó la creación del worktree. El resultado es incierto; inspeccioná el worktree antes de continuar.'
  : 'No se confirmó el lanzamiento del agente. El resultado es incierto; reconciliá el recibo antes de continuar.'

export class TeamOrchestration {
  private recovery?:Promise<void>
  private readonly memberOperations=new Map<string,Promise<unknown>>()
  constructor(readonly chat:LocalChat, private readonly catalog:TeamCatalog, private readonly orca:TeamOrca,
    private readonly usage?:Pick<UsageQuotas,'forCli'>, private readonly collaborationEnabled:()=>boolean=()=>true) {}
  private get db() { return this.chat.db }
  private derived?: DerivedPorts
  /** Wired once by the service owner; without it launchDerived is unavailable. */
  attachAutomation(ports: DerivedPorts) { this.derived = ports }
  /** True only when a derived plan could launch right now: ports attached, a Hub runtime that applies the action profile and an issuer for it. */
  derivedAvailable() { return Boolean(this.derived?.actionProfile && this.orca.provider==='hub' && this.orca.supportsProfiles && this.collaborationEnabled()) }

  async call(operation:string, raw:unknown, agent?:AgentContext):Promise<any> {
    const definition=teamDefinitions[operation as keyof typeof teamDefinitions]
    check(definition,'Operación de equipo inexistente',404)
    const input=parse(definition[1] as z.ZodType,raw ?? {}) as any
    check(agent,'Sólo los agentes pueden participar en equipos',403)
    const who=await this.chat.requireNickname(agent,input.session_key)
    check(!who.closed_at,'La sesión de colaboración está cerrada',403)
    if(!teamReadOperations.includes(operation)) {
      check(this.collaborationEnabled(),'La colaboración está deshabilitada',403)
      check(who.nickname?.trim(),'Elegí tu propio nick con chat_set_nick antes de participar.',409)
    }
    if(operation==='team_catalog')return this.catalogView(who,input.repository_path)
    if(operation==='team_prepare')return this.prepare(input,who)
    if(operation==='team_launch')return this.launch(input,who)
    if(operation==='team_status')return this.status(input.plan_id,who)
    if(operation==='team_join')return this.join(input.invitation,who,agent!)
    if(operation==='team_answer')return this.answer(input,who)
    if(operation==='team_control')return this.control(input,who)
    if(operation==='team_close')return this.close(input,who)
    throw new Error('unreachable')
  }

  private async catalogView(who:Record<string,any>,repositoryPath?:string) {
    const value=await this.catalog.catalog(),channel=(await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[who.channel_id]))[0]
    const blockers:Array<{code:string;message:string;next_action:string}>=[]
    const leader=channel?.leader_id ? (await this.db.query('SELECT closed_at,lease_until FROM chat_sessions WHERE id=$1',[channel.leader_id]))[0] : null
    const leaderOffline=!!leader && (Boolean(leader.closed_at) || !(Date.parse(leader.lease_until)>Date.now()))
    const canActivate=channel?.kind==='virtual' && !channel.activated_at && !channel.closed_at
    if(channel?.leader_id!==who.id && !canActivate)blockers.push({code:'coordinator_required',
      message:leaderOffline?'El coordinador reconocido está desconectado; esta sesión es miembro.':'Esta sesión no es la coordinadora reconocida.',next_action:'La persona puede designar esta sesión desde Colaboración → Agentes → Designar coordinador.'})
    if(canActivate)blockers.push({code:'channel_required',message:'La sesión no tiene un canal activo.',next_action:'Preguntá a la persona si autoriza crear un canal y, tras su confirmación, usá memory_chat_create_channel(task_key, name).'})
    let workspace:TeamWorkspace|undefined
    try {
      check(channel && !channel.closed_at,'El canal está cerrado.',409)
      workspace=await this.orca.workspace(repositoryPath ?? this.parentId(channel))
      check(repositoryPath || (this.orca.provider==='hub'?workspace.path===await realpath(channel.path):workspace.id===channel.orca_workspace_id),'El backend devolvió otro espacio de trabajo.',409)
    } catch(error) {
      blockers.push({code:'workspace_unavailable',message:error instanceof MemoryError ? error.message:'No se pudo consultar el espacio de trabajo.',
        next_action:'Verificá la ruta o indicá repository_path. Una carpeta local sin Git admite un espacio virtual.'})
    }
    const taskChannelAvailable=Boolean(channel && !channel.closed_at)
    if(taskChannelAvailable) {
      const blocker=blockers.find(item=>item.code==='coordinator_required')
      if(blocker)blocker.next_action='Para un equipo nuevo, pedí autorización a la persona y creá su canal con memory_chat_create_channel(task_key, name). Para continuar en el canal existente, la persona puede designar coordinador desde la UI.'
    }
    const launch_context={provider:this.orca.provider ?? 'orca',orca_workspace_id:this.orca.provider==='hub'?null:workspace?.id ?? channel?.orca_workspace_id ?? null,
      workspace_id:workspace?.id ?? null,workspace:workspace ?? null,available:!!workspace && blockers.length===0,
      reason:blockers.map(item=>item.message).join(' ') || undefined}
    const preference=await this.preference()
    const context={...launch_context,readiness:{ready:launch_context.available,blockers,activation_required:canActivate,
      task_channel_available:taskChannelAvailable,
      ...(taskChannelAvailable?{next_action:'Preguntá a la persona antes de crear un canal con memory_chat_create_channel(session_key, task_key, name). La carpeta o el worktree no definen el canal.'}:{}),
      coordinator_id:channel?.leader_id ?? null,coordinator_offline:leaderOffline},preferred_backend:preference}
    if(!value || typeof value!=='object' || Array.isArray(value))return {catalog:value,launch_context:context}
    const catalog=value as Record<string,any>
    const clis=await Promise.all((Array.isArray(catalog.clis)?catalog.clis:[]).map(async(entry:Record<string,any>)=>{
      if(!entry.launchable)return entry
      if(!launch_context.available)return {...entry,launchable:false,launch_reason:launch_context.reason}
      const model=Array.isArray(catalog.models)?catalog.models.find((item:Record<string,any>)=>item.cli===entry.id):undefined
      if(!model || !['kiro','claude_code','codex_cli'].includes(entry.id))return {...entry,launchable:false,launch_reason:'No hay un modelo seleccionable para esta CLI.'}
      try {
        await this.orca.preflight?.([{cli:entry.id as ExtractionCli,model:model.id}])
        return entry
      } catch(error) {return {...entry,launchable:false,launch_reason:error instanceof MemoryError ? error.message:'El adaptador no confirmó los requisitos de lanzamiento de esta CLI en la plataforma actual.'}}
    }))
    const models=await Promise.all((Array.isArray(catalog.models)?catalog.models:[]).map(async(model:Record<string,any>)=>({
      ...model,usage:await this.quota(model.cli,model.id,who)})))
    if(context.available && !clis.some(entry=>entry.launchable)) {
      blockers.push({code:'launcher_unavailable',message:'Ninguna CLI confirmó los requisitos de lanzamiento.',next_action:'Revisá launch_reason de las CLI y su instalación.'})
      context.available=false;context.readiness.ready=false
      context.reason=blockers.map(item=>item.message).join(' ')
    }
    return {...catalog,clis,models,launch_context:context}
  }

  async humanPlan(planId:string) {
    const plan=(await this.db.query('SELECT * FROM chat_team_plans WHERE id=$1',[planId]))[0]
    check(plan,'Plan inexistente.',404)
    const who=(await this.db.query('SELECT * FROM chat_sessions WHERE id=$1',[plan.created_by]))[0]
    check(who,'La sesión coordinadora no existe.',409)
    return this.view(planId,who)
  }
  async approveByHuman(planId:string,digest:string,userId:string) {
    const plan=(await this.db.query('SELECT * FROM chat_team_plans WHERE id=$1',[planId]))[0]
    check(plan,'Plan inexistente.',404)
    const who=(await this.db.query('SELECT * FROM chat_sessions WHERE id=$1',[plan.created_by]))[0]
    check(who && !who.closed_at && !who.removed_at,'La sesión coordinadora no está disponible.',409)
    return this.launch({plan_id:planId,digest,human_instruction:`Plan ${planId} con digest ${digest} aprobado desde la UI por ${userId}`},who,userId)
  }
  async stopTransferredPlans(planIds:string[]) {
    const uncertain:string[]=[]
    if(this.orca.provider==='hub')for(const planId of planIds) {
      const members=await this.db.query('SELECT id,launch_handle FROM chat_team_members WHERE team_id=$1',[planId])
      for(const member of members)if(member.launch_handle)await this.serial(member.id,async()=>{
        try {
          const receipt=await this.orca.stop?.(member.launch_handle)
          check(receipt && typeof receipt==='object' && ['stopped','failed'].includes(String((receipt as {state?:string}).state)),'Detención no confirmada.',409)
          await this.updateRuntime(member.id,{state:'stopped'})
        }
        catch {uncertain.push(member.id);await this.updateRuntime(member.id,{state:'unknown'})}
      })
    }
    return {uncertain_members:uncertain}
  }
  async preference():Promise<'hub'|'native'> {
    const row=(await this.db.query("SELECT value FROM settings WHERE key='team_backend'"))[0]
    return row?.value==='native'?'native':'hub'
  }
  async setPreference(value:'hub'|'native') {
    await this.db.query("INSERT INTO settings(key,value) VALUES('team_backend',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify(value)])
    return {preferred_backend:value}
  }
  private quota(cli:string,model:string,who:Record<string,any>) {
    if(!this.chat.usageEnabled(who.agent_id))return Promise.resolve({status:'unknown' as const,reason:'disabled',pools:[]})
    return this.usage?.forCli(cli,model) ?? Promise.resolve({status:'unknown' as const,reason:'no_observation',pools:[]})
  }
  private async checkQuota(members:Record<string,any>[],who:Record<string,any>) {
    for(const item of members) {
      const usage=await this.quota(item.cli,item.model,who)
      check(!['exhausted','cooldown'].includes(usage.status),
        `La cuota observada de ${item.cli} / ${item.model} impide lanzar ahora. Consultá usage_status para revisar ventana y reinicio; el plan conserva sus worktrees y recibos.`,409)
    }
  }

  private parentId(channel:Record<string,any>) { return this.orca.provider==='hub'?channel.path:channel.orca_workspace_id }

  private async master(who:Record<string,any>) {
    const channel=(await this.db.query(`SELECT c.* FROM chat_channels c JOIN chat_sessions s ON s.id=$1 AND s.channel_id=c.id
      WHERE c.id=$2 AND s.closed_at IS NULL AND s.removed_at IS NULL`,[who.id,who.channel_id]))[0]
    check(this.collaborationEnabled(),'La colaboración está deshabilitada',403)
    check(channel && !channel.closed_at && (this.orca.provider==='hub'?channel.path:channel.orca_workspace_id) && channel.leader_id===who.id,
      'Sólo el líder activo del canal master puede controlar equipos',403)
    // A member of a derived plan cannot lead its own child channel into a nested team: the delegation fixes the roster.
    check(!(await this.db.query(`SELECT 1 FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id
      WHERE m.session_id=$1 AND m.state<>'closed' AND p.delegation_project_id IS NOT NULL LIMIT 1`,[who.id])).length,
      'Los miembros de un plan derivado no administran equipos.',403)
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
    check(!input.repository_path || this.orca.provider==='hub','Elegir repositorio requiere el runtime Hub.',409)
    const parent=await this.orca.workspace(input.repository_path ?? this.parentId(channel))
    await this.master(who)
    check(input.repository_path || (this.orca.provider==='hub'?parent.path===await realpath(channel.path):parent.id===channel.orca_workspace_id),
      'El espacio o su revisión no coinciden con la propuesta; consultá team_catalog.',409)
    const baseRevision=await this.resolveBase(parent,input.base_revision ?? parent.head)
    if(parent.kind==='virtual')await this.db.query("UPDATE chat_channels SET kind='virtual',activated_at=COALESCE(activated_at,now()) WHERE id=$1",[channel.id])
    await this.master(who)
    const catalog=await this.catalog.catalog()
    await this.master(who)
    const validations=await this.validateMembers(input.members,who)
    await this.preflight(input.members,who)
    const planId=randomUUID(),members=input.members.map((item,index)=>({id:randomUUID(),ordinal:index,...item,capabilities:validations[index]}))
    const usage=await Promise.all(input.members.map(async item=>({worktree_name:item.worktree_name,cli:item.cli,model:item.model,...await this.quota(item.cli,item.model,who)})))
    const document={schema_version:1,id:planId,objective:input.objective,...(input.task_key?{task_key:input.task_key}:{}),master_channel_id:channel.id,created_by:who.id,
      parent,base_revision:baseRevision,catalog,members,usage,
      permissions:this.orca.provider==='hub'?'full_access':'native',
      planning_guidance:'Proponer una mezcla de CLI cuando haya cuotas frescas disponibles y modelos adecuados. Explicar la idoneidad de cada modelo, presentar el plan editable y esperar elección y confirmación humana. Unknown no confirma disponibilidad.',
      usage_guidance:'Observación de cuotas, no reserva ni garantía de terminar. Unknown o datos vencidos requieren planificar con incertidumbre; varios agentes comparten saldo.'}
    const digest=hash(document)
    return this.db.transaction(async sql=>{
      const root=(await sql.query('INSERT INTO chat_threads(id,channel_id,title,created_by) VALUES($1,$2,$3,$4) RETURNING *',
        [randomUUID(),channel.id,`Equipo: ${channel.scope_key?.startsWith('task:') ? channel.name : input.task_key ?? input.objective.slice(0,80)}`,who.id]))[0]!
      await sql.query(`INSERT INTO chat_team_plans(id,master_channel_id,root_thread_id,created_by,objective,parent,base_revision,plan,digest,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'prepared')`,[planId,channel.id,root.id,who.id,input.objective,JSON.stringify(parent),baseRevision,JSON.stringify(document),digest])
      for(const item of members) {
        await sql.query(`INSERT INTO chat_threads(id,channel_id,title,created_by,team_root_thread_id) VALUES($1,$2,$3,$4,$5)`,
          [item.id,channel.id,item.worktree_name,who.id,root.id])
        await sql.query(`INSERT INTO chat_team_members(id,team_id,ordinal,worktree_name,cli,model,effort,role,task,prompt,capabilities,state,work_thread_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'prepared',$1)`,[item.id,planId,item.ordinal,item.worktree_name,item.cli,item.model,item.effort ?? null,item.role,item.task,item.prompt,JSON.stringify(item.capabilities ?? null)])
      }
      await this.event(sql,planId,null,'prepared',who.id,channel.id,root.id,{digest})
      return this.view(planId,who,sql)
    })
  }

  private async resolveBase(parent:TeamWorkspace,base:string) {
    if(this.orca.baseRevision)return this.orca.baseRevision(parent,base)
    check(base===parent.head,'Este backend sólo admite el HEAD del padre; elegí el runtime Hub para usar otro commit como base.',409)
    return base
  }

  private async launch(input:z.infer<typeof launchInput>,who:Record<string,any>,ownerId?:string,provenance?:{source:string;userId:string}) {
    await this.master(who)
    const plan=(await this.db.query('SELECT * FROM chat_team_plans WHERE id=$1',[input.plan_id]))[0]
    check(plan && plan.created_by===who.id && plan.master_channel_id===who.channel_id,'El plan no pertenece a este líder',403)
    check(plan.digest===input.digest,'El digest no coincide con el plan inmutable elegido',409)
    if(plan.state!=='prepared')return this.view(plan.id,who)
    const document=plan.plan as Record<string,any>,parent=plan.parent as TeamWorkspace
    await this.validateMembers(document.members,who)
    await this.preflight(document.members,who)
    await this.checkQuota(document.members,who)
    await this.master(who)
    const current=await this.orca.workspace(parent.id)
    await this.master(who)
    check(current.id===parent.id && current.repo_id===parent.repo_id && current.path===parent.path && current.head===parent.head,
      'El worktree master cambió desde la propuesta; prepará y elegí un plan nuevo',409)
    await this.resolveBase(current,plan.base_revision)
    const claimed=await this.db.transaction(async sql=>{
      const rows=await sql.query(`UPDATE chat_team_plans SET state='launching',human_instruction=$3,launched_by=$2,launch_started_at=now(),updated_at=now(),approval_source=$4,approved_by_user_id=$5
        WHERE id=$1 AND state='prepared' RETURNING id`,[plan.id,who.id,input.human_instruction,provenance?.source ?? (ownerId?'owner_ui':'coordinator_declaration'),provenance?.userId ?? ownerId ?? null])
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
    await this.checkQuota([member],who)
    if(plan.delegation_project_id)await this.assertDerivedLaunchable(plan)
    const token=randomBytes(32).toString('base64url'),expires=new Date(Date.now()+30*60_000).toISOString()
    const intent=await this.db.query(`UPDATE chat_team_members SET state='workspace_intent',invitation_hash=$2,invitation_expires_at=$3,updated_at=now()
      WHERE id=$1 AND state='prepared' AND EXISTS(SELECT 1 FROM chat_team_plans t WHERE t.id=team_id AND t.state='launching') RETURNING id`,
      [member.id,invitationHash(token),expires])
    if(!intent.length)return false
    await this.event(this.db,plan.id,member.id,'workspace_intent',who.id,who.channel_id,plan.root_thread_id,{worktree_name:member.worktree_name})
    if(!await this.launchActive(plan,who))return false
    let workspace:TeamWorkspace
    try {
      workspace=plan.base_revision===parent.head ? await this.orca.create(parent,member.worktree_name)
        : await this.orca.create(parent,member.worktree_name,plan.base_revision)
      check(workspace.repo_id===parent.repo_id && workspace.head===plan.base_revision && workspace.id!==parent.id,
        'El backend devolvió un worktree hijo distinto del plan',502)
    } catch(error) {await this.unknown(plan,member,'workspace',who,error);return true}
    await this.db.query(`UPDATE chat_team_members SET state=CASE WHEN state='closed' THEN state ELSE 'workspace_created' END,
      workspace_id=$2,workspace_path=$3,workspace_repo_id=$4,workspace_head=$5,updated_at=now() WHERE id=$1`,
      [member.id,workspace.id,workspace.path,workspace.repo_id,workspace.head])
    await this.event(this.db,plan.id,member.id,'workspace_created',who.id,who.channel_id,plan.root_thread_id,{workspace_id:workspace.id,head:workspace.head})
    if(!await this.launchActive(plan,who))return false
    await this.checkQuota([member],who)
    const launching=await this.db.query(`UPDATE chat_team_members SET state='launch_intent',updated_at=now() WHERE id=$1 AND state='workspace_created'
      AND EXISTS(SELECT 1 FROM chat_team_plans t WHERE t.id=team_id AND t.state='launching') RETURNING id`,[member.id])
    if(!launching.length)return false
    if(!await this.launchActive(plan,who))return false
    const prompt=this.workerPrompt(token)
    let receipt:TeamLaunchReceipt
    try {
      const profile=plan.delegation_project_id?await this.derivedProfile(plan,member):undefined
      receipt=await this.orca.launch(workspace,{member_id:member.id,...(profile?{profile}:{}),authorize:async()=>{
      await this.checkQuota([member],who)
      if(plan.delegation_project_id)await this.assertDelegationCurrent(plan.delegation_project_id,plan.delegation_version)
      check(await this.launchActive(plan,who),'El equipo ya no admite este lanzamiento',409)
      const current=(await this.db.query('SELECT state,invitation_hash,runtime FROM chat_team_members WHERE id=$1 AND team_id=$2',[member.id,plan.id]))[0]
      check(current?.state==='launch_intent' && current.invitation_hash===invitationHash(token)
        && (current.runtime?.generation ?? 'none')===(member.runtime?.generation ?? 'none'),'El miembro cambió antes del lanzamiento',409)
    },cli:member.cli,model:member.model,...(member.effort?{effort:member.effort}:{}),prompt})}
    catch(error) {await this.unknown(plan,member,'launch',who,error);return true}
    await this.db.query(`UPDATE chat_team_members SET state=CASE WHEN state IN ('joined','closed') THEN state ELSE 'accepted' END,
      launch_handle=$2,launch_kind=$3,operation_id=$4,prompt_outcome=$5,error=NULL,updated_at=now() WHERE id=$1`,
      [member.id,receipt.handle,receipt.kind,receipt.operation_id ?? null,receipt.prompt_outcome])
    if(this.orca.provider==='hub') {
      await this.setRuntime(member.id,receipt.runtime ?? {generation:randomUUID(),state:'unknown',updated_at:new Date().toISOString()})
      let active=false
      try {active=await this.launchActive(plan,who)} catch { /* lost authority while the process was starting */ }
      if(!active) {
        await this.orca.stop?.(receipt.handle)
        await this.updateRuntime(member.id,{state:'stopped'})
        return false
      }
    }
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
    const {view}=await this.cancelPlan(plan,input.reason,who)
    return view
  }

  /**
   * Logical cancellation first (invitations, deliveries), then the stop of every owned process. The plan stays cancelled even when a stop
   * cannot be confirmed; the member is then marked `stop_unconfirmed` so later closes and the capacity count still see it.
   */
  private async cancelPlan(plan:Record<string,any>,reason:string,who:Record<string,any>) {
    const view=await this.db.transaction(async sql=>{
      const changed=await sql.query(`UPDATE chat_team_plans SET state='cancelled',close_reason=$3,closed_at=now(),updated_at=now()
        WHERE id=$1 AND created_by=$2 AND state NOT IN ('cancelled','completed') RETURNING id`,[plan.id,who.id,reason])
      if(changed.length) {
        await sql.query(`UPDATE chat_team_members SET state=CASE WHEN state='joined' THEN state ELSE 'closed' END,
          invitation_hash=NULL,invitation_expires_at=NULL,updated_at=now() WHERE team_id=$1`,[plan.id])
        await sql.query(`UPDATE chat_deliveries SET cancelled_at=now(),error='Equipo cerrado por su líder' WHERE handled_at IS NULL AND cancelled_at IS NULL
          AND message_id IN (SELECT m.id FROM chat_messages m JOIN chat_threads h ON h.id=m.thread_id
            WHERE h.id=$1 OR h.team_root_thread_id=$1)`,[plan.root_thread_id])
        await this.chat.cancelInvalidTurnAlerts()
        await this.event(sql,plan.id,null,'cancelled',who.id,who.channel_id ?? plan.master_channel_id,plan.root_thread_id,{reason})
      }
      return this.view(plan.id,who,sql)
    })
    let revoked=true
    if(plan.delegation_project_id && this.derived?.revokeProfiles) {
      try {await this.derived.revokeProfiles(plan.id)} catch {
        revoked=false
        await this.event(this.db,plan.id,null,'profile_revocation_failed',who.id,plan.master_channel_id,plan.root_thread_id,{}).catch(()=>undefined)
      }
    }
    const stop=await this.stopMembers(plan,who)
    return {view:this.orca.provider==='hub'?await this.view(plan.id,who):view,uncertain:stop.uncertain,revoked}
  }

  /** A stop counts only with a receipt from this handle in a terminal state; a missing `stop`, a throw or any other answer leaves the member uncertain. */
  private async stopMembers(plan:Record<string,any>,who:Record<string,any>) {
    const confirmed:string[]=[],uncertain:string[]=[]
    if(this.orca.provider!=='hub')return {confirmed,uncertain}
    const members=await this.db.query('SELECT id,launch_handle,error,runtime FROM chat_team_members WHERE team_id=$1',[plan.id])
    for(const item of members)await this.serial(item.id,async()=>{
      if(!item.launch_handle)return
      let receipt:unknown
      try {
        check(this.orca.stop,'El backend no permite detener el worker.',409)
        receipt=await this.orca.stop(item.launch_handle)
      } catch {receipt=undefined}
      const value=receipt as {id?:unknown;state?:unknown}|undefined
      const ok=Boolean(value && typeof value==='object' && TERMINAL_RUNTIME.includes(String(value.state)) && (value.id===undefined || value.id===item.launch_handle))
      const generation=item.runtime?.generation ?? null
      if(ok) {
        confirmed.push(item.id)
        if(item.error===STOP_UNCONFIRMED) {
          await this.db.query('UPDATE chat_team_members SET error=NULL,updated_at=now() WHERE id=$1',[item.id])
          await this.event(this.db,plan.id,item.id,'stop_confirmed',who.id,plan.master_channel_id,plan.root_thread_id,{generation})
        }
        return
      }
      uncertain.push(item.id)
      await this.db.query('UPDATE chat_team_members SET error=$2,updated_at=now() WHERE id=$1',[item.id,STOP_UNCONFIRMED])
      await this.event(this.db,plan.id,item.id,'stop_unconfirmed',who.id,plan.master_channel_id,plan.root_thread_id,{generation})
    })
    return {confirmed,uncertain}
  }

  /** Called once by the daemon owner before exposing chat or notifications. Worker services must not recover live launches. */
  initialize() {
    this.recovery ??= this.db.transaction(async sql=>{
      if(this.orca.provider==='hub')await sql.query(`UPDATE chat_team_members SET runtime=json_patch(runtime,'{"state":"unknown"}') WHERE runtime IS NOT NULL`)
      await sql.query(`UPDATE chat_team_members SET state='unknown',error='El Hub se reinició con un efecto pendiente; reconciliá el backend antes de continuar.',updated_at=now()
        WHERE state IN ('workspace_intent','workspace_created','launch_intent')`)
      await sql.query(`UPDATE chat_deliveries SET cancelled_at=now(),error='Equipo pausado tras reinicio' WHERE handled_at IS NULL AND cancelled_at IS NULL
        AND message_id IN (SELECT m.id FROM chat_messages m JOIN chat_threads h ON h.id=m.thread_id
          JOIN chat_team_plans t ON t.root_thread_id=COALESCE(h.team_root_thread_id,h.id) WHERE t.state='launching')`)
      await sql.query(`UPDATE chat_team_members SET invitation_hash=NULL,invitation_expires_at=NULL
        WHERE team_id IN (SELECT id FROM chat_team_plans WHERE state='launching')`)
      await sql.query("UPDATE chat_team_plans SET state='paused',updated_at=now() WHERE state='launching'")
    })
    return this.recovery
  }

  /**
   * Single gate for a derived plan's authority: the automations switch, the unrevoked delegation version, the open channel the person authorized, and
   * the hub_system leader of the automation channel with its authorized name and workspace. Run at insert, authorize, every spawn and start/clear.
   */
  private async assertDelegationCurrent(projectId:string,version:number,sql:Sql=this.db) {
    check(this.derived?.automationsEnabled(),'Las automatizaciones están deshabilitadas.',409)
    const row=(await sql.query(`SELECT a.enabled,a.delegation_version,a.channel_id,a.coordinator_session_id,d.document,d.digest,d.revoked_at
      FROM project_automation a JOIN project_delegations d ON d.project_id=a.project_id AND d.version=a.delegation_version WHERE a.project_id=$1`,[projectId]))[0]
    check(row?.enabled && row.delegation_version===version && !row.revoked_at && row.coordinator_session_id,'La delegación del proyecto no está vigente.',409)
    await this.assertAutomationChannel(sql,projectId,row)
    return row
  }

  private async assertAutomationChannel(sql:Sql,projectId:string,row:Record<string,any>) {
    const delegation=asObject(row.document) as StoredDelegation
    check(delegation.channel,'La delegación no autoriza un canal de automatización; sin él no hay coordinador ni planes derivados.',409)
    const source=row.channel_id?(await sql.query('SELECT id FROM chat_channels WHERE id=$1 AND closed_at IS NULL AND project_id=$2',[row.channel_id,projectId]))[0]:undefined
    check(source,'El canal autorizado del proyecto no está disponible.',409)
    check(await this.validLeader(sql,projectId,row.coordinator_session_id) && await this.channelMatchesDelegation(sql,projectId,row.coordinator_session_id,delegation),
      'La sesión de automatización del proyecto no coincide con su canal.',409)
  }

  /** Every spawn of a derived member needs the delegation gate, a request whose authority is still live, and a plan that has not outlived its runtime limit. */
  private async assertDerivedLaunchable(plan:Record<string,any>) {
    check(this.orca.supportsProfiles && this.derived?.actionProfile,'action_profile_unavailable: los planes derivados no pueden lanzarse sin el perfil de ejecución action.',409)
    const automation=await this.assertDelegationCurrent(plan.delegation_project_id,plan.delegation_version)
    check(Date.parse(asObject(plan.plan).expires_at)>Date.now(),'El plan derivado superó el tiempo máximo de la delegación.',409)
    check(await this.derived.live(plan.decision_request_id),'La autoridad de la solicitud aprobada ya no está vigente.',409)
    return automation
  }

  private async derivedProfile(plan:Record<string,any>,member:Record<string,any>):Promise<ActionProfile> {
    await this.assertDerivedLaunchable(plan)
    const profile=await this.derived!.actionProfile!({plan_id:plan.id,member_id:member.id,project_id:plan.delegation_project_id,delegation_version:plan.delegation_version})
    check(profile?.kind==='action' && typeof profile.agent_instance_id==='string' && profile.agent_instance_id && typeof profile.principal_handle==='string' && profile.principal_handle,
      'action_profile_unavailable: el perfil emitido no es válido.',409)
    return profile
  }

  /** The system session of a project is valid only while it is exactly the hub_system leader of that project's automation channel. */
  private async validLeader(sql:Sql,projectId:string,sessionId:string) {
    return (await sql.query(`SELECT s.id FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id
      WHERE s.id=$1 AND s.agent_id='agenthub-system' AND s.cli_kind='hub' AND s.capability='hub_system' AND s.closed_at IS NULL AND s.removed_at IS NULL
      AND c.scope_key=$2 AND c.project_id=$3 AND c.leader_id=s.id AND c.closed_at IS NULL`,[sessionId,`automation:${projectId}`,projectId]))[0]
  }

  /** The existing automation channel must still be exactly what the delegation authorized: its name and its delegated workspace. */
  private async channelMatchesDelegation(sql:Sql,projectId:string,sessionId:string,delegation:StoredDelegation) {
    const channel=(await sql.query('SELECT c.name,c.path FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id WHERE s.id=$1',[sessionId]))[0]
    if(!channel || !delegation.channel)return false
    return channel.name===delegation.channel.name.slice(0,200) && channel.path===this.automationPath(projectId,delegation)
  }

  private automationPath(projectId:string,delegation:StoredDelegation) {
    const base=(this.orca as {directory?:string}).directory
    return delegation.repositories[0]?.repo_path ?? (base?join(base,'automation-workspaces',projectId):undefined)
  }

  /**
   * Backend-only. Creates once the project's automation channel and the system session that leads it. The channel exists only because the activation
   * recorded its name and objective in the delegation, and it is anchored to the channel the person authorized (project_automation.channel_id).
   * The session's key is never stored or returned, so no client can authenticate as it. When the previous channel or its session was closed (backup
   * restore, closed system session) it is retired explicitly and a new channel with a new session replaces it; a live but inconsistent one is refused.
   */
  async ensureProjectLeader(projectId:string):Promise<string> {
    const path=await this.prepareAutomationPath(projectId)
    return this.db.transaction(async sql=>{
      const row=(await sql.query(`SELECT a.enabled,a.channel_id,a.coordinator_session_id,d.document,d.revoked_at
        FROM project_automation a JOIN project_delegations d ON d.project_id=a.project_id AND d.version=a.delegation_version WHERE a.project_id=$1`,[projectId]))[0]
      check(row?.enabled && !row.revoked_at,'El proyecto no tiene una delegación vigente.',409)
      const delegation=asObject(row.document) as StoredDelegation
      check(delegation.channel,'La delegación no autoriza un canal de automatización; sin él no hay coordinador ni planes derivados.',409)
      const source=row.channel_id?(await sql.query('SELECT * FROM chat_channels WHERE id=$1 AND closed_at IS NULL',[row.channel_id]))[0]:undefined
      check(source && source.project_id===projectId,'El canal autorizado del proyecto no está disponible.',409)
      const scope=`automation:${projectId}`
      const existing=(await sql.query('SELECT id,closed_at,leader_id FROM chat_channels WHERE scope_key=$1',[scope]))[0]
      const leader=row.coordinator_session_id?(await sql.query('SELECT closed_at,removed_at FROM chat_sessions WHERE id=$1',[row.coordinator_session_id]))[0]:undefined
      const retired=!existing || Boolean(existing.closed_at) || Boolean(row.coordinator_session_id && (!leader || leader.closed_at || leader.removed_at))
      if(!retired) {
        check(row.coordinator_session_id && await this.validLeader(sql,projectId,row.coordinator_session_id) && await this.channelMatchesDelegation(sql,projectId,row.coordinator_session_id,delegation),
          existing && !row.coordinator_session_id?'El canal de automatización del proyecto ya existe sin una sesión vinculada.':'La sesión de automatización del proyecto no coincide con su canal.',409)
        return String(row.coordinator_session_id)
      }
      await this.retireAutomationChannel(sql,projectId,row.coordinator_session_id)
      const channel=(await sql.query(`INSERT INTO chat_channels(id,project_id,path,name,scope_key,kind,activated_at)
        VALUES($1,$2,$3,$4,$5,'virtual',now()) RETURNING *`,[randomUUID(),projectId,path ?? this.automationPath(projectId,delegation),delegation.channel.name.slice(0,200),scope]))[0]!
      const sessionId=`system:${randomUUID()}`
      await sql.query(`INSERT INTO chat_sessions(id,agent_id,key_hash,label,cli_kind,channel_id,state,capability,event_at)
        VALUES($1,'agenthub-system',$2,'Agent Hub','hub',$3,'offline','hub_system',now())`,[sessionId,hash(randomBytes(32).toString('hex')),channel.id])
      await sql.query('UPDATE chat_channels SET leader_id=$2,updated_at=now() WHERE id=$1',[channel.id,sessionId])
      await sql.query('UPDATE project_automation SET coordinator_session_id=$2,updated_at=now() WHERE project_id=$1',[projectId,sessionId])
      return sessionId
    })
  }

  /** The scope key is unique: a retired channel gives it up so a new one can take it, and no leadership moves between them. */
  private async retireAutomationChannel(sql:Sql,projectId:string,sessionId?:string|null) {
    const scope=`automation:${projectId}`
    const existing=(await sql.query('SELECT id FROM chat_channels WHERE scope_key=$1',[scope]))[0]
    if(existing) {
      await sql.query('UPDATE chat_channels SET closed_at=COALESCE(closed_at,now()),leader_id=NULL,scope_key=$2,updated_at=now() WHERE id=$1',[existing.id,`${scope}:closed:${existing.id}`])
      await sql.query("UPDATE chat_sessions SET state='offline',closed_at=COALESCE(closed_at,now()),lease_until=NULL WHERE channel_id=$1 AND capability='hub_system'",[existing.id])
    }
    if(sessionId)await sql.query("UPDATE chat_sessions SET state='offline',closed_at=COALESCE(closed_at,now()),lease_until=NULL WHERE id=$1 AND capability='hub_system'",[sessionId])
  }

  /** Called when a delegation is replaced or revoked: the next activation builds a new channel and system session from its own authorization. */
  async retireProjectLeader(projectId:string) {
    await this.db.transaction(async sql=>{
      const row=(await sql.query('SELECT coordinator_session_id FROM project_automation WHERE project_id=$1',[projectId]))[0]
      await this.retireAutomationChannel(sql,projectId,row?.coordinator_session_id)
      await sql.query('UPDATE project_automation SET coordinator_session_id=NULL,updated_at=now() WHERE project_id=$1',[projectId])
    })
  }

  /** The workspace comes from the delegation, never from the source channel: the first delegated repository, or a Hub-owned empty folder created before the transaction opens. */
  private async prepareAutomationPath(projectId:string) {
    const row=(await this.db.query(`SELECT d.document FROM project_automation a JOIN project_delegations d ON d.project_id=a.project_id AND d.version=a.delegation_version
      WHERE a.project_id=$1 AND a.enabled=1 AND d.revoked_at IS NULL`,[projectId]))[0]
    if(!row)return undefined
    const delegation=asObject(row.document) as StoredDelegation
    if(!delegation.channel)return undefined
    const path=this.automationPath(projectId,delegation)
    check(path,'No hay un espacio de trabajo para el canal de automatización.',503)
    if(!delegation.repositories[0])await mkdir(path,{recursive:true})
    return path
  }

  /**
   * Backend-only entry for a follow-up approved through the decision store. Plan, members and digest come from the standing delegation, the approved
   * items and the authenticated follow-up receipt; nothing a reply, a coordinator or the caller says can add members, change models or widen the profile.
   */
  async launchDerived(input:{project_id:string;delegation_version:number;request_id:string}) {
    check(this.derived,'Los planes derivados no están disponibles en este servicio.',503)
    check(this.orca.provider==='hub','Los planes derivados requieren workers administrados por el Hub.',409)
    check(this.orca.supportsProfiles && this.derived.actionProfile,'action_profile_unavailable: los planes derivados no pueden lanzarse sin el perfil de ejecución action.',409)
    check(this.collaborationEnabled(),'La colaboración está deshabilitada',403)
    const automation=await this.assertDelegationCurrent(input.project_id,input.delegation_version)
    const who=(await this.db.query('SELECT * FROM chat_sessions WHERE id=$1',[automation.coordinator_session_id]))[0]
    check(who,'La sesión de automatización del proyecto no coincide con su canal.',409)
    const prior=(await this.db.query('SELECT id FROM chat_team_plans WHERE delegation_project_id=$1 AND decision_request_id=$2',[input.project_id,input.request_id]))[0]
    if(prior)return this.view(prior.id,who)
    const delegation=asObject(automation.document) as StoredDelegation
    check(await this.derived.live(input.request_id),'La autoridad de la solicitud aprobada no está vigente.',409)
    const decision=await this.derived.approved(input.request_id)
    const items=decision.items.filter(item=>item.project_id===input.project_id && APPROVED_ITEM_STATES.includes(item.state))
    const mine=decision.follow_ups.filter(entry=>entry.project_id===input.project_id)
    check(mine.length<=1,'La respuesta trae más de un seguimiento para el proyecto; no se puede elegir uno con certeza.',409)
    const followUp=mine[0]
    // The follow-up must hang from an item of this project that was actually approved in the same reply.
    check(followUp && followUp.ref && Date.parse(followUp.expires_at)>Date.now() && items.some(item=>item.ordinal===followUp.ordinal),'No hay una instrucción de seguimiento autenticada y vigente para esta solicitud.',409)
    const project=(await this.db.query("SELECT id,title FROM entities WHERE id=$1 AND kind='project'",[input.project_id]))[0]
    check(project,'El proyecto no existe.',404)
    const derived=deriveStandingPlan({project:{id:project.id,name:project.title},delegation:{version:input.delegation_version,digest:automation.digest,document:delegation},
      decision:{request_id:input.request_id,canonical_digest:decision.canonical_digest},items,follow_up:{text:followUp.text,ref:followUp.ref,source:followUp.source}})
    const channel=(await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[who.channel_id]))[0]
    check(channel && !channel.closed_at,'El canal de automatización del proyecto está cerrado.',409)
    const parent=await this.orca.workspace(this.parentId(channel))
    const expected=delegation.repositories[0]?.repo_path
    check(expected?parent.kind!=='virtual' && parent.path===expected:parent.kind==='virtual','El espacio de trabajo no corresponde a los repositorios de la delegación.',409)
    const baseRevision=await this.resolveBase(parent,parent.head)
    const validations=await this.validateMembers(derived.members,who)
    await this.preflight(derived.members,who)
    await this.checkQuota(derived.members,who)
    const planId=randomUUID(),members=derived.members.map((item,index)=>({id:randomUUID(),ordinal:index,...item,capabilities:validations[index]}))
    const expiresAt=new Date(Date.now()+delegation.limits.max_runtime_minutes*60_000).toISOString()
    const document={schema_version:1,id:planId,objective:derived.objective,master_channel_id:channel.id,created_by:who.id,parent,base_revision:baseRevision,members,usage:[],
      permissions:'action_profile',derived:derived.document,expires_at:expiresAt}
    try {
      await this.db.transaction(async sql=>{
        // Delegation validity and the concurrency slot are claimed in the same transaction that inserts the plan.
        await this.assertDelegationCurrent(input.project_id,input.delegation_version,sql)
        const active=(await sql.query(`SELECT count(*) AS count FROM chat_team_plans WHERE delegation_project_id=$1 AND (state NOT IN ('paused','cancelled','completed') OR ${HOLDS_PROCESS})`,[input.project_id]))[0]
        check(Number(active?.count ?? 0)<delegation.limits.max_concurrent_plans,'La delegación alcanzó su tope de planes simultáneos.',409)
        const root=(await sql.query('INSERT INTO chat_threads(id,channel_id,title,created_by) VALUES($1,$2,$3,$4) RETURNING *',
          [randomUUID(),channel.id,`Equipo: ${derived.objective}`.slice(0,200),who.id]))[0]!
        await sql.query(`INSERT INTO chat_team_plans(id,master_channel_id,root_thread_id,created_by,objective,parent,base_revision,plan,digest,state,delegation_project_id,delegation_version,decision_request_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'prepared',$10,$11,$12)`,[planId,channel.id,root.id,who.id,derived.objective,JSON.stringify(parent),baseRevision,JSON.stringify(document),derived.digest,
          input.project_id,input.delegation_version,input.request_id])
        for(const item of members) {
          await sql.query('INSERT INTO chat_threads(id,channel_id,title,created_by,team_root_thread_id) VALUES($1,$2,$3,$4,$5)',[item.id,channel.id,item.worktree_name,who.id,root.id])
          await sql.query(`INSERT INTO chat_team_members(id,team_id,ordinal,worktree_name,cli,model,effort,role,task,prompt,capabilities,state,work_thread_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'prepared',$1)`,[item.id,planId,item.ordinal,item.worktree_name,item.cli,item.model,item.effort ?? null,item.role,item.task,item.prompt,JSON.stringify(item.capabilities ?? null)])
        }
        await this.event(sql,planId,null,'prepared',who.id,channel.id,root.id,{digest:derived.digest,delegation_version:input.delegation_version,follow_up_ref:followUp.ref})
      })
    } catch(error) {
      // The unique (project, request) index makes a concurrent replay of the same approved request return the plan that won.
      const winner=(await this.db.query('SELECT id FROM chat_team_plans WHERE delegation_project_id=$1 AND decision_request_id=$2',[input.project_id,input.request_id]))[0]
      if(winner)return this.view(winner.id,who)
      throw error
    }
    // The slot is already held, so a request that loses the race for capacity never burns its follow-up. The claim is idempotent per (project, request).
    const claim=await this.derived.claimFollowUp(input.request_id,input.project_id,`derived:${input.project_id}:${input.request_id}`).catch(()=>'authority_unavailable' as const)
    if(claim!=='claimed' && claim!=='already_claimed_by_same') {
      const row=(await this.db.query('SELECT * FROM chat_team_plans WHERE id=$1',[planId]))[0]
      if(row)await this.cancelPlan(row,`El seguimiento no pudo reclamarse (${claim}).`,who).catch(()=>undefined)
      check(false,'El seguimiento aprobado ya no puede reclamarse: la solicitud perdió su autoridad, venció o lo tomó otro consumidor.',409)
    }
    await this.event(this.db,planId,null,'follow_up_claimed',who.id,channel.id,(await this.db.query('SELECT root_thread_id FROM chat_team_plans WHERE id=$1',[planId]))[0]!.root_thread_id,
      {follow_up_ref:followUp.ref,claim,plan_expires_at:expiresAt})
    return this.launch({plan_id:planId,digest:derived.digest,
      human_instruction:`Seguimiento aprobado (${followUp.source}, recibo ${followUp.ref}): solicitud ${input.request_id}, delegación v${input.delegation_version} de ${project.title}`},
    who,undefined,{source:followUp.source==='channel_reply'?DERIVED_APPROVAL_SOURCE:'standing_delegation+owner_ui',userId:this.derived.ownerId()})
  }

  /**
   * Closes the given derived plans without going through the leader session: the kill switch must work when that session or the collaboration
   * switch is gone. A plan counts as closed only when every owned process has a confirmed stop and its principal handles were revoked; otherwise
   * it is reported as failed, keeps its logical cancellation and stays selectable by later closes.
   */
  private async closeDerived(plans:Array<Record<string,any>>,reason:string) {
    const closed:string[]=[],failed:string[]=[]
    for(const plan of plans) {
      try {
        const who=(await this.db.query('SELECT * FROM chat_sessions WHERE id=$1',[plan.created_by]))[0]
        check(who,'La sesión de automatización no existe.',409)
        const outcome=await this.cancelPlan(plan,reason,who)
        if(outcome.uncertain.length || !outcome.revoked) {
          failed.push(plan.id)
          await this.event(this.db,plan.id,null,'close_failed',plan.created_by,plan.master_channel_id,plan.root_thread_id,
            {reason,uncertain_members:outcome.uncertain,profiles_revoked:outcome.revoked}).catch(()=>undefined)
        } else closed.push(plan.id)
      } catch(error) {
        failed.push(plan.id)
        await this.event(this.db,plan.id,null,'close_failed',plan.created_by,plan.master_channel_id,plan.root_thread_id,{reason,error:error instanceof MemoryError?error.message:'close_failed'}).catch(()=>undefined)
      }
    }
    return {closed,failed}
  }

  /** Closes derived plans whose delegation runtime limit elapsed. */
  async expireDerived(now=Date.now()) {
    const plans=await this.db.query(`SELECT * FROM chat_team_plans WHERE ${OPEN_DERIVED}`)
    return this.closeDerived(plans.filter(plan=>Date.parse(asObject(plan.plan).expires_at)<=now),'Se cumplió el tiempo máximo de la delegación.')
  }

  /** Called when a delegation is revoked, replaced or its project deactivated: running plans and their handles must not outlive it. */
  async closeDerivedForProject(projectId:string,reason:string) {
    const plans=await this.db.query(`SELECT * FROM chat_team_plans WHERE delegation_project_id=$1 AND (state NOT IN ('paused','cancelled','completed') OR ${HOLDS_PROCESS})`,[projectId])
    return this.closeDerived(plans,reason)
  }

  private async join(token:string,who:Record<string,any>,agent:AgentContext) {
    const digest=invitationHash(token),member=(await this.db.query(`SELECT m.*,t.digest,t.state AS team_state,t.master_channel_id,t.root_thread_id,t.created_by
      FROM chat_team_members m JOIN chat_team_plans t ON t.id=m.team_id WHERE m.invitation_hash=$1`,[digest]))[0]
    check(member && !member.invitation_used_at && Date.parse(member.invitation_expires_at)>Date.now(),'Invitación inexistente, vencida o ya consumida',409)
    return this.serial(member.id,async()=>{
      check(activePlan(member.team_state) && ['accepted','launch_intent','unknown'].includes(member.state),'El equipo no admite incorporaciones en este estado',409)
      check(member.cli===agent.cli_kind,'La invitación pertenece a otra CLI',403)
      if(this.orca.provider!=='hub')check(agent.orca_workspace_id===member.workspace_id,'La identidad Orca no coincide con el worktree asignado',403)
      const channel=(await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[who.channel_id]))[0]
      check(channel && !channel.closed_at && (this.orca.provider==='hub'?channel.path===member.workspace_path:channel.orca_workspace_id===member.workspace_id),'La invitación pertenece a otro worktree',403)
      const actual=await realpath(agent.cwd ?? '').catch(()=>null),expected=await realpath(member.workspace_path).catch(()=>null)
      check(actual && expected && actual===expected,'La sesión no está en la carpeta real del worktree asignado',403)
      const result=await this.db.transaction(async sql=>{
        check(this.collaborationEnabled(),'La colaboración está deshabilitada',403)
        const current=(await sql.query(`SELECT m.id,t.state AS team_state,master.leader_id,leader.closed_at AS leader_closed,leader.removed_at AS leader_removed
          FROM chat_team_members m JOIN chat_team_plans t ON t.id=m.team_id JOIN chat_channels master ON master.id=t.master_channel_id
          JOIN chat_sessions leader ON leader.id=t.created_by
          JOIN chat_sessions participant ON participant.id=$3
          JOIN chat_channels child ON child.id=participant.channel_id
          WHERE m.id=$1 AND m.invitation_hash=$2 AND m.invitation_used_at IS NULL AND m.invitation_expires_at>now()
          AND master.closed_at IS NULL AND participant.closed_at IS NULL AND participant.removed_at IS NULL
          AND child.closed_at IS NULL AND ${this.orca.provider==='hub'?'child.path=m.workspace_path':'child.orca_workspace_id=m.workspace_id'}`,[member.id,digest,who.id]))[0]
        check(current && activePlan(current.team_state) && current.leader_id===member.created_by && !current.leader_closed && !current.leader_removed,
          'El líder master o el equipo ya no están vigentes',409)
        const used=await sql.query(`UPDATE chat_team_members SET state='joined',invitation_used_at=now(),invitation_hash=NULL,session_id=$2,channel_id=$3,updated_at=now()
          WHERE id=$1 AND invitation_used_at IS NULL AND invitation_hash=$4 RETURNING *`,[member.id,who.id,who.channel_id,digest])
        check(used.length,'La invitación ya fue consumida',409)
        // The approved invitation also authorizes this worker's virtual conversation.
        await sql.query("UPDATE chat_channels SET activated_at=COALESCE(activated_at,now()),leader_id=COALESCE(leader_id,$2) WHERE id=$1 AND kind='virtual' AND closed_at IS NULL",[who.channel_id,who.id])
        await this.event(sql,member.team_id,member.id,'joined',who.id,who.channel_id,member.root_thread_id,{})
        const plan=(await sql.query('SELECT * FROM chat_team_plans WHERE id=$1',[member.team_id]))[0]!
        const peers=await sql.query('SELECT id,session_id,role,task,cli,model,state,work_thread_id FROM chat_team_members WHERE team_id=$1 ORDER BY ordinal,id',[member.team_id])
        return {team_id:member.team_id,member_id:member.id,root_thread_id:member.root_thread_id,work_thread_id:member.work_thread_id,master_channel_id:member.master_channel_id,
          master_session_id:member.created_by,session:{id:who.id,channel_id:who.channel_id},state:'joined',
          task:member.task,role:member.role,prompt:member.prompt,peers,
          authorization:{...this.authorization(plan),assignment:plan.plan.members.find((entry:{id:string})=>entry.id===member.id)},source_workspace:plan.parent,
          guidance:'El master coordina desde root_thread_id como TL y resuelve decisiones técnicas dentro del alcance aprobado. La autorización adjunta indica su procedencia; no autoriza acciones ajenas al plan ni levanta restricciones de la CLI. No exijas una segunda aprobación directa de la persona para la misma acción ya autorizada. Si falta alcance o hay un bloqueo real, reportá la acción, la regla o error concreto y lo que falta al master. No abras preguntas directas a la persona; consultá al master por el Hub mencionando master_session_id. Los pares pueden pedirte subtareas dentro de tu rol por el hilo del equipo: respondé al solicitante y escalá al TL sólo conflictos o decisiones fuera de alcance. Usá work_thread_id para tu trabajo y tus reportes, mencionando master_session_id; root_thread_id es para coordinación general. Los pares pueden responder en tu hilo y vos en el suyo. Registrá trabajo y reportá al incorporarte; si tu tarea depende de una PR u otro resultado, registrá waiting con esa dependencia. No confundas idle con trabajo terminado.'}
      })
      check(this.collaborationEnabled(),'La colaboración está deshabilitada',403)
      await this.orca.bind?.(member.id,who.id)
      return result
    })
  }

  private workerPrompt(token:string) {
    return `Agent Hub: elegí tu nickname y registralo con memory_chat_join y memory_chat_set_nick, conservando la identidad/session_key recibida. Después usá memory_team_join con invitation=${token}. Esa herramienta entrega tu tarea y el contexto del equipo. La invitación vence y se consume una sola vez.`
  }
  private authorization(plan:Record<string,any>) {
    return {plan_id:plan.id,digest:plan.digest,source:plan.approval_source ?? (plan.human_instruction?'legacy_record':null),
      instruction:plan.human_instruction ?? null,coordinator_id:plan.created_by,approved_by_user_id:plan.approved_by_user_id ?? null,
      permissions:plan.plan.permissions,scope:plan.objective,
      ...(plan.delegation_project_id?{delegation:{project_id:plan.delegation_project_id,version:plan.delegation_version,decision_request_id:plan.decision_request_id}}:{})}
  }

  private serial<T>(memberId:string,operation:()=>Promise<T>):Promise<T> {
    const previous=this.memberOperations.get(memberId) ?? Promise.resolve()
    const current=previous.catch(()=>undefined).then(operation)
    this.memberOperations.set(memberId,current)
    void current.finally(()=>{if(this.memberOperations.get(memberId)===current)this.memberOperations.delete(memberId)}).catch(()=>undefined)
    return current
  }

  private runtime(value:Partial<TeamRuntimeMetadata>|null|undefined,generation?:string):TeamRuntimeMetadata {
    const questions=pendingQuestions.safeParse(value?.questions)
    const safe=(text:unknown)=>typeof text==='string' && text.length<=512 && !/[\x00-\x1f\x7f]/.test(text)
    return {...(this.orca.provider==='hub'?{provider:'hub' as const}:{}),...(questions.success?{questions:questions.data as TeamPendingQuestion[]}:{}),generation:generation ?? (typeof value?.generation==='string'?value.generation:randomUUID()),
      state:safe(value?.state)?value!.state!:'unknown',native_id:safe(value?.native_id)?value!.native_id!:null,
      turn_id:safe(value?.turn_id)?value!.turn_id!:null,updated_at:typeof value?.updated_at==='string' && Number.isFinite(Date.parse(value.updated_at))?value.updated_at:new Date().toISOString()}
  }

  private async setRuntime(memberId:string,value:TeamRuntimeMetadata) {
    // Hub protocol events own runtime metadata. Seed only adapters that did not persist a receipt;
    // never replace a later native event with the earlier launch snapshot.
    await this.db.query(`UPDATE chat_team_members SET runtime=$2,updated_at=now() WHERE id=$1${this.orca.provider==='hub'?' AND runtime IS NULL':''}`,
      [memberId,JSON.stringify(this.runtime(value))])
  }
  private async updateRuntime(memberId:string,patch:Partial<TeamRuntimeMetadata>) {
    if(this.orca.provider==='hub')return // Only the backend can confirm stop, failure or native activity.
    const item=(await this.db.query('SELECT runtime FROM chat_team_members WHERE id=$1',[memberId]))[0]
    if(item?.runtime)await this.setRuntime(memberId,{...item.runtime,...patch,updated_at:new Date().toISOString()})
  }

  private async controlAuthority(planId:string,who:Record<string,any>) {
    await this.master(who)
    const plan=(await this.db.query('SELECT * FROM chat_team_plans WHERE id=$1',[planId]))[0]
    check(plan && plan.created_by===who.id && plan.master_channel_id===who.channel_id,'El plan no pertenece al líder vigente',403)
    check(activePlan(plan.state) && !['prepared','launching'].includes(plan.state) && plan.human_instruction,'El plan no está aprobado y activo',409)
    return plan
  }

  private async answer(input:z.infer<typeof answerInput>,who:Record<string,any>) {
    check(this.orca.provider==='hub' && this.orca.answer && this.orca.status,'Las respuestas nativas requieren un runtime Hub conectado',409)
    return this.serial(input.member_id,async()=>{
      const validate=async()=>{
        const plan=await this.controlAuthority(input.plan_id,who)
        const item=(await this.db.query('SELECT * FROM chat_team_members WHERE id=$1 AND team_id=$2',[input.member_id,plan.id]))[0]
        check(item?.launch_handle && item.runtime?.generation===input.expected_generation,'La generación o el runtime de la pregunta cambiaron',409)
        return {plan,item}
      }
      const {plan,item}=await validate()
      const current=await this.orca.status!(item.launch_handle)
      check(current?.generation===input.expected_generation && ['waiting_input','busy'].includes(current.state ?? ''),'El worker ya no espera esta respuesta o su estado es desconocido',409)
      const pending=pendingQuestions.safeParse(current.questions)
      const request=pending.success?pending.data.find(question=>question.id===input.question_id):undefined
      check(request,'La pregunta ya no está pendiente en esta generación',409)
      const ids=new Set(request.questions.map(question=>question.id)),answers=Object.keys(input.answers)
      check(ids.size===answers.length && answers.every(id=>ids.has(id)),'Las respuestas deben corresponder exactamente a las preguntas pendientes',422)
      await validate() // A status read may await protocol persistence; recheck authority immediately before answering.
      await this.orca.answer!(item.launch_handle,input.question_id,input.answers)
      await this.event(this.db,plan.id,item.id,'answer',who.id,who.channel_id,plan.root_thread_id,{question_id:input.question_id})
      return this.view(plan.id,who)
    })
  }

  private async control(input:z.infer<typeof controlInput>,who:Record<string,any>) {
    check(this.orca.provider==='hub','Los controles requieren workers administrados por el Hub',409)
    return this.serial(input.member_id,async()=>{
      const plan=await this.controlAuthority(input.plan_id,who)
      check(!plan.delegation_project_id || input.action!=='edit','Un plan derivado no admite cambios de rol, tarea ni prompt.',409)
      const load=async()=>{
        await this.controlAuthority(plan.id,who)
        const item=(await this.db.query('SELECT * FROM chat_team_members WHERE id=$1 AND team_id=$2',[input.member_id,plan.id]))[0]
        check(item,'Miembro inexistente en este plan',404)
        check((item.runtime?.generation ?? 'none')===input.expected_generation,'La generación del worker cambió; consultá team_status',409)
        return item
      }
      let item=await load()
      if(input.action==='edit') {
        await this.db.query('UPDATE chat_team_members SET role=$2,task=$3,prompt=$4,updated_at=now() WHERE id=$1',
          [item.id,input.role ?? item.role,input.task ?? item.task,input.prompt ?? item.prompt])
      } else if(input.action==='start' || input.action==='clear') {
        check(item.workspace_id && item.workspace_path,'El miembro todavía no tiene worktree confirmado',409)
        if(input.action==='start')check(!item.runtime || ['stopped','exited','failed','unknown'].includes(item.runtime.state),
          'El worker ya está activo; usá clear para iniciar otra conversación',409)
        await this.validateMembers([item],who)
        await this.preflight([item],who)
        await this.checkQuota([item],who)
        if(plan.delegation_project_id)await this.assertDerivedLaunchable(plan)
        item=await load()
        check(item.launch_handle || !item.runtime || ['stopped','failed'].includes(item.runtime.state),
          'El runtime no tiene un recibo verificable para confirmar su detención. No se lanzará un reemplazo de un proceso desconocido.',409)
        // An unknown process may still exist. Stop the owned handle before replacing it.
        if(item.launch_handle) {
          check(this.orca.stop,'El backend no permite detener el worker',409)
          let stopped:unknown
          try {stopped=await this.orca.stop(item.launch_handle)} catch {
            check(false,'El Hub no pudo confirmar la detención de este runtime. Conservá el estado desconocido; no se lanzará un reemplazo ni se adoptarán procesos ajenos.',409)
          }
          check(stopped && typeof stopped==='object' && ['stopped','failed'].includes(String((stopped as {state?:unknown}).state)),
            'El Hub no confirmó la detención del worker. Su estado sigue desconocido; no se lanzará un reemplazo.',409)
          item=await load()
        }
        const token=randomBytes(32).toString('base64url'),expires=new Date(Date.now()+30*60_000).toISOString()
        await this.db.transaction(async sql=>{
          if(item.session_id) {
            await sql.query("UPDATE chat_sessions SET state='offline',closed_at=COALESCE(closed_at,now()),lease_until=NULL WHERE id=$1",[item.session_id])
            await sql.query('UPDATE chat_channels SET leader_id=NULL WHERE id=$1 AND leader_id=$2',[item.channel_id,item.session_id])
            await sql.query("UPDATE chat_deliveries SET cancelled_at=now(),error='Conversación del worker reemplazada' WHERE recipient_id=$1 AND handled_at IS NULL AND cancelled_at IS NULL",[item.session_id])
          }
          await sql.query(`UPDATE chat_team_members SET state='launch_intent',session_id=NULL,channel_id=NULL,
            invitation_used_at=NULL,invitation_hash=$2,invitation_expires_at=$3,launch_handle=NULL,error=NULL,updated_at=now() WHERE id=$1`,
            [item.id,invitationHash(token),expires])
        })
        // Revalidate authority immediately before the external launch; the per-member lock protects the rotated generation.
        await this.controlAuthority(plan.id,who)
        const prompt=this.workerPrompt(token)
        try {
          const profile=plan.delegation_project_id?await this.derivedProfile(plan,item):undefined
          const receipt=await this.orca.launch({id:item.workspace_id,path:item.workspace_path,repo_id:item.workspace_repo_id,head:item.workspace_head},
            {member_id:item.id,resume_worktree:true,...(profile?{profile}:{}),authorize:async()=>{
              await this.checkQuota([item],who)
              if(plan.delegation_project_id)await this.assertDelegationCurrent(plan.delegation_project_id,plan.delegation_version)
              const current=await load()
              check(current.state==='launch_intent' && current.invitation_hash===invitationHash(token),'La incorporación cambió antes del lanzamiento',409)
            },cli:item.cli,model:item.model,...(item.effort?{effort:item.effort}:{}),prompt})
          await this.db.query(`UPDATE chat_team_members SET state=CASE WHEN state='joined' THEN state ELSE 'accepted' END,
            launch_handle=$2,launch_kind=$3,operation_id=$4,prompt_outcome=$5,updated_at=now() WHERE id=$1`,
            [item.id,receipt.handle,receipt.kind,receipt.operation_id ?? null,receipt.prompt_outcome])
          await this.setRuntime(item.id,this.runtime(receipt.runtime ?? {state:'unknown'}))
          try {await this.controlAuthority(plan.id,who)} catch(error) {
            await this.orca.stop?.(receipt.handle)
            await this.updateRuntime(item.id,{state:'stopped'})
            await this.db.query('UPDATE chat_team_members SET invitation_hash=NULL,invitation_expires_at=NULL WHERE id=$1',[item.id])
            throw error
          }
        } catch(error) {
          await this.unknown(plan,item,'launch',who,error)
          await this.updateRuntime(item.id,{state:'unknown'})
          throw error
        }
      } else {
        check(item.launch_handle,'El miembro no tiene un runtime confirmado',409)
        item=await load()
        if(input.action==='send') {
          check(this.orca.send,'El backend no permite enviar instrucciones',409)
          await this.orca.send(item.launch_handle,input.text!)
        } else if(input.action==='interrupt') {
          check(this.orca.interrupt,'El backend no permite interrumpir',409)
          await this.orca.interrupt(item.launch_handle)
        } else {
          check(this.orca.stop,'El backend no permite detener',409)
          await this.orca.stop(item.launch_handle)
          await this.updateRuntime(item.id,{state:'stopped'})
          await this.db.query('UPDATE chat_team_members SET invitation_hash=NULL,invitation_expires_at=NULL WHERE id=$1',[item.id])
        }
      }
      await this.event(this.db,plan.id,item.id,'control',who.id,who.channel_id,plan.root_thread_id,{action:input.action})
      return this.view(plan.id,who)
    })
  }

  private async status(planId:string,who:Record<string,any>,sql:Sql=this.db) {
    const plan=(await sql.query('SELECT * FROM chat_team_plans WHERE id=$1',[planId]))[0]
    check(plan,'Plan de equipo inexistente',404)
    const allowed=plan.created_by===who.id || (await sql.query("SELECT id FROM chat_team_members WHERE team_id=$1 AND session_id=$2 AND state='joined'",[planId,who.id])).length>0
    check(allowed,'La sesión no pertenece a este equipo',403)
    const result=await this.view(planId,who,sql)
    if(this.orca.provider==='hub')for(const item of result.members)if(item.runtime && item.launch_handle) {
      let observed:Partial<TeamRuntimeMetadata>|undefined
      try {observed=await this.orca.status?.(item.launch_handle)} catch { /* unavailable metadata is unknown */ }
      // Status is a public snapshot, never a writer racing native events in the same generation.
      item.runtime=this.publicRuntime(observed?{...item.runtime,...observed}:{...item.runtime,state:'unknown'},observed?.generation ?? item.runtime.generation)
    }
    return result
  }

  private publicRuntime(value:Partial<TeamRuntimeMetadata>,generation?:string) {
    const runtime=this.runtime(value,generation)
    return ['busy','running','working','starting'].includes(runtime.state) && Date.now()-Date.parse(runtime.updated_at)>90_000
      ? {...runtime,state:'unknown',activity_stale:true}:runtime
  }

  private async view(planId:string,who:Record<string,any>,sql:Sql=this.db) {
    const plan=(await sql.query('SELECT * FROM chat_team_plans WHERE id=$1',[planId]))[0]
    check(plan,'Plan de equipo inexistente',404)
    check(plan.created_by===who.id || (await sql.query("SELECT id FROM chat_team_members WHERE team_id=$1 AND session_id=$2 AND state='joined'",[planId,who.id])).length>0,
      'La sesión no pertenece a este equipo',403)
    const members=await sql.query(`SELECT id,ordinal,worktree_name,cli,model,effort,role,task,capabilities,state,workspace_id,workspace_path,workspace_repo_id,workspace_head,
      ${this.orca.provider==='hub'?'runtime,':''}launch_handle,launch_kind,operation_id,prompt_outcome,error,invitation_expires_at,invitation_used_at,session_id,channel_id,work_thread_id,created_at,updated_at
      FROM chat_team_members WHERE team_id=$1 ORDER BY ordinal,id`,[planId])
    for(const item of members) {
      if(item.runtime)item.runtime=this.publicRuntime(item.runtime)
      const session=item.session_id?(await sql.query('SELECT nickname FROM chat_sessions WHERE id=$1',[item.session_id]))[0]:null
      item.nickname=session?.nickname ?? null
      item.work=(await sql.query(`SELECT status,waiting_for,summary,updated_at,report_message_id FROM chat_work_state
        WHERE session_id=$1 AND thread_id IN (SELECT id FROM chat_threads WHERE id=$2 OR team_root_thread_id=$2)
        ORDER BY updated_at DESC LIMIT 1`,[item.session_id,plan.root_thread_id]))[0] ?? null
      item.last_report=(await sql.query(`SELECT m.id,m.thread_id,substr(m.text,1,600) AS text,m.created_at FROM chat_messages m
        JOIN chat_threads t ON t.id=m.thread_id WHERE m.author_id=$1 AND (t.id=$2 OR t.team_root_thread_id=$2)
        ORDER BY m.seq DESC LIMIT 1`,[item.session_id,plan.root_thread_id]))[0] ?? null
    }
    return {id:plan.id,digest:plan.digest,objective:plan.objective,state:plan.state,master_channel_id:plan.master_channel_id,
      root_thread_id:plan.root_thread_id,created_by:plan.created_by,parent:plan.parent,base_revision:plan.base_revision,plan:this.chat.usageEnabled(who.agent_id)?plan.plan:{...plan.plan,usage:[],usage_guidance:'La consulta de cuotas está deshabilitada para este cliente.',usage_redacted:true},
      launch:{started_at:plan.launch_started_at,accepted_at:plan.launched_at,instruction_declared:Boolean(plan.human_instruction)},
      authorization:this.authorization(plan),
      close:{at:plan.closed_at,reason:plan.close_reason},members,
      progress:{prepared:true,workspaces_created:members.filter(m=>m.workspace_id).length,processes_accepted:members.filter(m=>m.launch_handle && m.prompt_outcome).length,joined:members.filter(m=>m.session_id).length,total:members.length},
      approval_url:plan.state==='prepared'?`/memory/collaboration?plan=${plan.id}`:null}
  }

  private async event(sql:Sql,teamId:string,memberId:string|null,type:string,
    actor:string,sourceChannel:string,targetThread:string,payload:Record<string,unknown>) {
    await sql.query(`INSERT INTO chat_team_events(id,team_id,member_id,type,actor_session_id,source_channel_id,target_thread_id,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),teamId,memberId,type,actor,sourceChannel,targetThread,JSON.stringify(payload)])
  }
}
