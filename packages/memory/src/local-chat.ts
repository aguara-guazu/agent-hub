import { UsageNotices } from './usage-notices.js'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'
import { z } from 'zod'
import { check, id, parse } from './contracts.js'
import { projectForPath, orcaWorkspaceSchema, type AgentContext } from './agents.js'
import type { MemoryStore } from './store.js'
import type { Sql } from './database.js'
import { teamGuidance } from './local-chat-team.js'

const exec = promisify(execFile)
const key = z.string().min(32).max(200)
const nickname = z.string().max(200).transform(s => s.normalize('NFKC').trim().replace(/ +/g, ' ')).pipe(z.string().min(2).max(40)
  .refine(s => !/[\p{Cc}\p{Cf}]/u.test(s), 'El nick no puede contener caracteres invisibles ni de control')
  .refine(s => !/^(?:native:|[a-f0-9]{32,}$|[a-f0-9]{8}-[a-f0-9-]{27}$)/i.test(s), 'Inventá un nick, no uses un identificador técnico'))
const session = { session_key: key.optional() }
export const chatKickInput = z.object({channel_id:id,participant_id:z.string().min(8).max(200),reason:z.string().trim().min(1).max(1000)})
const page = { limit: z.number().int().min(1).max(100).default(40), offset: z.number().int().min(0).default(0) }
const scope = { project_id: id.optional(), channel_id: id.optional(), unassigned: z.boolean().default(false) }
export const chatDefinitions = {
  chat_join: ['Registrarte en el canal local de tu espacio de Orca, worktree Git o canal virtual ya solicitado. En una carpeta común sólo deja la conexión preparada: no crea un canal activo. Conservá session_key y usala en cada llamada de chat; identifica esta conversación, nunca a toda la CLI.', z.object({ ...session, path: z.string().max(4000).optional() }).strict()],
  chat_create_channel: ['Crear explícitamente un canal virtual descartable en la carpeta común de esta sesión. Usala sólo cuando la persona pida crear el canal: nunca durante el registro, por conveniencia ni en segundo plano. El primer creador queda como líder y se incorporan las conexiones ya abiertas en la misma carpeta real.', z.object({ ...session, name: z.string().trim().min(1).max(200).optional() }).strict()],
  chat_close_channel: ['Cerrar explícitamente el canal virtual descartable de esta sesión. Sólo puede hacerlo su líder. Conserva historial y bloquea nuevas adhesiones; una conversación nueva podrá crear otro canal futuro en la misma carpeta.', z.object({ ...session }).strict()],
  chat_set_nick: ['Elegí libremente tu nick inventado (2–40 caracteres) antes de escribir. Debe ser único en este Hub, incluso entre sesiones desconectadas; ante conflicto elegí otro. Sólo cambia tu propia sesión y conserva su identidad e historial.', z.object({ ...session, nickname }).strict()],
  chat_channels: ['Explorar canales locales activos o históricos. unassigned=true devuelve sólo canales sin proyecto; los virtuales pendientes permanecen ocultos.', z.object({ ...scope, ...page }).strict()],
  chat_agents: ['Encontrar identidades de sesiones concretas para mencionarlas; por defecto excluye expulsados. Usá include_removed=true sólo para auditoría. unassigned=true limita a canales sin proyecto.', z.object({ ...scope, active_only: z.boolean().default(false), include_removed: z.boolean().default(false), ...page }).strict()],
  chat_threads: ['Buscar hilos y mensajes históricos por texto, canal, proyecto, autor o estado. unassigned=true limita a canales sin proyecto. El historial permanece al cerrar los agentes.', z.object({ ...scope, query: z.string().max(500).default(''), author_id: z.string().max(200).optional(), state: z.enum(['open','resolved']).optional(), ...page }).strict()],
  chat_read: ['Leer una página de un hilo. Sólo registra lectura de las menciones devueltas destinadas a tu sesión; no las marca atendidas.', z.object({ ...session, project_id:id.optional(), thread_id: id, ...page }).strict()],
  chat_send: ['Crear un hilo por tarea (channel_id,title) o responder (thread_id). Fuera del canal propio sólo admite el hilo raíz de un equipo vinculado; mentions queda limitado a miembros del mismo equipo. request_id estable permite reintentar sin duplicar. Requiere autorización para colaborar.', z.object({ ...session, thread_id: id.optional(), channel_id: id.optional(), title: z.string().trim().min(1).max(200).optional(), task_id: id.optional(), text: z.string().trim().min(1).max(16000), mentions: z.array(z.string().min(8).max(200)).max(20).default([]), reply_to: id.optional(), request_id: z.string().min(1).max(200) }).strict()],
  chat_inbox: ['Leer tus menciones pendientes. Marcarlas leídas no las atiende; pendientes sin atender permanecen visibles. No hacer polling con el modelo: el Hub notifica.', z.object({ ...session, unread_only: z.boolean().default(false), ...page }).strict()],
  chat_kick: ['Expulsar una sesión del canal por orden de la persona. Sólo el líder reconocido puede hacerlo; indicá el motivo de la orden. Conserva el historial, cancela avisos y bloquea la reincorporación de esa sesión. No cierra su terminal ni detiene trabajos en curso.', chatKickInput.extend(session).strict()],
  chat_ack: ['Marcar como atendida una mención propia después de resolverla o responder. No acepta la tarea por sólo haberla leído.', z.object({ ...session, message_id: id }).strict()],
  chat_resolve: ['Cerrar o reabrir un hilo del canal de tu sesión. No borra el historial ni marca mensajes ajenos como atendidos.', z.object({ ...session, thread_id: id, state: z.enum(['open','resolved']) }).strict()],
} satisfies Record<string, [string, z.ZodType]>
export const chatReadOperations = ['chat_channels','chat_agents','chat_threads','chat_read']
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const publicSession = (s: Record<string, any>) => ({ id: s.id, label: s.label, nickname: s.nickname, needs_nickname: !s.nickname, cli_kind: s.cli_kind, channel_id: s.channel_id,
  state: s.removed_at ? 'removed' : s.closed_at ? 'offline' : !s.lease_until || Date.parse(s.lease_until) < Date.now() ? 'unknown' : s.state,
  capability: s.capability, last_seen_at: s.last_seen_at, created_at: s.created_at, closed_at: s.closed_at, wake_error: s.wake_error, removed_at:s.removed_at, removed_by:s.removed_by, removal_reason:s.removal_reason })

export async function chatFolder(path: string) {
  try {
    let root = await realpath(resolve(path))
    // Never let a Git environment inherited by the Hub redirect another session's worktree.
    const env = { ...process.env }
    for (const name of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR']) delete env[name]
    const run = (args: string[]) => exec('git', ['-C', root, ...args], { env, timeout:1500, maxBuffer:8192 }).then(r=>r.stdout.trim())
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

async function virtualFolder(path: string) {
  const root = await realpath(resolve(path)).catch(()=>null)
  check(root && await stat(root).then(value=>value.isDirectory()).catch(()=>false), 'La carpeta local no está disponible.', 409)
  const env = { ...process.env }
  for (const name of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR']) delete env[name]
  try {
    await exec('git',['-C',root,'rev-parse','--git-dir'],{env,timeout:1500,maxBuffer:8192})
    check(false,'La ruta pertenece a un repositorio Git pero no es un worktree disponible.',409)
  } catch (error) {
    if ((error as {statusCode?:number}).statusCode) throw error
    const failure=error as NodeJS.ErrnoException & {killed?:boolean}
    if(failure.killed || failure.name==='AbortError' || failure.code==='ETIMEDOUT' || failure.code==='ENOENT' || failure.syscall?.startsWith('spawn'))
      check(false,'No se pudo ejecutar Git para verificar la carpeta. Reintentá cuando Git esté disponible.',503)
  }
  return root
}

/** Durable data; events are hints only. Reconnecting listeners always re-read SQLite. */
export class LocalChat {
  usageEnabled: (agentId:string)=>boolean = () => true
  readonly events = new EventEmitter().setMaxListeners(0)
  private readonly availability = new Map<string,{until:number;readOnly:Promise<boolean|null>}>()
  constructor(readonly store: MemoryStore) {}
  get db() { return this.store.db }
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
        check(!who.closed_at && who.channel_id===channel.id && channel.leader_id===who.id,'Sólo el líder reconocido de este canal puede expulsar agentes',403)
        check(who.id!==input.participant_id,'El líder no puede expulsarse a sí mismo; la persona puede hacerlo desde la UI',400)
        removedBy=`agent:${who.id}`
      } else removedBy=`user:${actor.user_id}`
      const target=(await sql.query('SELECT * FROM chat_sessions WHERE id=$1 AND channel_id=$2',[input.participant_id,channel.id]))[0]
      check(target,'El agente no pertenece a este canal',404)
      if(!target.removed_at) {
        await sql.query(`UPDATE chat_sessions SET removed_at=now(),removed_by=$2,removal_reason=$3,state='offline',closed_at=now(),lease_until=NULL,wake_error=NULL WHERE id=$1`,[target.id,removedBy,input.reason])
        await sql.query(`UPDATE chat_deliveries SET cancelled_at=now(),error='Destinatario expulsado del canal' WHERE recipient_id=$1 AND handled_at IS NULL AND cancelled_at IS NULL`,[target.id])
        await sql.query('UPDATE chat_channels SET leader_id=NULL,updated_at=now() WHERE id=$1 AND leader_id=$2',[channel.id,target.id])
      }
      return {session:publicSession((await sql.query('SELECT * FROM chat_sessions WHERE id=$1',[target.id]))[0]!),team:await this.team(channel.id)}
    })
    if(notify)this.events.emit('change',input.participant_id)
    return result
  }
  async team(channelId:string) {
    const c=(await this.db.query('SELECT c.leader_id,s.nickname,s.label,s.closed_at FROM chat_channels c LEFT JOIN chat_sessions s ON s.id=c.leader_id WHERE c.id=$1',[channelId]))[0]!
    return {leader_id:c.leader_id,leader_nickname:c.nickname ?? c.label,leader_offline:Boolean(c.closed_at),guidance:teamGuidance}
  }
  async activate(sid:string) {
    await this.db.query(`UPDATE chat_channels SET leader_id=$1 WHERE leader_id IS NULL AND closed_at IS NULL
      AND (kind<>'virtual' OR activated_at IS NOT NULL) AND id=(SELECT channel_id FROM chat_sessions WHERE id=$1 AND closed_at IS NULL)`,[sid])
    await this.db.query(`UPDATE chat_sessions SET team_seen=1 WHERE id=$1 AND EXISTS(
      SELECT 1 FROM chat_channels c WHERE c.id=chat_sessions.channel_id AND c.closed_at IS NULL AND (c.kind<>'virtual' OR c.activated_at IS NOT NULL))`,[sid])
  }
  private async registration(session:Record<string,any>,channel:Record<string,any>,sessionKey:string|undefined,active:boolean) {
    if(active)await this.activate(session.id)
    const team=await this.team(channel.id)
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
    check(agent.cwd, 'La sesión necesita una carpeta para elegir su canal', 409)
    const workspace=agent.orca_workspace_id ? parse(orcaWorkspaceSchema,agent.orca_workspace_id) : null
    const existingChannel=workspace ? (await this.db.query('SELECT * FROM chat_channels WHERE orca_workspace_id=$1',[workspace]))[0] : undefined
    const root=workspace ? await this.workspaceFolder(existingChannel?.path ?? (workspace.includes('::') ? workspace.slice(workspace.indexOf('::')+2) : agent.cwd)) : null
    let virtual=false
    const folder = root ? {root,branch:null,repository:root} : await chatFolder(agent.cwd).catch(async error=>{
      if ((error as {statusCode?:number}).statusCode!==409) throw error
      virtual=true
      const plain=await virtualFolder(agent.cwd!)
      return {root:plain,branch:null,repository:null}
    })
    const project = virtual ? null : await this.project(folder.root,folder.repository ?? folder.root)
    const channel = virtual
      ? (await this.db.query(`INSERT INTO chat_channels(id,project_id,path,name,branch,repository,scope_key,orca_workspace_id,kind,virtual_path)
          VALUES($1,NULL,$2,$3,NULL,NULL,$4,NULL,'virtual',$2)
          ON CONFLICT(virtual_path) DO UPDATE SET updated_at=now() RETURNING *`,
        [randomUUID(),folder.root,basename(folder.root)||folder.root,`virtual:${randomUUID()}`]))[0]!
      : (await this.db.query(`INSERT INTO chat_channels(id,project_id,path,name,branch,repository,scope_key,orca_workspace_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT(scope_key) DO UPDATE SET project_id=excluded.project_id,branch=excluded.branch,repository=excluded.repository,updated_at=now() RETURNING *`,
        [randomUUID(),project?.id ?? null,folder.root,basename(folder.root)||folder.root,folder.branch,folder.repository,workspace ? `orca:${workspace}` : `git:${folder.root}`,workspace]))[0]!
    return this.db.transaction(async () => {
      const existing = (await this.db.query('SELECT * FROM chat_sessions WHERE key_hash=$1', [hash(sessionKey)]))[0]
      check(!existing || existing.agent_id === agent.agent_id, 'La identidad pertenece a otro cliente', 403)
      const sid = existing?.id ?? (nativeId ? agent.session_id : randomUUID())
      const priorIdentity=(await this.db.query('SELECT id,agent_id,channel_id FROM chat_sessions WHERE id=$1',[sid]))[0]
      check(!priorIdentity || (priorIdentity.agent_id===agent.agent_id && priorIdentity.channel_id===channel.id),
        'La conversación nativa ya pertenece a otro canal y no puede migrarse; abrí una conversación nueva en el worktree asignado.',409)
      const value = (await this.db.query(`INSERT INTO chat_sessions(id,agent_id,native_id,key_hash,label,cli_kind,channel_id,event_at,lease_until,gateway_session_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET channel_id=excluded.channel_id,key_hash=excluded.key_hash RETURNING *`,
      [sid, agent.agent_id, nativeId, hash(sessionKey), 'Sin nick todavía', agent.cli_kind, channel.id, '1970-01-01T00:00:00.000Z', new Date(Date.now()+90000).toISOString(),agent.session_id]))[0]!
      return this.registration(value,channel,sessionKey,active)
    })
  }
  async identity(agent: AgentContext | undefined, sessionKey?: string) {
    check(agent, 'Sólo los agentes pueden participar en la colaboración local', 403)
    const s = (await this.db.query(sessionKey ? 'SELECT * FROM chat_sessions WHERE key_hash=$1 AND agent_id=$2' : 'SELECT * FROM chat_sessions WHERE id=$1 AND agent_id=$2',
      [sessionKey ? hash(sessionKey) : agent.session_id, agent.agent_id]))[0]
    check(s, 'Registrate con chat_join o usá la session_key que recibiste al iniciar. No se puede adivinar la sesión.', 409)
    check(!s.removed_at,'Esta sesión fue expulsada del canal',410)
    return s
  }
  async lifecycle(agent: AgentContext, input: { session_key: string; native_id: string; event: string; at: string; process_id?: number | undefined; process_started?: string | undefined; transport?:string | undefined }) {
    const result=await this.db.transaction(async()=>{
    await this.assertNotRemoved(agent,input.session_key)
    const known = (await this.db.query('SELECT * FROM chat_sessions WHERE key_hash=$1 AND agent_id=$2',[hash(input.session_key),agent.agent_id]))[0]
    if(known)await this.joinableChannel((await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[known.channel_id]))[0]!)
    const registration = !known || input.event==='SessionStart' ? await this.register(agent,input.session_key,input.native_id,false)
      : { session:publicSession(known),channel:(await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[known.channel_id]))[0],session_key:input.session_key }
    const sid = registration.session.id
    if(['UserPromptSubmit','BeforeAgent'].includes(input.event))await this.activate(sid)
    const state = ['SessionStart','Stop','AfterAgent'].includes(input.event) ? 'idle' : ['Interrupt','StopFailure'].includes(input.event) ? 'blocked' : input.event === 'SessionEnd' ? 'offline' : 'busy'
    if (input.event !== 'Heartbeat' && input.event !== 'Watch') {
      await this.db.query(`UPDATE chat_sessions SET state=$2,event_at=$3,last_seen_at=now(),lease_until=$4,
        closed_at=CASE WHEN $2='offline' THEN $3 ELSE NULL END,process_id=COALESCE($5,process_id),process_started=COALESCE($6,process_started),
        capability=CASE WHEN $7 IS NOT NULL THEN $7 WHEN cli_kind='codex_cli' AND capability NOT IN ('codex_appserver','tui_prompt') THEN 'codex_queue' ELSE capability END
        WHERE id=$1 AND event_at<=$3`, [sid, state, input.at, new Date(Date.now()+90000).toISOString(), input.process_id ?? null, input.process_started ?? null, input.transport ?? null])
    } else {
      await this.db.query(`UPDATE chat_sessions SET last_seen_at=now(),lease_until=$2,
        capability=CASE WHEN $3='Watch' AND $4 IS NOT NULL THEN $4 WHEN $3='Watch' AND cli_kind='claude_code' THEN 'claude_rewake' ELSE capability END WHERE id=$1 AND closed_at IS NULL`,
      [sid, new Date(Date.now()+90000).toISOString(), input.event,input.transport ?? null])
    }
    if(input.event==='SessionStart') {
      await this.db.query('UPDATE chat_deliveries SET attempts=0,next_attempt_at=now(),error=NULL WHERE recipient_id=$1 AND read_at IS NULL',[sid])
      await this.db.query('UPDATE chat_sessions SET bootstrap_attempts=0,bootstrap_sent_at=NULL WHERE id=$1 AND team_seen=0',[sid])
    }
    const s = (await this.db.query('SELECT * FROM chat_sessions WHERE id=$1',[sid]))[0]!
    const team=await this.team(s.channel_id)
    return { ...registration, session: {...publicSession(s),role:team.leader_id===sid?'leader':'member'},team,pending: await this.pending(sid) }
    })
    this.events.emit('change',result.session.id)
    return result
  }
  async pending(sid: string) {
    return (await this.db.query(`SELECT d.message_id,m.thread_id FROM chat_deliveries d JOIN chat_messages m ON m.id=d.message_id
      WHERE d.recipient_id=$1 AND d.read_at IS NULL AND d.cancelled_at IS NULL ORDER BY m.seq LIMIT 100`, [sid]))
  }
  async call(operation: string, raw: unknown, agent?: AgentContext):Promise<any> {
    const execute=async()=>{
      if(agent)await this.assertNotRemoved(agent,typeof (raw as any)?.session_key==='string' ? (raw as any).session_key : undefined)
      return this.callInner(operation,raw,agent)
    }
    const writes=['chat_join','chat_create_channel','chat_close_channel','chat_set_nick','chat_inbox','chat_send','chat_ack','chat_resolve','chat_kick']
    const result=await (writes.includes(operation)?this.db.transaction(execute):execute())
    if(writes.includes(operation))this.events.emit('change')
    return result
  }
  private async callInner(operation: string, raw: unknown, agent?: AgentContext) {
    const definition = chatDefinitions[operation as keyof typeof chatDefinitions]
    check(definition, 'Operación de chat inexistente', 404)
    const input = parse(definition[1] as z.ZodType, raw ?? {}) as any
    if(operation==='chat_kick'){check(agent,'Sólo el líder puede usar esta herramienta; la persona usa el control de la UI',403);return this.kick(input,{agent,session_key:input.session_key},false)}
    if (operation === 'chat_join') {
      check(agent, 'Sólo los agentes pueden registrarse', 403)
      if (input.session_key) return this.register({ ...agent, cwd: input.path ?? agent.cwd }, input.session_key)
      // Native identities must retain their hook-issued key; fallback conversations create their own identity.
      const native = (await this.db.query('SELECT * FROM chat_sessions WHERE id=$1 AND agent_id=$2',[agent.session_id, agent.agent_id]))[0]
      if (native) {
        const channel=(await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[native.channel_id]))[0]!
        await this.joinableChannel(channel)
        return this.registration(native,channel,undefined,true)
      }
      return this.register({ ...agent, cwd: input.path ?? agent.cwd }, randomUUID())
    }
    if (operation === 'chat_channels') {
      // Folder assignments can be added after sessions and channels already exist.
      for (const c of await this.db.query("SELECT id,path,repository,project_id FROM chat_channels WHERE kind<>'virtual'")) {
        const project=await this.project(c.path,c.repository ?? c.path)
        if ((project?.id ?? null)!==c.project_id) await this.db.query('UPDATE chat_channels SET project_id=$2 WHERE id=$1',[c.id,project?.id ?? null])
      }
      const result = await this.page(`SELECT c.*,(SELECT label FROM chat_sessions WHERE id=c.leader_id) AS leader_label,(SELECT count(*) FROM chat_threads t WHERE t.channel_id=c.id) AS threads FROM chat_channels c WHERE (c.kind<>'virtual' OR c.activated_at IS NOT NULL) AND ($1 IS NULL OR c.project_id=$1) AND ($2 IS NULL OR c.id=$2) AND ($3=0 OR c.project_id IS NULL)`, [input.project_id ?? null,input.channel_id ?? null,input.unassigned ? 1 : 0], 'updated_at DESC,id', input)
      return { ...result,items:await Promise.all(result.items.map(async c=>({...c,read_only:await this.channelReadOnly(c)}))) }
    }
    if (operation === 'chat_agents') {
      const result = await this.page(`SELECT s.*,CASE WHEN c.leader_id=s.id THEN 'leader' ELSE 'member' END AS role FROM chat_sessions s JOIN chat_channels c ON c.id=s.channel_id WHERE (c.kind<>'virtual' OR c.activated_at IS NOT NULL) AND ($1 IS NULL OR c.project_id=$1) AND ($2 IS NULL OR c.id=$2)
        AND ($3=0 OR (c.closed_at IS NULL AND s.closed_at IS NULL AND s.lease_until>now())) AND ($4=1 OR s.removed_at IS NULL) AND ($5=0 OR c.project_id IS NULL)`,
      [input.project_id ?? null,input.channel_id ?? null,input.active_only ? 1 : 0,input.include_removed ? 1 : 0,input.unassigned ? 1 : 0], 'last_seen_at DESC,id',input)
      return { ...result, items: result.items.map(s=>({...publicSession(s),role:s.role})) }
    }
    if (operation === 'chat_threads') return this.page(`SELECT t.*,c.name AS channel_name,s.label AS author_label,
      (SELECT count(*) FROM chat_messages m WHERE m.thread_id=t.id) AS messages,
      (SELECT text FROM chat_messages m WHERE m.thread_id=t.id ORDER BY seq DESC LIMIT 1) AS preview
      FROM chat_threads t JOIN chat_channels c ON c.id=t.channel_id JOIN chat_sessions s ON s.id=t.created_by
      WHERE ($1 IS NULL OR c.project_id=$1) AND ($2 IS NULL OR c.id=$2) AND ($3 IS NULL OR t.state=$3)
      AND ($4='' OR instr(lower(t.title),lower($4))>0 OR EXISTS(SELECT 1 FROM chat_messages m WHERE m.thread_id=t.id AND instr(lower(m.text),lower($4))>0))
      AND ($5 IS NULL OR EXISTS(SELECT 1 FROM chat_messages m WHERE m.thread_id=t.id AND m.author_id=$5)) AND ($6=0 OR c.project_id IS NULL)`,
    [input.project_id ?? null,input.channel_id ?? null,input.state ?? null,input.query,input.author_id ?? null,input.unassigned ? 1 : 0], 'updated_at DESC,id',input)
    const who = agent ? await this.identity(agent, input.session_key) : undefined
    if (operation === 'chat_read') {
      const thread = (await this.db.query('SELECT * FROM chat_threads WHERE id=$1',[input.thread_id]))[0]
      check(thread, 'Hilo inexistente',404)
      if(input.project_id) check((await this.db.query('SELECT id FROM chat_channels WHERE id=$1 AND project_id=$2',[thread.channel_id,input.project_id])).length,'El hilo no pertenece al proyecto',404)
      const result = await this.page(`SELECT m.*,s.label AS author_label,s.cli_kind FROM chat_messages m JOIN chat_sessions s ON s.id=m.author_id WHERE m.thread_id=$1`,[thread.id],'seq',input)
      if (who) for (const m of result.items) await this.db.query('UPDATE chat_deliveries SET read_at=COALESCE(read_at,now()) WHERE message_id=$1 AND recipient_id=$2 AND cancelled_at IS NULL',[m.id,who.id])
      return { ...result, thread, team:await this.team(thread.channel_id),items: await this.receipts(result.items) }
    }
    check(who && !who.closed_at, 'Sólo una sesión de agente abierta puede participar',403)
    if (operation === 'chat_create_channel') {
      const channel=(await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[who.channel_id]))[0]!
      check(channel.kind==='virtual' && !channel.closed_at,'Esta sesión no está esperando un canal virtual descartable.',409)
      if(channel.activated_at) {
        check(channel.leader_id===who.id,'Ya existe un canal virtual activo en esta carpeta. El primer creador conserva el liderazgo.',409)
      } else {
        await this.db.query('UPDATE chat_channels SET activated_at=now(),leader_id=$2,name=COALESCE($3,name),updated_at=now() WHERE id=$1 AND activated_at IS NULL AND closed_at IS NULL',[channel.id,who.id,input.name ?? null])
      }
      await this.db.query('UPDATE chat_sessions SET team_seen=1 WHERE id=$1',[who.id])
      return this.registration((await this.db.query('SELECT * FROM chat_sessions WHERE id=$1',[who.id]))[0]!,(await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[channel.id]))[0]!,input.session_key,false)
    }
    if (operation === 'chat_close_channel') {
      const channel=(await this.db.query('SELECT * FROM chat_channels WHERE id=$1',[who.channel_id]))[0]!
      check(channel.kind==='virtual' && channel.activated_at && !channel.closed_at,'Esta sesión no pertenece a un canal virtual activo.',409)
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
      const team=await this.team(who.channel_id)
      return { session:{...publicSession(value),role:team.leader_id===who.id?'leader':'member'},team }
    }
    if (operation === 'chat_inbox') {
      await this.activate(who.id)
      await this.db.query('UPDATE chat_sessions SET last_seen_at=now(),lease_until=$2 WHERE id=$1 AND closed_at IS NULL',[who.id,new Date(Date.now()+90000).toISOString()])
      const result = await this.page(`SELECT m.*,s.label AS author_label,t.title,d.read_at,d.handled_at FROM chat_deliveries d JOIN chat_messages m ON m.id=d.message_id
        JOIN chat_threads t ON t.id=m.thread_id JOIN chat_sessions s ON s.id=m.author_id WHERE d.recipient_id=$1 AND d.handled_at IS NULL AND d.cancelled_at IS NULL AND ($2=0 OR d.read_at IS NULL)`,[who.id,input.unread_only ? 1 : 0],'seq',input)
      for (const m of result.items) await this.db.query('UPDATE chat_deliveries SET read_at=COALESCE(read_at,now()) WHERE message_id=$1 AND recipient_id=$2 AND cancelled_at IS NULL',[m.id,who.id])
      return {...result,team:await this.team(who.channel_id),usage_notices:await new UsageNotices(this).pending(who.id,true)}
    }
    await this.db.query('UPDATE chat_sessions SET last_seen_at=now(),lease_until=$2 WHERE id=$1 AND closed_at IS NULL',[who.id,new Date(Date.now()+90000).toISOString()])
    if (operation === 'chat_ack') {
      const rows = await this.db.query('UPDATE chat_deliveries SET read_at=COALESCE(read_at,now()),handled_at=COALESCE(handled_at,now()) WHERE message_id=$1 AND recipient_id=$2 AND cancelled_at IS NULL RETURNING *',[input.message_id,who.id])
      check(rows.length, 'La mención no está destinada a esta sesión',403); return rows[0]
    }
    await this.writableChannel(who.channel_id)
    if (operation === 'chat_resolve') {
      const rows = await this.db.query('UPDATE chat_threads SET state=$2,updated_at=now() WHERE id=$1 AND channel_id=$3 RETURNING *',[input.thread_id,input.state,who.channel_id])
      check(rows.length,'El hilo no pertenece a tu canal',403); return rows[0]
    }
    check(who.nickname, 'Elegí tu propio nick con chat_set_nick antes de escribir.',409)
    const requestHash=hash(JSON.stringify({thread:input.thread_id ?? null,channel:input.channel_id ?? null,title:input.title ?? null,task:input.task_id ?? null,text:input.text,reply:input.reply_to ?? null,mentions:[...new Set(input.mentions)].sort()}))
    const result = await this.db.transaction(async sql => {
      const prior = (await sql.query('SELECT * FROM chat_messages WHERE author_id=$1 AND request_id=$2',[who.id,input.request_id]))[0]
      if (prior) {
        check(prior.request_hash===requestHash, 'request_id ya usado con otro mensaje',409)
        return prior
      }
      let thread
      if (input.thread_id) thread = (await sql.query('SELECT * FROM chat_threads WHERE id=$1',[input.thread_id]))[0]
      else {
        check(input.title && input.channel_id === who.channel_id, 'Para iniciar un hilo usá el channel_id de tu sesión y un título',400)
        if (input.task_id) check((await sql.query('SELECT id FROM tasks WHERE id=$1 AND project_id=(SELECT project_id FROM chat_channels WHERE id=$2)',[input.task_id,who.channel_id])).length,'La tarea no pertenece al proyecto',400)
        thread = (await sql.query('INSERT INTO chat_threads(id,channel_id,title,created_by,task_id) VALUES($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),who.channel_id,input.title,who.id,input.task_id ?? null]))[0]
      }
      check(thread,'Hilo inexistente',404)
      let linkedTeam:Record<string,any>|undefined
      const teamRoot=(await sql.query('SELECT id FROM chat_team_plans WHERE root_thread_id=$1',[thread.id]))[0]
      if(teamRoot || thread.channel_id!==who.channel_id) {
        linkedTeam=await this.teamForThread(sql,who,thread)
        check(linkedTeam,'Sólo el master y miembros vinculados pueden escribir en el hilo raíz activo de su equipo.',403)
      }
      if (input.reply_to) check((await sql.query('SELECT id FROM chat_messages WHERE id=$1 AND thread_id=$2',[input.reply_to,thread.id])).length,'La respuesta debe apuntar al mismo hilo',400)
      for (const recipient of new Set(input.mentions as string[])) {
        check(recipient !== who.id,'No podés despertarte mencionándote a vos mismo',400)
        const target=(await sql.query('SELECT id,channel_id,removed_at FROM chat_sessions WHERE id=$1',[recipient]))[0]
        if(linkedTeam)check(await this.teamRecipient(sql,linkedTeam,recipient),'La mención debe pertenecer al equipo vinculado a este hilo.',400)
        else if(target && target.channel_id===thread.channel_id)check(!target.removed_at,'La mención no puede dirigirse a una sesión expulsada',400)
        else check(false,'La mención debe pertenecer al mismo canal.',400)
      }
      const message = (await sql.query('INSERT INTO chat_messages(id,thread_id,author_id,text,reply_to,request_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [randomUUID(),thread.id,who.id,input.text,input.reply_to ?? null,input.request_id,requestHash]))[0]!
      for (const recipient of new Set(input.mentions as string[])) await sql.query('INSERT INTO chat_deliveries(message_id,recipient_id) VALUES($1,$2)',[message.id,recipient])
      if(linkedTeam)await sql.query(`INSERT INTO chat_team_events(id,team_id,type,actor_session_id,source_channel_id,target_thread_id,payload)
        VALUES($1,$2,'chat_message',$3,$4,$5,$6)`,[randomUUID(),linkedTeam.id,who.id,who.channel_id,thread.id,JSON.stringify({message_id:message.id,request_hash:requestHash})])
      await sql.query('UPDATE chat_threads SET updated_at=now() WHERE id=$1',[thread.id])
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
        WHERE m.team_id=t.id AND m.session_id=$3 AND m.channel_id=$2 AND m.state='joined'))`,[thread.id,who.channel_id,who.id]))[0]
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
    if(channel.kind==='virtual') {
      check(!channel.closed_at,'Este canal virtual está cerrado. El historial se conserva, pero no admite nuevas escrituras ni adhesiones.',409)
      check(channel.activated_at,'La carpeta está preparada, pero la persona todavía no pidió crear un canal virtual. No lo crees silenciosamente.',409)
      return this.workspaceFolder(channel.path)
    }
    if(channel.orca_workspace_id) return this.workspaceFolder(channel.path)
    const folder=await chatFolder(channel.path)
    check(folder.root===channel.path, 'Este canal anterior es histórico. Registrate desde la raíz del worktree en una nueva conversación.',409)
    return folder
  }
  private async joinableChannel(channel:Record<string,any>) {
    if(channel.kind==='virtual') {
      check(!channel.closed_at,'Este canal virtual está cerrado y no admite nuevas adhesiones. Una conversación nueva puede crear otro cuando la persona lo pida.',409)
      return this.workspaceFolder(channel.path)
    }
    return this.writableChannel(channel.id)
  }
  private async workspaceFolder(path:string) {
    const root=await realpath(resolve(path)).catch(()=>null)
    check(root && await stat(root).then(s=>s.isDirectory()).catch(()=>false),'La carpeta del espacio de Orca no está disponible. El canal conserva su historial.',409)
    return root
  }
  private channelReadOnly(channel:Record<string,any>):Promise<boolean|null> {
    const {path}=channel,cacheKey=`${channel.scope_key}:${channel.activated_at ?? ''}:${channel.closed_at ?? ''}`
    const cached=this.availability.get(cacheKey)
    if(cached && cached.until>Date.now())return cached.readOnly
    // Observers poll frequently. Presence here is advisory; writes always validate Git again.
    if(this.availability.size>=256)this.availability.clear()
    const readOnly=channel.kind==='virtual' ? (channel.closed_at || !channel.activated_at ? Promise.resolve(true) : this.workspaceFolder(path).then(()=>false,()=>true))
      : channel.orca_workspace_id ? this.workspaceFolder(path).then(()=>false,()=>true)
      : chatFolder(path).then(folder=>folder.root!==path,error=>(error as {statusCode?:number}).statusCode===503 ? null : true)
    void readOnly.then(value=>{if(value===null)this.availability.delete(cacheKey)})
    this.availability.set(cacheKey,{until:Date.now()+30000,readOnly})
    return readOnly
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
