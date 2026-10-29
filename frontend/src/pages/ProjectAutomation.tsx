import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ConfirmDialog } from '../components/Modal'
import { DataTable } from '../components/DataTable'
import { formatDateTime } from '../components/DataTable'
import { useRuns, useDeliveryChannels, useSchedules, useScheduleActions, CHANNEL_REASONS } from '../lib/automations'
import { GmailAuthorize } from '../components/GmailAuthorize'
import { cleanDocument, DEFAULT_LIMITS, ITEM_KIND_LABELS, useAddRepository, useProjectAutomation, useSaveProjectAutomation } from '../lib/project-automation'
import type { DelegatedItemKind, DelegationDocument, ProjectAutomationView, RosterEntry } from '../lib/project-automation'
import { CLI_LABELS } from '../lib/types'
import { ErrorBox } from '../lib/memory'
import type { MemoryEntity } from '../lib/memory'
import { describeNextRun } from './Automations'

const FLEET_CLIS = ['claude_code', 'codex_cli', 'gemini_cli', 'kiro', 'opencode', 'antigravity'] as const
const OWNER_TEMPLATES = ['daily_brief', 'daily_close', 'project_status'] as const
const TEMPLATE_NAMES: Record<string, string> = { daily_brief: 'Brief', daily_close: 'Cierre', project_status: 'Estado del proyecto' }

function RosterPicker({ label, value, onChange }: { label: string; value: RosterEntry; onChange: (value: RosterEntry) => void }) {
  return <fieldset className="project-automation-roster"><legend>{label}</legend>
    <label>CLI<select value={value.cli} onChange={event => onChange({ ...value, cli: event.target.value })}>{FLEET_CLIS.map(cli => <option key={cli} value={cli}>{CLI_LABELS[cli as keyof typeof CLI_LABELS] ?? cli}</option>)}</select></label>
    <label>Modelo<input value={value.model} placeholder="modelo del catálogo" onChange={event => onChange({ ...value, model: event.target.value })} /></label>
  </fieldset>
}

function RepositoryAdder({ projectId }: { projectId: string }) {
  const save = useAddRepository(projectId)
  const [path, setPath] = useState('')
  const [branches, setBranches] = useState('feat/*, fix/*')
  return <div className="project-automation-repo-add">
    <label>Ruta del repositorio<input value={path} placeholder="/ruta/al/repositorio" onChange={event => setPath(event.target.value)} /></label>
    <label>Ramas permitidas<input value={branches} onChange={event => setBranches(event.target.value)} /></label>
    <button type="button" className="btn btn-sm" disabled={!path.trim() || save.isPending} onClick={() => save.mutate({ repo_path: path.trim(), allowed_branches: branches.split(',').map(item => item.trim()).filter(Boolean) }, { onSuccess: () => setPath('') })}>Agregar repositorio</button>
  </div>
}

/** Formulario de activación: una sola pantalla con valores por defecto; la persona sólo confirma. */
function ActivationForm({ project, view, onDone }: { project: MemoryEntity; view: ProjectAutomationView; onDone: () => void }) {
  const save = useSaveProjectAutomation(project.id)
  const channels = useDeliveryChannels()
  const current = view.delegation?.document
  const fallback: RosterEntry = view.defaults?.coordinator ?? { cli: 'claude_code', model: '' }
  const [coordinator, setCoordinator] = useState<RosterEntry>(current?.roster.coordinator ?? fallback)
  const [agent, setAgent] = useState<RosterEntry>(current?.roster.project_agent ?? view.defaults?.project_agent ?? fallback)
  const hasJira = Boolean(project.data?.jira_project_key)
  const [kinds, setKinds] = useState<DelegatedItemKind[]>(current?.item_kinds ?? (hasJira ? ['jira_worklog'] : []))
  const [repositories, setRepositories] = useState<string[]>(current?.repository_ids ?? [])
  const [channelId, setChannelId] = useState(view.channel?.id ?? view.channel_candidates[0]?.id ?? '')
  const toggleKind = (...group: DelegatedItemKind[]): void => setKinds(items => group.every(kind => items.includes(kind)) ? items.filter(kind => !group.includes(kind)) : [...new Set([...items, ...group])])
  const pushOn = kinds.includes('git_push')
  const needsRoster = Boolean(channelId)
  const valid = !needsRoster || (coordinator.model.trim() !== '' && agent.model.trim() !== '')
  const submit = (): void => {
    const document: DelegationDocument = cleanDocument({
      schema_version: 1,
      roster: { coordinator: { ...coordinator, model: coordinator.model.trim() }, project_agent: { ...agent, model: agent.model.trim() } },
      item_kinds: kinds, repository_ids: pushOn ? repositories : [], limits: current?.limits ?? { ...DEFAULT_LIMITS },
    })
    save.mutate({ enabled: true, expected_version: view.delegation?.version ?? null, channel_id: channelId || null, document }, { onSuccess: onDone })
  }
  return <form className="project-automation-form" onSubmit={event => { event.preventDefault(); submit() }}>
    <section><h3>Horarios</h3><p>Brief a las 08:00 y cierre a las 17:30, de lunes a viernes, en la zona horaria del sistema. Los cambias después en <Link to="/schedules">Automatizaciones</Link>.</p></section>
    <section><h3>Entrega</h3><p>La app siempre recibe la entrega. Los otros canales se cambian en cada automatización, desde <Link to="/schedules">Programaciones</Link> (acción «Canales»).</p>
      <ul>{(channels.data?.items ?? []).map(channel => <li key={channel.channel}>{channel.channel === 'app' ? 'App de Agent Hub' : `Gmail${channel.destination ? ` a ${channel.destination}` : ''}`}: {channel.available ? 'disponible' : CHANNEL_REASONS[channel.reason ?? ''] ?? 'no disponible'}{channel.channel === 'gmail' && channel.reason === 'scope_missing' && <> <GmailAuthorize destination={channel.destination} /></>}</li>)}</ul></section>
    <section><h3>Acciones que el cierre puede proponer</h3><p>Todas requieren tu aprobación por ítem.</p>
      <label><input type="checkbox" disabled={!hasJira} checked={kinds.includes('jira_worklog')} onChange={() => toggleKind('jira_worklog')} /> Horas en Jira</label>
      <label><input type="checkbox" disabled={!hasJira} checked={kinds.includes('jira_transition') && kinds.includes('jira_comment')} onChange={() => toggleKind('jira_transition', 'jira_comment')} /> Transiciones y comentarios en Jira</label>
      {!hasJira && <p className="automations-muted">Falta la clave de proyecto de Jira (jira_project_key) en este proyecto.</p>}
      <label><input type="checkbox" checked={pushOn} onChange={() => toggleKind('git_push')} /> Pushes</label>
      {pushOn && <div className="project-automation-repos">
        {view.repositories.length === 0 && <p className="automations-muted">Este proyecto todavía no tiene repositorios conocidos.</p>}
        {view.repositories.map(repo => <label key={repo.id}><input type="checkbox" checked={repositories.includes(repo.id)} onChange={() => setRepositories(items => items.includes(repo.id) ? items.filter(id => id !== repo.id) : [...items, repo.id])} /> {repo.repo_path} <small className="automations-muted">ramas: {repo.allowed_branches.join(', ')} · la principal ({repo.default_branch}) queda excluida</small></label>)}
        <RepositoryAdder projectId={project.id} /></div>}</section>
    <section><h3>Coordinador y agentes</h3>
      <label>Canal de trabajo{view.channel_candidates.length > 0 ? <select value={channelId} onChange={event => setChannelId(event.target.value)}>{view.channel_candidates.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}<option value="">Sin canal</option></select> : <span> ninguno autorizado</span>}</label>
      {!channelId && <p className="automations-muted">Sin canal: el brief, el cierre y el estado funcionan igual, pero no habrá coordinador ni acciones de flota.</p>}
      {channelId && <><RosterPicker label="Coordinador" value={coordinator} onChange={setCoordinator} /><RosterPicker label="Agente del proyecto" value={agent} onChange={setAgent} /></>}</section>
    {project.data?.remote_processing === false && <p className="automations-warning">El resumen de este proyecto no se generará con un modelo remoto; recibirás solo los datos.</p>}
    <div className="automations-actions"><button type="submit" className="btn btn-primary" disabled={!valid || save.isPending}>{view.delegation ? 'Guardar cambios' : 'Activar para este proyecto'}</button><button type="button" className="btn" onClick={onDone} disabled={save.isPending}>Cancelar</button></div>
  </form>
}

/** La delegación completa en lenguaje claro: lo que la persona confirma es lo que el backend va a usar. */
function DelegationSummary({ document, view }: { document: DelegationDocument; view: ProjectAutomationView }) {
  const repositories = document.repository_ids.map(id => view.repositories.find(repo => repo.id === id) ?? null)
  const roster = (entry: RosterEntry): string => `${CLI_LABELS[entry.cli as keyof typeof CLI_LABELS] ?? entry.cli} · ${entry.model}${entry.effort ? ` · esfuerzo ${entry.effort}` : ''}`
  return <div className="project-automation-summary">
    <h4>Acciones que podrá proponer</h4>
    {document.item_kinds.length ? <ul>{document.item_kinds.map(kind => <li key={kind}>{ITEM_KIND_LABELS[kind] ?? kind}</li>)}</ul> : <p>Ninguna.</p>}
    {document.item_kinds.includes('git_push') && <><h4>Repositorios y ramas</h4>
      {repositories.length ? <ul>{repositories.map((repo, index) => <li key={repo?.id ?? index}>{repo ? <>{repo.repo_path} <small className="automations-muted">remoto {repo.canonical_remote_url} · ramas permitidas: {repo.allowed_branches.join(', ') || 'ninguna'} · la principal ({repo.default_branch}) queda excluida</small></> : `Repositorio ${document.repository_ids[index]} (ya no está disponible)`}</li>)}</ul> : <p>Ninguno: no podrá proponer pushes.</p>}</>}
    <h4>Equipo</h4>
    <ul><li>Coordinador: {roster(document.roster.coordinator)}</li><li>Agente del proyecto: {roster(document.roster.project_agent)}</li></ul>
    <h4>Límites</h4>
    <ul><li>Planes simultáneos: {document.limits.max_concurrent_plans}</li><li>Duración máxima: {document.limits.max_runtime_minutes} min</li></ul>
    <p className="automations-muted">Canal de trabajo: {view.channel?.name ?? 'sin canal (no habrá coordinador ni acciones de flota)'}. Cada acción externa sigue pidiendo tu aprobación por ítem.</p>
  </div>
}

function UpcomingRuns({ projectId }: { projectId: string }) {
  const schedules = useSchedules()
  const actions = useScheduleActions()
  const rows = (schedules.data?.items ?? []).filter(item => item.state === 'active' && OWNER_TEMPLATES.includes(item.template as typeof OWNER_TEMPLATES[number]) && (item.scope === 'owner' || item.project_id === projectId))
  return <section className="project-automation-card"><h3>Próximas ejecuciones</h3>
    <DataTable rows={rows} rowKey={item => item.id} loading={schedules.isLoading} empty="Todavía no hay ejecuciones programadas." caption="Próximas ejecuciones"
      columns={[{ key: 'name', header: 'Automatización', render: item => TEMPLATE_NAMES[item.template] ?? item.title }, { key: 'next', header: 'Próxima', render: item => describeNextRun(item.next_run_at) },
        { key: 'run', header: '', className: 'actions', render: item => <button className="btn btn-sm" onClick={() => actions.runNow.mutate({ id: item.id })}>Ejecutar ahora</button> }]} />
    <p><Link to="/schedules">Ver todas las programaciones</Link></p></section>
}

function LastClose() {
  const runs = useRuns({ kind: 'close', limit: '1' })
  const last = runs.data?.items[0]
  return <section className="project-automation-card"><h3>Último cierre (todos los proyectos)</h3>
    {last ? <p><Link to={`/deliveries/${last.run_id}`}>{last.title}</Link> · {formatDateTime(last.scheduled_for)}{last.decision ? ` · aprobado ${last.decision.approved} de ${last.decision.total}` : ''}</p> : <p className="automations-muted">Todavía no hubo un cierre.</p>}</section>
}

/** Pestaña «Brief y cierre» de la página de un proyecto. */
export function ProjectAutomation({ project }: { project: MemoryEntity }) {
  const automation = useProjectAutomation(project.id)
  const save = useSaveProjectAutomation(project.id)
  const [editing, setEditing] = useState(false)
  const [deactivating, setDeactivating] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const view = automation.data
  if (automation.error) return <ErrorBox error={automation.error} retry={automation.refetch} />
  if (!view) return <div className="hub-loading" role="status">Cargando…</div>
  const delegation = view.delegation
  const active = view.enabled && delegation !== null
  if (editing) return <ActivationForm project={project} view={view} onDone={() => setEditing(false)} />
  if (!active) return <div className="memory-callout"><p>Cada mañana a las 08:00 recibes el estado del proyecto y lo que requiere tu acción; a las 17:30 una propuesta de horas, tareas y pushes que apruebas respondiendo por el mismo canal.</p><button className="btn btn-primary" onClick={() => setEditing(true)}>Activar para este proyecto</button></div>
  return <div className="project-automation">
    <section className="project-automation-card"><h3>Delegación v{delegation.version}</h3>
      <p>{delegation.approval_source === 'owner_ui' ? 'Aprobada en la app' : `Declarada por un agente${delegation.instruction ? `: «${delegation.instruction}»` : ''}`} · {formatDateTime(delegation.created_at)} · digest {delegation.digest.slice(0, 8)}…</p>
      <p>Acciones permitidas: {delegation.document.item_kinds.length ? delegation.document.item_kinds.map(kind => ITEM_KIND_LABELS[kind] ?? kind).join('; ') : 'ninguna'}. Coordinador: {view.coordinator === 'ready' ? 'listo' : view.coordinator === 'no_channel' ? 'sin canal' : 'desactivado'}{view.channel ? ` · canal ${view.channel.name}` : ''}.</p>
      <div className="automations-actions">
        {delegation.approval_source === 'coordinator_declaration' && <button className="btn" disabled={save.isPending} onClick={() => setConfirming(true)}>Revisar y confirmar</button>}
        <button className="btn" onClick={() => setEditing(true)}>Configurar</button>
        <button className="btn btn-danger" onClick={() => setDeactivating(true)}>Desactivar</button></div></section>
    <UpcomingRuns projectId={project.id} />
    <LastClose />
    <ConfirmDialog open={confirming} title="Confirmar la delegación" confirmLabel="Confirmar en la app" cancelLabel="Volver" busy={save.isPending} onClose={() => setConfirming(false)}
      message={<><p>Un agente declaró esta delegación{delegation.instruction ? <> con la frase «{delegation.instruction}»</> : ''}. Al confirmar queda aprobada por ti, con exactamente lo siguiente (versión {delegation.version}, digest {delegation.digest.slice(0, 12)}…):</p><DelegationSummary document={delegation.document} view={view} /></>}
      onConfirm={() => save.mutate({ enabled: true, expected_version: delegation.version, channel_id: view.channel?.id ?? null, document: cleanDocument(delegation.document) }, { onSuccess: () => setConfirming(false) })} />
    <ConfirmDialog open={deactivating} title="Desactivar brief y cierre" destructive confirmLabel="Desactivar" busy={save.isPending}
      message="Se revoca la delegación y se cancelan las automatizaciones de este proyecto. Se conservan el historial y las entregas."
      onClose={() => setDeactivating(false)} onConfirm={() => save.mutate({ enabled: false, expected_version: delegation.version, channel_id: view.channel?.id ?? null, document: cleanDocument(delegation.document) }, { onSuccess: () => setDeactivating(false) })} />
  </div>
}
