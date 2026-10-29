import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Icon } from '../components/Icon'
import { Badge } from '../components/Badge'
import type { BadgeTone } from '../components/Badge'
import { DataTable, formatDateTime } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { ErrorState } from '../components/ErrorState'
import { LoadingBlock } from '../components/Spinner'
import { Markdown } from '../components/Markdown'
import { Modal, ConfirmDialog } from '../components/Modal'
import { GmailAuthorize } from '../components/GmailAuthorize'
import { GmailSetupNotice } from '../components/GmailSetup'
import { useToast } from '../components/Toast'
import { api } from '../lib/api'
import { useMemory } from '../lib/memory'
import type { MemoryEntity, Page } from '../lib/memory'
import { automationKeys, CHANNEL_REASONS, STORE_ITEM_TO_PUBLIC, DECISION_ERRORS, useAutomationSettings, useDeliveryChannels, useDecision, useDecisionActions, useRetryDelivery, useRun, useRuns, useScheduleActions, useSchedules } from '../lib/automations'
import type { DeliveryAvailability, DeliveryTarget, DeliveryView, ItemState, PublicItem, Recurrence, RunListItem, RunState, ScheduleView } from '../lib/automations'

const TEMPLATE_LABELS: Record<string, string> = {
  daily_brief: 'Brief', daily_close: 'Cierre', project_status: 'Estado del proyecto', reminder: 'Recordatorio', custom_synthesis: 'Síntesis', team_health: 'Salud del equipo',
}
const KIND_LABELS = { notice: 'Sin modelo', synthesis: 'Con modelo' } as const
const KIND_HINTS = { notice: 'Sin modelo: se arma solo con datos del Hub.', synthesis: 'Con modelo: un modelo sin herramientas resume datos del Hub.' } as const
const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'] as const
const TARGET_LABELS = { hub_inbox: 'Bandeja del Hub', app_window: 'App', gmail_self: 'Gmail', slack_self: 'Slack' } as const
const RUN_STATE_LABELS: Record<RunState, string> = {
  pending: 'pendiente', running: 'en curso', deferred: 'diferido', succeeded: 'ok', partial: 'parcial', failed: 'falló', uncertain: 'incierto', skipped: 'omitido', cancelled: 'cancelado', interrupted: 'interrumpido',
}
const RUN_STATE_TONES: Record<RunState, BadgeTone> = {
  pending: 'neutral', running: 'accent', deferred: 'stale', succeeded: 'on', partial: 'stale', failed: 'off', uncertain: 'stale', skipped: 'neutral', cancelled: 'neutral', interrupted: 'off',
}
const ITEM_STATE_LABELS: Record<ItemState, string> = {
  proposed: 'propuesto', approved: 'aprobado', rejected: 'rechazado', dispatching: 'en curso', succeeded: 'hecho', uncertain: 'en reconciliación', expired: 'vencido', superseded: 'reemplazado por una revisión', unverifiable: 'sin verificar',
}
const SKIP_REASONS: Record<string, string> = {
  overlap: 'la ocurrencia anterior seguía en curso', misfire_out_of_grace: 'Agent Hub estaba cerrado', automations_off: 'automatizaciones desactivadas', schedule_cancelled: 'cancelada', remote_processing_excluded: 'procesamiento remoto desactivado',
}
const DEFERRED_REASONS: Record<string, string> = { quota: 'cuota agotada', automations_off: 'automatizaciones desactivadas', delivery_unavailable: 'canal de entrega no disponible' }

function templateLabel(schedule: Pick<ScheduleView, 'template' | 'title'>): string {
  return TEMPLATE_LABELS[schedule.template] ?? schedule.template
}

export function describeRecurrence(recurrence: Recurrence): string {
  if (recurrence.type === 'once') return `Una vez, ${formatDateTime(recurrence.at)}`
  if (recurrence.type === 'interval') return recurrence.minutes % 60 === 0 ? `Cada ${recurrence.minutes / 60} h` : `Cada ${recurrence.minutes} min`
  const days = recurrence.weekdays ?? [1, 2, 3, 4, 5, 6, 7]
  const label = days.length === 7 ? 'Todos los días' : days.join(',') === '1,2,3,4,5' ? 'Lunes a viernes' : days.map(day => WEEKDAYS[day - 1]).join(' ')
  return `${label} a las ${recurrence.time}`
}

/** «mañana 08:00 · en 14 h» sin depender de bibliotecas de fechas. */
export function describeNextRun(iso: string | null, now = Date.now()): string {
  if (!iso) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  const minutes = Math.round((at.getTime() - now) / 60_000)
  const when = minutes < 0 ? 'vencida' : minutes < 60 ? `en ${Math.max(minutes, 1)} min` : minutes < 48 * 60 ? `en ${Math.round(minutes / 60)} h` : `en ${Math.round(minutes / 1440)} días`
  return `${formatDateTime(iso)} · ${when}`
}

function AutomationsHeader({ children }: { children?: ReactNode }) {
  return <>
    <div className="hub-heading"><div><div className="hub-eyebrow">LO QUE TUS AGENTES PROGRAMARON</div><h1>Automatizaciones</h1><p>Lo que tus agentes programaron y lo que ya te entregaron.</p></div><div className="hub-actions">{children}</div></div>
    <nav className="automations-tabs" aria-label="Automatizaciones">
      <NavLink to="/schedules" className={({ isActive }) => isActive ? 'active' : ''}>Programaciones</NavLink>
      <NavLink to="/deliveries" className={({ isActive }) => isActive ? 'active' : ''}>Entregas</NavLink>
    </nav>
  </>
}

function useAutostart() {
  const cache = useQueryClient()
  const query = useQuery({ queryKey: ['desktop-autostart'], queryFn: () => window.agentHub?.getAutostart() ?? Promise.resolve(true) })
  const enable = async (): Promise<void> => { await window.agentHub?.setAutostart(true); await cache.invalidateQueries({ queryKey: ['desktop-autostart'] }) }
  return { enabled: query.data ?? true, enable }
}

function ScheduleNotices() {
  const settings = useAutomationSettings()
  const autostart = useAutostart()
  return <>
    {settings.data && !settings.data.automations_enabled && <div className="hub-notice error" role="alert"><Icon name="alert" /><div><strong>Automatizaciones desactivadas en Ajustes</strong><p>No se ejecutan ni se entregan hasta que las actives. <Link to="/settings">Ir a Ajustes</Link></p></div></div>}
    <div className="memory-callout automations-callout"><p>Las automatizaciones corren solo mientras Agent Hub está abierto. Si cierras desde la bandeja, se detienen.</p>{!autostart.enabled && window.agentHub && <button className="btn btn-sm" onClick={() => void autostart.enable()}>Iniciar Agent Hub al ingresar</button>}</div>
  </>
}

function RescheduleModal({ schedule, onClose }: { schedule: ScheduleView; onClose: () => void }) {
  const actions = useScheduleActions()
  const daily = schedule.recurrence.type === 'daily' ? schedule.recurrence : null
  const [time, setTime] = useState(daily?.time ?? '08:00')
  const [days, setDays] = useState<number[]>(daily?.weekdays ?? [1, 2, 3, 4, 5, 6, 7])
  const toggle = (day: number): void => setDays(current => current.includes(day) ? current.filter(item => item !== day) : [...current, day].sort())
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(time) && days.length > 0
  return <Modal open title={`Cambiar horario · ${schedule.title}`} onClose={onClose} busy={actions.reschedule.isPending} footer={<>
    <button className="btn" onClick={onClose} disabled={actions.reschedule.isPending}>Cancelar</button>
    <button className="btn btn-primary" disabled={!daily || !valid || actions.reschedule.isPending} onClick={() => actions.reschedule.mutate({ id: schedule.id, revision: schedule.revision, recurrence: { type: 'daily', time, weekdays: days } }, { onSuccess: onClose })}>Guardar</button>
  </>}>
    {daily ? <div className="automations-form">
      <label>Hora<input type="time" value={time} onChange={event => setTime(event.target.value)} /></label>
      <fieldset><legend>Días</legend><div className="chip-list">{WEEKDAYS.map((label, index) => <button key={label} type="button" className={`chip automations-day ${days.includes(index + 1) ? 'selected' : ''}`} aria-pressed={days.includes(index + 1)} onClick={() => toggle(index + 1)}>{label}</button>)}</div></fieldset>
      <p className="automations-muted">Zona horaria del sistema: {schedule.timezone}</p>
    </div> : <p>Esta automatización no es diaria ({describeRecurrence(schedule.recurrence)}). Su horario lo cambia el agente que la creó.</p>}
  </Modal>
}

const CHANNEL_TARGETS = [['gmail', 'gmail_self', 'Gmail a mi propia cuenta']] as const

function ChannelsModal({ schedule, onClose }: { schedule: ScheduleView; onClose: () => void }) {
  const actions = useScheduleActions()
  const channels = useDeliveryChannels()
  const [selected, setSelected] = useState<DeliveryTarget[]>(schedule.delivery.filter(target => target === 'gmail_self'))
  const toggle = (target: DeliveryTarget): void => setSelected(current => current.includes(target) ? current.filter(item => item !== target) : [...current, target])
  return <Modal open title={`Canales · ${schedule.title}`} onClose={onClose} busy={actions.delivery.isPending} footer={<>
    <button className="btn" onClick={onClose} disabled={actions.delivery.isPending}>Cancelar</button>
    <button className="btn btn-primary" disabled={actions.delivery.isPending} onClick={() => actions.delivery.mutate({ id: schedule.id, revision: schedule.revision, delivery: ['hub_inbox', 'app_window', ...selected] }, { onSuccess: onClose })}>Guardar</button>
  </>}>
    <div className="automations-form">
      <label><input type="checkbox" checked disabled /> App de Agent Hub (siempre)</label>
      {!CHANNEL_TARGETS.some(([, target]) => schedule.delivery_allowed?.includes(target) ?? true) && <p className="automations-muted">Este tipo de automatización se entrega solo en la app.</p>}
      {CHANNEL_TARGETS.filter(([, target]) => schedule.delivery_allowed?.includes(target) ?? true).map(([channel, target, label]) => { const info = channels.data?.items.find(item => item.channel === channel); const available = info?.available === true
        return <label key={target}><input type="checkbox" disabled={!available && !selected.includes(target)} checked={selected.includes(target)} onChange={() => toggle(target)} /> {label}{info?.destination ? ` (${info.destination})` : ''}{!available && info && <small className="automations-muted"> {CHANNEL_REASONS[info.reason ?? ''] ?? 'no disponible'}</small>}{channel === 'gmail' && info?.reason === 'scope_missing' && <GmailAuthorize destination={info.destination} />}</label> })}
      <p className="automations-muted">Un canal se puede elegir cuando está listo para enviar. Los correos y mensajes van solo a tu propia cuenta.</p>
    </div>
  </Modal>
}

function ScheduleRow({ schedule }: { schedule: ScheduleView }) {
  const overridden = schedule.human_override
  return <div className="automations-name"><strong>{templateLabel(schedule)}</strong><span>{schedule.title}</span><small>{describeRecurrence(schedule.recurrence)}{overridden.includes('recurrence') ? ' · horario fijado por ti' : ''}</small>{overridden.includes('delivery') && <small>Canales fijados por ti</small>}</div>
}

function createdByText(schedule: ScheduleView): string {
  const { kind, label } = schedule.created_by
  return kind === 'agent' ? label || 'Un agente' : kind === 'human' ? 'Tú' : 'Agent Hub'
}

function channelChips(schedule: ScheduleView, availability: DeliveryAvailability | undefined): ReactNode {
  return <div className="chip-list">{schedule.delivery.filter(target => target !== 'hub_inbox').map(target => {
    const missing = schedule.delivery_unavailable.includes(target)
    const reason = target === 'gmail_self' || target === 'slack_self' ? availability?.[target]?.reason : undefined
    return <span key={target} className="chip" title={missing ? `No disponible: ${CHANNEL_REASONS[reason ?? ''] ?? 'revisa la conexión'}` : 'activo'}>{TARGET_LABELS[target]}{missing ? ' ⚠' : ''}</span>
  })}</div>
}

function lastRunText(schedule: ScheduleView): ReactNode {
  const run = schedule.last_run
  if (!run) return <span className="automations-muted">Todavía no corrió</span>
  const reason = run.state === 'skipped' && run.skip_reason ? SKIP_REASONS[run.skip_reason] ?? run.skip_reason : run.state === 'deferred' && run.deferred_reason ? DEFERRED_REASONS[run.deferred_reason] ?? run.deferred_reason : ''
  return <><Badge tone={RUN_STATE_TONES[run.state]}>{RUN_STATE_LABELS[run.state]}</Badge>{reason && <small> {reason}</small>}<br /><Link to={`/deliveries/${run.id}`}>{formatDateTime(run.scheduled_for)}</Link></>
}

function nextRunText(schedule: ScheduleView): ReactNode {
  if (schedule.state === 'paused') return schedule.paused_by === 'human' ? 'pausado por ti' : schedule.paused_by === 'system' ? 'pausado por el sistema' : 'pausado por el agente'
  if (schedule.state !== 'active') return '—'
  if (schedule.deferred?.reason === 'quota') return `diferido: cuota ${schedule.deferred.resets_at ? `hasta ${formatDateTime(schedule.deferred.resets_at)}` : 'agotada'}`
  return describeNextRun(schedule.next_run_at)
}

function stateBadge(schedule: ScheduleView): ReactNode {
  const labels = { active: 'activo', paused: 'pausado', cancelled: 'cancelado', expired: 'vencido', completed: 'completado' } as const
  return <Badge tone={schedule.state === 'active' ? 'on' : 'neutral'}>{labels[schedule.state]}</Badge>
}

export function SchedulesPage() {
  const schedules = useSchedules()
  const actions = useScheduleActions()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const focus = params.get('focus')
  const [runningNow, setRunningNow] = useState<ScheduleView | null>(null)
  const [editing, setEditing] = useState<ScheduleView | null>(null)
  const [channelsFor, setChannelsFor] = useState<ScheduleView | null>(null)
  const [cancelling, setCancelling] = useState<ScheduleView | null>(null)
  const rows = (schedules.data?.items ?? []).filter(schedule => schedule.state === 'active' || schedule.state === 'paused')
  const loaded = schedules.data !== undefined
  // El parámetro se consume una vez que la tabla ya tiene filas; limpiarlo al desmontar devolvería la navegación a /schedules.
  useEffect(() => {
    if (!focus || !loaded) return
    document.getElementById(`schedule-${focus}`)?.scrollIntoView?.({ block: 'center' })
    setHighlighted(focus)
    setParams(current => { const next = new URLSearchParams(current); next.delete('focus'); return next }, { replace: true })
  }, [focus, loaded, setParams])
  const columns: Column<ScheduleView>[] = [
    { key: 'name', header: 'Automatización', render: schedule => <ScheduleRow schedule={schedule} /> },
    { key: 'kind', header: 'Tipo', render: schedule => <span title={KIND_HINTS[schedule.kind]}>{KIND_LABELS[schedule.kind]}</span> },
    { key: 'by', header: 'Creado por', render: schedule => <div><span>{createdByText(schedule)}</span><small className="automations-muted">{schedule.admission_note}</small></div> },
    { key: 'next', header: 'Próxima ejecución', render: nextRunText },
    { key: 'last', header: 'Última ejecución', render: lastRunText },
    { key: 'channels', header: 'Canales', render: schedule => channelChips(schedule, schedules.data?.delivery_available) },
    { key: 'state', header: 'Estado', render: stateBadge },
    { key: 'actions', header: '', className: 'actions', render: schedule => <div className="actions">
      <button className="btn btn-sm" onClick={() => setEditing(schedule)}>Cambiar horario</button>
      <button className="btn btn-sm" onClick={() => setChannelsFor(schedule)}>Canales</button>
      {schedule.state === 'paused' ? <button className="btn btn-sm" onClick={() => actions.resume.mutate({ id: schedule.id, revision: schedule.revision })}>Reanudar</button> : <button className="btn btn-sm" onClick={() => actions.pause.mutate({ id: schedule.id, revision: schedule.revision })}>Pausar</button>}
      <button className="btn btn-sm" disabled={schedule.state !== 'active'} onClick={() => setRunningNow(schedule)}>Ejecutar ahora</button>
      <button className="btn btn-sm btn-danger" onClick={() => setCancelling(schedule)}>Cancelar</button>
    </div> },
  ]
  return <>
    <AutomationsHeader />
    <ScheduleNotices />
    {loaded && <GmailSetupNotice schedules={rows} availability={schedules.data?.delivery_available} />}
    <DataTable columns={columns} rows={rows} rowKey={schedule => schedule.id} loading={schedules.isLoading} error={schedules.error} onRetry={() => void schedules.refetch()} caption="Automatizaciones programadas"
      rowId={schedule => `schedule-${schedule.id}`} rowClassName={schedule => schedule.id === highlighted ? 'automations-focus' : undefined}
      empty={<>Todavía no hay automatizaciones. Activa el brief y el cierre desde un proyecto, o pídeselo a tu agente. <Link to="/projects">Ir a proyectos</Link></>} />
    {editing && <RescheduleModal key={editing.id} schedule={editing} onClose={() => setEditing(null)} />}
    {channelsFor && <ChannelsModal key={channelsFor.id} schedule={channelsFor} onClose={() => setChannelsFor(null)} />}
    <ConfirmDialog open={runningNow !== null} title="Ejecutar ahora" confirmLabel="Ejecutar" cancelLabel="Volver" busy={actions.runNow.isPending}
      message={<><p>Se genera la entrega de «{runningNow?.title}» ahora, fuera de su horario.</p>{runningNow?.delivery.some(target => target === 'gmail_self' || target === 'slack_self') && <p>Si tiene Gmail o Slack como canal, el mensaje también se envía a tu propia cuenta.</p>}</>}
      onClose={() => setRunningNow(null)}
      onConfirm={() => runningNow && actions.runNow.mutate({ id: runningNow.id }, { onSuccess: () => { setRunningNow(null); toast.success('Ejecución encolada', 'La entrega dirá «ejecutado manualmente».') } })} />
    <ConfirmDialog open={cancelling !== null} title="Cancelar automatización" destructive confirmLabel="Cancelar automatización" cancelLabel="Volver" busy={actions.cancel.isPending}
      message={<><p>«{cancelling?.title}» deja de ejecutarse. Si un agente la vuelve a programar, te llegará el aviso y podrás cancelarla de nuevo.</p><p>Para detenerla un tiempo sin perderla, usa «Pausar».</p></>}
      onClose={() => setCancelling(null)}
      onConfirm={() => cancelling && actions.cancel.mutate({ id: cancelling.id, revision: cancelling.revision }, { onSuccess: () => setCancelling(null) })} />
  </>
}

function deliverySummary(deliveries: DeliveryView[] | undefined): ReactNode {
  if (!deliveries) return <span className="automations-muted">—</span>
  return <div className="chip-list">{deliveries.filter(item => item.target !== 'hub_inbox').map(item => <span key={item.target} className="chip" title={item.error_code ?? undefined}>{TARGET_LABELS[item.target]} {item.state === 'sent' ? '✓' : item.state === 'failed' ? `falló${item.error_code ? `: ${item.error_code}` : ''}` : item.state === 'uncertain' ? 'incierto' : item.state === 'sending' ? '…' : item.state === 'skipped' ? 'omitido' : 'pendiente'}</span>)}</div>
}

function decisionSummary(run: RunListItem): string {
  const decision = run.decision
  if (decision === undefined) return '—'
  switch (decision.state) {
    case 'none': return 'sin acciones'
    case 'pending': return `pendiente${decision.expires_at ? ` hasta ${formatDateTime(decision.expires_at)}` : ''}`
    case 'dispatching': return `ejecutando ${decision.approved} de ${decision.total}`
    case 'uncertain': return 'en reconciliación'
    case 'expired': return 'vencido'
    case 'done': return decision.approved === 0 ? 'rechazado' : `aprobado ${decision.approved} de ${decision.total}`
  }
}

/** Encabezado de tiempos: «generado» solo cuando hubo retraso real o un disparo especial. */
export function generatedNote(run: Pick<RunListItem, 'trigger' | 'scheduled_for' | 'started_at' | 'state'>): string {
  if (run.trigger === 'run_now') return ' · ejecutado manualmente'
  if (!run.started_at) return run.state === 'deferred' ? ' · diferido, todavía no generado' : ''
  const delayMinutes = (Date.parse(run.started_at) - Date.parse(run.scheduled_for)) / 60_000
  if (run.trigger === 'misfire') return ` · generado ${formatDateTime(run.started_at)} al encender`
  return delayMinutes > 10 ? ` · generado ${formatDateTime(run.started_at)} (con retraso)` : ''
}

const ARTIFACT_LABELS = { notice: 'Aviso', brief: 'Brief', close: 'Cierre', status: 'Estado', report: 'Informe' } as const

export function DeliveriesPage() {
  const [kind, setKind] = useState('')
  const [projectId, setProjectId] = useState('')
  const projects = useMemory<Page<MemoryEntity>>('list_entities', { kind: 'project', limit: 200 })
  const runs = useRuns({ kind: kind || undefined, project_id: projectId || undefined })
  const columns: Column<RunListItem>[] = [
    { key: 'unread', header: '', render: run => run.read_at ? null : <span className="automations-unread" role="img" aria-label="No leída" /> },
    { key: 'when', header: 'Fecha', render: run => <Link to={`/deliveries/${run.run_id}`}>{formatDateTime(run.started_at ?? run.scheduled_for)}</Link> },
    { key: 'kind', header: 'Tipo', render: run => run.artifact_kind ? ARTIFACT_LABELS[run.artifact_kind] : '—' },
    { key: 'title', header: 'Entrega', render: run => run.title },
    { key: 'channels', header: 'Canales', render: run => deliverySummary(run.deliveries) },
    { key: 'decision', header: 'Decisión', render: decisionSummary },
    { key: 'state', header: 'Estado', render: run => <Badge tone={RUN_STATE_TONES[run.state]}>{RUN_STATE_LABELS[run.state]}</Badge> },
  ]
  return <>
    <AutomationsHeader><label className="automations-filter">Tipo<select value={kind} onChange={event => setKind(event.target.value)}><option value="">Todos</option><option value="brief">Brief</option><option value="close">Cierre</option><option value="notice">Aviso</option></select></label><label className="automations-filter">Proyecto<select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Todos</option>{(projects.data?.items ?? []).map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label></AutomationsHeader>
    <DataTable columns={columns} rows={runs.data?.items ?? []} rowKey={run => run.run_id} loading={runs.isLoading} error={runs.error} onRetry={() => void runs.refetch()} caption="Entregas" empty="Todavía no hay entregas." rowClassName={run => run.read_at ? undefined : 'automations-unread-row'} />
  </>
}

const hoursText = (seconds: number): string => `${(seconds / 3600).toLocaleString('es', { maximumFractionDigits: 1 })} h`
const PROPOSAL_ITEM_STATES: readonly ItemState[] = ['proposed']
/** Ítems cuyo efecto no se deshace con una corrección de horas: se confirman viendo el efecto exacto. */
const SENSITIVE_KINDS: readonly PublicItem['kind'][] = ['git_push', 'jira_transition', 'jira_comment']
const KIND_LABELS_ITEM: Record<PublicItem['kind'], string> = { jira_worklog: 'Horas en Jira', jira_transition: 'Cambio de estado en Jira', jira_comment: 'Comentario en Jira', git_push: 'Push', info: 'Informativo' }

function ItemsBlock({ runId, items, hasDecision }: { runId: string; items: PublicItem[]; hasDecision: boolean }) {
  const decision = useDecision(runId, hasDecision)
  const actions = useDecisionActions(runId)
  const toast = useToast()
  // El estado público del run manda; el del almacén solo corrige un ítem que el run aún marca como propuesto. Un propuesto que la solicitud cargada no contiene no se puede aprobar.
  const stored = new Map((decision.data?.items ?? []).map(item => [item.ordinal, item]))
  const merged: { ordinal: number; kind: PublicItem['kind']; summary: string; state: ItemState }[] = items.map(item => {
    const live = stored.get(item.ordinal)
    const published = item.state ?? 'proposed'
    const unmatched = published === 'proposed' && decision.data !== undefined && !live
    return { ordinal: item.ordinal, kind: live?.kind ?? item.kind, summary: live?.summary ?? item.summary, state: unmatched ? 'unverifiable' : published === 'proposed' && live && live.state !== 'pending' ? STORE_ITEM_TO_PUBLIC[live.state] : published }
  })
  const estimates = new Map(items.map(item => [item.ordinal, item.estimate]))
  const [selected, setSelected] = useState<Set<number> | null>(null)
  const [hours, setHours] = useState<Record<number, string>>({})
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null)
  const proposed = merged.filter(item => PROPOSAL_ITEM_STATES.includes(item.state))
  const chosen = selected ?? new Set(proposed.map(item => item.ordinal))
  const toggle = (ordinal: number): void => setSelected(() => { const next = new Set(chosen); if (next.has(ordinal)) next.delete(ordinal); else next.add(ordinal); return next })
  if (merged.length === 0) return null
  const approve = (done?: () => void): void => actions.approve.mutate({ ordinals: [...chosen].sort((a, b) => a - b), digest: decision.data!.digest }, { onSuccess: () => { setSelected(null); done?.() } })
  const chosenItems = merged.filter(item => chosen.has(item.ordinal) && item.state === 'proposed')
  const sensitive = chosenItems.some(item => SENSITIVE_KINDS.includes(item.kind))
  const open = decision.data?.state === 'open'
  const expired = decision.data?.state === 'expired'
  return <section className="automations-items"><h2>Acciones propuestas</h2>
    {decision.data && ['locked', 'revoked', 'superseded'].includes(decision.data.state) && <p className="automations-warning">{DECISION_ERRORS[decision.data.state]}</p>}
    {decision.data?.authority === 'authority_unavailable' && <p className="automations-warning">No se puede verificar la autoridad de esta solicitud; no se puede aprobar ni volver a proponer hasta reconciliar.</p>}
    <ul>{merged.map(item => { const estimate = estimates.get(item.ordinal); const mutable = item.state === 'proposed' && open
      return <li key={item.ordinal} className={`automations-item state-${item.state}`}>
        <label><input type="checkbox" disabled={!mutable} checked={mutable && chosen.has(item.ordinal)} onChange={() => toggle(item.ordinal)} /><strong>{item.ordinal}.</strong> {item.summary}</label>
        <Badge tone={item.state === 'succeeded' ? 'on' : item.state === 'uncertain' || item.state === 'unverifiable' ? 'stale' : item.state === 'rejected' || item.state === 'expired' ? 'off' : 'neutral'}>{ITEM_STATE_LABELS[item.state]}</Badge>
        {estimate && <small className="automations-muted">Estimación del agente, no medición: {(estimate.seconds / 3600).toLocaleString('es', { maximumFractionDigits: 1 })} h · confianza {estimate.confidence === 'high' ? 'alta' : estimate.confidence === 'medium' ? 'media' : 'baja'} · Base: {estimate.basis}{estimate.assumptions?.length ? ` · Supuestos: ${estimate.assumptions.join('; ')}` : ''}{estimate.would_change ? ` · Cambiaría si: ${estimate.would_change}` : ''}{estimate.approved_seconds !== undefined ? ` · Aprobado: ${hoursText(estimate.approved_seconds)}` : ''}{estimate.sent_seconds !== undefined ? ` · Enviado: ${hoursText(estimate.sent_seconds)}` : ''}</small>}
        {mutable && item.kind === 'jira_worklog' && <span className="automations-revise"><input type="number" min={0.5} step={0.5} aria-label={`Horas del ítem ${item.ordinal}`} value={hours[item.ordinal] ?? ''} placeholder="h" onChange={event => setHours(current => ({ ...current, [item.ordinal]: event.target.value }))} />
          <button className="btn btn-sm" disabled={actions.revise.isPending || !(Number(hours[item.ordinal]) >= 0.5)} onClick={() => actions.revise.mutate({ ordinal: item.ordinal, seconds: Math.round(Number(hours[item.ordinal]) * 3600) }, { onSuccess: () => { setSelected(null); setHours({}); toast.info('Corrección registrada', 'Aprueba desde la app: el código enviado por el canal deja de valer.') } })}>Corregir</button></span>}
      </li> })}</ul>
    {open && decision.data && merged.some(item => item.kind === 'jira_worklog') && <small className="automations-muted">Si corriges las horas, se crea una solicitud nueva: tras corregir, aprueba desde la app; el código enviado por el canal deja de valer.</small>}
    {open && decision.data && <div className="automations-actions">
      <button className="btn btn-primary" disabled={actions.approve.isPending || chosen.size === 0 || decision.data.authority !== 'verified'} onClick={() => sensitive ? setConfirming('approve') : approve()}>Aprobar seleccionados</button>
      <button className="btn" disabled={actions.reject.isPending || proposed.length === 0} onClick={() => setConfirming('reject')}>Rechazar todo</button>
      <small className="automations-muted">También puedes aprobar respondiendo con el código que recibiste por el canal de entrega.</small>
    </div>}
    {expired && <div className="automations-actions"><button className="btn" disabled={actions.repropose.isPending} onClick={() => actions.repropose.mutate()}>Volver a proponer</button></div>}
    <ConfirmDialog open={confirming === 'approve'} title="Aprobar estas acciones" confirmLabel="Aprobar" cancelLabel="Volver" busy={actions.approve.isPending} onClose={() => setConfirming(null)}
      onConfirm={() => approve(() => setConfirming(null))}
      message={<><p>Se ejecutarán exactamente estas acciones sobre tus sistemas:</p><ul>{chosenItems.map(item => <li key={item.ordinal}><strong>{KIND_LABELS_ITEM[item.kind]}:</strong> {item.summary}</li>)}</ul></>} />
    <ConfirmDialog open={confirming === 'reject'} title="Rechazar todo" destructive confirmLabel="Rechazar todo" cancelLabel="Volver" busy={actions.reject.isPending} onClose={() => setConfirming(null)}
      onConfirm={() => actions.reject.mutate({ ordinals: proposed.map(item => item.ordinal) }, { onSuccess: () => setConfirming(null) })}
      message={<p>Ninguna de las {proposed.length} acciones propuestas se ejecutará. Para repetirlas tendrás que volver a proponerlas.</p>} />
  </section>
}

const RETRYABLE: readonly DeliveryTarget[] = ['gmail_self', 'slack_self']

/** «Reintentar» de una entrega por canal fallida o incierta; siempre pide confirmación antes de llamar. */
function DeliveryRetry({ runId, deliveries }: { runId: string; deliveries: DeliveryView[] | undefined }) {
  const retry = useRetryDelivery(runId)
  const [asking, setAsking] = useState<DeliveryView | null>(null)
  const retryable = (deliveries ?? []).filter(item => item.id && RETRYABLE.includes(item.target) && (item.state === 'failed' || item.state === 'uncertain'))
  if (retryable.length === 0) return null
  return <div className="automations-actions">
    {retryable.map(item => <button key={item.id} className="btn btn-sm" disabled={retry.isPending} onClick={() => setAsking(item)}>Reintentar {TARGET_LABELS[item.target]}</button>)}
    <ConfirmDialog open={asking !== null} title={`Reintentar el envío por ${asking ? TARGET_LABELS[asking.target] : ''}`} confirmLabel="Reintentar" cancelLabel="Volver" busy={retry.isPending} onClose={() => setAsking(null)}
      message={asking?.state === 'uncertain' ? <p>No se pudo confirmar si este mensaje llegó: puede llegar dos veces. Reintenta solo si no lo recibiste.</p> : <p>El envío falló; se vuelve a intentar una vez, a tu propia cuenta.</p>}
      onConfirm={() => asking?.id && retry.mutate(asking.id, { onSettled: () => setAsking(null) })} />
  </div>
}

export function DeliveryDetailPage() {
  const { runId = '' } = useParams()
  const navigate = useNavigate()
  const run = useRun(runId)
  const cache = useQueryClient()
  const unread = run.data !== undefined && run.data.read_at === null
  useEffect(() => {
    if (!unread) return
    void api.put(`/memory/schedules/runs/${encodeURIComponent(runId)}/read`).then(() => cache.invalidateQueries({ queryKey: ['schedule-runs'] })).catch(() => undefined)
  }, [unread, runId, cache])
  if (run.isLoading) return <LoadingBlock label="Cargando la entrega…" />
  if (run.error || !run.data) return <ErrorState error={run.error} onRetry={() => void run.refetch()} />
  const data = run.data
  return <>
    <AutomationsHeader><button className="btn btn-sm" onClick={() => navigate('/deliveries')}><Icon name="back" /> Entregas</button></AutomationsHeader>
    <article className="automations-detail">
      <header><h2>{data.title}</h2><p className="automations-muted">Programado {formatDateTime(data.scheduled_for)}{generatedNote(data)}</p>
        {deliverySummary(data.deliveries)}
        <DeliveryRetry runId={data.run_id} deliveries={data.deliveries} />
        {data.incidents?.map(incident => <p key={incident.observed_at} className="automations-warning">Proceso interrumpido ({incident.cause}): {incident.action}</p>)}
        <Link to={`/schedules?focus=${data.schedule_id}`}>Ver automatización</Link></header>
      <Markdown source={data.body_md} />
      <ItemsBlock runId={data.run_id} items={data.items} hasDecision={data.has_decision} />
    </article>
  </>
}

export { automationKeys }
