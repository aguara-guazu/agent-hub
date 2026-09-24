import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { Field, ErrorBox, EmptyMemory, Pager, formatTime, useMemory, useMemoryMutation, type MemoryEntity } from '../lib/memory'

export const TASK_STATUS_LABELS: Record<string, string> = { todo: 'Por hacer', in_progress: 'En curso', blocked: 'Bloqueada', done: 'Terminada', dropped: 'Descartada' }
const ORIGIN_LABELS: Record<string, string> = { jira: 'Jira', manual: 'Manual', agent: 'Agente', meeting: 'Reunión', note: 'Nota', code: 'Código' }
const NOTE_STATES: Record<string, string> = { working: 'En curso', done: 'Terminó', blocked: 'Bloqueado' }
const FINISH_REASONS: Record<string, string> = { explicit: 'cerrada por el agente', turn_end: 'terminó el turno', session_end: 'terminó la sesión', inactive: 'sin actividad', superseded: 'reemplazada por una nota nueva' }
const statusClass = (status: string) => status === 'done' ? 'badge-on' : status === 'blocked' ? 'badge-off' : status === 'in_progress' ? 'badge-accent' : status === 'dropped' ? '' : 'badge-stale'

export function ProjectTasks({ project }: { project: MemoryEntity }) {
  const [params, setParams] = useSearchParams(), view = params.get('view') ?? 'list'
  const setView = (next: string) => setParams(current => { const values = new URLSearchParams(current); if (next === 'list') values.delete('view'); else values.set('view', next); return values }, { replace: true })
  return <section className="memory-section memory-tasks">
    <JiraSetup project={project} />
    <div className="memory-subtabs" role="tablist" aria-label="Tareas del proyecto">{[['list', 'Tareas'], ['stats', 'Estadísticas'], ['notes', 'Notas de agentes']].map(([key, label]) =>
      <button key={key} role="tab" aria-selected={view === key} className={view === key ? 'active' : ''} onClick={() => setView(key!)}>{label}</button>)}</div>
    {view === 'list' && <TaskList project={project} />}
    {view === 'stats' && <TaskStats project={project} />}
    {view === 'notes' && <AgentNotes projectId={project.id} />}
  </section>
}

function JiraSetup({ project }: { project: MemoryEntity }) {
  const toast = useToast(), [editing, setEditing] = useState(!project.data.jira_project_key)
  const [key, setKey] = useState(project.data.jira_project_key ?? ''), [site, setSite] = useState(project.data.jira_site_url ?? '')
  const save = useMemoryMutation('update_entity', () => { setEditing(false); toast.success('Clave de Jira guardada') })
  const sync = useMemoryMutation<any>('sync_tasks', result => toast.success('Tareas de Jira sincronizadas',
    `${result.received} issues · ${result.created} nuevas · ${result.status_changed} con cambio de estado${result.unmatched?.length ? ` · ${result.unmatched.length} sin proyecto` : ''}`))
  return <div className="card memory-panel memory-jira-setup">
    <div className="spread"><div><h2>Jira</h2><p className="muted">{project.data.jira_project_key ? `Proyecto ${project.data.jira_project_key}${project.data.jira_site_url ? ` · ${project.data.jira_site_url.replace('https://', '')}` : ''}` : 'Sin clave de Jira configurada'}</p></div>
      <div className="memory-button-wrap">{!editing && <button className="btn btn-sm" onClick={() => setEditing(true)}>Configurar</button>}
        <button className="btn btn-primary btn-sm" disabled={!project.data.jira_project_key || sync.isPending} onClick={() => sync.mutate({ project_id: project.id })}>{sync.isPending ? 'Sincronizando…' : 'Sincronizar con Jira'}</button></div></div>
    {editing && <form className="memory-form" onSubmit={e => { e.preventDefault(); save.mutate({ id: project.id, expected_updated_at: project.updated_at, data: { jira_project_key: key.trim().toUpperCase() || null, jira_site_url: site.trim() || null } }) }}>
      <div className="memory-form-grid"><Field label="Clave del proyecto en Jira"><input value={key} onChange={e => setKey(e.target.value.toUpperCase())} placeholder="POC" pattern="[A-Za-z][A-Za-z0-9_]{0,19}" /><span className="field-hint">El prefijo de los issues: POC en POC-123.</span></Field>
        <Field label="Sitio de Jira (opcional)"><input type="url" value={site} onChange={e => setSite(e.target.value)} placeholder="https://empresa.atlassian.net" /><span className="field-hint">Arma los enlaces y elige el conector si hay varios sitios.</span></Field></div>
      <ErrorBox error={save.error} /><div className="memory-button-wrap"><button className="btn btn-primary btn-sm" disabled={save.isPending}>Guardar</button>{project.data.jira_project_key && <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>Cancelar</button>}</div>
    </form>}
    <p className="field-hint">{project.data.jira_synced_at ? `Última sincronización desde el hub: ${formatTime(project.data.jira_synced_at)}. ` : ''}El hub intenta actualizar estas tareas cuando un agente consulta o modifica Jira a través del hub, y le avisa si no puede confirmar la actualización. Sincroniza con tu cuenta de Atlassian conectada en MCP servers o con un conector Jira de Fuentes y ajustes.</p>
    <ErrorBox error={sync.error} />
  </div>
}

function TaskList({ project }: { project: MemoryEntity }) {
  const [kind, setKind] = useState(''), [status, setStatus] = useState('open'), [query, setQuery] = useState(''), [offset, setOffset] = useState(0)
  const [creating, setCreating] = useState(false), [selected, setSelected] = useState<string | null>(null)
  const tasks = useMemory<any>('list_tasks', { project_id: project.id, ...(kind ? { kind } : {}), ...(status ? { status } : {}), ...(query ? { query } : {}), limit: 50, offset })
  const counts: { kind: string; status: string; count: number }[] = tasks.data?.counts ?? []
  const open = (k?: string) => counts.filter(c => (!k || c.kind === k) && ['todo', 'in_progress', 'blocked'].includes(c.status)).reduce((sum, c) => sum + c.count, 0)
  return <>
    <div className="memory-stats">{[['Abiertas', open()], ['De Jira', open('jira')], ['Pendientes internos', open('pending')], ['Bloqueadas', counts.filter(c => c.status === 'blocked').reduce((sum, c) => sum + c.count, 0)]].map(([label, value]) => <div key={label} className="card"><strong>{value}</strong><span>{label}</span></div>)}</div>
    <div className="memory-toolbar"><input className="input" aria-label="Buscar tareas" placeholder="Buscar por título o clave…" value={query} onChange={e => { setQuery(e.target.value); setOffset(0) }} />
      <select className="input" aria-label="Tipo de tarea" value={kind} onChange={e => { setKind(e.target.value); setOffset(0) }}><option value="">Todos los tipos</option><option value="jira">Jira</option><option value="pending">Pendientes internos</option></select>
      <select className="input" aria-label="Estado" value={status} onChange={e => { setStatus(e.target.value); setOffset(0) }}><option value="open">Abiertas</option><option value="">Todos los estados</option>{Object.entries(TASK_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <button className="btn btn-primary" onClick={() => setCreating(true)}>Nuevo pendiente</button></div>
    <ErrorBox error={tasks.error} retry={tasks.refetch} />
    <div className="card memory-task-list">{tasks.isPending ? <p className="memory-loading" role="status">Cargando tareas…</p> : tasks.data?.items.length ? tasks.data.items.map((task: any) =>
      <button key={task.id} className="memory-task-row" onClick={() => setSelected(task.id)}>
        <span className={`memory-kind ${task.kind === 'jira' ? 'kind-meeting' : 'kind-fact'}`}>{task.kind === 'jira' ? task.external_key : ORIGIN_LABELS[task.origin] ?? 'Pendiente'}</span>
        <div><strong>{task.title}</strong><p>{task.kind === 'jira' ? `${task.external_status}${task.assignee ? ` · ${task.assignee}` : ''}${task.issue_type ? ` · ${task.issue_type}` : ''}` : task.code_ref ?? task.source_title ?? task.description?.slice(0, 140) ?? ''}{task.last_event?.detail?.note ? ` · Última nota: ${task.last_event.detail.note.slice(0, 100)}` : ''}</p></div>
        <span className={`badge ${statusClass(task.status)}`}>{TASK_STATUS_LABELS[task.status]}</span><span className="memory-row-date">{formatTime(task.updated_at)}</span>
      </button>) : <EmptyMemory>{status === 'open' ? 'No hay tareas abiertas en este filtro.' : 'No hay tareas en este filtro.'} Sincroniza Jira o agrega un pendiente interno: deuda técnica, algo que falta en el código o un compromiso de una reunión.</EmptyMemory>}</div>
    {tasks.data && <Pager total={tasks.data.total} offset={offset} limit={50} setOffset={setOffset} />}
    {creating && <PendingForm projectId={project.id} onClose={() => setCreating(false)} />}
    {selected && <TaskDetail taskId={selected} onClose={() => setSelected(null)} />}
  </>
}

function PendingForm({ projectId, task, onClose }: { projectId: string; task?: any; onClose: () => void }) {
  const [title, setTitle] = useState(task?.title ?? ''), [description, setDescription] = useState(task?.description ?? ''), [origin, setOrigin] = useState(task?.origin ?? 'manual')
  const [codeRef, setCodeRef] = useState(task?.code_ref ?? ''), [status, setStatus] = useState(task?.status ?? 'todo')
  const save = useMemoryMutation('save_task', onClose)
  return <Modal open title={task ? 'Editar pendiente' : 'Nuevo pendiente interno'} onClose={onClose} busy={save.isPending} width={680}><form className="memory-form" onSubmit={e => { e.preventDefault()
    save.mutate({ ...(task ? { id: task.id } : { project_id: projectId }), title, description, origin, status, code_ref: codeRef.trim() || null }) }}>
    <p className="muted">Para lo que no va a Jira: deuda técnica, algo que falta implementar, un compromiso mencionado en una reunión o una nota.</p>
    <Field label="Título"><input required maxLength={500} value={title} onChange={e => setTitle(e.target.value)} /></Field>
    <Field label="Detalle"><textarea rows={4} value={description} onChange={e => setDescription(e.target.value)} /></Field>
    <div className="memory-form-grid"><Field label="Origen"><select value={origin} onChange={e => setOrigin(e.target.value)}>{['manual', 'meeting', 'note', 'code', 'agent'].map(o => <option key={o} value={o}>{ORIGIN_LABELS[o]}</option>)}</select></Field>
      <Field label="Estado"><select value={status} onChange={e => setStatus(e.target.value)}>{Object.entries(TASK_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field></div>
    <Field label="Referencia en el código (opcional)"><input value={codeRef} onChange={e => setCodeRef(e.target.value)} placeholder="packages/api/src/auth.ts:120" /></Field>
    <ErrorBox error={save.error} /><div className="memory-form-actions"><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn btn-primary" disabled={save.isPending || !title.trim()}>Guardar</button></div>
  </form></Modal>
}

function TaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const detail = useMemory<any>('get_task', { id: taskId }), toast = useToast()
  const [note, setNote] = useState(''), [transition, setTransition] = useState(''), [comment, setComment] = useState(''), [editing, setEditing] = useState(false)
  const save = useMemoryMutation('save_task', () => { setNote(''); setTransition(''); setComment('') })
  const pushJira = useMemoryMutation('save_task', () => { setTransition(''); setComment(''); toast.success('Cambio enviado a Jira') })
  const task = detail.data?.task
  return <Modal open title={task ? task.kind === 'jira' ? `${task.external_key} · ${task.title}` : task.title : 'Tarea'} onClose={onClose} width={760}>
    <ErrorBox error={detail.error} />{!task ? <p role="status">Cargando…</p> : <div className="memory-form">
      <div className="memory-meta"><span className={`badge ${statusClass(task.status)}`}>{TASK_STATUS_LABELS[task.status]}</span>{task.kind === 'jira' ? <><span>Jira: {task.external_status}</span>{task.assignee && <span>{task.assignee}</span>}{task.priority && <span>Prioridad {task.priority}</span>}{task.external_url && <a href={task.external_url} target="_blank" rel="noreferrer">Abrir en Jira ↗</a>}</>
        : <><span>Origen: {ORIGIN_LABELS[task.origin] ?? task.origin}</span>{task.code_ref && <code>{task.code_ref}</code>}</>}<span>Creada {formatTime(task.created_at)} por {task.created_by}</span></div>
      {task.description && <p className="memory-task-description">{task.description}</p>}
      {task.kind === 'pending' && <div className="memory-button-wrap">{Object.entries(TASK_STATUS_LABELS).filter(([value]) => value !== task.status).map(([value, label]) =>
        <button key={value} className="btn btn-sm" disabled={save.isPending} onClick={() => save.mutate({ id: task.id, status: value })}>Marcar {label.toLowerCase()}</button>)}<button className="btn btn-sm" onClick={() => setEditing(true)}>Editar</button></div>}
      <form className="memory-inline-form" onSubmit={e => { e.preventDefault(); save.mutate({ id: task.id, note }) }}><Field label="Agregar nota de avance"><textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="Qué se avanzó, qué falta, qué lo bloquea…" /></Field><button className="btn btn-sm" disabled={!note.trim() || save.isPending}>Guardar nota</button></form>
      {task.kind === 'jira' && <details className="memory-details"><summary>Actualizar en Jira desde el hub</summary><form className="memory-form" onSubmit={e => { e.preventDefault(); pushJira.mutate({ id: task.id, jira: { ...(transition.trim() ? { transition: transition.trim() } : {}), ...(comment.trim() ? { comment: comment.trim() } : {}) } }) }}>
        <p>Requiere un conector de Jira con token. Sin conector, los agentes lo hacen con el MCP de Jira y esta tarea se actualiza sola.</p>
        <div className="memory-form-grid"><Field label="Nuevo estado"><input value={transition} onChange={e => setTransition(e.target.value)} placeholder="En curso" /></Field><Field label="Comentario"><input value={comment} onChange={e => setComment(e.target.value)} /></Field></div>
        <ErrorBox error={pushJira.error} /><button className="btn btn-sm" disabled={pushJira.isPending || (!transition.trim() && !comment.trim())}>Enviar a Jira</button></form></details>}
      <ErrorBox error={save.error} />
      <section className="memory-section"><h3>Historial</h3><ol className="memory-timeline">{detail.data.events.map((event: any) => <li key={event.id}><span className="muted">{formatTime(event.created_at)} · {event.actor}</span>
        <span>{event.action === 'created' ? `Creada en ${TASK_STATUS_LABELS[event.status_after] ?? event.status_after}` : event.action === 'status' ? `${TASK_STATUS_LABELS[event.status_before] ?? event.status_before} → ${TASK_STATUS_LABELS[event.status_after] ?? event.status_after}${event.detail?.jira_status ? ` (Jira: ${event.detail.jira_status})` : ''}` : event.action === 'note' ? 'Nota' : event.action === 'jira_comment' ? 'Comentario enviado a Jira' : 'Actualizada'}</span>
        {(event.detail?.note || event.detail?.text) && <p>{event.detail.note ?? event.detail.text}</p>}</li>)}</ol></section>
      {detail.data.notes.length > 0 && <section className="memory-section"><h3>Notas de agentes</h3>{detail.data.notes.map((n: any) => <NoteRow key={n.id} note={n} />)}</section>}
      {detail.data.evidence.length > 0 && <section className="memory-section"><h3>Evidencia</h3>{detail.data.evidence.map((f: any) => <Link key={f.id} className="memory-cell-link" to={`/memory/entities/${f.entity_id}?version=${f.version_id}&fragment=${f.id}`}>{f.title}: {f.text.slice(0, 160)} ↗</Link>)}</section>}
    </div>}
    {editing && task && <PendingForm projectId={task.project_id} task={task} onClose={() => setEditing(false)} />}
  </Modal>
}

function NoteRow({ note, onClose }: { note: any; onClose?: (note: any) => void }) {
  return <article className={`memory-note ${note.state === 'working' ? 'working' : ''}`}>
    <div className="spread"><strong>{note.agent_label}</strong><span className={`badge ${note.state === 'working' ? 'badge-accent' : note.state === 'blocked' ? 'badge-off' : 'badge-on'}`}>{NOTE_STATES[note.state]}</span></div>
    <p>{note.text}</p>
    <div className="memory-meta"><span>{formatTime(note.updated_at)}</span>{note.state !== 'working' && note.finish_reason && <span>{FINISH_REASONS[note.finish_reason] ?? note.finish_reason}</span>}{note.task_title && <span>Tarea: {note.task_key ?? note.task_title}</span>}
      {onClose && note.state === 'working' && <button className="btn btn-ghost btn-sm" onClick={() => onClose(note)}>Marcar terminada</button>}</div>
  </article>
}

export function AgentNotes({ projectId }: { projectId: string }) {
  const [offset, setOffset] = useState(0), [text, setText] = useState('')
  const notes = useMemory<any>('list_notes', { project_id: projectId, limit: 40, offset })
  const write = useMemoryMutation('write_note', () => setText(''))
  return <>
    <p className="memory-section-note">Los agentes dejan aquí qué están haciendo y qué terminaron, para no pisarse entre sesiones. Los clientes con integración de eventos cierran la nota al terminar el turno. También se cierra al terminar la sesión o tras {notes.data?.inactivity_minutes ?? 20} minutos sin actividad.</p>
    <form className="memory-inline-form card memory-panel" onSubmit={e => { e.preventDefault(); write.mutate({ project_id: projectId, text, state: 'done' }) }}><Field label="Dejar una nota para los agentes"><textarea rows={2} maxLength={600} value={text} onChange={e => setText(e.target.value)} placeholder="Contexto que deben tener en cuenta, prioridades, qué no tocar…" /></Field><button className="btn btn-sm" disabled={!text.trim() || write.isPending}>Guardar nota</button></form>
    <ErrorBox error={notes.error ?? write.error} />
    <div className="memory-notes">{notes.data?.items.map((note: any) => <NoteRow key={note.id} note={note} onClose={n => write.mutate({ id: n.id, text: n.text, state: 'done' })} />)}{notes.data?.items.length === 0 && <EmptyMemory>Todavía no hay notas de agentes en este proyecto.</EmptyMemory>}</div>
    {notes.data && <Pager total={notes.data.total} offset={offset} limit={40} setOffset={setOffset} />}
  </>
}

const weekLabel = (value: string) => new Date(value).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' })

function WeeklyChart({ weeks }: { weeks: { week: string; created: number; closed: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...weeks.flatMap(w => [w.created, w.closed])), height = 160, bar = 10, gap = 2, group = bar * 2 + gap, step = group + 18
  const width = weeks.length * step, scale = (value: number) => value / max * height
  const last = weeks.at(-1)
  return <figure className="memory-chart">
    <figcaption><strong>Creadas y cerradas por semana</strong><span className="memory-chart-legend"><span><i className="swatch series-1" />Creadas</span><span><i className="swatch series-2" />Cerradas</span></span></figcaption>
    <div className="memory-chart-scroll"><svg role="img" aria-label="Tareas creadas y cerradas por semana" viewBox={`0 -14 ${width} ${height + 34}`} width={width} height={height + 34} onMouseLeave={() => setHover(null)}>
      <line x1={0} x2={width} y1={height} y2={height} className="axis" />
      {weeks.map((w, index) => { const x = index * step + 9
        return <g key={w.week} onMouseEnter={() => setHover(index)}>
          <rect x={x - 9} y={-14} width={step} height={height + 34} className="hit" />
          <path className="series-1" d={roundedBar(x, height, bar, scale(w.created))} /><path className="series-2" d={roundedBar(x + bar + gap, height, bar, scale(w.closed))} />
          {index % 2 === weeks.length % 2 && <text x={x + group / 2} y={height + 16} textAnchor="middle" className="tick">{weekLabel(w.week)}</text>}
        </g> })}
      {last && <text x={(weeks.length - 1) * step + 9 + group / 2} y={height - Math.max(scale(last.created), scale(last.closed)) - 4} textAnchor="middle" className="value">{last.created}/{last.closed}</text>}
    </svg>{hover !== null && weeks[hover] && <div className="memory-chart-tooltip" style={{ left: hover * step + group / 2 + 9 }}><strong>Semana del {weekLabel(weeks[hover]!.week)}</strong><span><i className="swatch series-1" />Creadas {weeks[hover]!.created}</span><span><i className="swatch series-2" />Cerradas {weeks[hover]!.closed}</span></div>}</div>
    <details className="memory-details"><summary>Ver como tabla</summary><table className="memory-table"><thead><tr><th>Semana</th><th>Creadas</th><th>Cerradas</th></tr></thead><tbody>{weeks.map(w => <tr key={w.week}><td>{weekLabel(w.week)}</td><td>{w.created}</td><td>{w.closed}</td></tr>)}</tbody></table></details>
  </figure>
}
/** Bar anchored to the baseline with only its data end rounded. */
function roundedBar(x: number, baseline: number, width: number, value: number) {
  if (value <= 0) return `M${x},${baseline}h${width}v-1h-${width}z`
  const r = Math.min(4, width / 2, value), top = baseline - value
  return `M${x},${baseline}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${baseline}Z`
}

function TaskStats({ project }: { project: MemoryEntity }) {
  const stats = useMemory<any>('task_stats', { project_id: project.id, weeks: 12 })
  const s = stats.data
  if (stats.error) return <ErrorBox error={stats.error} retry={stats.refetch} />
  if (!s) return <p role="status">Calculando estadísticas…</p>
  const tiles: [string, number][] = [['Abiertas', s.summary.open], ['En curso', s.summary.in_progress], ['Bloqueadas', s.summary.blocked], ['Sin movimiento hace 3 semanas', s.summary.stale_open],
    ['Creadas en 2 semanas', s.summary.created_last_2_weeks], ['Cerradas en 2 semanas', s.summary.closed_last_2_weeks], ['Terminadas', s.summary.done], ['Descartadas', s.summary.dropped]]
  return <>
    <div className="spread"><p className="memory-section-note">Calculado a partir del historial de cada tarea. Actualizado {formatTime(s.generated_at)}.</p><button className="btn" onClick={() => downloadStats(project, s)}>Exportar HTML</button></div>
    <div className="memory-stats memory-stats-8">{tiles.map(([label, value]) => <div key={label} className="card"><strong>{value}</strong><span>{label}</span></div>)}</div>
    <div className="card memory-panel"><WeeklyChart weeks={s.weekly} /></div>
    <div className="memory-stats-grid">
      <StatsTable title="Por estado" head={['Tipo', 'Estado', 'Cantidad']} rows={s.by_status.map((r: any) => [r.kind === 'jira' ? 'Jira' : 'Pendiente', TASK_STATUS_LABELS[r.status] ?? r.status, r.count])} />
      <StatsTable title="Tiempo hasta terminar" head={['Tipo', 'Promedio (días)', 'Terminadas']} rows={s.lead_time.map((r: any) => [r.kind === 'jira' ? 'Jira' : 'Pendiente', r.avg_days, r.closed])} />
      <StatsTable title="Jira por responsable" head={['Responsable', 'Abiertas', 'Terminadas']} rows={s.assignees.map((r: any) => [r.assignee, r.open, r.done])} />
      <StatsTable title="Pendientes por origen" head={['Origen', 'Abiertos', 'Terminados']} rows={s.origins.map((r: any) => [ORIGIN_LABELS[r.origin] ?? r.origin, r.open, r.done])} />
      <StatsTable title="Actividad de agentes (30 días)" head={['Agente', 'Notas', 'Última']} rows={s.agents.map((r: any) => [r.agent_label, r.notes, formatTime(r.last_note)])} />
      <StatsTable title="Sin movimiento hace más de 3 semanas" head={['Tarea', 'Estado', 'Última actualización']} rows={s.stale.map((r: any) => [r.external_key ? `${r.external_key} · ${r.title}` : r.title, TASK_STATUS_LABELS[r.status], formatTime(r.updated_at)])} />
    </div>
  </>
}
function StatsTable({ title, head, rows }: { title: string; head: string[]; rows: (string | number)[][] }) {
  return <div className="card memory-panel"><h3>{title}</h3>{rows.length ? <div className="memory-table-wrap"><table className="memory-table"><thead><tr>{head.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody></table></div> : <p className="muted">Sin datos todavía.</p>}</div>
}

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
/** Standalone report: no scripts or external assets, so it opens anywhere and can be attached as is. */
export function statsHtml(project: MemoryEntity, s: any): string {
  const rowsTable = (head: string[], rows: unknown[][]) => rows.length ? `<table><thead><tr>${head.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${escape(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p class="muted">Sin datos todavía.</p>'
  const table = (title: string, head: string[], rows: unknown[][]) => `<section><h2>${escape(title)}</h2>${rowsTable(head, rows)}</section>`
  const max = Math.max(1, ...s.weekly.flatMap((w: any) => [w.created, w.closed])), h = 140, step = 40
  const bars = s.weekly.map((w: any, i: number) => `<g><title>Semana del ${escape(weekLabel(w.week))}: ${w.created} creadas, ${w.closed} cerradas</title><path class="s1" d="${roundedBar(i * step + 8, h, 10, w.created / max * h)}"/><path class="s2" d="${roundedBar(i * step + 20, h, 10, w.closed / max * h)}"/>${i % 2 === s.weekly.length % 2 ? `<text x="${i * step + 19}" y="${h + 16}" text-anchor="middle">${escape(weekLabel(w.week))}</text>` : ''}</g>`).join('')
  const tiles = [['Abiertas', s.summary.open], ['En curso', s.summary.in_progress], ['Bloqueadas', s.summary.blocked], ['Sin movimiento hace 3 semanas', s.summary.stale_open], ['Creadas en 2 semanas', s.summary.created_last_2_weeks], ['Cerradas en 2 semanas', s.summary.closed_last_2_weeks], ['Terminadas', s.summary.done], ['Descartadas', s.summary.dropped]]
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(project.title)} · Estado de tareas</title><style>
:root{color-scheme:light;--bg:#f8f9fb;--surface:#fff;--border:#dfe3ea;--text:#101828;--muted:#667085;--s1:#2a78d6;--s2:#eb6834}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#090c11;--surface:#11161f;--border:#262f3d;--text:#f2f5f9;--muted:#8b95a7;--s1:#3987e5;--s2:#d95926}}
body{margin:0;padding:32px 16px;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1080px;margin:0 auto;display:grid;gap:20px}
h1{margin:0;font-size:26px}h2{font-size:15px;margin:0 0 10px}.muted{color:var(--muted)}.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.tile,section{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px}.tile strong{display:block;font-size:26px}.tile span{color:var(--muted);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-top:1px solid var(--border);font-size:12px}th{color:var(--muted);font-weight:500}
.chart{overflow-x:auto}svg text{fill:var(--muted);font-size:10px}.s1{fill:var(--s1)}.s2{fill:var(--s2)}.axis{stroke:var(--border)}.legend{display:flex;gap:14px;font-size:12px;color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
</style></head><body><main><header><h1>${escape(project.title)}</h1><p class="muted">Estado de tareas generado el ${escape(formatTime(s.generated_at))}${project.data.jira_project_key ? ` · Jira ${escape(project.data.jira_project_key)}` : ''}</p></header>
<div class="tiles">${tiles.map(([label, value]) => `<div class="tile"><strong>${escape(value)}</strong><span>${escape(label)}</span></div>`).join('')}</div>
<section><h2>Creadas y cerradas por semana</h2><div class="legend"><span><i style="background:var(--s1)"></i>Creadas</span><span><i style="background:var(--s2)"></i>Cerradas</span></div><div class="chart"><svg role="img" aria-label="Tareas creadas y cerradas por semana" width="${s.weekly.length * step}" height="${h + 24}"><line class="axis" x1="0" x2="${s.weekly.length * step}" y1="${h}" y2="${h}"/>${bars}</svg></div>
${rowsTable(['Semana', 'Creadas', 'Cerradas'], s.weekly.map((w: any) => [weekLabel(w.week), w.created, w.closed]))}</section>
<div class="grid">${table('Por estado', ['Tipo', 'Estado', 'Cantidad'], s.by_status.map((r: any) => [r.kind === 'jira' ? 'Jira' : 'Pendiente', TASK_STATUS_LABELS[r.status] ?? r.status, r.count]))}
${table('Tiempo hasta terminar', ['Tipo', 'Promedio (días)', 'Terminadas'], s.lead_time.map((r: any) => [r.kind === 'jira' ? 'Jira' : 'Pendiente', r.avg_days, r.closed]))}
${table('Jira por responsable', ['Responsable', 'Abiertas', 'Terminadas'], s.assignees.map((r: any) => [r.assignee, r.open, r.done]))}
${table('Pendientes por origen', ['Origen', 'Abiertos', 'Terminados'], s.origins.map((r: any) => [ORIGIN_LABELS[r.origin] ?? r.origin, r.open, r.done]))}
${table('Sin movimiento hace más de 3 semanas', ['Tarea', 'Estado', 'Última actualización'], s.stale.map((r: any) => [r.external_key ? `${r.external_key} · ${r.title}` : r.title, TASK_STATUS_LABELS[r.status], formatTime(r.updated_at)]))}
${table('Actividad reciente', ['Fecha', 'Tarea', 'Cambio', 'Por'], s.recent.map((r: any) => [formatTime(r.created_at), r.external_key ?? r.title, r.action === 'status' ? `${TASK_STATUS_LABELS[r.status_before] ?? r.status_before} → ${TASK_STATUS_LABELS[r.status_after] ?? r.status_after}` : r.action, r.actor]))}</div>
</main></body></html>`
}
function downloadStats(project: MemoryEntity, stats: any) {
  const url = URL.createObjectURL(new Blob([statsHtml(project, stats)], { type: 'text/html;charset=utf-8' })), link = document.createElement('a')
  link.href = url; link.download = `${project.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'proyecto'}-tareas-${new Date().toISOString().slice(0, 10)}.html`
  link.click(); URL.revokeObjectURL(url)
}
