import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from './api'
import { useToast } from '../components/Toast'

/**
 * Formas de las rutas humanas del scheduler (`/api/memory/schedules/*`) y de los ajustes de automatizaciones.
 * `ScheduleView` espeja `packages/memory/src/schedule-contract.ts`; las respuestas de runs se normalizan abajo
 * (`normalizeRunList`, `normalizeRunDetail`) porque el backend las entrega como filas planas.
 */

export type ScheduleState = 'active' | 'paused' | 'cancelled' | 'expired' | 'completed'
export type ScheduleKind = 'notice' | 'synthesis'
export type DeliveryTarget = 'hub_inbox' | 'app_window' | 'gmail_self' | 'slack_self'
export type RunState = 'pending' | 'running' | 'deferred' | 'succeeded' | 'partial' | 'failed' | 'uncertain' | 'skipped' | 'cancelled' | 'interrupted'

export type Recurrence =
  | { type: 'once'; at: string }
  | { type: 'daily'; time: string; weekdays?: number[] }
  | { type: 'interval'; minutes: number }

export type HumanOverrideField = 'recurrence' | 'delivery'
export type Actor = 'agent' | 'human' | 'system'

export interface ScheduleRunSummary {
  id: string
  state: RunState
  scheduled_for: string
  trigger?: 'clock' | 'misfire' | 'run_now'
  skip_reason?: string
  deferred_reason?: string
}

export interface ScheduleView {
  id: string
  scope: 'project' | 'owner'
  project_id: string | null
  template: string
  template_version: number
  kind: ScheduleKind
  title: string
  recurrence: Recurrence
  timezone: string
  next_run_at: string | null
  next_run_local: string | null
  delivery: DeliveryTarget[]
  /** Destinos pedidos cuyo adaptador reporta no disponible; el motivo sale de `delivery_available` en la lista. */
  delivery_unavailable: DeliveryTarget[]
  /** Destinos que admite la plantilla; sin el campo (core anterior) se asumen todos. */
  delivery_allowed?: DeliveryTarget[]
  state: ScheduleState
  paused_by: Actor | null
  revision: number
  /** Campos que la persona cambió desde la app; un agente ya no puede modificarlos. */
  human_override: HumanOverrideField[]
  created_by: { kind: Actor; agent_id: string | null; label: string }
  /** Línea fija de la plantilla que explica por qué no pidió aprobación. */
  admission_note: string
  last_run?: ScheduleRunSummary
  /** Presente cuando hay un run diferido (por cuota, automatizaciones apagadas o entrega no disponible). */
  deferred?: { reason: string; resets_at: string | null; next_attempt_at: string | null }
}

export type DeliveryUnavailableReason = 'not_connected' | 'scope_missing' | 'identity_unverified' | 'identity_is_bot' | 'tool_off'
export type DeliveryAvailability = Record<'gmail_self' | 'slack_self', { available: boolean; reason?: DeliveryUnavailableReason; destination?: string }>

export interface Page { total: number; limit: number; offset: number }

/** Ítem público de un artefacto de decisión, sin códigos de aprobación. */
export type ItemState = 'proposed' | 'approved' | 'rejected' | 'dispatching' | 'succeeded' | 'uncertain' | 'expired' | 'superseded' | 'unverifiable'
export type ItemKind = 'jira_worklog' | 'jira_transition' | 'jira_comment' | 'git_push' | 'info'
export interface PublicItem {
  ordinal: number
  kind: ItemKind
  project_id: string | null
  summary: string
  state?: ItemState
  /** Referencia a la estimación de horas (`hour_estimates`); sus partes no viajan en el detalle del run. */
  estimate_id?: string
  /** Estimación del agente: lo estimado, lo aprobado y lo enviado se guardan y se muestran por separado. */
  estimate?: { seconds: number; basis: string; confidence: 'low' | 'medium' | 'high'; assumptions?: string[]; would_change?: string; approved_seconds?: number; sent_seconds?: number } | null
  receipt_url?: string | null
  failure_reason?: string | null
}

export interface DeliveryView { id?: string; target: DeliveryTarget; state: 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'skipped'; error_code?: string | null; updated_at?: string }

/** Fila de la lista de entregas. `deliveries` y `decision` quedan sin definir mientras `GET …/schedules/runs` no los incluya. */
export interface RunListItem {
  run_id: string
  schedule_id: string
  artifact_kind: 'notice' | 'brief' | 'close' | 'status' | 'report' | null
  title: string
  project_id: string | null
  scheduled_for: string
  started_at: string | null
  state: RunState
  trigger: 'clock' | 'misfire' | 'run_now'
  skip_reason: string | null
  deferred_reason: string | null
  read_at: string | null
  deliveries?: DeliveryView[]
  decision?: DecisionSummary
}

/** Resumen público de la decisión de un run, derivado de los estados de sus ítems. */
export interface DecisionSummary { state: 'none' | 'pending' | 'dispatching' | 'uncertain' | 'expired' | 'done'; expires_at: string | null; approved: number; total: number }

/** Detalle de una entrega: artefacto markdown, ítems públicos con su estado y entregas por canal. */
export interface RunDetail extends RunListItem {
  body_md: string
  items: PublicItem[]
  /** Hay ítems accionables, por lo que existe una solicitud de decisión que consultar. */
  has_decision: boolean
  incidents?: { cause: string; action: string; observed_at: string }[]
}

interface RawRun {
  id: string; schedule_id: string; scheduled_for: string; trigger: RunListItem['trigger']; state: RunState; skip_reason?: string | null; deferred_reason?: string | null
  started_at?: string | null; finished_at?: string | null
}
export interface RawRunListItem extends RawRun {
  schedule_title?: string | null; project_id?: string | null; artifact_kind?: RunListItem['artifact_kind']; title?: string | null; read_at?: string | null
  deliveries?: DeliveryView[]; decision?: DecisionSummary
}
/** Fila de `hour_estimates` tal como la entrega el detalle del run. */
interface RawEstimate { estimated_seconds: number | null; basis: string | null; confidence: 'low' | 'medium' | 'high' | null; assumptions: unknown; approved_seconds?: number | null; sent_seconds?: number | null }
type RawArtifactItem = Omit<PublicItem, 'state' | 'estimate'> & { estimate?: RawEstimate }
export interface RawRunDetail {
  run: RawRun
  project_id?: string | null
  decision?: DecisionSummary
  artifact: { id: string; kind: NonNullable<RunListItem['artifact_kind']>; title: string; body_md: string; items: RawArtifactItem[]; read_at: string | null } | null
  items: { ordinal: number; kind: ItemKind; state: ItemState; estimate_id?: string | null }[]
  deliveries: DeliveryView[]
  incidents?: RunDetail['incidents']
}

export function normalizeRunList(raw: { items: RawRunListItem[] } & Page): { items: RunListItem[] } & Page {
  return { ...raw, items: raw.items.map(item => ({
    run_id: item.id, schedule_id: item.schedule_id, artifact_kind: item.artifact_kind ?? null, title: item.title ?? item.schedule_title ?? 'Entrega', project_id: item.project_id ?? null,
    scheduled_for: item.scheduled_for, started_at: item.started_at ?? null, state: item.state, trigger: item.trigger, skip_reason: item.skip_reason ?? null, deferred_reason: item.deferred_reason ?? null,
    read_at: item.read_at ?? null, ...(item.deliveries ? { deliveries: item.deliveries } : {}), ...(item.decision ? { decision: item.decision } : {}),
  })) }
}

function normalizeEstimate(raw: RawEstimate | undefined): PublicItem['estimate'] {
  if (!raw || typeof raw.estimated_seconds !== 'number' || !raw.basis || !raw.confidence) return undefined
  const assumptions = Array.isArray(raw.assumptions) ? raw.assumptions.filter((entry): entry is string => typeof entry === 'string') : []
  return { seconds: raw.estimated_seconds, basis: raw.basis, confidence: raw.confidence, ...(assumptions.length ? { assumptions } : {}),
    ...(typeof raw.approved_seconds === 'number' ? { approved_seconds: raw.approved_seconds } : {}), ...(typeof raw.sent_seconds === 'number' ? { sent_seconds: raw.sent_seconds } : {}) }
}

export function normalizeRunDetail(raw: RawRunDetail): RunDetail {
  const states = new Map(raw.items.map(item => [item.ordinal, item.state]))
  const items: PublicItem[] = (raw.artifact?.items ?? []).map(({ estimate, ...item }) => { const parts = normalizeEstimate(estimate); return { ...item, state: states.get(item.ordinal) ?? 'proposed', ...(parts ? { estimate: parts } : {}) } })
  return {
    run_id: raw.run.id, schedule_id: raw.run.schedule_id, artifact_kind: raw.artifact?.kind ?? null, title: raw.artifact?.title ?? 'Entrega', project_id: raw.project_id ?? null,
    scheduled_for: raw.run.scheduled_for, started_at: raw.run.started_at ?? null, state: raw.run.state, trigger: raw.run.trigger, skip_reason: raw.run.skip_reason ?? null, deferred_reason: raw.run.deferred_reason ?? null,
    read_at: raw.artifact?.read_at ?? null, deliveries: raw.deliveries, ...(raw.decision ? { decision: raw.decision } : {}), body_md: raw.artifact?.body_md ?? '', items,
    has_decision: (raw.decision?.total ?? 0) > 0 || items.some(item => item.kind !== 'info'),
    ...(raw.incidents ? { incidents: raw.incidents } : {}),
  }
}

export interface AutomationSettings {
  automations_enabled: boolean
  notify_schedule_created: boolean
  notify_delivery: boolean
  workday_hours: number
  keep_awake: boolean
}

export interface JiraServerOption {
  id: string
  name: string
  usable: boolean
}

export interface JiraServerSetting {
  selected: string | null
  servers: JiraServerOption[]
}

export const automationKeys = {
  settings: ['automations'] as const,
  jiraServer: ['automations', 'jira-server'] as const,
  schedules: ['schedules'] as const,
  runs: (filters: Record<string, string | undefined> = {}) => ['schedule-runs', filters] as const,
  run: (id: string) => ['schedule-run', id] as const,
}

export function useAutomationSettings() {
  return useQuery({ queryKey: automationKeys.settings, queryFn: () => api.get<AutomationSettings>('/automations') })
}

export function useSaveAutomationSettings() {
  const cache = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (patch: Partial<AutomationSettings>) => api.put<AutomationSettings>('/automations', patch),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: automationKeys.settings }) },
    onError: error => toast.error('No se pudo guardar', error.message),
  })
}

export function useSchedules() {
  return useQuery({ queryKey: automationKeys.schedules, queryFn: () => api.get<{ items: ScheduleView[]; delivery_available?: DeliveryAvailability } & Page>('/memory/schedules?limit=200'), refetchInterval: 5000 })
}

/** Mutaciones humanas sobre un schedule; todas devuelven el ScheduleView actualizado salvo `run_now` (`{ run_id }`). */
export function useScheduleActions() {
  const cache = useQueryClient()
  const toast = useToast()
  const refresh = async (): Promise<void> => { await cache.invalidateQueries({ queryKey: automationKeys.schedules }) }
  const base = (id: string): string => `/memory/schedules/${encodeURIComponent(id)}`
  const onError = (error: Error): void => { toast.error(error.message.includes('stale_revision') ? 'La automatización cambió mientras la editabas' : 'No se pudo completar la acción', error.message) }
  const make = <V,>(call: (vars: V) => Promise<unknown>) => ({ mutationFn: call, onSuccess: refresh, onError })
  return {
    pause: useMutation(make(({ id, revision }: { id: string; revision: number }) => api.post(`${base(id)}/pause`, { expected_revision: revision }))),
    resume: useMutation(make(({ id, revision }: { id: string; revision: number }) => api.post(`${base(id)}/resume`, { expected_revision: revision }))),
    runNow: useMutation(make(({ id }: { id: string }) => api.post<{ run_id: string }>(`${base(id)}/run_now`, {}))),
    reschedule: useMutation(make(({ id, revision, recurrence }: { id: string; revision: number; recurrence: Recurrence }) => api.put(`${base(id)}/recurrence`, { expected_revision: revision, recurrence }))),
    delivery: useMutation(make(({ id, revision, delivery }: { id: string; revision: number; delivery: DeliveryTarget[] }) => api.put(`${base(id)}/delivery`, { expected_revision: revision, delivery }))),
    cancel: useMutation(make(({ id, revision }: { id: string; revision: number }) => api.post(`${base(id)}/cancel`, { expected_revision: revision }))),
  }
}

export function useRuns(filters: { kind?: string; project_id?: string; unread?: 'true' | 'false'; limit?: string } = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value)
  const query = params.toString()
  return useQuery({ queryKey: automationKeys.runs(filters), queryFn: async () => normalizeRunList(await api.get<{ items: RawRunListItem[] } & Page>(`/memory/schedules/runs${query ? `?${query}` : ''}`)), refetchInterval: 5000 })
}

export function useRun(runId: string) {
  return useQuery({ queryKey: automationKeys.run(runId), queryFn: async () => normalizeRunDetail(await api.get<RawRunDetail>(`/memory/schedules/runs/${encodeURIComponent(runId)}`)), refetchInterval: 5000 })
}

/** Estado de la solicitud de decisión de una entrega (`GET …/runs/:runId/decision`). Nunca trae el código de aprobación: ese viaja solo por el canal. */
export interface DecisionView {
  request_id: string
  revision: number
  state: RequestState
  expires_at: string | null
  /** Digest exacto que se envía al aprobar. */
  digest: string
  authority: 'verified' | 'authority_unavailable'
  items: { ordinal: number; kind: ItemKind; summary: string; state: StoreItemState; effect_digest: string }[]
}

/** Estados de la solicitud y de sus ítems en el almacén de decisiones; los de los ítems no son los estados públicos del run. */
export type RequestState = 'open' | 'locked' | 'expired' | 'revoked' | 'superseded' | 'closed'
export type StoreItemState = 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked' | 'superseded' | 'blocked_uncertain'
export const STORE_ITEM_TO_PUBLIC: Record<StoreItemState, ItemState> = { pending: 'proposed', approved: 'approved', rejected: 'rejected', expired: 'expired', revoked: 'superseded', superseded: 'superseded', blocked_uncertain: 'uncertain' }

export interface DecisionResult {
  request_id: string
  revision: number
  state: RequestState
  approved?: number[]
  rejected?: number[]
  blocked_uncertain?: number[]
  digest?: string
  items: { ordinal: number; kind: ItemKind; summary: string; state: StoreItemState }[]
}

/** Motivo legible de los errores cerrados de la aprobación. */
export const DECISION_ERRORS: Record<string, string> = {
  digest_mismatch: 'La propuesta cambió; revisa los ítems y vuelve a aprobar.',
  expired: 'La solicitud venció. Puedes volver a proponerla.',
  revoked: 'La solicitud fue revocada.',
  superseded: 'Hay una revisión más nueva de esta propuesta.',
  locked: 'La solicitud está bloqueada por demasiados intentos fallidos.',
  authority_unavailable: 'No se puede verificar la autoridad de esta solicitud (por ejemplo, tras restaurar un respaldo).',
  bad_selection: 'La selección no es válida.',
}

export function useDecision(runId: string, enabled: boolean) {
  return useQuery({ queryKey: [...automationKeys.run(runId), 'decision'], queryFn: () => api.get<DecisionView>(`/memory/schedules/runs/${encodeURIComponent(runId)}/decision`), enabled, retry: false })
}

export function useDecisionActions(runId: string) {
  const cache = useQueryClient()
  const toast = useToast()
  const base = `/memory/schedules/runs/${encodeURIComponent(runId)}`
  const refresh = async (): Promise<void> => { await Promise.all([cache.invalidateQueries({ queryKey: automationKeys.run(runId) }), cache.invalidateQueries({ queryKey: ['schedule-runs'] })]) }
  const onError = (error: Error): void => { toast.error('No se pudo registrar la decisión', error instanceof ApiError && error.code && DECISION_ERRORS[error.code] ? DECISION_ERRORS[error.code]! : error.message) }
  return {
    approve: useMutation({ mutationFn: (vars: { ordinals: number[]; digest: string }) => api.post<DecisionResult>(`${base}/approve`, vars), onSuccess: refresh, onError }),
    reject: useMutation({ mutationFn: (vars: { ordinals: number[] }) => api.post<DecisionResult>(`${base}/reject`, vars), onSuccess: refresh, onError }),
    revise: useMutation({ mutationFn: (vars: { ordinal: number; seconds: number }) => api.post<DecisionResult>(`${base}/revise`, vars), onSuccess: refresh, onError }),
    repropose: useMutation({ mutationFn: () => api.post(`${base}/repropose`, {}), onSuccess: refresh, onError }),
  }
}

export function useReconcile() {
  const cache = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (intentId: string) => api.post<{ intent_id: string; state: string; remote_ref?: string }>(`/memory/schedules/actions/${encodeURIComponent(intentId)}/reconcile`, {}),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: ['schedule-run'] }) },
    onError: error => { toast.error('No se pudo reconciliar', error.message) },
  })
}

export interface DeliveryChannel { channel: 'app' | 'gmail' | 'slack'; available: boolean; reason?: 'not_connected' | 'scope_missing' | 'identity_unverified' | 'identity_is_bot' | 'tool_off'; destination?: string }
export const CHANNEL_REASONS: Record<string, string> = {
  not_connected: 'No está conectado',
  scope_missing: 'Falta autorizar el envío',
  identity_unverified: 'No se pudo verificar la identidad',
  identity_is_bot: 'La integración es un bot, no tu usuario',
  tool_off: 'La herramienta de envío está apagada',
}
export function useDeliveryChannels() {
  // La autorización de Gmail termina en el navegador externo, y una ventana que sigue visible no emite `visibilitychange`: mientras falte, se relee.
  return useQuery({ queryKey: ['delivery-channels'], queryFn: () => api.get<{ items: DeliveryChannel[] }>('/memory/schedules/delivery-channels'), refetchOnWindowFocus: true,
    refetchInterval: query => query.state.data?.items.some(item => item.reason === 'scope_missing') ? 5000 : false })
}

export interface RetryResult { delivery_id: string; state: DeliveryView['state']; error_code?: string; may_duplicate: boolean }
const RETRY_ERRORS: Record<string, string> = {
  not_retryable: 'Esta entrega ya no se puede reintentar.',
  automations_off: 'Las automatizaciones están desactivadas en Ajustes.',
  delivery_not_found: 'La entrega ya no existe.',
}

/** Reintento humano de una entrega fallida o incierta (`POST …/deliveries/:id/retry`); una incierta pudo haber llegado ya. */
export function useRetryDelivery(runId: string) {
  const cache = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (deliveryId: string) => api.post<RetryResult>(`/memory/schedules/deliveries/${encodeURIComponent(deliveryId)}/retry`, {}),
    onSuccess: async result => {
      await Promise.all([cache.invalidateQueries({ queryKey: automationKeys.run(runId) }), cache.invalidateQueries({ queryKey: ['schedule-runs'] })])
      if (result.state === 'sent') toast.success('Entrega reenviada', result.may_duplicate ? 'Puede haber llegado dos veces.' : undefined)
      else toast.info('El reintento no terminó', `Estado: ${result.state}${result.error_code ? ` (${result.error_code})` : ''}.`)
    },
    onError: error => { toast.error('No se pudo reintentar', error instanceof ApiError && error.code && RETRY_ERRORS[error.code] ? RETRY_ERRORS[error.code]! : error.message) },
  })
}

/** Servidor de Jira (`jira.server_id`) con el que el cierre escribe horas, transiciones y comentarios. */
export function useJiraServer() {
  return useQuery({ queryKey: automationKeys.jiraServer, queryFn: () => api.get<JiraServerSetting>('/automations/jira-server') })
}

export function useSaveJiraServer() {
  const cache = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (serverId: string | null) => api.put<unknown>('/automations/jira-server', { server_id: serverId }),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: automationKeys.jiraServer }) },
    onError: error => toast.error('No se pudo guardar', error.message),
  })
}
