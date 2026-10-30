import type { TeamPendingQuestion } from './team-orca.js'
import { workDefinitions, updateWork } from './local-work.js'
import { UsageNotices } from './usage-notices.js'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { realpath, stat, lstat } from 'node:fs/promises'
import { basename, resolve, dirname, join, relative, isAbsolute, sep } from 'node:path'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'
import { z } from 'zod'
import { check, id, parse, MemoryError } from './contracts.js'
import { projectForPath, orcaWorkspaceSchema, type AgentContext } from './agents.js'
import type { MemoryStore } from './store.js'
import type { Sql } from './database.js'
import { teamGuidance, teamGuidanceVersion } from './local-chat-team.js'
import { canReadChannel, readAccessDefinitions, readDenied, readElevate, readInterest, readNoticeValid, readRequest, readScope, sweepReadAccess,
  READ_GRANT_LIVENESS_GRACE_MS, confirmReadRequest, rejectReadRequest, revokeReadGrant, personReadGrants, personReadRequests, type ReadScope } from './chat-read-access.js'
import { channelProjectId, recordAuthorityEvent, sessionProjectId, ACTIVE_TEAM_STATES, type AuthorityEvent } from "./chat-access.js"
import { lastLiveness, leaseActive, writeAssociation, LEADER_LIVENESS_TIMEOUT_MS, LEADERSHIP_ATTEMPT_WINDOW_MS,
  LEADERSHIP_ATTEMPTS_PER_CHANNEL, LEADERSHIP_ATTEMPTS_PER_SESSION, LEADERSHIP_COOLDOWN_MS, SESSION_LEASE_MS } from "./channel-authority.js"
import { AUTHOR_SOURCE_SQL, NON_AGENT_CLI_KINDS, THREAD_AGENT_COUNT_COLUMN, agentCountField, messageKind } from "./chat-debate.js"
import { CHAT_CHANNEL_DESCRIPTION_MAX } from "@agenthub/shared"
import { INTERHUB_REMOTE_CLI_KIND, interhubChannelFields, interhubMessageFields, interhubNoticeValid, interhubThreadFields } from "./interhub/chat.js"

const exec = promisify(execFile)
const key = z.string().min(32).max(200)
const nickname = z.string().max(200).transform(s => s.normalize('NFKC').trim().replace(/ +/g, ' ')).pipe(z.string().min(2).max(40)
  .refine(s => !/[\p{Cc}\p{Cf}]/u.test(s), 'El nick no puede contener caracteres invisibles ni de control')
  .refine(s => !/^(?:native:|[a-f0-9]{32,}$|[a-f0-9]{8}-[a-f0-9-]{27}$)/i.test(s), 'El nick no puede ser un identificador técnico'))
const session = { session_key: key.optional() }
export const chatKickInput = z.object({channel_id:id,participant_id:z.string().min(8).max(200),reason:z.string().trim().min(1).max(1000)})
export const chatCoordinatorInput = z.object({channel_id:id,participant_id:z.string().min(8).max(200),expected_leader_id:z.string().nullable()}).strict()
export const chatDeleteChannelInput = z.object({channel_id:id,reason:z.string().trim().min(1).max(1000)}).strict()
export const chatTakeLeadershipInput = z.object({channel_id:id,expected_leader_id:z.string().min(8).max(200).nullable(),reason:z.string().trim().min(1).max(1000)}).strict()
const page = { limit: z.number().int().min(1).max(100).default(40), offset: z.number().int().min(0).default(0) }
const scope = { project_id: id.optional(), channel_id: id.optional(), unassigned: z.boolean().default(false) }
export const chatDefinitions = {
  ...workDefinitions,
  chat_join: ['Start/recover registration after choosing collaboration. Before a nickname it returns only identity and key, no channel or context. Connection stays private and inactive; no folder or worktree joins sessions to channels. Use session_key in every chat call; it identifies this conversation, not the whole CLI.', z.object({ ...session, path: z.string().max(4000).optional() }).strict()],
  chat_create_channel: ['Create a channel independent of folders, Git and Orca, only after asking the person and getting approval. task_key identifies it for retries (omitted: name, else default); the same key reuses the current channel. Keeps identity/key; moves only this session, as coordinator; never takes the old channel or changes its team. Optional description is shown in the Hub UI.', z.object({ ...session, name: z.string().trim().min(1).max(200).optional(), task_key:z.string().trim().min(1).max(200).optional(), description:z.string().trim().min(1).max(CHAT_CHANNEL_DESCRIPTION_MAX).optional() }).strict()],
  chat_close_channel: ['Close a channel you lead on explicit person request (channel_id; default: your session channel). Leader only. Keeps history, blocks new joins.', z.object({ ...session, channel_id:id.optional() }).strict()],
  chat_delete_channel: ['Trash your own channel on explicit person request. Leader only (the person deletes others in the UI). Closes sessions, cancels its teams, revokes deliveries; the Hub tries to stop its workers and reports uncertain stops. Keeps files/worktrees. History leaves search; the person can restore from trash.',chatDeleteChannelInput.extend(session).strict()],
  chat_set_nick: ['Pick and register your nickname (2–40 chars); if taken, pick another. Unlocks collaboration context. Changes only your session; keeps identity and history.', z.object({ ...session, nickname }).strict()],
  chat_channels: ['Browse active or past local channels you can read: your project, your own and team channels, and projects with a person-granted read permission. unassigned=true: only projectless channels; pending virtual ones stay hidden. deleted=true: trash. Worker spaces group under their team channel; include_workers=true adds them for audit.', z.object({ ...session, ...scope, ...page,deleted:z.boolean().default(false),include_workers:z.boolean().default(false) }).strict()],
  chat_agents: ['Find session identities to mention, within the channels you can read. Coordinator channel_id includes linked team members. Default excludes kicked, closed and nickless sessions; stable order by registration. connection_state/last_seen_at = connection, not work. state=unknown + state_reason=activity_stale = unconfirmed activity: ask status via the Hub, never infer working or done. include_team_history shows disconnected past-team members with real state. include_removed/include_closed/include_pending: audit only. unassigned=true: projectless channels only.', z.object({ ...session, ...scope, active_only: z.boolean().default(false), include_removed: z.boolean().default(false), include_closed: z.boolean().default(false), include_team_history: z.boolean().default(false), include_pending: z.boolean().default(false), ...page }).strict()],
  chat_threads: ['Search past threads/messages by text, channel, project, author or state, within your project, your own and team channels and person-granted projects. Reading a channel never lets you write there. unassigned=true: projectless channels only. History outlives agents.', z.object({ ...session, ...scope, query: z.string().max(500).default(''), author_id: z.string().max(200).optional(), state: z.enum(['open','resolved']).optional(), ...page }).strict()],
  chat_read: ['Read thread messages. With session_key: by default only messages pending for it (not its own), marking only those returned as read; page pending with offset: 0. unread_only=false: history. Without session_key: read-only history that marks nothing. Only threads of channels you can read (same scope as chat_threads); another project needs memory_chat_read_request.', z.object({ ...session, project_id:id.optional(), thread_id: id, unread_only:z.boolean().optional(), ...page }).strict()],
  chat_send: ['Create a task thread (channel_id,title), a short linked-team thread (team_root_thread_id,title), or reply (thread_id). Only in channels you belong to: your own, or the root and threads bound to a current team; mentions only its members. Read access never grants writing. A stable request_id makes retries duplicate-free. Linked-worker new topics auto-post to the team channel. Report in your assigned work_thread_id. To request an action/decision: response_required=true plus recipients. Reply via reply_to: notifies the author, handles only your request. Optional kind tags your stance: proposal, objection, fact, agreement or question. Requires collaboration authorization.', z.object({ ...session, thread_id: id.optional(), team_root_thread_id:id.optional(), channel_id: id.optional(), title: z.string().trim().min(1).max(200).optional(), task_id: id.optional(), text: z.string().trim().min(1).max(16000), kind: messageKind.optional(), mentions: z.array(z.string().min(8).max(200)).max(20).default([]), reply_to: id.optional(), response_required: z.boolean().optional(), request_id: z.string().min(1).max(200) }).strict()],
  chat_inbox: ['Read your pending mentions and private notices. Private notices have no thread; ask the agent for status via work_thread_id. Read is not handled; unhandled items stay visible. No model polling: the Hub notifies.', z.object({ ...session, unread_only: z.boolean().default(false), ...page }).strict()],
  chat_kick: ['Kick a session from the channel when the person orders it. Only the current leader of that channel (also if you lead it from another channel); give the reason. Not the session that may reclaim the channel nor one that leads other channels: only the person removes those. Keeps history, cancels notices, blocks rejoin. Does not close its terminal or stop running work. Taking over a silent leader is memory_chat_take_leadership, not a kick.', chatKickInput.extend(session).strict()],
  chat_take_leadership: [`Take over or reclaim a channel's leadership; pass the leader_id you read (expected_leader_id) and a reason. Takeover: only a session outside Hub teams, from the channel's project as the Hub derives it, when the leader has had no Hub-verified liveness for over ${LEADER_LIVENESS_TIMEOUT_MS/60000} minutes; it displaces that leader only, who keeps the right to reclaim. Reclaim: the exact displaced session (same session_key) recovers the channel even if the new leader is online. Never on a guess about the leader; check team.leader_offline and leader_last_liveness_at first. Audited and rate limited; the person can always correct it in the UI.`, chatTakeLeadershipInput.extend(session).strict()],
  chat_ack: ['Mark your own mention/private notice handled (message_id=item id) after resolving or answering. Reading alone is not acceptance.', z.object({ ...session, message_id: id }).strict()],
  ...readAccessDefinitions,
  chat_resolve: ['Close/reopen a thread in your channel. Keeps history; never marks messages of others handled.', z.object({ ...session, thread_id: id, state: z.enum(['open','resolved']) }).strict()],
} satisfies Record<string, [string, z.ZodType]>
export const chatReadOperations = ['chat_work_list','chat_channels','chat_agents','chat_threads','chat_read']
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export function sessionStatus(s: Record<string, any>,now=Date.now()) {
  const connected=Date.parse(s.lease_until)>now
  // PID checks and listener heartbeats prove connection only. They cannot renew busy evidence.
  const activityStale=s.state==='busy' && !(Date.parse(s.event_at)>=now-90_000)
  const state=s.removed_at?'removed':s.closed_at?'offline':!connected||activityStale?'unknown':s.state
  return {state,state_reason:state==='unknown'?(connected?'activity_stale':'connection_stale'):null,state_observed_at:s.event_at,
    connection_state:s.removed_at||s.closed_at?'offline':connected?'online':'unknown'}
}
const publicSession = (s: Record<string, any>) => {
  return { id:s.id,label:s.label,nickname:s.nickname,needs_nickname:!s.nickname,cli_kind:s.cli_kind,channel_id:s.channel_id,
    ...sessionStatus(s),
    capability:s.capability,last_seen_at:s.last_seen_at,created_at:s.created_at,closed_at:s.closed_at,wake_error:s.wake_error,
    removed_at:s.removed_at,removed_by:s.removed_by,removal_reason:s.removal_reason }
}

export async function chatFolder(path: string) {
  try {
    let root = await realpath(resolve(path))
    // Never let a Git environment inherited by the Hub redirect another session's worktree.
    const env = { ...process.env }
    for (const name of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR']) delete env[name]
    const run = (args: string[]) => exec('git', ['-C', root, ...args], { env, timeout:5000, maxBuffer:8192 }).then(r=>r.stdout.trim())
    check(await run(['rev-parse','--is-inside-work-tree'])==='true', 'No es un worktree',409)
    root = await realpath(await run(['rev-parse','--show-toplevel']))
    const branch = await run(['symbolic-ref','--short','HEAD']).catch(()=>null)
    const common = await realpath(await run(['rev-parse','--path-format=absolute','--git-common-dir']))
    return { root,branch,repository:resolve(common,'..') }
  } catch (error) {
    const failure=error as NodeJS.ErrnoException & {killed?:boolean}
    if(failure.killed || failure.name==='AbortError' || failure.code==='ETIMEDOUT' || failure.syscall?.startsWith('spawn')) {
      check(false, 'No se pudo ejecutar Git para verificar el worktree. Reintentá cuando Git esté disponible.',503)
    }
    check(false, 'La colaboración requiere un worktree Git disponible. Abrí la sesión dentro de un worktree; para tareas paralelas usá worktrees distintos.',409)
    throw new Error('unreachable')
  }
}

export async function virtualFolder(path: string) {
  const root = await realpath(resolve(path)).catch(()=>null)
  check(root && await stat(root).then(value=>value.isDirectory()).catch(()=>false), 'La carpeta local no está disponible.', 409)
  const env:NodeJS.ProcessEnv = { ...process.env, LC_ALL:'C' }
  for (const name of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR']) delete env[name]
  try {
    await exec('git',['-C',root,'rev-parse','--git-dir'],{env,timeout:5000,maxBuffer:8192})
    check(false,'La ruta pertenece a un repositorio Git pero no es un worktree disponible.',409)
  } catch (error) {
    if ((error as {statusCode?:number}).statusCode) throw error
    const failure=error as NodeJS.ErrnoException & {killed?:boolean}
    if(failure.killed || failure.name==='AbortError' || failure.code==='ETIMEDOUT' || failure.code==='ENOENT' || failure.syscall?.startsWith('spawn'))
      check(false,'No se pudo ejecutar Git para verificar la carpeta. Reintentá cuando Git esté disponible.',503)
    // A dangling .git file or directory is a broken repository, not an ordinary folder. Checked before
    // Git's message: its wording for an unresolvable gitdir differs across Git versions.
    for(let current=root;;current=dirname(current)) {
      const marker=await lstat(join(current,'.git')).catch(cause=>{
        if(cause.code==='ENOENT')return null
        throw new Error('No se pudo verificar el marcador Git de la carpeta.')
      })
      check(!marker,'La carpeta pertenece a un repositorio Git inválido. Reparalo antes de continuar; no se crea un espacio virtual.',409)
      if(dirname(current)===current)break
    }
    check(/not a git repository/i.test(String((error as {stderr?:string}).stderr)),
      'Git no confirmó una carpeta sin repositorio. Revisá permisos y el estado del repositorio antes de crear un espacio virtual.',409)
  }
  return root
}

/** Durable data; events are hints only. Reconnecting listeners always re-read SQLite. */
export class LocalChat {
  usageEnabled: (agentId:string)=>boolean = () => true
  /** Set by MemoryOperations; the Hub runtime calls it on every tick to advance timed-out inter-hub escalations. */
  interhubSweep?: () => Promise<unknown>
  readonly events = new EventEmitter().setMaxListeners(0)
  private async localHub() {
    const { SharedProjects } = await import("./sharing/projects.js")
    const who = await new SharedProjects(this.store).identity()
    return { id: who.id, name: who.name }
  }
  constructor(readonly store: MemoryStore, readonly turnAlertGraceMs=60_000) {}
  get db() { return this.store.db }
  async deleteChannel(input:z.infer<typeof chatDeleteChannelInput>,actor:{user_id:string}|{agent:AgentContext;session_key?:string}) {
    const result=await this.db.transaction(async sql=>{
      const channel=(await sql.query('SELECT * FROM chat_channels WHERE id=$1',[input.channel_id]))[0]
      check(channel,'Canal inexistente.',404)
      let deletedBy:string
      if('agent' in actor) {
        const who=await this.requireNickname(actor.agent,actor.session_key)
        check(channel.leader_id===who.id && (!who.closed_at || channel.deleted_at),
          'Sólo el líder puede eliminar su propio canal; la persona puede eliminar otros desde la UI.',403)
        deletedBy=`agent:${who.id}`
      } else deletedBy=`user:${actor.user_id}`
      const stopping=await sql.query(`SELECT DISTINCT p.id FROM chat_team_plans p JOIN chat_team_members m ON m.team_id=p.id
        WHERE p.master_channel_id=$1 AND m.launch_handle IS NOT NULL AND COALESCE(json_extract(m.runtime,'$.state'),'unknown') NOT IN ('stopped','failed','exited')`,[channel.id])
      if(channel.deleted_at)return {channel_id:channel.id,deleted_at:channel.deleted_at,affected_plans:stopping.map(p=>String(p.id))}
      check(!(await sql.query(`SELECT 1 FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id
        WHERE m.channel_id=$1 AND p.master_channel_id<>$1 AND p.state NOT IN ('cancelled','completed') LIMIT 1`,[channel.id])).length,
        'Este canal pertenece a un worker de un equipo vigente. Cerrá primero el equipo desde su coordinador.',409)
      const plans=await sql.query("SELECT id,root_thread_id FROM chat_team_plans WHERE master_channel_id=$1 AND state NOT IN ('cancelled','completed')",[channel.id])
      for(const plan of plans) {
        await sql.query("UPDATE chat_team_plans SET state='cancelled',closed_at=now(),close_reason=$2,updated_at=now() WHERE id=$1",[plan.id,input.reason])
        await sql.query("UPDATE chat_team_members SET state='closed',invitation_hash=NULL,invitation_expires_at=NULL WHERE team_id=$1",[plan.id])
        await sql.query(`UPDATE chat_deliveries SET cancelled_at=now(),error='Canal eliminado' WHERE handled_at IS NULL AND cancelled_at IS NULL
          AND message_id IN (SELECT m.id FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id WHERE t.id=$1 OR t.team_root_thread_id=$1)`,[plan.root_thread_id])
      }
      const deleted=(await sql.query(`UPDATE chat_channels SET deleted_at=now(),deleted_by=$2,deletion_reason=$3,closed_at=COALESCE(closed_at,now()),
        scope_key='deleted:'||id,orca_workspace_id=NULL,virtual_path=NULL,updated_at=now() WHERE id=$1 RETURNING deleted_at`,[channel.id,deletedBy,input.reason]))[0]!
      await sql.query("UPDATE chat_sessions SET state='offline',closed_at=COALESCE(closed_at,now()),lease_until=NULL,wake_error=NULL WHERE channel_id=$1",[channel.id])
      await sql.query(`UPDATE chat_deliveries SET cancelled_at=now(),error='Canal eliminado' WHERE handled_at IS NULL AND cancelled_at IS NULL
        AND (recipient_id IN (SELECT id FROM chat_sessions WHERE channel_id=$1) OR message_id IN (SELECT m.id FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id WHERE t.channel_id=$1))`,[channel.id])
      await this.cancelInvalidTurnAlerts()
      return {channel_id:channel.id,deleted_at:deleted.deleted_at,affected_plans:[...new Set([...plans,...stopping].map(p=>String(p.id)))]}
    })
    this.events.emit('change')
    return result
  }
  /** Owner-only recovery restores historical visibility, never sessions or processes. */
  async restoreChannel(channelId:string) {
    const restored=(await this.db.query('UPDATE chat_channels SET deleted_at=NULL,updated_at=now() WHERE id=$1 AND deleted_at IS NOT NULL RETURNING *',[channelId]))[0]
    check(restored,'Canal no encontrado en la papelera.',404)
    this.events.emit('change')
    return {channel:restored}
  }
  /** Called only by the authenticated owner route. No MCP tool can claim leadership. */
  async designateCoordinator(input:z.infer<typeof chatCoordinatorInput>,userId:string) {
    const result=await this.db.transaction(async sql=>{
      const channel=(await sql.query('SELECT * FROM chat_channels WHERE id=$1',[input.channel_id]))[0]
      check(channel && !channel.closed_at,'Canal no disponible.',409)
      check(channel.leader_id===input.expected_leader_id,'El coordinador cambió. Actualizá la vista antes de continuar.',409)
      const target=(await sql.query('SELECT * FROM chat_sessions WHERE id=$1 AND channel_id=$2',[input.participant_id,channel.id]))[0]
      check(target?.nickname && !target.closed_at && !target.removed_at && Date.parse(target.lease_until)>Date.now(),'La sesión elegida debe estar registrada y conectada.',409)
      if(channel.leader_id===target.id)return {channel_id:channel.id,leader_id:target.id,affected_plans:[] as string[]}
      const plans=await this.pauseChannelPlans(sql,channel.id,`Coordinador designado por ${userId}`,target.id,{user_id:userId,previous_leader_id:channel.leader_id,leader_id:target.id})
      // The person's designation prevails over any pending reclaim right.
      await sql.query('UPDATE chat_channels SET leader_id=$2,displaced_leader_id=NULL,displaced_at=NULL,leader_changed_at=now(),activated_at=COALESCE(activated_at,now()),updated_at=now() WHERE id=$1',[channel.id,target.id])
      await recordAuthorityEvent(sql,{kind:"leadership_designated",channel_id:channel.id,project_id:await channelProjectId(sql,channel.id),actor_user_id:userId,
        target_session_id:target.id,reason:"Coordinador designado desde la UI",evidence:{previous_leader_id:channel.leader_id,displaced_leader_id:channel.displaced_leader_id ?? null,affected_plans:plans}})
      await this.cancelInvalidTurnAlerts()
      return {channel_id:channel.id,leader_id:target.id,affected_plans:plans}
    })
    this.events.emit('change')
    return result
  }
  /** Owner route only. The phrase is the person's own confirmation; no MCP operation reaches this. */
  async confirmReadRequest(requestId:string,phrase:string,userId:string) {
    const result=await this.db.transaction(sql=>confirmReadRequest(sql,requestId,phrase,userId))
    this.events.emit('change');return result
  }
  async rejectReadRequest(requestId:string,userId:string,note?:string) {
    const result=await this.db.transaction(sql=>rejectReadRequest(sql,requestId,userId,note))
    this.events.emit('change');return result
  }
  async revokeReadGrant(grantId:string,userId:string,reason='Revocado por la persona') {
    const grant=await this.db.transaction(sql=>revokeReadGrant(sql,grantId,reason,{user_id:userId}))
    check(grant,'El permiso no existe o ya terminó.',404)
    this.events.emit('change');return {grant_id:grant.id,revoked:true}
  }
  readRequests(filter:Parameters<typeof personReadRequests>[1]) { return personReadRequests(this.db,filter) }
  readGrants(filter:Parameters<typeof personReadGrants>[1]) { return personReadGrants(this.db,filter) }
  async sweepReadAccess(now=Date.now()) {
    const result=await this.db.transaction(sql=>sweepReadAccess(sql,now))
    if(result.revoked || result.cancelled)this.events.emit('change')
    return result
    }
  /** Leadership changed under these plans: they stop coordinating until their new leader prepares or the person resumes them. */
  private async pauseChannelPlans(sql:Sql,channelId:string,reason:string,actorSessionId:string,payload:Record<string,unknown>) {
    const plans=await sql.query("SELECT id,root_thread_id FROM chat_team_plans WHERE master_channel_id=$1 AND state NOT IN ('cancelled','completed')",[channelId])
    for(const plan of plans) {
      await sql.query("UPDATE chat_team_plans SET state='paused',close_reason=$2,updated_at=now() WHERE id=$1",[plan.id,reason])
      await sql.query("UPDATE chat_team_members SET state='closed',invitation_hash=NULL,invitation_expires_at=NULL WHERE team_id=$1",[plan.id])
      await sql.query(`UPDATE chat_deliveries SET cancelled_at=now(),error='Cambio de coordinador' WHERE handled_at IS NULL AND cancelled_at IS NULL
        AND message_id IN (SELECT m.id FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id WHERE t.id=$1 OR t.team_root_thread_id=$1)`,[plan.root_thread_id])
      await sql.query(`INSERT INTO chat_team_events(id,team_id,type,actor_session_id,source_channel_id,target_thread_id,payload)
        VALUES($1,$2,'coordinator_changed',$3,$4,$5,$6)`,[randomUUID(),plan.id,actorSessionId,channelId,plan.root_thread_id,JSON.stringify(payload)])
    }
    return plans.map(p=>String(p.id))
  }
  private async project(...paths: string[]) {
    let best: { id:string; length:number } | null = null
    for (const path of paths) {
      const exact = await projectForPath(this.db,path)
      if (exact) return exact
    }
    const projects = await this.db.query("SELECT id,data FROM entities WHERE kind='project' AND json_type(data,'$.folders')='array'")
    for (const project of projects) for (const raw of project.data.folders as string[]) {
      const folder = await realpath(resolve(raw)).catch(()=>resolve(raw))
      for (const path of paths) if ((path===folder || path.startsWith(`${folder}/`)) && (!best || folder.length>best.length)) best={ id:project.id,length:folder.length }
    }
    return best
  }
  private async assertNotRemoved(agent:AgentContext,sessionKey?:string) {
    const removed=(await this.db.query(`SELECT id FROM chat_sessions WHERE agent_id=$1 AND removed_at IS NOT NULL
      AND (id=$2 OR gateway_session_id=$2 OR key_hash=$3) LIMIT 1`,[agent.agent_id,agent.session_id,sessionKey ? hash(sessionKey):null]))[0]
    check(!removed,'Esta sesión fue expulsada del canal. No puede reincorporarse ni participar; consultá a la persona.',410)
  }
  /** Human authority only enters through the authenticated UI route, never through MCP arguments. */
  async kick(input:z.infer<typeof chatKickInput> & {project_id?:string},actor:{user_id:string}|{agent:AgentContext;session_key?:string},notify=true) {
    const result=await this.db.transaction(async sql=>{
      const channel=(await sql.query('SELECT * FROM chat_channels WHERE id=$1',[input.channel_id]))[0]
      check(channel && (!input.project_id || channel.project_id===input.project_id),'Canal inexistente en este proyecto',404)
      let removedBy:string
      if('agent' in actor) {
        await this.assertNotRemoved(actor.agent,actor.session_key)
        const who=await this.identity(actor.agent,actor.session_key)
        check(who.nickname, 'Elegí tu propio nick con chat_set_nick antes de participar.',409)
        check(!who.closed_at && channel.leader_id===who.id,'Sólo el líder reconocido de este canal puede expulsar agentes',403)
        check(who.id!==input.participant_id,'El líder no puede expulsarse a sí mismo; la persona puede hacerlo desde la UI',400)
        removedBy=`agent:${who.id}`
      } else removedBy=`user:${actor.user_id}`
      // The person may also remove a leader that lives in another channel: that revokes this leadership only.
      const target=(await sql.query('SELECT * FROM chat_sessions WHERE id=$1 AND (channel_id=$2 OR id=$3)',[input.participant_id,channel.id,'agent' in actor?null:channel.leader_id]))[0]
      check(target && !(NON_AGENT_CLI_KINDS as readonly string[]).includes(target.cli_kind),'El agente no pertenece a este canal',404)
      // A removal drops the reclaim right, so a leader that took the channel could otherwise make its takeover permanent.
      if('agent' in actor)check(target.id!==channel.displaced_leader_id,'Esa sesión puede reclamar este canal; sólo la persona puede expulsarla desde la UI.',403)
      // A removal also releases every channel the target leads; only the takeover rules or the person may end those leaderships.
      if('agent' in actor)check(!(await sql.query('SELECT 1 FROM chat_channels WHERE leader_id=$1 AND id<>$2 AND closed_at IS NULL AND deleted_at IS NULL LIMIT 1',[target.id,channel.id])).length,
        'Esa sesión lidera otros canales; sólo la persona puede expulsarla desde la UI.',403)
      if(target.channel_id!==channel.id) {
        await sql.query('UPDATE chat_channels SET leader_id=NULL,leader_changed_at=now(),updated_at=now() WHERE id=$1 AND leader_id=$2',[channel.id,target.id])
        await recordAuthorityEvent(sql,{kind:"leadership_kick",channel_id:channel.id,project_id:await channelProjectId(sql,channel.id),actor_user_id:removedBy.slice(5),
          target_session_id:target.id,reason:input.reason,evidence:{scope:"leadership_only",home_channel_id:target.channel_id}})
        await this.cancelInvalidTurnAlerts()
        return {session:publicSession(target),team:await this.team(channel.id)}
      }
      if(!target.removed_at) {
        const led=(await sql.query('SELECT id FROM chat_channels WHERE leader_id=$1',[target.id])).map(row=>String(row.id))
        const reclaims=(await sql.query('SELECT id FROM chat_channels WHERE displaced_leader_id=$1',[target.id])).map(row=>String(row.id))
        await sql.query(`UPDATE chat_sessions SET removed_at=now(),removed_by=$2,removal_reason=$3,state='offline',closed_at=now(),lease_until=NULL,wake_error=NULL WHERE id=$1`,[target.id,removedBy,input.reason])
        await sql.query(`UPDATE chat_deliveries SET cancelled_at=now(),error='Destinatario expulsado del canal' WHERE recipient_id=$1 AND handled_at IS NULL AND cancelled_at IS NULL`,[target.id])
        // A removed session can never act again, so it releases every channel it led and any reclaim right.
        await sql.query('UPDATE chat_channels SET leader_id=NULL,leader_changed_at=now(),updated_at=now() WHERE leader_id=$1',[target.id])
        await sql.query('UPDATE chat_channels SET displaced_leader_id=NULL,displaced_at=NULL WHERE displaced_leader_id=$1',[target.id])
        await recordAuthorityEvent(sql,{kind:"session_kicked",channel_id:channel.id,project_id:await channelProjectId(sql,channel.id),
          actor_session_id:'agent' in actor?removedBy.slice(6):null,actor_user_id:'agent' in actor?null:removedBy.slice(5),target_session_id:target.id,
          reason:input.reason,evidence:{released_leaderships:led,released_reclaims:reclaims}})
        await this.cancelInvalidTurnAlerts()
      }
      return {session:publicSession((await sql.query('SELECT * FROM chat_sessions WHERE id=$1',[target.id]))[0]!),team:await this.team(channel.id)}
    })
    if(notify)this.events.emit('change',input.participant_id)
    return result
  }
  /**
   * Attempts (accepted or refused) bound per session and per channel, so refusals cannot flood the audit. Refusals of sessions
   * outside the channel's project never count against the channel, and a reclaim only spends its own budget: other sessions
   * must not be able to lock the displaced leader out of its channel.
   */
  private async leadershipAttemptsLeft(sql:Sql,sessionId:string,channelId:string,now=Date.now(),reclaim=false) {
    const counts=(await sql.query(`SELECT COALESCE(SUM(CASE WHEN actor_session_id=$2 THEN 1 ELSE 0 END),0) AS mine,
      COALESCE(SUM(CASE WHEN kind='leadership_rejected' AND json_extract(evidence,'$.code')='project_mismatch' THEN 0 ELSE 1 END),0) AS total FROM chat_authority_events
      WHERE channel_id=$1 AND kind IN ('leadership_takeover','leadership_reclaim','leadership_rejected') AND created_at>$3`,
    [channelId,sessionId,new Date(now-LEADERSHIP_ATTEMPT_WINDOW_MS).toISOString()]))[0]!
    return Number(counts.mine)<LEADERSHIP_ATTEMPTS_PER_SESSION && (reclaim || Number(counts.total)<LEADERSHIP_ATTEMPTS_PER_CHANNEL)
  }
  /**
   * Takeover and reclaim are one compare-and-set on leader_id inside the writer transaction: two candidates, or a candidate
   * and a reconnecting leader, serialize and the loser sees a changed leader_id. A channel never has two leaders, and the
   * old leader is replaced in the same statement, never left without one. Liveness is re-read here, never trusted from input.
   */
  async takeLeadership(input:z.infer<typeof chatTakeLeadershipInput>,who:Record<string,any>) {
    return this.db.transaction(async sql=>{
      const now=Date.now()
      const channel=(await sql.query('SELECT * FROM chat_channels WHERE id=$1',[input.channel_id]))[0]
      check(channel && !channel.deleted_at,'Canal inexistente.',404)
      const projectId=await channelProjectId(sql,channel.id)
      // Identity is the authenticated session row (session_key hash + gateway agent), compared by id; a nickname proves nothing.
      const reclaim=channel.displaced_leader_id===who.id
      check(await this.leadershipAttemptsLeft(sql,who.id,channel.id,now,reclaim),
        'Demasiados intentos de liderazgo sobre este canal. Esperá unos minutos o pedí a la persona que designe el coordinador desde la UI.',429)
      const refuse=(status:number,code:string,message:string,evidence:Record<string,unknown>={}):never=>{
        const audit:AuthorityEvent={kind:"leadership_rejected",channel_id:channel.id,project_id:projectId,actor_session_id:who.id,
          target_session_id:channel.leader_id ?? null,reason:input.reason,evidence:{code,...evidence}}
        throw Object.assign(new MemoryError(status,message,false,code),{leadershipAudit:audit})
      }
      if(channel.leader_id===who.id)return {channel_id:channel.id,leader_id:who.id,mode:'unchanged' as const,previous_leader_id:who.id,affected_plans:[] as string[],team:await this.team(channel.id)}
      // First refusal for any session outside the project, so they learn nothing else about the channel and spend no channel budget.
      const sessionProject=await sessionProjectId(sql,who.id)
      if(!projectId || sessionProject!==projectId)
        refuse(403,'project_mismatch','Sólo un agente del mismo proyecto del canal, según el Hub, puede tomar su liderazgo.',{session_project_id:sessionProject})
      if(channel.closed_at)refuse(409,'channel_closed','El canal está cerrado.')
      if(channel.kind==='virtual' && !channel.activated_at)refuse(409,'channel_inactive','El canal no está activo.')
      if((await sql.query('SELECT 1 FROM chat_team_members WHERE channel_id=$1 LIMIT 1',[channel.id])).length)
        refuse(409,'worker_channel','Es el canal de un worker de equipo; su coordinador lo reemplaza con memory_team_control.')
      if(channel.leader_id!==input.expected_leader_id)
        refuse(409,'leader_changed','El líder del canal cambió. Volvé a consultar team.leader_id antes de reintentar.',{current_leader_id:channel.leader_id})
      let evidence:Record<string,unknown>
      if(reclaim) {
        // The authenticated call of the exact displaced session is its connection proof; it renews the lease below.
        evidence={previous_leader_id:channel.leader_id,displaced_at:channel.displaced_at}
      } else {
        const inTeam=(await sql.query(`SELECT 1 FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id
          WHERE m.session_id=$1 AND m.state='joined' AND p.state IN (${ACTIVE_TEAM_STATES.map(s=>`'${s}'`).join(',')}) LIMIT 1`,[who.id])).length
        if(who.capability==='hub_fleet' || inTeam)refuse(403,'team_member','Los miembros de un equipo del Hub no toman canales; pedíselo a su coordinador.')
        if(!channel.leader_id)refuse(409,'no_leader','El canal no tiene líder: el Hub lo asigna a su próximo participante activo o la persona lo designa en la UI.')
        const lost=(await sql.query(`SELECT created_at FROM chat_authority_events WHERE channel_id=$1 AND target_session_id=$2
          AND kind IN ('leadership_takeover','leadership_reclaim') AND created_at>$3 ORDER BY seq DESC LIMIT 1`,[channel.id,who.id,new Date(now-LEADERSHIP_COOLDOWN_MS).toISOString()]))[0]
        if(lost)refuse(409,'cooldown',`Perdiste el liderazgo de este canal hace menos de ${LEADERSHIP_COOLDOWN_MS/60000} minutos; esperá antes de volver a tomarlo.`,{lost_at:lost.created_at,cooldown_ms:LEADERSHIP_COOLDOWN_MS})
        const leader=(await sql.query('SELECT * FROM chat_sessions WHERE id=$1',[channel.leader_id]))[0]!
        const liveness=lastLiveness(leader,now)
        if(leaseActive(leader,now))refuse(409,'leader_live','El líder tiene liveness vigente según el Hub; coordiná con él por el canal.',{...liveness,threshold_ms:LEADER_LIVENESS_TIMEOUT_MS})
        if(liveness.silent_ms<=LEADER_LIVENESS_TIMEOUT_MS)
          refuse(409,'leader_recent',`El líder lleva ${Math.floor(liveness.silent_ms/60000)} min sin liveness verificado; la toma requiere más de ${LEADER_LIVENESS_TIMEOUT_MS/60000}.`,{...liveness,threshold_ms:LEADER_LIVENESS_TIMEOUT_MS})
        evidence={previous_leader_id:channel.leader_id,...liveness,threshold_ms:LEADER_LIVENESS_TIMEOUT_MS}
      }
      const previous=channel.leader_id as string|null
      // Takeover leaves the displaced leader a reclaim right; a reclaim leaves none to the one it replaces (no ping-pong).
      const changed=await sql.query(`UPDATE chat_channels SET leader_id=$2,displaced_leader_id=$3,displaced_at=CASE WHEN $3 IS NULL THEN NULL ELSE now() END,
        leader_changed_at=now(),updated_at=now() WHERE id=$1 AND leader_id IS $4 AND closed_at IS NULL RETURNING id`,[channel.id,who.id,reclaim?null:previous,previous])
      check(changed.length===1,'El líder del canal cambió durante la operación; volvé a consultar.',409)
      await sql.query('UPDATE chat_sessions SET last_seen_at=now(),lease_until=$2 WHERE id=$1 AND closed_at IS NULL',[who.id,new Date(now+SESSION_LEASE_MS).toISOString()])
      const plans=await this.pauseChannelPlans(sql,channel.id,reclaim?'Liderazgo reclamado':'Liderazgo tomado por falta de liveness',who.id,
        {previous_leader_id:previous,leader_id:who.id,mode:reclaim?'reclaim':'takeover'})
      const event=await recordAuthorityEvent(sql,{kind:reclaim?"leadership_reclaim":"leadership_takeover",channel_id:channel.id,project_id:projectId,
        actor_session_id:who.id,target_session_id:previous,reason:input.reason,evidence:{...evidence,affected_plans:plans}})
      if(previous) {
        const minutes=typeof evidence.silent_ms==='number'?Math.floor(evidence.silent_ms/60000):null
        const text=reclaim
          ? `Agent Hub: ${who.label}, displaced earlier from channel "${channel.name}" (${channel.id}), reclaimed its leadership. You no longer lead or write there; channels you lead elsewhere are unchanged. Audit event ${event.id}.`
          : `Agent Hub: ${who.label} took over leadership of channel "${channel.name}" (${channel.id}) after ${minutes} min without Hub-verified liveness from you. You no longer lead or write there. This same session can reclaim it with memory_chat_take_leadership(channel_id, expected_leader_id=${who.id}, reason). Audit event ${event.id}.`
        await this.leadershipNotice(sql,channel.id,previous,event.id,reclaim?'leadership_reclaimed':'leadership_taken',text)
      }
      await this.cancelInvalidTurnAlerts()
      return {channel_id:channel.id,leader_id:who.id,mode:reclaim?'reclaim' as const:'takeover' as const,previous_leader_id:previous,
        event_id:event.id,affected_plans:plans,team:await this.team(channel.id)}
    })
  }
  /** Durable private notice from the channel's system identity; one pending per channel and recipient. */
  private async leadershipNotice(sql:Sql,channelId:string,recipientId:string,eventId:string,cause:string,text:string) {
    const sender=`hub-system:${channelId}`
    await sql.query(`INSERT OR IGNORE INTO chat_sessions(id,agent_id,key_hash,label,cli_kind,channel_id,state,event_at,closed_at)
      VALUES($1,'agenthub-system',$2,'Agent Hub','hub',$3,'offline',now(),now())`,[sender,hash(randomUUID()),channelId])
    await sql.query(`UPDATE chat_status_notices SET cancelled_at=now(),error='Aviso de liderazgo superado' WHERE session_id=$1 AND recipient_id=$2
      AND handled_at IS NULL AND cancelled_at IS NULL`,[sender,recipientId])
    await sql.query(`INSERT INTO chat_status_notices(id,session_id,turn_id,cause,channel_id,recipient_id,text) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(),sender,`leadership:${eventId}`,cause,channelId,recipientId,text])
  }
  async team(channelId:string, includeGuidance=false, sessionId?:string) {
    const c=(await this.db.query('SELECT c.leader_id,c.displaced_leader_id,s.nickname,s.label,s.closed_at,s.lease_until,s.last_seen_at,s.created_at FROM chat_channels c LEFT JOIN chat_sessions s ON s.id=c.leader_id WHERE c.id=$1',[channelId]))[0]!
    const linked=sessionId ? (await this.db.query(`SELECT t.id AS team_id,t.created_by AS master_leader_id,t.root_thread_id,t.master_channel_id,m.work_thread_id
      FROM chat_team_members m JOIN chat_team_plans t ON t.id=m.team_id
      JOIN chat_channels master ON master.id=t.master_channel_id JOIN chat_sessions leader ON leader.id=t.created_by
      WHERE m.session_id=$1 AND m.channel_id=$2 AND m.state='joined'
      AND t.state IN ('launching','launched','partial','uncertain','active') AND master.closed_at IS NULL
      AND master.leader_id=t.created_by AND leader.closed_at IS NULL AND leader.removed_at IS NULL`,[sessionId,channelId]))[0] ?? null : null
    const version=hash(JSON.stringify([teamGuidanceVersion,c.leader_id,linked])).slice(0,16)
    return {scope:'channel' as const,channel_id:channelId,leader_id:c.leader_id,leader_nickname:c.nickname ?? c.label,
      leader_offline:Boolean(c.leader_id && (c.closed_at || !(Date.parse(c.lease_until)>Date.now()))),
      leader_last_liveness_at:c.leader_id ? lastLiveness(c).last_liveness_at : null,displaced_leader_id:c.displaced_leader_id ?? null,
      linked_team:linked,guidance_version:version,...(includeGuidance?{guidance:teamGuidance}:{})}
  }
  async activate(sid:string) {
    // Registration and inbox bootstrap are available before choosing a nickname.
    if(!(await this.db.query(`SELECT 1 FROM chat_sessions WHERE id=$1 AND nickname IS NOT NULL AND trim(nickname)<>''`,[sid])).length)return
    // A displaced leader recovers a channel only through an explicit, audited reclaim.
    await this.db.transaction(async sql=>{
      const assigned=await sql.query(`UPDATE chat_channels SET leader_id=$1 WHERE leader_id IS NULL AND closed_at IS NULL AND displaced_leader_id IS NOT $1
        AND (kind<>'virtual' OR activated_at IS NOT NULL) AND id=(SELECT channel_id FROM chat_sessions WHERE id=$1 AND closed_at IS NULL) RETURNING id`,[sid])
      for(const row of assigned)await recordAuthorityEvent(sql,{kind:"leadership_assigned",channel_id:String(row.id),project_id:await channelProjectId(sql,String(row.id)),
        target_session_id:sid,reason:"Asignado automáticamente al primer participante activo de un canal sin líder",evidence:{mode:"auto"}})
    })
    await this.db.query(`UPDATE chat_sessions SET team_seen=1 WHERE id=$1 AND EXISTS(
      SELECT 1 FROM chat_channels c WHERE c.id=chat_sessions.channel_id AND c.closed_at IS NULL AND (c.kind<>'virtual' OR c.activated_at IS NOT NULL))`,[sid])
  }
  private async registration(session:Record<string,any>,channel:Record<string,any>,sessionKey:string|undefined,active:boolean) {
    if(active)await this.activate(session.id)
    const team=await this.team(channel.id,true,session.id)
    return {session:{...publicSession(session),role:team.leader_id===session.id?'leader':'member'},channel:{...channel,leader_id:team.leader_id},team,...(sessionKey ? {session_key:sessionKey}:{})}
  }
  async register(agent: AgentContext, sessionKey: string, nativeId: string | null = null, active=true) {
    await this.assertNotRemoved(agent,sessionKey)
    // A routing key is bound to its conversation and channel, including migrated history.
    // Old gateways and resumed clients may not carry the workspace metadata yet.
    const known = (await this.db.query('SELECT * FROM chat_sessions WHERE key_hash=$1',[hash(sessionKey)]))[0]
    if (known) {
      check(known.agent_id===agent.agent_id,'La identidad pertenece a otro cliente',403)
      await this.db.query('UPDATE chat_sessions SET gateway_session_id=COALESCE(gateway_session_id,$2) WHERE id=$1',[known.id,agent.session_id])
      const channel=(await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[known.channel_id]))[0]!
      await this.joinableChannel(channel)
      return this.registration(known,channel,sessionKey,active)
    }
    check(agent.cwd, 'La sesión necesita una carpeta de trabajo', 409)
    const root=await this.workspaceFolder(agent.cwd)
    let workspace=agent.orca_workspace_id ? parse(orcaWorkspaceSchema,agent.orca_workspace_id) : null
    if(workspace) {
      const knownWorkspace=(await this.db.query('SELECT path FROM chat_channels WHERE orca_workspace_id=$1 ORDER BY created_at LIMIT 1',[workspace]))[0]
      const claimed=await realpath(resolve(workspace.includes('::')?workspace.slice(workspace.indexOf('::')+2):knownWorkspace?.path ?? root)).catch(()=>null)
      const child=claimed===null?null:relative(claimed,root)
      if(child===null || child==='..' || child.startsWith('..'+sep) || isAbsolute(child))workspace=null
    }
    const git=await chatFolder(root).catch(()=>null)
    const path=git?.root ?? root
    const project=await this.project(path,git?.repository ?? path)
    // A transport connection has a private, inactive scope. Folders and worktrees
    // are execution metadata; they never enroll unrelated conversations together.
    const channel=(await this.db.query(`INSERT INTO chat_channels(id,project_id,path,name,scope_key,orca_workspace_id,kind,branch,repository)
      VALUES($1,$2,$3,$4,$5,$6,'virtual',$7,$8)
      ON CONFLICT(scope_key) DO UPDATE SET updated_at=now() RETURNING *`,
      [randomUUID(),project?.id ?? null,path,basename(path)||path,`session:${hash(sessionKey)}`,workspace,git?.branch ?? null,git?.repository ?? null]))[0]!
    return this.db.transaction(async () => {
      const existing = (await this.db.query('SELECT * FROM chat_sessions WHERE key_hash=$1', [hash(sessionKey)]))[0]
      check(!existing || existing.agent_id === agent.agent_id, 'La identidad pertenece a otro cliente', 403)
      const sid = existing?.id ?? (nativeId ? agent.session_id : randomUUID())
      const priorIdentity=(await this.db.query('SELECT id,agent_id,channel_id FROM chat_sessions WHERE id=$1',[sid]))[0]
      check(!priorIdentity || (priorIdentity.agent_id===agent.agent_id && priorIdentity.channel_id===channel.id),
        'La conversación nativa ya pertenece a otro canal y no puede migrarse; conservá la session_key de esa conversación.',409)
      const value = (await this.db.query(`INSERT INTO chat_sessions(id,agent_id,native_id,key_hash,label,cli_kind,channel_id,event_at,lease_until,gateway_session_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET channel_id=excluded.channel_id,key_hash=excluded.key_hash RETURNING *`,
      [sid, agent.agent_id, nativeId, hash(sessionKey), 'Sin nick todavía', agent.cli_kind, channel.id, '1970-01-01T00:00:00.000Z', new Date(Date.now()+90000).toISOString(),agent.session_id]))[0]!
      return this.registration(value,channel,sessionKey,active)
    })
  }
  /** Explicit task channels preserve conversation identity and never claim a workspace. */
  async createTaskChannel(sessionId:string,taskKey:string,name=taskKey,description?:string) {
    return this.db.transaction(async sql=>{
      const who=(await sql.query('SELECT * FROM chat_sessions WHERE id=$1',[sessionId]))[0]
      check(who?.nickname && !who.closed_at && !who.removed_at,'La sesión debe estar registrada y activa.',409)
      const current=(await sql.query('SELECT * FROM chat_channels WHERE id=$1',[who.channel_id]))[0]!
      check(!current.closed_at,'El canal está cerrado.',409)
      const path=current.path
      const scopeKey=`task:${hash(JSON.stringify([sessionId,taskKey]))}`
      const prior=(await sql.query('SELECT * FROM chat_channels WHERE scope_key=$1',[scopeKey]))[0]
      if(prior?.id===who.channel_id) {
        if(description!==undefined && description!==current.description)return {session:who,channel:(await sql.query('UPDATE chat_channels SET description=$2,updated_at=now() WHERE id=$1 RETURNING *',[current.id,description]))[0]!}
        return {session:who,channel:current}
      }
      check(!prior,'Esta tarea ya tiene un canal anterior; no se puede cambiar de alcance con un reintento viejo.',409)
      check(!(await sql.query(`SELECT 1 FROM chat_team_plans p WHERE p.state NOT IN ('cancelled','completed') AND
        (p.created_by=$1 OR EXISTS(SELECT 1 FROM chat_team_members m WHERE m.team_id=p.id AND m.session_id=$1 AND m.state<>'closed')) LIMIT 1`,[who.id])).length,
        'La sesión ya participa en un equipo. Cerrá ese equipo antes de iniciar otra tarea.',409)
      check(!(await sql.query("SELECT 1 FROM chat_work_state WHERE session_id=$1 AND status<>'completed' LIMIT 1",[who.id])).length,
        'La sesión tiene trabajo pendiente; finalizalo antes de iniciar otra tarea.',409)
      const channel=(await sql.query(`INSERT INTO chat_channels(id,project_id,path,name,branch,repository,scope_key,kind,leader_id,activated_at,orca_workspace_id,description)
        VALUES($1,$2,$3,$4,$8,$9,$5,'virtual',$6,now(),$7,$10) RETURNING *`,
        [randomUUID(),current.project_id,path,name,scopeKey,who.id,current.orca_workspace_id,current.branch,current.repository,description ?? null]))[0]!
      // Leadership is per channel: the previous channel keeps this session as its leader (multi-channel).
      const moved=(await sql.query('UPDATE chat_sessions SET channel_id=$2,team_seen=1 WHERE id=$1 RETURNING *',[who.id,channel.id]))[0]!
      // A turn already opened by the CLI now belongs to this explicitly requested task.
      await sql.query('UPDATE chat_turns SET channel_id=$2,team_id=NULL,report_recipient_id=NULL WHERE session_id=$1 AND terminal_at IS NULL',[who.id,channel.id])
      await sql.query("UPDATE chat_deliveries SET cancelled_at=now(),error='La sesión inició otra tarea' WHERE recipient_id=$1 AND handled_at IS NULL AND cancelled_at IS NULL",[who.id])
      await sql.query("UPDATE chat_status_notices SET cancelled_at=now(),error='La sesión inició otra tarea' WHERE (session_id=$1 OR recipient_id=$1) AND handled_at IS NULL AND cancelled_at IS NULL",[who.id])
      return {session:moved,channel}
    })
  }
  /** Agent-facing enrollment never reveals the channel, peers, tasks or messages before naming. */
  enrollmentView(result: Record<string,any>): any {
    if (!result.session?.needs_nickname) return result
    return {session:{id:result.session.id,needs_nickname:true},
      ...(result.session_key ? {session_key:result.session_key}:{}),
      registration_required:true, next_action:'memory_chat_set_nick'}
  }
  async requireNickname(agent:AgentContext,sessionKey?:string) {
    const rows=await this.db.query(sessionKey
      ? 'SELECT * FROM chat_sessions WHERE agent_id=$1 AND key_hash=$2'
      : 'SELECT * FROM chat_sessions WHERE agent_id=$1 AND (id=$2 OR gateway_session_id=$2)',
      [agent.agent_id,sessionKey ? hash(sessionKey):agent.session_id])
    check(rows.length===1 && rows[0]?.nickname && !rows[0]?.removed_at,
      'Registrate con memory_chat_join y elegí tu nick con memory_chat_set_nick antes de consultar colaboración.',409)
    return rows[0]!
  }
  async identity(agent: AgentContext | undefined, sessionKey?: string) {
    check(agent, 'Sólo los agentes pueden participar en la colaboración local', 403)
    const s = (await this.db.query(sessionKey ? 'SELECT * FROM chat_sessions WHERE key_hash=$1 AND agent_id=$2' : 'SELECT * FROM chat_sessions WHERE id=$1 AND agent_id=$2',
      [sessionKey ? hash(sessionKey) : agent.session_id, agent.agent_id]))[0]
    check(s, 'Registrate con chat_join o usá la session_key que recibiste al iniciar. No se puede adivinar la sesión.', 409)
    check(!s.removed_at,'Esta sesión fue expulsada del canal',410)
    return s
  }
  async lifecycle(agent: AgentContext, input: { session_key: string; native_id: string; event: string; at: string; turn_id?:string | undefined; process_id?: number | undefined; process_started?: string | undefined; transport?:string | undefined; model?:string | undefined; source?:string | undefined }) {
    const result=await this.db.transaction(async()=>{
    await this.assertNotRemoved(agent,input.session_key)
    const known = (await this.db.query('SELECT * FROM chat_sessions WHERE key_hash=$1 AND agent_id=$2',[hash(input.session_key),agent.agent_id]))[0]
    if(known)await this.joinableChannel((await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[known.channel_id]))[0]!)
    // Revoke before this event reopens the session or renews its lease: grants must not outlive a close or a silence.
    if(known && (known.closed_at || !(Date.parse(known.lease_until)>Date.now()-READ_GRANT_LIVENESS_GRACE_MS)))await sweepReadAccess(this.db)
    const registration = !known || input.event==='SessionStart' ? await this.register(agent,input.session_key,input.native_id,false)
      : { session:publicSession(known),channel:(await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[known.channel_id]))[0],session_key:input.session_key }
    const sid = registration.session.id
    const latest=(await this.db.query('SELECT turn_id FROM chat_turns WHERE session_id=$1 ORDER BY opened_at DESC LIMIT 1',[sid]))[0]
    const terminal=['Stop','AfterAgent','SessionEnd','StopFailure','Interrupt'].includes(input.event)
    const repeatedClosedStart=input.turn_id && ['HubPromptSubmit','UserPromptSubmit','BeforeAgent'].includes(input.event) &&
      (await this.db.query('SELECT 1 FROM chat_turns WHERE session_id=$1 AND turn_id=$2 AND terminal_at IS NOT NULL',[sid,input.turn_id])).length>0
    // PostModelSwitch only reports the model in use; it is never a turn event and must not change the session state.
    const accepted=input.event!=='PostModelSwitch' && (!known?.closed_at || input.event==='SessionStart') && known?.capability!=='hub_fleet' && (!known || known.event_at<=input.at) && !repeatedClosedStart && !(terminal && input.turn_id && latest?.turn_id!==input.turn_id)
    if(accepted && ['UserPromptSubmit','BeforeAgent'].includes(input.event))await this.activate(sid)
    const state = ['SessionStart','Stop','AfterAgent'].includes(input.event) ? 'idle' : ['Interrupt','StopFailure'].includes(input.event) ? 'blocked' : input.event === 'SessionEnd' ? 'offline' : 'busy'
    if (accepted && input.event !== 'Heartbeat' && input.event !== 'Watch') {
      await this.db.query(`UPDATE chat_sessions SET state=$2,event_at=$3,last_seen_at=now(),lease_until=$4,
        closed_at=CASE WHEN $2='offline' THEN $3 ELSE NULL END,process_id=COALESCE($5,process_id),process_started=COALESCE($6,process_started),
        capability=CASE WHEN $7 IS NOT NULL THEN $7 WHEN cli_kind='codex_cli' AND capability NOT IN ('codex_appserver','tui_prompt') THEN 'codex_queue' ELSE capability END
        WHERE id=$1 AND event_at<=$3`, [sid, state, input.at, new Date(Date.now()+90000).toISOString(), input.process_id ?? null, input.process_started ?? null, input.transport ?? null])
      await this.captureNative(sid,agent,input)
      if(state==='offline')await sweepReadAccess(this.db)
    } else if(input.event==='PostModelSwitch') {
      if(known && !known.closed_at && input.model)await this.db.query(`UPDATE chat_sessions SET model=$2,model_observed_at=$3
        WHERE id=$1 AND native_id=$4 AND (model_observed_at IS NULL OR model_observed_at<=$3)`,[sid,input.model,input.at,input.native_id])
    } else if(input.event==='Heartbeat' || input.event==='Watch') {
      await this.db.query(`UPDATE chat_sessions SET last_seen_at=now(),lease_until=$2,
        capability=CASE WHEN capability='hub_fleet' THEN capability WHEN $3='Watch' AND $4 IS NOT NULL THEN $4 WHEN $3='Watch' AND cli_kind='claude_code' THEN 'claude_rewake' ELSE capability END WHERE id=$1 AND closed_at IS NULL`,
      [sid, new Date(Date.now()+90000).toISOString(), input.event,input.transport ?? null])
    }
    if(accepted)await this.recordTurnEvent(sid,input.event,input.at,input.turn_id)
    if(accepted && input.event==='SessionStart') {
      await this.db.query('UPDATE chat_deliveries SET attempts=0,next_attempt_at=now(),error=NULL WHERE recipient_id=$1 AND read_at IS NULL',[sid])
      await this.db.query('UPDATE chat_status_notices SET attempts=0,next_attempt_at=now(),error=NULL WHERE recipient_id=$1 AND read_at IS NULL AND notified_at IS NULL AND cancelled_at IS NULL',[sid])
      await this.db.query('UPDATE chat_sessions SET bootstrap_attempts=0,bootstrap_sent_at=NULL WHERE id=$1 AND team_seen=0',[sid])
    }
    const s = (await this.db.query('SELECT * FROM chat_sessions WHERE id=$1',[sid]))[0]!
    const team=await this.team(s.channel_id,input.event==='SessionStart',s.id)
    return { ...registration, session: {...publicSession(s),role:team.leader_id===sid?'leader':'member'},team,pending: await this.pending(sid) }
    })
    this.events.emit('change',result.session.id)
    return result
  }
  /**
   * Metadata the CLI itself reported through its hook. An absent field never erases a known one, the first captured
   * directory is kept unless a new SessionStart reports another, and nothing is inferred or completed from a catalog.
   */
  private async captureNative(sid:string,agent:AgentContext,input:{native_id:string;event:string;at:string;model?:string | undefined;source?:string | undefined}) {
    await this.db.query(`UPDATE chat_sessions SET model=COALESCE($2,model),model_observed_at=CASE WHEN $2 IS NOT NULL THEN $6 ELSE model_observed_at END,
      start_source=CASE WHEN $3 IS NOT NULL AND ($4='SessionStart' OR start_source IS NULL) THEN $3 ELSE start_source END,
      native_cwd=CASE WHEN $5 IS NOT NULL AND ($4='SessionStart' OR native_cwd IS NULL) THEN $5 ELSE native_cwd END,
      surface=COALESCE(surface,'interactive'),id_captured_by=COALESCE(id_captured_by,'hook'),id_captured_at=COALESCE(id_captured_at,$6),resumable=1
      WHERE id=$1 AND native_id IS NOT NULL AND native_id=$7 AND (id_captured_at IS NULL OR $2 IS NOT NULL OR $3 IS NOT NULL OR $4='SessionStart')`,
    [sid,input.model ?? null,input.source ?? null,input.event,agent.cwd,input.at,input.native_id])
  }
  /** Authoritative native protocol from a Hub-owned process; never a caller-supplied tool. */
  async managedLifecycle(sessionId:string,event:string,at:string,turnId?:string) {
    check(['UserPromptSubmit','Stop','SessionEnd','StopFailure','RequestUserInput'].includes(event) && Number.isFinite(Date.parse(at)), 'Evento de flota inválido',400)
    const changed=await this.db.transaction(async()=>{
      const session=(await this.db.query('SELECT * FROM chat_sessions WHERE id=$1',[sessionId]))[0]
      if(!session || session.removed_at || session.closed_at)return false
      const member=(await this.db.query(`SELECT m.state,p.state AS plan_state,c.closed_at AS channel_closed_at
        FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id JOIN chat_channels c ON c.id=m.channel_id
        WHERE m.session_id=$1 AND m.channel_id=$2`,[sessionId,session.channel_id]))[0]
      if(!member)return false
      const active=!member.channel_closed_at && !['cancelled','completed','paused'].includes(member.plan_state) && member.state==='joined'
      if(['UserPromptSubmit','RequestUserInput'].includes(event) && (!active || !turnId))return false
      // Once bound, only native protocol timestamps may advance activity. Hooks can renew connection only.
      if(session.capability==='hub_fleet' && session.event_at>at)return false
      const latest=(await this.db.query('SELECT turn_id,terminal_at FROM chat_turns WHERE session_id=$1 ORDER BY opened_at DESC LIMIT 1',[sessionId]))[0]
      if(event!=='UserPromptSubmit' && turnId && latest && latest.turn_id!==turnId && session.capability==='hub_fleet')return false
      if(event==='UserPromptSubmit' && (await this.db.query('SELECT 1 FROM chat_turns WHERE session_id=$1 AND turn_id=$2 AND terminal_at IS NOT NULL',[sessionId,turnId])).length)return false
      const state=event==='UserPromptSubmit'?'busy':event==='Stop'?'idle':event==='SessionEnd'?'offline':'blocked'
      await this.db.query(`UPDATE chat_sessions SET capability='hub_fleet',state=$2,event_at=$3,last_seen_at=now(),lease_until=$4,
        closed_at=CASE WHEN $2='offline' THEN $3 ELSE NULL END,process_id=NULL,process_started=NULL WHERE id=$1`,
        [sessionId,state,at,new Date(Date.now()+90000).toISOString()])
      if(active)await this.recordTurnEvent(sessionId,event,at,turnId)
      return true
    })
    if(changed)this.events.emit('change',sessionId)
  }
  /** Structured native questions only; no terminal content. Works before the worker has joined. */
  async managedQuestions(senderId:string,questions:TeamPendingQuestion[],generation:string) {
    if(!questions.length)return
    const changed=await this.db.transaction(async sql=>{
      const member=(await sql.query(`SELECT m.*,p.created_by AS master_id,p.root_thread_id,p.master_channel_id,p.state AS plan_state,
        c.leader_id,c.closed_at AS master_closed,leader.removed_at AS leader_removed,leader.channel_id AS leader_channel
        FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id
        JOIN chat_channels c ON c.id=p.master_channel_id JOIN chat_sessions leader ON leader.id=p.created_by
        WHERE (m.id=$1 OR m.session_id=$1) AND m.runtime IS NOT NULL`,[senderId]))[0]
      if(!member || member.runtime.generation!==generation || member.master_closed || member.leader_removed ||
        member.leader_id!==member.master_id || member.leader_channel!==member.master_channel_id || ['paused','cancelled','completed','prepared'].includes(member.plan_state) || member.state==='closed')return false
      const sender=`hub-system:${member.master_channel_id}`
      let sent=false
      for(const pending of questions) {
        if(!member.runtime.questions?.some((item:TeamPendingQuestion)=>item.id===pending.id))continue
        const request=`fleet-question:${generation}:${pending.id}`
        if((await sql.query('SELECT id FROM chat_messages WHERE author_id=$1 AND request_id=$2',[sender,request])).length)continue
        await sql.query(`INSERT OR IGNORE INTO chat_sessions(id,agent_id,key_hash,label,cli_kind,channel_id,state,event_at,closed_at)
          VALUES($1,'agenthub-system',$2,'Agent Hub','hub',$3,'offline',now(),now())`,[sender,hash(randomUUID()),member.master_channel_id])
        const detail=pending.questions.map(q=>`${q.id}: ${q.question}${q.options?.length?'\nOptions: '+q.options.map(o=>o.label+' — '+o.description).join('; '):''}`).join('\n\n')
        const text=`Agent Hub · native question from ${member.worktree_name} for the leader. Resolve with available context and authorization; if the person must decide, ask them in their language, then answer via memory_team_answer. Never invent permissions.\nplan_id=${member.team_id} member_id=${member.id} expected_generation=${generation} question_id=${pending.id}\n${detail}`.slice(0,15800)
        const message=randomUUID()
        await sql.query(`INSERT INTO chat_messages(id,thread_id,author_id,text,request_id,request_hash) VALUES($1,$2,$3,$4,$5,$6)`,
          [message,member.root_thread_id,sender,text,request,hash(text)])
        await sql.query('INSERT INTO chat_deliveries(message_id,recipient_id) VALUES($1,$2)',[message,member.master_id])
        await sql.query('UPDATE chat_threads SET updated_at=now(),archived_notice=0 WHERE id=$1',[member.root_thread_id])
        sent=true
      }
      return sent
    })
    if(changed)this.events.emit('change')
  }
  async pending(sid: string) {
    await this.cancelInvalidTurnAlerts()
    return this.db.query(`SELECT * FROM (
      SELECT d.message_id,m.thread_id,m.created_at FROM chat_deliveries d JOIN chat_messages m ON m.id=d.message_id
       WHERE d.recipient_id=$1 AND d.read_at IS NULL AND d.cancelled_at IS NULL
      UNION ALL
      SELECT id AS message_id,NULL AS thread_id,created_at FROM chat_status_notices
       WHERE recipient_id=$1 AND read_at IS NULL AND handled_at IS NULL AND cancelled_at IS NULL
      ) ORDER BY created_at,message_id LIMIT 100`,[sid])
  }

  /** Hook events are evidence of a turn boundary, not proof of task completion. */
  private async recordTurnEvent(sessionId:string,event:string,at:string,turnId?:string) {
    if(!['HubPromptSubmit','UserPromptSubmit','BeforeAgent','Stop','AfterAgent','SessionEnd','StopFailure','Interrupt'].includes(event))return
    if(['HubPromptSubmit','UserPromptSubmit','BeforeAgent'].includes(event)) {
      const key=turnId ?? `fallback:${at}`
      const current=(await this.db.query('SELECT * FROM chat_turns WHERE session_id=$1 AND turn_id=$2',[sessionId,key]))[0]
      // A native id is idempotent: a repeated start never reopens its closed turn.
      if(current)return
      const open=(await this.db.query('SELECT * FROM chat_turns WHERE session_id=$1 AND terminal_at IS NULL ORDER BY opened_at DESC LIMIT 1',[sessionId]))[0]
      // Several transports repeat busy/start events. Without an id there is no evidence of a new turn.
      if(open && !turnId && !open.alerted_at)return
      if(open)await this.db.query(`UPDATE chat_turns SET terminal_at=$2,terminal_cause='unobserved',alerted_at=$2
        WHERE session_id=$1 AND terminal_at IS NULL`,[sessionId,at])
      const source=(await this.db.query('SELECT channel_id FROM chat_sessions WHERE id=$1',[sessionId]))[0]!
      // Retain even a revoked membership: it must never fall back to an unrelated child-channel leader.
      const member=(await this.db.query(`SELECT m.team_id FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id
        WHERE m.session_id=$1 AND m.channel_id=$2 ORDER BY p.created_at DESC,p.id DESC LIMIT 1`,[sessionId,source.channel_id]))[0]
      await this.db.query(`INSERT INTO chat_turns(session_id,turn_id,opened_at,last_event_at,channel_id,team_id)
        VALUES($1,$2,$3,$3,$4,$5)`,[sessionId,key,at,source.channel_id,member?.team_id ?? null])
      return
    }
    const current=turnId ? (await this.db.query('SELECT * FROM chat_turns WHERE session_id=$1 AND turn_id=$2',[sessionId,turnId]))[0]
      : (await this.db.query('SELECT * FROM chat_turns WHERE session_id=$1 AND terminal_at IS NULL ORDER BY opened_at DESC LIMIT 1',[sessionId]))[0]
    if(!current || current.terminal_at || current.opened_at>at || current.last_event_at>at)return
    const cause=event==='Stop' || event==='AfterAgent' ? 'normal' : event
    const work=await this.db.query("SELECT status,waiting_for,updated_at FROM chat_work_state WHERE session_id=$1 AND status<>'completed'",[sessionId])
    const waiting=cause==='normal' && work.some(w=>w.updated_at>=current.opened_at && w.updated_at<=at) &&
      work.every(w=>w.status==='waiting' && ['human','permission','schedule','agent','tool'].includes(w.waiting_for))
    await this.db.query(`UPDATE chat_turns SET terminal_at=$3,terminal_cause=$4,last_event_at=$3,waiting_at_close=$5
      WHERE session_id=$1 AND turn_id=$2 AND terminal_at IS NULL`,[sessionId,current.turn_id,at,cause,waiting?1:0])
  }
  private async recordTurnChat(sql:Sql,sessionId:string,message:Record<string,any>,receipt?:{turn_id:string;receivedAt:number},replay=false) {
    if(!receipt)return
    const turn=(await sql.query('SELECT * FROM chat_turns WHERE session_id=$1 AND turn_id=$2',[sessionId,receipt.turn_id]))[0]
    if(!turn || (replay && message.created_at<turn.opened_at))return
    const route=await this.turnAlertRoute(sql,turn)
    if(!route || !(await sql.query('SELECT 1 FROM chat_deliveries WHERE message_id=$1 AND recipient_id=$2 AND cancelled_at IS NULL',[message.id,route.recipient.id])).length)return
    await sql.query('UPDATE chat_turns SET chat_sent_at=now(),report_recipient_id=$3 WHERE session_id=$1 AND turn_id=$2',[sessionId,receipt.turn_id,route.recipient.id])
    // A report delivered before a pending notice is handled makes that notice obsolete.
    await sql.query(`UPDATE chat_status_notices SET cancelled_at=now(),error='El agente ya reportó al coordinador'
      WHERE session_id=$1 AND recipient_id=$2 AND channel_id=$3 AND (team_id=$4 OR (team_id IS NULL AND $4 IS NULL))
      AND turn_id IN (SELECT turn_id FROM chat_turns WHERE session_id=$1 AND opened_at<=$5)
      AND handled_at IS NULL AND cancelled_at IS NULL`,[sessionId,route.recipient.id,turn.channel_id,turn.team_id,turn.opened_at])
  }
  async closeTurnForPid(sessionId:string,at=new Date().toISOString()) {
    await this.db.query(`UPDATE chat_turns SET terminal_at=$2,terminal_cause='pid_exit',last_event_at=$2,waiting_at_close=0
      WHERE session_id=$1 AND turn_id=(SELECT turn_id FROM chat_turns WHERE session_id=$1 AND terminal_at IS NULL AND opened_at<=$2 ORDER BY opened_at DESC LIMIT 1) AND terminal_at IS NULL`,[sessionId,at])
  }
  /** Wait for a real idle interval, then notify the coordinator privately once. */
  async processTurnAlerts(now=Date.now(),graceMs=this.turnAlertGraceMs) {
    await this.cancelInvalidTurnAlerts()
    const cutoff=new Date(now-graceMs).toISOString()
    const turns=await this.db.query(`SELECT t.* FROM chat_turns t
      WHERE t.terminal_at IS NOT NULL AND t.terminal_at<=$1 AND t.alerted_at IS NULL AND t.chat_sent_at IS NULL
      ORDER BY t.opened_at DESC`,[cutoff])
    for(const turn of turns) await this.db.transaction(async sql=>{
      const fresh=(await sql.query('SELECT * FROM chat_turns WHERE session_id=$1 AND turn_id=$2',[turn.session_id,turn.turn_id]))[0]
      if(!fresh || fresh.alerted_at || fresh.chat_sent_at || !fresh.terminal_at || fresh.terminal_at>cutoff)return
      const finish=()=>sql.query('UPDATE chat_turns SET alerted_at=$3 WHERE session_id=$1 AND turn_id=$2',[turn.session_id,turn.turn_id,new Date(now).toISOString()])
      // A newer turn supersedes the old idle interval. Never wake a coordinator about historical silence.
      if((await sql.query('SELECT 1 FROM chat_turns WHERE session_id=$1 AND opened_at>$2 LIMIT 1',[turn.session_id,fresh.opened_at])).length){await finish();return}
      const route=await this.turnAlertRoute(sql,fresh)
      if(fresh.waiting_at_close || !route || route.source.state==='busy') {await finish();return}
      const waiting=await sql.query("SELECT status,waiting_for FROM chat_work_state WHERE session_id=$1 AND status<>'completed'",[turn.session_id])
      if(waiting.length && waiting.every(w=>w.status==='waiting' && ['human','permission','schedule','agent','tool'].includes(w.waiting_for))){await finish();return}
      const {source,recipient,root}=route
      const existing=await sql.query(`SELECT 1 FROM chat_status_notices WHERE session_id=$1 AND recipient_id=$2
        AND ((handled_at IS NULL AND cancelled_at IS NULL) OR created_at>$3) LIMIT 1`,[source.id,recipient.id,new Date(now-300_000).toISOString()])
      if(existing.length)return // Defer, never discard a newer missing report because of cooldown.
      const assignedThread=(await sql.query('SELECT work_thread_id FROM chat_team_members WHERE team_id=$1 AND session_id=$2',[fresh.team_id,source.id]))[0]?.work_thread_id
      const workThread=assignedThread ?? root?.id ?? (await sql.query(`SELECT h.id FROM chat_threads h JOIN chat_messages m ON m.thread_id=h.id
        WHERE h.channel_id=$1 AND h.archived_notice=0 AND h.state='open' AND (m.author_id=$2 OR EXISTS(
          SELECT 1 FROM chat_deliveries d WHERE d.message_id=m.id AND d.recipient_id=$2)) ORDER BY m.seq DESC LIMIT 1`,[source.channel_id,source.id]))[0]?.id ?? null
      const text=`${source.label} ended activity and missed the report deadline without notifying the coordinator. Mention it in the work thread to request a Hub status report. Never read its terminal, output, logs or transcript; never restart or close processes. Already reported or explicit wait: handle this notice without waking it. Offline: report that limitation. Private notice, not a thread.`
      await sql.query(`INSERT INTO chat_status_notices(id,session_id,turn_id,cause,channel_id,team_id,recipient_id,work_thread_id,text,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),source.id,fresh.turn_id,fresh.terminal_cause,fresh.channel_id,fresh.team_id,recipient.id,workThread,text,new Date(now).toISOString()])
      await finish()
    })
  }
  /** One durable escalation per unanswered request. No polling agents, fake replies, or new threads. */
  async processResponseAlerts(now=Date.now(),graceMs=300_000) {
    const pending=await this.db.query(`SELECT d.recipient_id,m.id,m.author_id,m.thread_id,t.channel_id,s.label
      FROM chat_deliveries d JOIN chat_messages m ON m.id=d.message_id JOIN chat_threads t ON t.id=m.thread_id
      JOIN chat_sessions s ON s.id=d.recipient_id JOIN chat_channels c ON c.id=t.channel_id
      WHERE d.response_required=1 AND d.response_message_id IS NULL AND d.cancelled_at IS NULL AND d.response_alerted_at IS NULL
      AND m.created_at<=$1 AND t.state='open' AND c.closed_at IS NULL AND c.deleted_at IS NULL AND s.state<>'busy'`,[new Date(now-graceMs).toISOString()])
    for(const item of pending)await this.db.transaction(async sql=>{
      const notice={session_id:item.recipient_id,recipient_id:item.author_id,work_thread_id:item.thread_id,turn_id:'response:'+item.id}
      if(!await this.responseAlertValid(sql,notice))return
      if((await sql.query('SELECT 1 FROM chat_status_notices WHERE session_id=$1 AND recipient_id=$2 AND handled_at IS NULL AND cancelled_at IS NULL',[item.recipient_id,item.author_id])).length)return
      const text=`${item.label} has not answered your request. Check thread ${item.thread_id}, message ${item.id}, and delivery state before deciding. Keep follow-up in that thread; never duplicate the task or restart the agent. A read or ack is not a reply.`
      await sql.query(`INSERT OR IGNORE INTO chat_status_notices(id,session_id,turn_id,cause,channel_id,recipient_id,work_thread_id,text,created_at)
        VALUES($1,$2,$3,'response_due',$4,$5,$6,$7,$8)`,[randomUUID(),item.recipient_id,notice.turn_id,item.channel_id,item.author_id,item.thread_id,text,new Date(now).toISOString()])
      await sql.query('UPDATE chat_deliveries SET response_alerted_at=$3 WHERE message_id=$1 AND recipient_id=$2',[item.id,item.recipient_id,new Date(now).toISOString()])
    })
  }
  private async responseAlertValid(sql:Sql,notice:Record<string,any>) {
    const request=(await sql.query(`SELECT m.author_id FROM chat_deliveries d JOIN chat_messages m ON m.id=d.message_id
      WHERE m.id=$1 AND d.recipient_id=$2 AND d.response_required=1 AND d.response_message_id IS NULL AND d.cancelled_at IS NULL`,[String(notice.turn_id).slice(9),notice.session_id]))[0]
    if(request?.author_id!==notice.recipient_id)return false
    const thread=(await sql.query(`SELECT t.* FROM chat_threads t JOIN chat_channels c ON c.id=t.channel_id WHERE t.id=$1 AND t.state='open' AND c.closed_at IS NULL AND c.deleted_at IS NULL`,[notice.work_thread_id]))[0]
    const author=(await sql.query('SELECT * FROM chat_sessions WHERE id=$1 AND closed_at IS NULL AND removed_at IS NULL',[notice.recipient_id]))[0]
    if(!thread || !author)return false
    const isTeam=(await sql.query('SELECT id FROM chat_team_plans WHERE root_thread_id=$1',[thread.team_root_thread_id ?? thread.id])).length
    if(isTeam){
      const team=await this.teamForThread(sql,author,thread)
      if(!team)return false
      // A disconnected recipient still owes a response; expulsion/revocation cancels delivery separately.
      return (await sql.query(`SELECT 1 FROM chat_sessions s WHERE s.id=$1 AND s.removed_at IS NULL AND
        ((s.id=$2 AND s.channel_id=$3) OR EXISTS(SELECT 1 FROM chat_team_members m WHERE m.team_id=$4 AND m.session_id=s.id AND m.channel_id=s.channel_id AND m.state='joined'))`,[notice.session_id,team.created_by,team.master_channel_id,team.id])).length>0
    }
    return thread.channel_id===author.channel_id && (await sql.query('SELECT 1 FROM chat_sessions WHERE id=$1 AND channel_id=$2 AND removed_at IS NULL',[notice.session_id,thread.channel_id])).length>0
  }
  /** Presence is deliberately not an authorization condition: an offline leader retains a durable notice. */
  private async turnAlertRoute(sql:Sql,turn:Record<string,any>) {
    const source=(await sql.query(`SELECT s.* FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id
      WHERE s.id=$1 AND s.channel_id=$2 AND s.removed_at IS NULL AND s.cli_kind<>'hub' AND c.closed_at IS NULL
      AND (c.kind<>'virtual' OR c.activated_at IS NOT NULL)`,[turn.session_id,turn.channel_id]))[0]
    if(!source)return null
    let channelId=source.channel_id,root:Record<string,any>|undefined
    if(turn.team_id) {
      const plan=(await sql.query(`SELECT p.* FROM chat_team_plans p JOIN chat_team_members m ON m.team_id=p.id
        JOIN chat_channels c ON c.id=p.master_channel_id JOIN chat_sessions leader ON leader.id=p.created_by
        WHERE p.id=$1 AND m.session_id=$2 AND m.channel_id=$3 AND m.state='joined'
        AND p.state IN ('launching','launched','partial','uncertain','active') AND c.closed_at IS NULL
        AND c.leader_id=p.created_by AND leader.channel_id=c.id AND leader.removed_at IS NULL`,[turn.team_id,source.id,source.channel_id]))[0]
      if(!plan)return null
      channelId=plan.master_channel_id
      root=(await sql.query('SELECT * FROM chat_threads WHERE id=$1 AND channel_id=$2',[plan.root_thread_id,channelId]))[0]
      if(!root)return null
    }
    // The leader may live in another channel (multi-channel leadership); leader_id alone names the recipient.
    const recipient=(await sql.query(`SELECT s.* FROM chat_channels c JOIN chat_sessions s ON s.id=c.leader_id
      WHERE c.id=$1 AND c.closed_at IS NULL AND s.removed_at IS NULL AND s.cli_kind<>'hub'`,[channelId]))[0]
    if(!recipient || recipient.id===source.id)return null
    return {source,recipient,channelId,root}
  }
  /** Revalidate both read and wake paths; a durable message never grants a revoked coordination scope. */
  async cancelInvalidTurnAlerts() {
    await this.db.transaction(async sql=>{
      const pending=await sql.query('SELECT * FROM chat_status_notices WHERE handled_at IS NULL AND cancelled_at IS NULL')
      for(const alert of pending) {
        if(String(alert.cause).startsWith('read_')) {
          if(await readNoticeValid(sql,alert))continue
          await sql.query("UPDATE chat_status_notices SET cancelled_at=now(),error='Pedido de lectura resuelto o alcance revocado' WHERE id=$1",[alert.id]);continue
        }
        if(String(alert.cause).startsWith("interhub_")) {
          if(await interhubNoticeValid(sql,alert))continue
          await sql.query("UPDATE chat_status_notices SET cancelled_at=now(),error='Escalada resuelta, reasignada o destinatario fuera del canal' WHERE id=$1",[alert.id]);continue
        }
        if(String(alert.cause).startsWith("leadership_")) {
          // Owed to the displaced session even while it is offline; only a removal makes it moot.
          if((await sql.query("SELECT 1 FROM chat_sessions WHERE id=$1 AND removed_at IS NULL",[alert.recipient_id])).length)continue
          await sql.query("UPDATE chat_status_notices SET cancelled_at=now(),error='Destinatario expulsado' WHERE id=$1",[alert.id]);continue
        }
        if(alert.cause==='response_due') {
          if(await this.responseAlertValid(sql,alert))continue
          await sql.query("UPDATE chat_status_notices SET cancelled_at=now(),error='Pedido respondido o alcance cerrado' WHERE id=$1",[alert.id]);continue
        }
        const route=await this.turnAlertRoute(sql,alert)
        const newer=(await sql.query(`SELECT 1 FROM chat_turns WHERE session_id=$1 AND opened_at>(
          SELECT opened_at FROM chat_turns WHERE session_id=$1 AND turn_id=$2) LIMIT 1`,[alert.session_id,alert.turn_id])).length>0
        if(route?.recipient.id===alert.recipient_id && !newer)continue
        await sql.query("UPDATE chat_status_notices SET cancelled_at=now(),error='Aviso superado o alcance revocado' WHERE id=$1",[alert.id])
      }
    })
  }
  async call(operation: string, raw: unknown, agent?: AgentContext):Promise<any> {
    // Snapshot before joining the writer queue. A later start must not steal an in-flight send's receipt.
    // Transport delays before arrival remain ambiguous until clients attach native turn identity to tool calls.
    const receivedAt=Date.now(),sessionKey=(raw as any)?.session_key
    const observed=operation==='chat_send' && agent ? (await this.db.query(`SELECT t.turn_id FROM chat_turns t
      JOIN chat_sessions s ON s.id=t.session_id WHERE s.agent_id=$1 AND ${typeof sessionKey==='string'?'s.key_hash=$2':'s.id=$2'}
      ORDER BY t.opened_at DESC LIMIT 1`,[agent.agent_id,typeof sessionKey==='string'?hash(sessionKey):agent.session_id]))[0] : undefined
    const receipt=observed ? {turn_id:String(observed.turn_id),receivedAt} : undefined
    const execute=async()=>{
      if(agent)await this.assertNotRemoved(agent,typeof (raw as any)?.session_key==='string' ? (raw as any).session_key : undefined)
      if(operation==='chat_inbox' || operation==='chat_ack')await this.cancelInvalidTurnAlerts()
      return this.callInner(operation,raw,agent,receipt)
    }
    const writes=['chat_work_update','chat_join','chat_create_channel','chat_close_channel','chat_set_nick','chat_inbox','chat_send','chat_ack','chat_resolve','chat_kick','chat_read_interest','chat_read_request','chat_read_elevate','chat_take_leadership']
    // UI/history polling has no routing key and must remain a true read: no writer lock or wake-up event.
    const identifiedRead=operation==='chat_read' && typeof (raw as any)?.session_key==='string'
    let result:any
    try { result=await (writes.includes(operation) || identifiedRead ?this.db.transaction(execute):execute()) }
    catch(error) {
      // A refused takeover rolls back with its transaction; its audit row is written afterwards, within the same rate limit.
      const audit=(error as {leadershipAudit?:AuthorityEvent}).leadershipAudit
      if(audit)await this.db.transaction(async sql=>{
        if(await this.leadershipAttemptsLeft(sql,String(audit.actor_session_id),String(audit.channel_id)))await recordAuthorityEvent(sql,audit)
      }).catch(()=>undefined)
      throw error
    }
    if(writes.includes(operation) || (operation==='chat_read' && result.__chatReadChanged))this.events.emit('change')
    return result
  }
  private async callInner(operation: string, raw: unknown, agent?: AgentContext,receipt?:{turn_id:string;receivedAt:number}) {
    const definition = chatDefinitions[operation as keyof typeof chatDefinitions]
    check(definition, 'Operación de chat inexistente', 404)
    const input = parse(definition[1] as z.ZodType, raw ?? {}) as any
    const caller=agent && !['chat_join','chat_set_nick'].includes(operation) ? await this.requireNickname(agent,input.session_key) : undefined
    // Agents read within their scope; the person (no agent identity) is never scoped.
    const scope:ReadScope|null=caller && ['chat_channels','chat_agents','chat_threads','chat_read'].includes(operation) ? await readScope(this.db,caller.id) : null
    const scopeProjects=scope?JSON.stringify(scope.projects):null,scopeChannels=scope?JSON.stringify(scope.channels):null
    if(operation==='chat_kick'){check(agent,'Sólo el líder puede usar esta herramienta; la persona usa el control de la UI',403);return this.kick(input,{agent,session_key:input.session_key},false)}
    if(operation==='chat_delete_channel'){check(agent,'Usá el control de la UI para eliminar canales como persona.',403);return this.deleteChannel(input,{agent,session_key:input.session_key})}
    if (operation === 'chat_join') {
      check(agent, 'Sólo los agentes pueden registrarse', 403)
      if (input.session_key) return this.enrollmentView(await this.register({ ...agent, cwd: input.path ?? agent.cwd }, input.session_key))
      // Native identities must retain their hook-issued key; fallback conversations create their own identity.
      const native = (await this.db.query('SELECT * FROM chat_sessions WHERE id=$1 AND agent_id=$2',[agent.session_id, agent.agent_id]))[0]
      if (native) {
        const channel=(await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[native.channel_id]))[0]!
        await this.joinableChannel(channel)
        return this.enrollmentView(await this.registration(native,channel,undefined,true))
      }
      return this.enrollmentView(await this.register({ ...agent, cwd: input.path ?? agent.cwd }, randomUUID()))
    }
    if (operation === 'chat_channels') {
      // Folder assignments can be added after sessions and channels already exist.
      for (const c of await this.db.query("SELECT id,path,repository,project_id FROM chat_channels WHERE NOT EXISTS(SELECT 1 FROM chat_team_members m WHERE m.channel_id=chat_channels.id)")) {
        const project=await this.project(c.path,c.repository ?? c.path)
        if ((project?.id ?? null)!==c.project_id) await this.db.query('UPDATE chat_channels SET project_id=$2 WHERE id=$1',[c.id,project?.id ?? null])
      }
      const result = await this.page(`SELECT c.*,
        (SELECT p.id FROM chat_team_plans p WHERE p.master_channel_id=c.id ORDER BY p.created_at DESC,p.id DESC LIMIT 1) AS team_plan_id,
        (SELECT p.master_channel_id FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id WHERE m.channel_id=c.id LIMIT 1) AS parent_channel_id,
        (SELECT label FROM chat_sessions WHERE id=c.leader_id) AS leader_label,(SELECT count(*) FROM chat_threads t WHERE t.channel_id=c.id AND t.archived_notice=0) AS threads FROM chat_channels c WHERE (c.kind<>'virtual' OR c.activated_at IS NOT NULL) AND ($1 IS NULL OR c.project_id=$1) AND ($2 IS NULL OR c.id=$2) AND ($3=0 OR c.project_id IS NULL) AND (($4=1 AND c.deleted_at IS NOT NULL) OR ($4=0 AND c.deleted_at IS NULL))
        AND ($5=1 OR $2 IS NOT NULL OR NOT EXISTS(SELECT 1 FROM chat_team_members m WHERE m.channel_id=c.id))
        AND ($6 IS NULL OR c.id IN (SELECT value FROM json_each($7)) OR COALESCE((SELECT master.project_id FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id
          JOIN chat_channels master ON master.id=p.master_channel_id WHERE m.channel_id=c.id ORDER BY p.created_at DESC LIMIT 1),c.project_id) IN (SELECT value FROM json_each($6)))`,
        [input.project_id ?? null,input.channel_id ?? null,input.unassigned ? 1 : 0,input.deleted?1:0,input.include_workers?1:0,scopeProjects,scopeChannels], 'updated_at DESC,id', input)
      return { ...result,items:await interhubChannelFields(this.db,await Promise.all(result.items.map(async c=>({...c,read_only:await this.channelReadOnly(c)})))) }
    }
    if (operation === 'chat_agents') {
      const result = await this.page(`SELECT s.*,CASE WHEN c.leader_id=s.id THEN 'leader' ELSE 'member' END AS role,
        m.team_id,m.role AS team_role,m.work_thread_id,p.master_channel_id,p.state AS team_state,m.state AS member_state
        FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id
        LEFT JOIN chat_team_members m ON m.session_id=s.id AND m.channel_id=c.id AND (m.state='joined' OR ($8=1 AND m.state='closed'))
        LEFT JOIN chat_team_plans p ON p.id=m.team_id
        LEFT JOIN chat_channels master ON master.id=p.master_channel_id
        WHERE (c.kind<>'virtual' OR c.activated_at IS NOT NULL)
        AND ($1 IS NULL OR COALESCE(master.project_id,c.project_id)=$1)
        AND ($2 IS NULL OR c.id=$2 OR p.master_channel_id=$2)
        AND c.deleted_at IS NULL AND master.deleted_at IS NULL AND s.cli_kind NOT IN (${[...NON_AGENT_CLI_KINDS,INTERHUB_REMOTE_CLI_KIND].map(kind=>`'${kind}'`).join(',')})
        AND ($3=0 OR (c.closed_at IS NULL AND s.closed_at IS NULL AND s.lease_until>now()))
        AND ($4=1 OR s.removed_at IS NULL) AND ($5=0 OR COALESCE(master.project_id,c.project_id) IS NULL)
        AND ($6=1 OR ($8=1 AND m.team_id IS NOT NULL) OR (s.closed_at IS NULL AND c.closed_at IS NULL)) AND ($7=1 OR (s.nickname IS NOT NULL AND trim(s.nickname)<>''))
        AND ($9 IS NULL OR c.id IN (SELECT value FROM json_each($10)) OR p.master_channel_id IN (SELECT value FROM json_each($10)) OR COALESCE(master.project_id,c.project_id) IN (SELECT value FROM json_each($9)))`,
      [input.project_id ?? null,input.channel_id ?? null,input.active_only ? 1 : 0,input.include_removed ? 1 : 0,input.unassigned ? 1 : 0,input.include_closed || input.include_removed ? 1 : 0,input.include_pending ? 1 : 0,input.include_team_history ? 1 : 0,scopeProjects,scopeChannels], 'created_at ASC,id',input)
      return { ...result, items: result.items.map(s=>({...publicSession(s),role:s.team_id?'team_member':s.role,team_id:s.team_id,team_role:s.team_role,team_state:s.team_state,member_state:s.member_state,work_thread_id:s.work_thread_id,master_channel_id:s.master_channel_id})) }
    }
    if (operation === 'chat_threads') return this.page(`SELECT t.*,c.name AS channel_name,s.label AS author_label,${THREAD_AGENT_COUNT_COLUMN},
      (SELECT id FROM chat_team_plans p WHERE p.root_thread_id=COALESCE(t.team_root_thread_id,t.id)) AS team_plan_id,
      (SELECT state FROM chat_team_plans p WHERE p.root_thread_id=COALESCE(t.team_root_thread_id,t.id)) AS team_plan_state,
      (SELECT group_concat(label, ' · ') FROM (SELECT DISTINCT a.label FROM chat_messages m JOIN chat_sessions a ON a.id=m.author_id WHERE m.thread_id=t.id)) AS participants,
      (SELECT count(*) FROM chat_messages m WHERE m.thread_id=t.id) AS messages,
      (SELECT count(*) FROM chat_deliveries d JOIN chat_messages m ON m.id=d.message_id WHERE m.thread_id=t.id AND d.response_required=1 AND d.response_message_id IS NULL AND d.cancelled_at IS NULL) AS pending_responses,
      (SELECT group_concat(label, ' · ') FROM (SELECT DISTINCT r.label FROM chat_deliveries d JOIN chat_messages m ON m.id=d.message_id JOIN chat_sessions r ON r.id=d.recipient_id WHERE m.thread_id=t.id AND d.response_required=1 AND d.response_message_id IS NULL AND d.cancelled_at IS NULL)) AS awaiting_labels,
      (SELECT text FROM chat_messages m WHERE m.thread_id=t.id ORDER BY seq DESC LIMIT 1) AS preview
      FROM chat_threads t JOIN chat_channels c ON c.id=t.channel_id JOIN chat_sessions s ON s.id=t.created_by
      LEFT JOIN chat_channels parent ON parent.id=(SELECT p.master_channel_id FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id WHERE m.channel_id=c.id LIMIT 1)
      WHERE c.deleted_at IS NULL AND parent.deleted_at IS NULL AND t.archived_notice=0 AND ($1 IS NULL OR COALESCE(parent.project_id,c.project_id)=$1) AND ($2 IS NULL OR (c.id=$2 OR parent.id=$2)) AND ($3 IS NULL OR t.state=$3)
      AND ($4='' OR instr(lower(t.title),lower($4))>0 OR EXISTS(SELECT 1 FROM chat_messages m WHERE m.thread_id=t.id AND instr(lower(m.text),lower($4))>0))
      AND ($5 IS NULL OR EXISTS(SELECT 1 FROM chat_messages m WHERE m.thread_id=t.id AND m.author_id=$5)) AND ($6=0 OR COALESCE(parent.project_id,c.project_id) IS NULL)
      AND ($7 IS NULL OR c.id IN (SELECT value FROM json_each($8)) OR COALESCE(parent.project_id,c.project_id) IN (SELECT value FROM json_each($7)))`,
    [input.project_id ?? null,input.channel_id ?? null,input.state ?? null,input.query,input.author_id ?? null,input.unassigned ? 1 : 0,scopeProjects,scopeChannels], 'updated_at DESC,id',input)
      .then(async result=>({...result,items:await interhubThreadFields(this.db,result.items.map(agentCountField))}))
    if (operation === 'chat_read') {
      check(!(input.unread_only===true && !input.session_key),'unread_only=true requiere session_key; sin identidad chat_read sólo permite historial read-only.',400)
      // A routing key is the explicit reader identity. Native/UI reads without it remain historical and never write receipts.
      const who = input.session_key ? await this.identity(agent, input.session_key) : undefined
      const unreadOnly=input.unread_only ?? Boolean(input.session_key)
      const thread = (await this.db.query(`SELECT t.*,
        (SELECT id FROM chat_team_plans p WHERE p.root_thread_id=COALESCE(t.team_root_thread_id,t.id)) AS team_plan_id,
        (SELECT state FROM chat_team_plans p WHERE p.root_thread_id=COALESCE(t.team_root_thread_id,t.id)) AS team_plan_state
        FROM chat_threads t WHERE t.id=$1`,[input.thread_id]))[0]
      check(thread, 'Hilo inexistente',404)
      check(!(await this.db.query('SELECT 1 FROM chat_channels WHERE id=$1 AND deleted_at IS NOT NULL',[thread.channel_id])).length,'El canal está en la papelera.',404)
      if(caller)check(await canReadChannel(this.db,caller.id,thread.channel_id,scope ?? undefined),readDenied,403)
      if(input.project_id) check((await this.db.query('SELECT id FROM chat_channels WHERE id=$1 AND project_id=$2',[thread.channel_id,input.project_id])).length,'El hilo no pertenece al proyecto',404)
      const query=unreadOnly
        ? `SELECT m.*,s.label AS author_label,s.cli_kind,${AUTHOR_SOURCE_SQL} AS author_source FROM chat_messages m JOIN chat_sessions s ON s.id=m.author_id
            WHERE m.thread_id=$1 AND m.author_id<>$2 AND NOT EXISTS(SELECT 1 FROM chat_read_receipts r WHERE r.session_id=$2 AND r.message_id=m.id)`
        : `SELECT m.*,s.label AS author_label,s.cli_kind,${AUTHOR_SOURCE_SQL} AS author_source FROM chat_messages m JOIN chat_sessions s ON s.id=m.author_id WHERE m.thread_id=$1`
      const result = await this.page(query,unreadOnly ? [thread.id,who!.id] : [thread.id],'seq',input)
      let changed=false
      if (who) for (const m of result.items) {
        changed=(await this.db.query(`INSERT OR IGNORE INTO chat_read_receipts(session_id,message_id) VALUES($1,$2) RETURNING message_id`,[who.id,m.id])).length>0 || changed
        // Keep mention delivery state for notifications/UI; reading is never an acknowledgement.
        changed=(await this.db.query('UPDATE chat_deliveries SET read_at=now() WHERE message_id=$1 AND recipient_id=$2 AND read_at IS NULL AND cancelled_at IS NULL RETURNING message_id',[m.id,who.id])).length>0 || changed
      }
      // Pending pages must restart at zero: an offset can leave earlier unread messages untouched.
      const remaining=unreadOnly ? result.total-result.items.length : result.total-input.offset-result.items.length
      const response={ ...result, thread, team:await this.team(thread.channel_id,false,who && who.channel_id===thread.channel_id?who.id:undefined),
        items: await interhubMessageFields(this.db,thread.channel_id,await this.receipts(result.items),()=>this.localHub()),
        read:{unread_only:unreadOnly,remaining:Math.max(0,remaining),next_offset:remaining>0 ? unreadOnly ? 0 : input.offset+result.items.length : null} }
      Object.defineProperty(response,'__chatReadChanged',{value:changed,enumerable:false})
      return response
    }
    const who = agent ? await this.identity(agent, input.session_key) : undefined
    check(who && !who.closed_at, 'Sólo una sesión de agente abierta puede participar',403)
    if (!['chat_set_nick','chat_inbox','chat_ack','chat_work_list'].includes(operation))
      check(who.nickname, 'Elegí tu propio nick con chat_set_nick antes de participar.',409)
    if (operation === 'chat_read_interest') return readInterest(this.db,who,input)
    if (operation === 'chat_read_request') return readRequest(this.db,who,input)
    if (operation === 'chat_read_elevate') return readElevate(this.db,who,input)
    if (operation === 'chat_take_leadership') return this.takeLeadership(input,who)
    if (operation === 'chat_work_update' || operation === 'chat_work_list') {
      const thread=(await this.db.query('SELECT * FROM chat_threads WHERE id=$1',[input.thread_id]))[0]
      check(thread,'Hilo inexistente',404)
      const teamRoot=(await this.db.query('SELECT id FROM chat_team_plans WHERE root_thread_id=$1',[thread.team_root_thread_id ?? thread.id]))[0]
      // Single-channel sessions resolve exactly as before: own channel ⇒ member. A channel led from elsewhere counts too.
      if(teamRoot || !(await writeAssociation(this.db,who.id,thread.channel_id))) {
        await this.writableChannel(who.channel_id)
        check(await this.teamForThread(this.db,who,thread),'El hilo no pertenece a tu canal o equipo activo',403)
      } else await this.writableChannel(thread.channel_id)
      if(operation==='chat_work_update')return updateWork(this.db,who.id,input)
      const result=await this.page(`SELECT w.*,s.state AS session_state,s.closed_at AS session_closed_at,'agent' AS source,
        s.removed_at AS session_removed_at,s.lease_until AS session_lease_until,
        s.event_at AS session_event_at,o.work_version AS observed_version,o.policy_version,o.decision,o.last_observed_at,o.snapshot AS watchdog_snapshot,
        t.state AS watched_thread_state,c.closed_at AS watched_channel_closed_at,c.leader_id AS watched_recipient_id,
        recipient.closed_at AS watched_recipient_closed_at,recipient.removed_at AS watched_recipient_removed_at,recipient.lease_until AS watched_recipient_lease_until,
        d.message_id AS receipt_id,d.notified_at AS receipt_notified_at,d.read_at AS receipt_read_at,d.handled_at AS receipt_handled_at,
        d.cancelled_at AS receipt_cancelled_at,d.attempts AS receipt_attempts,d.next_attempt_at AS receipt_next_attempt_at,d.error AS receipt_error
        FROM chat_work_state w JOIN chat_sessions s ON s.id=w.session_id
        JOIN chat_threads t ON t.id=w.thread_id JOIN chat_channels c ON c.id=t.channel_id
        LEFT JOIN chat_sessions recipient ON recipient.id=c.leader_id
        LEFT JOIN chat_watchdog_observations o ON o.session_id=w.session_id AND o.work_id=w.work_id
        LEFT JOIN chat_deliveries d ON d.message_id=w.report_message_id AND d.recipient_id=c.leader_id
        WHERE w.thread_id=$1`,[thread.id],'updated_at DESC,session_id,work_id',input)
      return {...result,items:result.items.map(({session_event_at,session_removed_at,session_lease_until,observed_version,policy_version,decision,last_observed_at,watchdog_snapshot,
        watched_thread_state,watched_channel_closed_at,watched_recipient_id,watched_recipient_closed_at,watched_recipient_removed_at,watched_recipient_lease_until,
        receipt_id,receipt_notified_at,receipt_read_at,receipt_handled_at,
        receipt_cancelled_at,receipt_attempts,receipt_next_attempt_at,receipt_error,...item})=>{
        const presence=sessionStatus({state:item.session_state,event_at:session_event_at,closed_at:item.session_closed_at,removed_at:session_removed_at,lease_until:session_lease_until})
        item.session_state=presence.state
        const at=(value:unknown)=>typeof value==='string'?Date.parse(value):null
        const receipt=receipt_id?{notifiedAt:at(receipt_notified_at),readAt:at(receipt_read_at),handledAt:at(receipt_handled_at),
          cancelledAt:at(receipt_cancelled_at),attempts:receipt_attempts,nextAttemptAt:at(receipt_next_attempt_at),error:receipt_error}:null
        const stale=observed_version!==item.version || watched_thread_state!=='open' || Boolean(watched_channel_closed_at) ||
          item.session_state!==watchdog_snapshot?.session?.state || watched_recipient_id!==watchdog_snapshot?.recipientId ||
          watchdog_snapshot?.recipientAvailable!==Boolean(watched_recipient_id && !watched_recipient_closed_at && !watched_recipient_removed_at && (at(watched_recipient_lease_until)??0)>Date.now()) ||
          JSON.stringify(receipt)!==JSON.stringify(watchdog_snapshot?.delivery) ||
          Date.parse(session_event_at)>Date.parse(last_observed_at) || Date.now()-Date.parse(last_observed_at)>60_000 || Date.parse(last_observed_at)>Date.now()
        return {...item,session_state_reason:presence.state_reason,session_state_observed_at:presence.state_observed_at,
          connection_state:presence.connection_state,watchdog:last_observed_at?{mode:'shadow',work_version:observed_version,policy_version,decision,last_observed_at,stale}:null}
      })}
    }
    if (operation === 'chat_create_channel') {
      const created=await this.createTaskChannel(who.id,input.task_key ?? input.name ?? 'default',input.name,input.description)
      return this.registration(created.session,created.channel,input.session_key,false)
    }
    if (operation === 'chat_close_channel') {
      const channel=(await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[input.channel_id ?? who.channel_id]))[0]
      check(channel && (channel.kind!=='virtual' || channel.activated_at) && !channel.closed_at,'Esta sesión no pertenece a un canal activo.',409)
      check(channel.leader_id===who.id,'Sólo el líder reconocido puede cerrar este canal virtual.',403)
      const closed=(await this.db.query('UPDATE chat_channels SET closed_at=now(),virtual_path=NULL,updated_at=now() WHERE id=$1 AND closed_at IS NULL RETURNING *',[channel.id]))[0]!
      await this.db.query(`UPDATE chat_sessions SET state='offline',closed_at=COALESCE(closed_at,now()),lease_until=NULL,wake_error=NULL WHERE channel_id=$1`,[channel.id])
      await this.db.query(`UPDATE chat_deliveries SET cancelled_at=now(),error='Canal virtual cerrado' WHERE handled_at IS NULL AND cancelled_at IS NULL
        AND recipient_id IN (SELECT id FROM chat_sessions WHERE channel_id=$1)`,[channel.id])
      return {channel:closed,team:await this.team(channel.id)}
    }
    if (operation === 'chat_set_nick') {
      const canonical = input.nickname.toLowerCase()
      const value = await this.db.transaction(async sql => {
        const occupied = (await sql.query('SELECT id FROM chat_sessions WHERE nickname_key=$1 AND id<>$2',[canonical,who.id]))[0]
        check(!occupied, 'Ese nick ya pertenece a otra sesión. Elegí otro nick.',409)
        return (await sql.query('UPDATE chat_sessions SET nickname=$2,nickname_key=$3,label=$2 WHERE id=$1 RETURNING *',[who.id,input.nickname,canonical]))[0]!
      })
      await this.activate(who.id)
      const team=await this.team(who.channel_id,false,who.id)
      return { session:{...publicSession(value),role:team.leader_id===who.id?'leader':'member'},team }
    }
    if (operation === 'chat_inbox') {
      await this.activate(who.id)
      await this.db.query('UPDATE chat_sessions SET last_seen_at=now(),lease_until=$2 WHERE id=$1 AND closed_at IS NULL',[who.id,new Date(Date.now()+90000).toISOString()])
      const result = await this.page(`SELECT * FROM (
        SELECT m.id,m.thread_id,m.author_id,m.text,m.reply_to,m.request_id,m.created_at,m.seq,
          s.label AS author_label,s.cli_kind,${AUTHOR_SOURCE_SQL} AS author_source,'mention' AS kind,t.title,d.read_at,d.handled_at,d.response_required,
          NULL AS session_id,NULL AS turn_id,NULL AS cause,NULL AS work_thread_id
        FROM chat_deliveries d JOIN chat_messages m ON m.id=d.message_id JOIN chat_threads t ON t.id=m.thread_id
          JOIN chat_sessions s ON s.id=m.author_id WHERE d.recipient_id=$1 AND d.handled_at IS NULL AND d.cancelled_at IS NULL AND ($2=0 OR d.read_at IS NULL)
        UNION ALL
        SELECT id,NULL,'agenthub-system',text,NULL,NULL,created_at,NULL,
          'Agent Hub','hub','hub','status_notice',NULL,read_at,handled_at,0,session_id,turn_id,cause,work_thread_id
        FROM chat_status_notices WHERE recipient_id=$1 AND handled_at IS NULL AND cancelled_at IS NULL AND ($2=0 OR read_at IS NULL)
        )`,[who.id,input.unread_only ? 1 : 0],'created_at,id',input)
      for (const m of result.items) {
        if(m.kind==='status_notice') {
          await this.db.query('UPDATE chat_status_notices SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND recipient_id=$2 AND cancelled_at IS NULL',[m.id,who.id])
        } else {
          await this.db.query('UPDATE chat_deliveries SET read_at=COALESCE(read_at,now()) WHERE message_id=$1 AND recipient_id=$2 AND cancelled_at IS NULL',[m.id,who.id])
          await this.db.query('INSERT OR IGNORE INTO chat_read_receipts(session_id,message_id) VALUES($1,$2)',[who.id,m.id])
        }
      }
      return {...result,team:await this.team(who.channel_id,false,who.id),usage_notices:await new UsageNotices(this).pending(who.id,true)}
    }
    await this.db.query('UPDATE chat_sessions SET last_seen_at=now(),lease_until=$2 WHERE id=$1 AND closed_at IS NULL',[who.id,new Date(Date.now()+90000).toISOString()])
    if (operation === 'chat_ack') {
      check(!(await this.db.query('SELECT 1 FROM chat_deliveries WHERE message_id=$1 AND recipient_id=$2 AND response_required=1 AND response_message_id IS NULL AND cancelled_at IS NULL',[input.message_id,who.id])).length,'Reply in this thread with reply_to before marking the request handled; if blocked, reply with the concrete reason.',409)
      const rows = await this.db.query('UPDATE chat_deliveries SET read_at=COALESCE(read_at,now()),handled_at=COALESCE(handled_at,now()) WHERE message_id=$1 AND recipient_id=$2 AND cancelled_at IS NULL RETURNING *',[input.message_id,who.id])
      if(rows.length)return rows[0]
      const notices=await this.db.query('UPDATE chat_status_notices SET read_at=COALESCE(read_at,now()),handled_at=COALESCE(handled_at,now()) WHERE id=$1 AND recipient_id=$2 RETURNING id,handled_at',[input.message_id,who.id])
      check(notices.length, 'La mención o aviso no está destinado a esta sesión',403); return notices[0]
    }
    if (operation === 'chat_resolve') {
      const thread=(await this.db.query('SELECT * FROM chat_threads WHERE id=$1',[input.thread_id]))[0]
      check(thread,'Hilo inexistente',404)
      if(thread.team_root_thread_id) {
        await this.writableChannel(who.channel_id)
        check(await this.teamForThread(this.db,who,thread),'El hilo de equipo no está activo o no te pertenece.',403)
      } else {
        check(await writeAssociation(this.db,who.id,thread.channel_id),'El hilo no pertenece a tu canal',403)
        await this.writableChannel(thread.channel_id)
      }
      if(input.state==='resolved')check(!(await this.db.query('SELECT 1 FROM chat_deliveries d JOIN chat_messages m ON m.id=d.message_id WHERE m.thread_id=$1 AND d.response_required=1 AND d.response_message_id IS NULL AND d.cancelled_at IS NULL',[thread.id])).length,'Hay pedidos pendientes de respuesta en este hilo.',409)
      return (await this.db.query('UPDATE chat_threads SET state=$2,updated_at=now() WHERE id=$1 RETURNING *',[input.thread_id,input.state]))[0]
    }
    // Single-channel sessions keep the original upfront check; a session that leads other channels is checked per target below.
    const leadsElsewhere=(await this.db.query('SELECT 1 FROM chat_channels WHERE leader_id=$1 AND id<>$2 AND closed_at IS NULL AND deleted_at IS NULL LIMIT 1',[who.id,who.channel_id])).length>0
    if(!leadsElsewhere)await this.writableChannel(who.channel_id)
    check(who.nickname, 'Elegí tu propio nick con chat_set_nick antes de escribir.',409)
    const requestPayload={thread:input.thread_id ?? null,channel:input.channel_id ?? null,title:input.title ?? null,task:input.task_id ?? null,text:input.text,reply:input.reply_to ?? null,mentions:[...new Set(input.mentions)].sort()}
    // Preserve pre-team-thread request hashes exactly so durable retries still deduplicate after upgrade.
    if(input.team_root_thread_id)Object.assign(requestPayload,{team_root_thread:input.team_root_thread_id})
    if(input.response_required!==undefined)Object.assign(requestPayload,{response_required:input.response_required})
    if(input.kind!==undefined)Object.assign(requestPayload,{kind:input.kind})
    const requestHash=hash(JSON.stringify(requestPayload))
    const result = await this.db.transaction(async sql => {
      const prior = (await sql.query('SELECT * FROM chat_messages WHERE author_id=$1 AND request_id=$2',[who.id,input.request_id]))[0]
      if (prior) {
        check(prior.request_hash===requestHash, 'request_id ya usado con otro mensaje',409)
        await this.recordTurnChat(sql,who.id,prior,receipt,true)
        return prior
      }
      let thread
      if (input.thread_id) {
        check(!input.team_root_thread_id,'team_root_thread_id sólo crea un hilo nuevo; no puede retaggear uno existente.',400)
        thread = (await sql.query('SELECT * FROM chat_threads WHERE id=$1',[input.thread_id]))[0]
      }
      else if(input.team_root_thread_id) {
        check(input.title,'Un hilo de equipo requiere title.',400)
        const root=(await sql.query('SELECT * FROM chat_threads WHERE id=$1',[input.team_root_thread_id]))[0]
        check(root,'Hilo raíz inexistente',404)
        check(!root.team_root_thread_id,'team_root_thread_id debe referirse al hilo raíz canónico, no a un hilo hijo.',400)
        const team=await this.teamForThread(sql,who,root)
        check(team && team.root_thread_id===root.id && team.master_channel_id===root.channel_id,'Sólo el coordinador o un miembro vigente puede crear un hilo de este equipo activo.',403)
        check(!input.channel_id || input.channel_id===root.channel_id,'El hilo de equipo pertenece al canal master de su raíz.',400)
        const taskId=input.task_id ?? root.task_id ?? null
        if(taskId)check((await sql.query('SELECT id FROM tasks WHERE id=$1 AND project_id=(SELECT project_id FROM chat_channels WHERE id=$2)',[taskId,root.channel_id])).length,'La tarea no pertenece al proyecto del equipo.',400)
        thread=(await sql.query('INSERT INTO chat_threads(id,channel_id,title,created_by,task_id,team_root_thread_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
          [randomUUID(),root.channel_id,input.title,who.id,taskId,root.id]))[0]!
      }
      else {
        const membership=(await sql.query(`SELECT p.root_thread_id FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id
          WHERE m.session_id=$1 AND m.channel_id=$2 AND m.state='joined' AND p.state IN ('launching','launched','partial','uncertain','active')`,[who.id,who.channel_id]))[0]
        if(membership) {
          check(input.title && (!input.channel_id || input.channel_id===who.channel_id),'Para iniciar un tema usá title y el channel_id propio, o team_root_thread_id.',400)
          const root=(await sql.query('SELECT * FROM chat_threads WHERE id=$1',[membership.root_thread_id]))[0]!
          const team=await this.teamForThread(sql,who,root)
          check(team,'El equipo ya no está activo.',403)
          if(input.task_id)check((await sql.query('SELECT id FROM tasks WHERE id=$1 AND project_id=(SELECT project_id FROM chat_channels WHERE id=$2)',[input.task_id,root.channel_id])).length,'La tarea no pertenece al proyecto',400)
          thread=(await sql.query('INSERT INTO chat_threads(id,channel_id,title,created_by,task_id,team_root_thread_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
            [randomUUID(),root.channel_id,input.title,who.id,input.task_id ?? root.task_id,root.id]))[0]
        } else {
        check(input.title && input.channel_id && (input.channel_id===who.channel_id || await writeAssociation(sql,who.id,input.channel_id)==='leader'), 'Para iniciar un hilo usá el channel_id de tu sesión (o de un canal que liderás) y un título',400)
        if (input.task_id) check((await sql.query('SELECT id FROM tasks WHERE id=$1 AND project_id=(SELECT project_id FROM chat_channels WHERE id=$2)',[input.task_id,input.channel_id])).length,'La tarea no pertenece al proyecto',400)
        thread = (await sql.query('INSERT INTO chat_threads(id,channel_id,title,created_by,task_id) VALUES($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),input.channel_id,input.title,who.id,input.task_id ?? null]))[0]
        }
      }
      check(thread,'Hilo inexistente',404)
      let linkedTeam:Record<string,any>|undefined
      const teamRoot=(await sql.query('SELECT id FROM chat_team_plans WHERE root_thread_id=$1',[thread.team_root_thread_id ?? thread.id]))[0]
      // Server-enforced write rule: leader or non-displaced member of the thread's channel, or a linked team thread.
      if(teamRoot || !(await writeAssociation(sql,who.id,thread.channel_id))) {
        linkedTeam=await this.teamForThread(sql,who,thread)
        check(linkedTeam || teamRoot,'No estás asociado a este canal (o fuiste desplazado de su liderazgo): podés leerlo, no escribir. Para recuperar un canal tomado usá memory_chat_take_leadership.',403)
        check(linkedTeam,'Sólo el master y miembros vinculados pueden escribir en un hilo activo de su equipo.',403)
        if(leadsElsewhere)await this.writableChannel(who.channel_id)
      } else await this.writableChannel(thread.channel_id)
      const channelLeadership=(await sql.query('SELECT leader_id,displaced_leader_id FROM chat_channels WHERE id=$1',[thread.channel_id]))[0]!
      const recipients=new Set<string>(input.mentions)
      let replied:Record<string,any>|undefined
      if(input.reply_to) {
        replied=(await sql.query('SELECT * FROM chat_messages WHERE id=$1 AND thread_id=$2',[input.reply_to,thread.id]))[0]
        check(replied,'La respuesta debe apuntar al mismo hilo',400)
        if(replied.author_id!==who.id && replied.author_id!==channelLeadership.displaced_leader_id && (await sql.query('SELECT 1 FROM chat_sessions WHERE id=$1 AND closed_at IS NULL AND removed_at IS NULL',[replied.author_id])).length)recipients.add(replied.author_id)
      }
      // Task reports and assignments must reach the counterpart, even if the model omitted mentions.
      if(linkedTeam && !recipients.size && !replied) {
        const counterpart=who.id===linkedTeam.created_by
          ? (await sql.query("SELECT session_id FROM chat_team_members WHERE team_id=$1 AND work_thread_id=$2 AND state='joined'",[linkedTeam.id,thread.id]))[0]?.session_id
          : linkedTeam.created_by
        if(counterpart && counterpart!==who.id && await this.teamRecipient(sql,linkedTeam,counterpart))recipients.add(counterpart)
      }
      check(!input.response_required || recipients.size>0,'Un pedido de respuesta necesita al menos un destinatario.',400)
      check(thread.state==='open','Este hilo está resuelto; reabrilo antes de continuar el mismo objetivo.',409)
      for (const recipient of recipients) {
        check(recipient !== who.id,'No podés despertarte mencionándote a vos mismo',400)
        const target=(await sql.query('SELECT id,channel_id,removed_at,cli_kind FROM chat_sessions WHERE id=$1',[recipient]))[0]
        check(!target || !(NON_AGENT_CLI_KINDS as readonly string[]).includes(target.cli_kind),'Sólo se menciona a agentes; la persona lee el hilo en la UI.',400)
        if(linkedTeam)check(await this.teamRecipient(sql,linkedTeam,recipient),'La mención debe pertenecer al equipo vinculado a este hilo.',400)
        else if(target && target.channel_id===thread.channel_id && target.id!==channelLeadership.displaced_leader_id)check(!target.removed_at,'La mención no puede dirigirse a una sesión expulsada',400)
        else if(target && target.id===channelLeadership.leader_id)check(!target.removed_at,'La mención no puede dirigirse a una sesión expulsada',400)
        else check(false,'La mención debe pertenecer al mismo canal.',400)
      }
      const message = (await sql.query('INSERT INTO chat_messages(id,thread_id,author_id,text,reply_to,request_id,request_hash,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [randomUUID(),thread.id,who.id,input.text,input.reply_to ?? null,input.request_id,requestHash,input.kind ?? null]))[0]!
      for (const recipient of recipients) await sql.query('INSERT INTO chat_deliveries(message_id,recipient_id,response_required) VALUES($1,$2,$3)',[message.id,recipient,input.response_required?1:0])
      if(replied) {
        await sql.query('UPDATE chat_deliveries SET response_message_id=COALESCE(response_message_id,$3),read_at=COALESCE(read_at,now()),handled_at=COALESCE(handled_at,now()) WHERE message_id=$1 AND recipient_id=$2 AND cancelled_at IS NULL',[replied.id,who.id,message.id])
        await sql.query("UPDATE chat_status_notices SET cancelled_at=now(),error='El pedido ya recibió respuesta' WHERE cause='response_due' AND turn_id=$1 AND session_id=$2 AND handled_at IS NULL AND cancelled_at IS NULL",['response:'+replied.id,who.id])
      }
      await this.recordTurnChat(sql,who.id,message,receipt)
      if(linkedTeam)await sql.query(`INSERT INTO chat_team_events(id,team_id,type,actor_session_id,source_channel_id,target_thread_id,payload)
        VALUES($1,$2,'chat_message',$3,$4,$5,$6)`,[randomUUID(),linkedTeam.id,who.id,who.channel_id,thread.id,JSON.stringify({message_id:message.id,request_hash:requestHash})])
      await sql.query('UPDATE chat_threads SET updated_at=now(),archived_notice=0 WHERE id=$1',[thread.id])
      return message
    })
    return result
  }
  private async teamForThread(sql:Sql,who:Record<string,any>,thread:Record<string,any>) {
    return (await sql.query(`SELECT t.* FROM chat_team_plans t
      JOIN chat_channels master ON master.id=t.master_channel_id JOIN chat_channels source ON source.id=$2
      JOIN chat_sessions leader ON leader.id=t.created_by
      WHERE t.root_thread_id=$1 AND t.state IN ('launching','launched','partial','uncertain','active')
      AND master.closed_at IS NULL AND source.closed_at IS NULL AND master.leader_id=t.created_by
      AND leader.closed_at IS NULL AND leader.removed_at IS NULL
      AND ((t.created_by=$3 AND t.master_channel_id=$2) OR EXISTS(SELECT 1 FROM chat_team_members m
        WHERE m.team_id=t.id AND m.session_id=$3 AND m.channel_id=$2 AND m.state='joined'))`,[thread.team_root_thread_id ?? thread.id,who.channel_id,who.id]))[0]
  }
  private async teamRecipient(sql:Sql,team:Record<string,any>,recipientId:string) {
    return (await sql.query(`SELECT s.id FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id
      WHERE s.id=$2 AND s.closed_at IS NULL AND s.removed_at IS NULL AND c.closed_at IS NULL
      AND ((s.id=$3 AND s.channel_id=$4) OR EXISTS(SELECT 1 FROM chat_team_members m
        WHERE m.team_id=$1 AND m.session_id=s.id AND m.channel_id=s.channel_id AND m.state='joined'))`,
      [team.id,recipientId,team.created_by,team.master_channel_id])).length>0
  }
  private async writableChannel(channelId:string) {
    const channel=(await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[channelId]))[0]!
    check(!channel.deleted_at && !channel.closed_at,'Este canal está cerrado o eliminado.',409)
    check(channel.kind!=='virtual' || channel.activated_at,'La sesión no tiene un canal activo. Consultá a la persona antes de crear uno.',409)
    return channel
  }
  private async joinableChannel(channel:Record<string,any>) {
    check(!channel.deleted_at,'Este canal fue eliminado. Su sesión no puede reincorporarse.',409)
    check(!channel.closed_at,'Este canal está cerrado y no admite nuevas adhesiones.',409)
    return channel
  }
  private async workspaceFolder(path:string) {
    const root=await realpath(resolve(path)).catch(()=>null)
    check(root && await stat(root).then(s=>s.isDirectory()).catch(()=>false),'La carpeta de trabajo no está disponible.',409)
    return root
  }
  private channelReadOnly(channel:Record<string,any>):Promise<boolean|null> {
    return Promise.resolve(Boolean(channel.deleted_at || channel.closed_at || (channel.kind==='virtual' && !channel.activated_at)))
  }
  private async receipts(items: Record<string, any>[]) {
    return Promise.all(items.map(async m => ({ ...m, mentions: await this.db.query(`SELECT d.*,s.label FROM chat_deliveries d JOIN chat_sessions s ON s.id=d.recipient_id WHERE d.message_id=$1 ORDER BY s.label`,[m.id]) })))
  }
  private async page(query: string, args: unknown[], order: string, input: { limit: number; offset: number }) {
    const total = Number((await this.db.query(`SELECT count(*) AS n FROM (${query})`,args))[0]!.n)
    const items = await this.db.query(`SELECT * FROM (${query}) ORDER BY ${order} LIMIT $${args.length+1} OFFSET $${args.length+2}`,[...args,input.limit,input.offset])
    return { items,total,limit:input.limit,offset:input.offset }
  }
}
