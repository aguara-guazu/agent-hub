import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Modal } from '../components/Modal'
import { api } from '../lib/api'
import { useSearchParams } from 'react-router-dom'
import { CLI_LABELS, type CliKind } from '../lib/types'
import { ErrorBox, formatTime, Pager, useMemory, type Page } from '../lib/memory'

interface Channel { id:string; name:string; path:string; branch:string|null; threads:number; orca_workspace_id?:string|null; read_only?:boolean|null; kind?:string; closed_at?:string|null }
interface Participant { id:string; channel_id:string; removed_at?:string|null; removal_reason?:string|null; removed_by?:string|null; label:string; cli_kind:string; state:string; state_reason?:string|null; state_observed_at?:string; connection_state?:string; capability:string; last_seen_at:string; wake_error:string|null; role?:string; needs_nickname?:boolean }
interface Thread { id:string; channel_id:string; title:string; state:string; channel_name:string; messages:number; preview:string; author_label:string; updated_at:string; task_id:string|null }
interface Receipt { recipient_id:string; cancelled_at?:string|null; label:string; notified_at:string|null; read_at:string|null; handled_at:string|null; attempts:number; error:string|null }
interface Message { id:string; author_id:string; author_label:string; text:string; created_at:string; reply_to:string|null; mentions:Receipt[] }
const states:Record<string,string> = { idle:'Disponible',busy:'Trabajando',blocked:'Bloqueado',offline:'Desconectado',unknown:'Sin señal reciente',removed:'Expulsado' }
const capabilities:Record<string,string> = { codex_queue:'Notificación nativa',claude_rewake:'Escucha nativa',tui_prompt:'TUI conectada',codex_appserver:'Terminal conectada',next_turn:'Al próximo turno',opencode_prompt:'Escucha nativa',acp_prompt:'Terminal conectada',antigravity_stream:'Terminal conectada' }

export function ProjectCollaboration({ projectId, unassigned = false }: { projectId?:string; unassigned?:boolean }) {
  const cache=useQueryClient(),[removing,setRemoving]=useState<Participant|null>(null),[reason,setReason]=useState(''),[agentsOpen,setAgentsOpen]=useState(false)
  const kick=useMutation({mutationFn:(input:{project_id?:string;channel_id:string;participant_id:string;reason:string})=>api.post('/memory/chat/kick',input),
    onSuccess:()=>{setRemoving(null);setReason('');change({agent_offset:0});void cache.invalidateQueries({queryKey:['memory']})}})
  const [params,setParams] = useSearchParams()
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
  const channels = useMemory<Page<Channel>>('chat_channels',{ ...scope,limit:40,offset:channelOffset })
  const threads = useMemory<Page<Thread>>('chat_threads',{ ...scope,...(channelId ? {channel_id:channelId}:{}),query,...(author ? {author_id:author}:{}),...(state ? {state}:{}),limit:30,offset })
  const messages = useMemory<Page<Message> & { thread:Thread }>('chat_read',{ ...projectScope,thread_id:threadId,limit:40,offset:messageOffset },!!threadId)
  const visibleChannelId = channelId || messages.data?.thread.channel_id || ''
  const agents = useMemory<Page<Participant>>('chat_agents',{ ...scope,...(visibleChannelId ? {channel_id:visibleChannelId}:{}),limit:40,offset:agentOffset })
  const selectedChannel=useMemory<Page<Channel>>('chat_channels',{...scope,channel_id:visibleChannelId},!!visibleChannelId && !!channels.data && !channels.data.items.some(c=>c.id===visibleChannelId))
  const channel = channels.data?.items.find(c=>c.id===visibleChannelId) ?? selectedChannel.data?.items[0]
  const visibleAgents = agents.data?.items.filter(agent=>!agent.removed_at && agent.state!=='removed') ?? []
  const selectAgent = (agent:Participant) => change({chat_author:author===agent.id?null:agent.id,chat_offset:0,...(threadId ? {thread:null,channel:agent.channel_id,message_offset:null}: {})})
  return <section className="local-chat" aria-label="Colaboración local">
    <div className="local-chat-heading"><div><h2>Colaboración</h2><p>Conversaciones de los agentes de esta computadora, organizadas por espacio de trabajo y tarea.</p></div><span className="local-chat-observer">Chat de sólo lectura</span></div>
    <details className="local-chat-help"><summary>Cómo conectar una terminal</summary><p>Los lanzadores abren la TUI original de cada cliente y conservan sus opciones. Abrí Claude Code con <code>agenthub-claude</code>, OpenCode con <code>agenthub-opencode</code>, Codex con <code>agenthub-codex</code>, Gemini con <code>agenthub-gemini</code>, Kiro con <code>agenthub-kiro</code> o Antigravity CLI con <code>agenthub-agy</code> desde el espacio de la tarea. El Hub instala esos lanzadores al sincronizar el cliente.</p><p>Los conectores funcionan desde cualquier terminal, dentro o fuera de Orca. El primer agente al que le hablás coordina el equipo; el Hub incorpora a las demás conexiones y les pide que elijan su nick. El líder transmite tus tareas y permisos. Una sesión que indica «Al próximo turno» necesita su conector para recibir avisos en reposo.</p></details>
    <div className={`local-chat-layout ${agentsOpen?'agents-open':''}`}>
      <aside className="local-chat-channels" aria-label={unassigned?"Canales sin proyecto":"Canales del proyecto"}><h3>Canales <span>{channels.data?.total ?? 0}</span></h3>
        <button className={!visibleChannelId?'selected':''} onClick={()=>change({channel:null,thread:null,chat_offset:0,agent_offset:0})}>Todos los canales</button>
        <ErrorBox error={channels.error} retry={channels.refetch}/>
        {channels.isPending && <p role="status">Cargando canales…</p>}
        {channels.data?.items.map(c=><button key={c.id} className={visibleChannelId===c.id?'selected':''} title={c.path} onClick={()=>change({channel:c.id,thread:null,chat_offset:0,agent_offset:0,chat_author:null})}>
          <span className="local-chat-channel-name"># {c.name}<small>{c.threads}</small></span><small>{c.closed_at ? 'Cerrado · sólo lectura' : c.read_only ? 'Histórico · sólo lectura' : c.kind==='virtual' ? 'Canal virtual' : c.orca_workspace_id ? 'Espacio de Orca' : c.branch ?? 'HEAD separado'}</small><small className="local-chat-path">{c.path}</small>
        </button>)}
        {channels.data && channels.data.total>40 && <Pager {...channels.data} setOffset={v=>change({channel_offset:v})}/>}
        <p className="local-chat-help">Cada espacio de Orca o worktree Git tiene su canal. Para trabajar en una carpeta común, pedile al agente que será líder que cree un canal virtual; las otras conexiones de esa carpeta se incorporan. Separar canales no separa los archivos.</p>
      </aside>
      <div className="local-chat-work">
        {channel?.read_only && <p className="local-chat-help" role="status">{channel.closed_at ? 'Canal cerrado: el historial se conserva sólo para lectura.' : 'Espacio no disponible: este canal conserva su historial sólo para lectura.'}</p>}
        <div className="local-chat-scope"><div className="local-chat-scope-info"><strong>{channel ? `# ${channel.name}` : 'Todos los canales'}</strong>{channel && <span title={channel.path}>{channel.branch ?? channel.path}</span>}</div>
          <button className="btn btn-sm local-chat-agent-toggle" aria-controls="local-chat-agents-panel" aria-expanded={agentsOpen} onClick={()=>setAgentsOpen(open=>!open)}>{agentsOpen?'Ocultar agentes':`Mostrar agentes (${agents.data?.total ?? 0})`}</button>
        </div>
        {!threadId && <div className="local-chat-filters"><input className="input" type="search" aria-label="Buscar hilos y mensajes" placeholder="Buscar en títulos y mensajes…" value={query} onChange={e=>change({chat_q:e.target.value,chat_offset:0})}/>
          <select className="input" aria-label="Estado del hilo" value={state} onChange={e=>change({chat_state:e.target.value,chat_offset:0})}><option value="">Todos los estados</option><option value="open">Abiertos</option><option value="resolved">Resueltos</option></select>
          {author && <button className="btn btn-sm" onClick={()=>change({chat_author:null,chat_offset:0})}>Quitar filtro de agente</button>}
        </div>}
        <div className="local-chat-conversations">
          {!threadId && <div className="local-chat-threads" aria-label="Hilos del canal"><div className="local-chat-list-heading"><h3>Hilos</h3><span>{threads.data?.total ?? 0} conversaciones</span></div><ErrorBox error={threads.error} retry={threads.refetch}/>
            {threads.isPending && <p role="status">Buscando conversaciones…</p>}
            {threads.data?.items.map(t=><div key={t.id} className="local-chat-thread">
              <div className="local-chat-thread-summary"><div className="local-chat-thread-meta"><span className={`local-chat-tag ${t.state}`}>{t.state==='resolved'?'Resuelto':'Abierto'}</span><small>{t.messages} mensajes</small></div><h4>{t.title}</h4><p>{t.preview}</p><small>#{t.channel_name} · {t.author_label} · {formatTime(t.updated_at)}</small></div>
              <button className="btn btn-sm" aria-label={`Abrir hilo: ${t.title}`} onClick={()=>change({thread:t.id,channel:t.channel_id,message_offset:0,...(channelId===t.channel_id?{}:{chat_offset:0})})}>Abrir hilo <span aria-hidden="true">→</span></button>
            </div>)}
            {threads.data?.total===0 && <div className="memory-empty"><h3>{query || author || state ? 'Sin coincidencias' : 'Todavía no hay hilos'}</h3><p>{query || author || state ? 'Probá con otro texto o quitá los filtros. La búsqueda incluye el historial.' : 'Los agentes crean un hilo al iniciar una tarea o pedir una revisión. Podrás seguir la conversación acá.'}</p></div>}
            {threads.data && threads.data.total>30 && <Pager {...threads.data} setOffset={v=>change({chat_offset:v})}/>}
          </div>}
          {threadId && <article className="local-chat-detail" aria-label="Conversación del hilo"><nav className="local-chat-back"><button className="btn btn-sm" onClick={()=>change({thread:null,channel:messages.data?.thread.channel_id ?? channelId,message_offset:null})}>← Volver al canal</button></nav><ErrorBox error={messages.error} retry={messages.refetch}/>
            {messages.isPending && <p role="status">Abriendo hilo…</p>}
            {messages.data && <><header><div><span className={`local-chat-tag ${messages.data.thread.state}`}>{messages.data.thread.state==='resolved'?'Resuelto':'Abierto'}</span><h3>{messages.data.thread.title}</h3>{messages.data.thread.task_id && <small>Tarea vinculada: {messages.data.thread.task_id}</small>}</div><span className="local-chat-count">{messages.data.total} mensajes</span></header>
              <ol className="local-chat-messages">{messages.data.items.map(m=><li key={m.id} id={`chat-${m.id}`}><div className="local-chat-message-heading"><strong>{m.author_label}</strong><time dateTime={m.created_at}>{formatTime(m.created_at)}</time></div>
                {m.reply_to && <small className="muted">Respuesta a {m.reply_to.slice(0,8)}</small>}<p className="local-chat-message-text">{m.text}</p>
                {!!m.mentions.length && <ul className="local-chat-receipts" aria-label="Estado de las menciones">{m.mentions.map(r=><li key={r.recipient_id}><span>@{r.label}</span><strong>{r.cancelled_at?'Cancelado':r.handled_at?'Atendido':r.read_at?'Leído':r.notified_at?'Notificado':'Pendiente'}</strong>{r.error && <small>{r.error}</small>}{!r.cancelled_at && !r.read_at && r.attempts>=5 && <small>Sin confirmación de lectura después de 5 intentos</small>}</li>)}</ul>}
              </li>)}</ol><Pager {...messages.data} setOffset={v=>change({message_offset:v})}/>
              <footer>Las personas pueden observar. Sólo los agentes escriben y confirman lectura.</footer></>}
          </article>}
        </div>
      </div>
      {agentsOpen && <aside id="local-chat-agents-panel" className="local-chat-agents-panel" aria-label="Agentes vigentes">
        <div className="local-chat-agents-heading"><h3>Agentes</h3><span>{agents.data?.total ?? 0} vigentes</span></div>
        <ErrorBox error={agents.error} retry={agents.refetch}/>
        {agents.isPending && <p className="local-chat-help" role="status">Cargando agentes…</p>}
        <div className="local-chat-agents-list">{visibleAgents.map(a=><div key={a.id} className={`local-chat-agent ${author===a.id?'selected':''}`}>
          <button className="local-chat-agent-profile" onClick={()=>selectAgent(a)} title={`Ver sus mensajes · Última conexión: ${formatTime(a.last_seen_at)}${a.state_observed_at ? ` · Último estado observado: ${formatTime(a.state_observed_at)}` : ''}`}>
            <strong><span className={`local-chat-presence ${a.state}`}/>{a.label}{a.role==='leader' && <span className="local-chat-tag">Líder</span>}</strong>
            <small>{CLI_LABELS[a.cli_kind as CliKind] ?? a.cli_kind} · {a.state_reason==='activity_stale'?'Actividad sin confirmar':states[a.state] ?? a.state} · {capabilities[a.capability] ?? a.capability}</small>
            {a.state_reason==='activity_stale' && <small>La conexión sigue activa; no confirma que esté trabajando.</small>}
          </button>
          <button className="btn btn-ghost btn-sm local-chat-remove" aria-label={`Expulsar a ${a.label}`} onClick={()=>{kick.reset();setReason('');setRemoving(a)}}>Expulsar del canal</button>
          {a.wake_error && <small className="local-chat-warning">{a.wake_error}</small>}
        </div>)}</div>
        {agents.data && !agents.isPending && visibleAgents.length===0 && <p className="local-chat-help">No hay agentes vigentes en esta página.</p>}
        {agents.data && agents.data.total>40 && <Pager {...agents.data} setOffset={v=>change({agent_offset:v})}/>}
        <p className="local-chat-help">Las sesiones expulsadas no aparecen aquí; sus autores y mensajes siguen en el historial.</p>
      </aside>}
    </div>
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
