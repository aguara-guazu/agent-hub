import { TeamPlan, TeamPreference } from './TeamPlan'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AgentActivity } from './AgentActivity'
import { Modal } from '../components/Modal'
import { api } from '../lib/api'
import { useSearchParams } from 'react-router-dom'
import { CLI_LABELS, type CliKind } from '../lib/types'
import { ErrorBox, formatTime, Pager, useMemory, type Page } from '../lib/memory'

interface Channel { team_plan_id?:string|null; parent_channel_id?:string|null; leader_id?:string|null; id:string; name:string; path:string; branch:string|null; threads:number; orca_workspace_id?:string|null; read_only?:boolean|null; kind?:string; closed_at?:string|null; deleted_at?:string|null }
interface Participant { team_state?:string|null;member_state?:string|null;team_id?:string|null;team_role?:string|null;master_channel_id?:string|null;work_thread_id?:string|null; nickname?:string|null; closed_at?:string|null; created_at?:string; id:string; channel_id:string; removed_at?:string|null; removal_reason?:string|null; removed_by?:string|null; label:string; cli_kind:string; state:string; state_reason?:string|null; state_observed_at?:string; connection_state?:string; capability:string; last_seen_at:string; wake_error:string|null; role?:string; needs_nickname?:boolean }
interface Thread { pending_responses?:number;awaiting_labels?:string;participants?:string;team_root_thread_id?:string|null; id:string; channel_id:string; title:string; state:string; channel_name:string; messages:number; preview:string; author_label:string; updated_at:string; task_id:string|null; team_plan_id?:string|null; team_plan_state?:string|null }
interface Receipt { response_required?:number;response_message_id?:string|null;response_alerted_at?:string|null;recipient_id:string; cancelled_at?:string|null; label:string; notified_at:string|null; read_at:string|null; handled_at:string|null; attempts:number; error:string|null }
interface Message { id:string; author_id:string; author_label:string; text:string; created_at:string; reply_to:string|null; mentions:Receipt[] }
const states:Record<string,string> = { idle:'Disponible',busy:'Trabajando',blocked:'Bloqueado',offline:'Desconectado',unknown:'Sin señal reciente',removed:'Expulsado' }
const capabilities:Record<string,string> = { hub_fleet:'Flota del Hub',codex_queue:'Notificación nativa',claude_rewake:'Escucha nativa',tui_prompt:'TUI conectada',codex_appserver:'Terminal conectada',next_turn:'Al próximo turno',opencode_prompt:'Escucha nativa',acp_prompt:'Terminal conectada',antigravity_stream:'Terminal conectada' }

export function ProjectCollaboration({ projectId, unassigned = false }: { projectId?:string; unassigned?:boolean }) {
  const cache=useQueryClient(),[removing,setRemoving]=useState<Participant|null>(null),[reason,setReason]=useState(''),[agentsOpen,setAgentsOpen]=useState(false),[inspecting,setInspecting]=useState<Participant|null>(null),[coordinating,setCoordinating]=useState<Participant|null>(null)
  const kick=useMutation({mutationFn:(input:{project_id?:string;channel_id:string;participant_id:string;reason:string})=>api.post('/memory/chat/kick',input),
    onSuccess:()=>{setRemoving(null);setReason('');change({agent_offset:0});void cache.invalidateQueries({queryKey:['memory']})}})
  const designate=useMutation({mutationFn:(input:{channel_id:string;participant_id:string;expected_leader_id:string|null})=>api.post<{uncertain_members?:string[]}>('/memory/chat/coordinator',input),
    onSuccess:()=>{setCoordinating(null);void cache.invalidateQueries({queryKey:['memory']})}})
  const [deleting,setDeleting]=useState<Channel|null>(null)
  const removeChannel=useMutation({mutationFn:(channel_id:string)=>api.post<{uncertain_members?:string[]}>('/memory/chat/channels/delete',{channel_id,reason:'Eliminado por la persona desde la UI'}),
    onSuccess:()=>{setDeleting(null);change({channel:null,thread:null,plan:null});void cache.invalidateQueries({queryKey:['memory']})}})
  const restoreChannel=useMutation({mutationFn:(channel_id:string)=>api.post('/memory/chat/channels/restore',{channel_id}),onSuccess:()=>cache.invalidateQueries({queryKey:['memory']})})
  const [params,setParams] = useSearchParams()
  const trash=params.get('trash')==='1'
  const change = (patch:Record<string,string|number|null>) => setParams(previous => {
    const next = new URLSearchParams(previous)
    for (const [k,v] of Object.entries(patch)) { if (v===null || v==='') next.delete(k); else next.set(k,String(v)) }
    return next
  })
  const channelId = params.get('channel') ?? '', threadId = params.get('thread') ?? ''
  const query = params.get('chat_q') ?? '', author = params.get('chat_author') ?? '', state = params.get('chat_state') ?? ''
  const offset = Math.max(0,Number(params.get('chat_offset'))||0), messageOffset = Math.max(0,Number(params.get('message_offset'))||0)
  const channelOffset = Math.max(0,Number(params.get('channel_offset'))||0), agentOffset = Math.max(0,Number(params.get('agent_offset'))||0)
  const projectScope = projectId ? {project_id:projectId} : {}
  const scope = {...projectScope,...(!projectId && unassigned ? {unassigned:true}:{})}
  const channels = useMemory<Page<Channel>>('chat_channels',{ ...scope,limit:40,offset:channelOffset,...(trash?{deleted:true}:{}) })
  const threads = useMemory<Page<Thread>>('chat_threads',{ ...scope,...(channelId ? {channel_id:channelId}:{}),query,...(author ? {author_id:author}:{}),...(state ? {state}:{}),limit:30,offset })
  const messages = useMemory<Page<Message> & { thread:Thread }>('chat_read',{ ...projectScope,thread_id:threadId,limit:40,offset:messageOffset },!!threadId)
  const visibleChannelId = channelId || messages.data?.thread.channel_id || ''
  const agents = useMemory<Page<Participant>>('chat_agents',{ ...scope,include_team_history:true,...(visibleChannelId ? {channel_id:visibleChannelId}:{}),limit:40,offset:agentOffset })
  const selectedChannel=useMemory<Page<Channel>>('chat_channels',{...scope,channel_id:visibleChannelId},!!visibleChannelId && !!channels.data && !channels.data.items.some(c=>c.id===visibleChannelId))
  const channel = channels.data?.items.find(c=>c.id===visibleChannelId) ?? selectedChannel.data?.items[0]
  const visibleAgents = agents.data?.items.filter(agent=>!agent.removed_at && agent.state!=='removed' && (!!agent.team_id || (!agent.closed_at && agent.state!=='offline')) && !agent.needs_nickname && agent.label.trim() && (agent.nickname===undefined || !!agent.nickname?.trim())).sort((a,b)=>(a.created_at??'').localeCompare(b.created_at??'') || a.id.localeCompare(b.id)) ?? []
  const selectAgent = (agent:Participant) => change({chat_author:author===agent.id?null:agent.id,chat_offset:0,...(threadId ? {thread:null,channel:agent.master_channel_id ?? agent.channel_id,message_offset:null}: {})})
  const planId=params.get('plan') ?? (!threadId && params.get('view')==='team'?channel?.team_plan_id:null)
  const openThread=(thread:string,targetChannel?:string)=>change({thread,channel:targetChannel ?? visibleChannelId,plan:null,view:null,message_offset:0})
  return <section className="local-chat" aria-label="Colaboración local">
    <div className="local-chat-heading"><div><h2>Colaboración</h2><p>Equipo y conversaciones, organizados por tarea.</p></div><span className="local-chat-observer">Chat de sólo lectura</span></div>
    <details className="local-chat-help"><summary>Conexión y preferencias</summary><TeamPreference/><p>Los lanzadores abren la TUI original de cada cliente y conservan sus opciones. Abrí Claude Code con <code>agenthub-claude</code>, OpenCode con <code>agenthub-opencode</code>, Codex con <code>agenthub-codex</code>, Gemini con <code>agenthub-gemini</code>, Kiro con <code>agenthub-kiro</code> o Antigravity CLI con <code>agenthub-agy</code> desde el espacio de la tarea. El Hub instala esos lanzadores al sincronizar el cliente.</p><p>Los conectores funcionan desde cualquier terminal, dentro o fuera de Orca. Al empezar una tarea, el agente te pregunta si querés trabajar solo o usar el equipo del Hub. Antes de crear un canal, te pide autorización con su nombre y objetivo. Los canales son independientes de las carpetas y los worktrees; los miembros se incorporan por invitación del equipo aprobado. El líder transmite tus tareas y permisos. Una sesión que indica «Al próximo turno» necesita su conector para recibir avisos en reposo.</p></details>
    <div className={`local-chat-layout ${agentsOpen?'agents-open':''}`}>
      <aside className="local-chat-channels" aria-label={unassigned?"Canales sin proyecto":"Canales del proyecto"}><h3>Canales <span>{channels.data?.total ?? 0}</span></h3>
        <button className={!visibleChannelId && !trash?'selected':''} onClick={()=>change({trash:null,channel:null,thread:null,plan:null,chat_offset:0,agent_offset:0,channel_offset:0})}>Todos los canales</button>
        <button className={trash?'selected':''} onClick={()=>{setAgentsOpen(false);change({trash:'1',channel:null,thread:null,plan:null,channel_offset:0})}}>Papelera</button>
        <ErrorBox error={channels.error} retry={channels.refetch}/>
        {channels.isPending && <p role="status">Cargando canales…</p>}
        {channels.data?.items.map(c=><button key={c.id} className={visibleChannelId===c.id?'selected':''} title={c.path} disabled={trash && restoreChannel.isPending} onClick={()=>trash?restoreChannel.mutate(c.id):change({channel:c.id,thread:null,plan:null,view:null,chat_offset:0,agent_offset:0,chat_author:null})}>
          <span className="local-chat-channel-name"><span># {c.name}</span><small>{c.threads}</small></span><small>{c.closed_at ? 'Cerrado · sólo lectura' : c.read_only ? 'Histórico · sólo lectura' : c.kind==='virtual' ? 'Canal de tarea' : c.orca_workspace_id ? 'Espacio de Orca' : c.branch ?? 'HEAD separado'}</small><small className="local-chat-path">{c.path}</small>
          {trash && <span>Restaurar historial</span>}
        </button>)}
        <ErrorBox error={restoreChannel.error}/>
        {channels.data && channels.data.total>40 && <Pager {...channels.data} setOffset={v=>change({channel_offset:v})}/>}
        <details className="local-chat-help"><summary>Cómo se organizan</summary><p>Un canal reúne la tarea, el equipo y sus conversaciones. Los espacios de trabajo de cada miembro se consultan dentro del equipo.</p></details>
      </aside>
      <div className="local-chat-work">
        {channel?.read_only && <p className="local-chat-help" role="status">{channel.closed_at ? 'Canal cerrado: el historial se conserva sólo para lectura.' : 'Espacio no disponible: este canal conserva su historial sólo para lectura.'}</p>}
        <div className="local-chat-scope"><div className="local-chat-scope-info"><strong>{trash?'Papelera':channel ? `# ${channel.name}` : 'Todos los canales'}</strong>{channel && <span title={channel.path}>{channel.branch ?? channel.path}</span>}</div>
          {channel && !trash && <button className="btn btn-sm" onClick={()=>{removeChannel.reset();setDeleting(channel)}}>Eliminar canal</button>}
          <button className="btn btn-sm local-chat-agent-toggle" aria-controls="local-chat-agents-panel" aria-expanded={agentsOpen} onClick={()=>setAgentsOpen(open=>!open)}>{agentsOpen?'Ocultar agentes':`Mostrar agentes (${agents.data?.total ?? 0})`}</button>
        </div>
        {!trash && channel?.team_plan_id && <nav className="local-chat-tabs" aria-label="Vista del canal">
          <button className={!planId?'selected':''} onClick={()=>change({view:null,plan:null,thread:null,message_offset:null})}>Conversaciones{threads.data?` (${threads.data.total})`:''}</button>
          <button className={planId?'selected':''} onClick={()=>change({view:'team',plan:null,thread:null})}>Equipo y avances</button>
        </nav>}
        {channel?.parent_channel_id && <button className="btn" onClick={()=>change({channel:channel.parent_channel_id!,thread:null,plan:null})}>Volver al canal del equipo</button>}
        {!trash && planId && <TeamPlan key={planId} id={planId} compact={!params.get('plan')} onThread={openThread}/>}
        {trash && <p className="local-chat-help">Restaurar recupera el historial del canal. No reactiva sesiones ni equipos y no modifica archivos.</p>}
        {!trash && !planId && !threadId && <div className="local-chat-filters"><input className="input" type="search" aria-label="Buscar hilos y mensajes" placeholder="Buscar en títulos y mensajes…" value={query} onChange={e=>change({chat_q:e.target.value,chat_offset:0})}/>
          <select className="input" aria-label="Estado del hilo" value={state} onChange={e=>change({chat_state:e.target.value,chat_offset:0})}><option value="">Todos los estados</option><option value="open">Abiertos</option><option value="resolved">Resueltos</option></select>
          {author && <button className="btn btn-sm" onClick={()=>change({chat_author:null,chat_offset:0})}>Quitar filtro de agente</button>}
        </div>}
        {!trash && !planId && <div className="local-chat-conversations">
          {!threadId && <div className="local-chat-threads" aria-label="Hilos del canal"><div className="local-chat-list-heading"><h3>Hilos</h3><span>{threads.data?`${threads.data.total} conversaciones`:'Cargando…'}</span></div><ErrorBox error={threads.error} retry={threads.refetch}/>
            {threads.isPending && <p role="status">Buscando conversaciones…</p>}
            {threads.data?.items.map(t=><div key={t.id} className="local-chat-thread">
              <div className="local-chat-thread-summary"><div className="local-chat-thread-meta"><span className={`local-chat-tag ${t.state}`}>{t.state==='resolved'?'Resuelto':'Abierto'}</span><small>{t.messages} mensajes</small>{!!t.pending_responses && <span className="local-chat-tag pending">{t.pending_responses} sin respuesta</span>}</div><h4><button className="local-chat-thread-title" onClick={()=>openThread(t.id,t.channel_id)}>{t.title}</button></h4><p>{t.preview || 'Todavía no hay reportes en este hilo.'}</p>{t.awaiting_labels && <p className="local-chat-awaiting">Esperando respuesta de {t.awaiting_labels}</p>}{t.participants && <p className="local-chat-participants">Participan: {t.participants}</p>}<small>#{t.channel_name} · {t.author_label} · {formatTime(t.updated_at)}</small></div>
              <div className="local-chat-thread-actions">{t.team_plan_id && !t.team_root_thread_id && <button className="btn btn-primary btn-sm" onClick={()=>change({plan:t.team_plan_id!,channel:t.channel_id})}>{t.team_plan_state==='prepared'?'Revisar y aprobar equipo':'Ver equipo'}</button>}
              <button className="btn btn-sm" aria-label={`Abrir hilo: ${t.title}`} onClick={()=>change({thread:t.id,channel:t.channel_id,plan:null,message_offset:0,...(channelId===t.channel_id?{}:{chat_offset:0})})}>Abrir hilo <span aria-hidden="true">→</span></button></div>
            </div>)}
            {threads.data?.total===0 && <div className="memory-empty"><h3>{query || author || state ? 'Sin coincidencias' : 'Todavía no hay hilos'}</h3><p>{query || author || state ? 'Probá con otro texto o quitá los filtros. La búsqueda incluye el historial.' : 'Los agentes crean un hilo al iniciar una tarea o pedir una revisión. Podrás seguir la conversación acá.'}</p></div>}
            {threads.data && threads.data.total>30 && <Pager {...threads.data} setOffset={v=>change({chat_offset:v})}/>}
          </div>}
          {threadId && <article className="local-chat-detail" aria-label="Conversación del hilo"><nav className="local-chat-back"><button className="btn btn-sm" onClick={()=>change({thread:null,channel:messages.data?.thread.channel_id ?? channelId,message_offset:null})}>← Volver al canal</button></nav><ErrorBox error={messages.error} retry={messages.refetch}/>
            {messages.isPending && <p role="status">Abriendo hilo…</p>}
            {messages.data && <><header><div><span className={`local-chat-tag ${messages.data.thread.state}`}>{messages.data.thread.state==='resolved'?'Resuelto':'Abierto'}</span><h3>{messages.data.thread.title}</h3>{messages.data.thread.task_id && <small>Tarea vinculada: {messages.data.thread.task_id}</small>}</div><span className="local-chat-count">{messages.data.total} mensajes</span></header>
              {messages.data.thread.team_plan_id && <button className="btn btn-primary" onClick={()=>change({plan:messages.data!.thread.team_plan_id!})}>{messages.data.thread.team_plan_state==='prepared'?'Revisar y aprobar equipo':'Ver equipo'}</button>}
              <ol className="local-chat-messages">{messages.data.items.map(m=><li key={m.id} id={`chat-${m.id}`}><div className="local-chat-message-heading"><strong>{m.author_label}</strong><time dateTime={m.created_at}>{formatTime(m.created_at)}</time></div>
                {m.reply_to && <small className="muted">Respuesta a {m.reply_to.slice(0,8)}</small>}<p className="local-chat-message-text">{m.text}</p>
                {!!m.mentions.length && <ul className="local-chat-receipts" aria-label="Estado de las menciones">{m.mentions.map(r=><li key={r.recipient_id}><span>@{r.label}</span><strong>{r.cancelled_at?'Cancelado':r.response_message_id?'Respondido':r.response_required?(r.read_at?'Leído · falta responder':'Respuesta solicitada'):r.handled_at?'Atendido':r.read_at?'Leído':r.notified_at?'Notificado':'Pendiente'}</strong>{r.response_alerted_at && !r.response_message_id && !r.cancelled_at && <small>Se avisó al solicitante que sigue pendiente</small>}{r.error && <small>{r.error}</small>}{!r.cancelled_at && !r.read_at && r.attempts>=5 && <small>Sin confirmación de lectura después de 5 intentos</small>}</li>)}</ul>}
              </li>)}</ol><Pager {...messages.data} setOffset={v=>change({message_offset:v})}/>
              <footer>Las personas pueden observar. Sólo los agentes escriben y confirman lectura.</footer></>}
          </article>}
        </div>}
      </div>
      {agentsOpen && <aside id="local-chat-agents-panel" className="local-chat-agents-panel" aria-label="Agentes del canal y sus equipos">
        <div className="local-chat-agents-heading"><h3>Agentes</h3><span>{agents.data?.total ?? 0} {agents.data?.total===1?'participante':'participantes'}</span></div>
        <ErrorBox error={agents.error} retry={agents.refetch}/>
        {agents.isPending && <p className="local-chat-help" role="status">Cargando agentes…</p>}
        <div className="local-chat-agents-list">{visibleAgents.map(a=><div key={a.id} className={`local-chat-agent ${author===a.id?'selected':''}`}>
          <button className="local-chat-agent-profile" onClick={()=>setInspecting(a)} title={`Ver actividad · ${capabilities[a.capability] ?? a.capability}${a.state_reason==='activity_stale' ? ' · La conexión sigue activa; no confirma que esté trabajando.' : ''} · Última conexión: ${formatTime(a.last_seen_at)}${a.state_observed_at ? ` · Último estado observado: ${formatTime(a.state_observed_at)}` : ''}${a.wake_error ? ` · Aviso: ${a.wake_error}` : ''}`}>
            <strong><span className={`local-chat-presence ${a.state}`}/>{a.label}{a.role==='leader' && !a.team_id && <span className="local-chat-tag">Líder</span>}</strong>
            <small>{CLI_LABELS[a.cli_kind as CliKind] ?? a.cli_kind} · {a.state_reason==='activity_stale'?'Actividad sin confirmar':states[a.state] ?? a.state}</small>
          </button>
          {!a.closed_at && !a.team_id && a.role!=='leader' && a.connection_state==='online' && channel?.id===a.channel_id && <button className="btn btn-sm" onClick={()=>{designate.reset();setCoordinating(a)}}>Designar coordinador</button>}
          {a.team_state && ['cancelled','completed'].includes(a.team_state) && <small className="local-chat-team-role">Equipo cerrado</small>}
          {a.work_thread_id && <button className="btn btn-sm" onClick={()=>openThread(a.work_thread_id!,a.master_channel_id ?? a.channel_id)}>Ver conversación</button>}
          {a.team_role && <small className="local-chat-team-role">{a.team_role}</small>}
          {!a.team_id && <button className="btn btn-ghost btn-sm local-chat-remove" aria-label={`Expulsar a ${a.label}`} onClick={()=>{kick.reset();setReason('');setRemoving(a)}} title={`Expulsar a ${a.label}`}>×</button>}
        </div>)}</div>
        {agents.data && !agents.isPending && visibleAgents.length===0 && <p className="local-chat-help">No hay participantes visibles en esta página.</p>}
        {agents.data && agents.data.total>40 && <Pager {...agents.data} setOffset={v=>change({agent_offset:v})}/>}
        <p className="local-chat-help">Los miembros del equipo permanecen visibles al desconectarse o cerrar el equipo. Su presencia aquí no significa que sigan trabajando. Se ocultan las sesiones expulsadas y las pendientes de elegir nombre.</p>
      </aside>}
    </div>
    <Modal open={!!deleting} title="Eliminar canal" busy={removeChannel.isPending} onClose={()=>setDeleting(null)} footer={<>
      <button className="btn" disabled={removeChannel.isPending} onClick={()=>setDeleting(null)}>Cancelar</button>
      <button className="btn btn-danger" disabled={removeChannel.isPending} onClick={()=>deleting && removeChannel.mutate(deleting.id)}>Mover a la papelera</button>
    </>}><p>Se eliminará «{deleting?.name}» de los canales y las búsquedas. Sus sesiones se cerrarán, sus equipos se cancelarán y el Hub detendrá sus trabajadores.</p><p>Los archivos y worktrees se conservan. Podés recuperar el historial desde la papelera.</p><ErrorBox error={removeChannel.error}/></Modal>
    {!!removeChannel.data?.uncertain_members?.length && <div role="alert"><p>El canal está en la papelera, pero no se confirmó la detención de todos sus trabajadores.</p><button className="btn" disabled={removeChannel.isPending} onClick={()=>removeChannel.variables && removeChannel.mutate(removeChannel.variables)}>Reintentar detención</button></div>}
    <Modal open={!!coordinating} title="Designar coordinador" busy={designate.isPending} onClose={()=>setCoordinating(null)} footer={<>
      <button className="btn" disabled={designate.isPending} onClick={()=>setCoordinating(null)}>Cancelar</button>
      <button className="btn btn-primary" disabled={designate.isPending} onClick={()=>coordinating && designate.mutate({channel_id:coordinating.channel_id,participant_id:coordinating.id,expected_leader_id:channel?.leader_id ?? null})}>Designar esta sesión</button>
    </>}><p>{coordinating?.label} coordinará este canal. Los equipos anteriores quedarán pausados y sus trabajadores del Hub se detendrán. El historial se conserva.</p><ErrorBox error={designate.error}/></Modal>
    {designate.data?.uncertain_members?.length ? <p role="alert">El coordinador cambió, pero no se pudo confirmar la detención de todos los trabajadores. Revisá su estado antes de iniciar otro equipo.</p>:null}
    {inspecting && <AgentActivity key={inspecting.id} agent={inspecting} onClose={()=>setInspecting(null)} onMessages={()=>{selectAgent(inspecting);setInspecting(null)}}/>}
    <Modal open={!!removing} title={`Expulsar a ${removing?.label ?? 'agente'}`} busy={kick.isPending} onClose={()=>setRemoving(null)} footer={<>
      <button className="btn" disabled={kick.isPending} onClick={()=>setRemoving(null)}>Cancelar</button>
      <button className="btn btn-danger" disabled={kick.isPending} onClick={()=>removing && kick.mutate({...projectScope,channel_id:removing.channel_id,participant_id:removing.id,reason:reason.trim() || 'Expulsado por la persona desde la UI'})}>{kick.isPending?'Expulsando…':'Confirmar expulsión'}</button>
    </>}>
      <p>Dejará de recibir avisos y de participar en este canal. El historial se conserva y esta sesión no podrá reincorporarse automáticamente.</p>
      <p>Su terminal seguirá abierta y los trabajos que ya estén ejecutándose no se detendrán.</p>
      {removing?.role==='leader' && <p>El canal quedará sin líder. La próxima sesión habilitada que reciba un pedido humano o se registre explícitamente asumirá ese rol.</p>}
      <label className="field">Motivo (opcional)<input className="input" maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>
      <ErrorBox error={kick.error}/>
    </Modal>
  </section>
}
