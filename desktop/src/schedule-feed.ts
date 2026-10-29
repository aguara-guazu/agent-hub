/**
 * Consumo del feed de eventos del scheduler que publica el core (`GET /api/memory/schedules/feed`).
 *
 * Tres piezas puras e inyectables:
 *  - `FeedPoller` lleva el cursor y entrega los eventos nuevos y los runs activos;
 *  - `ScheduleNoticeBatcher` agrupa los cambios de schedules hechos por un agente en una sola notificación;
 *  - `deliveryNotice` arma el aviso de una entrega lista.
 * Las formas de `FeedEvent` y `FeedResponse` siguen el contrato del scheduler y se alinean con `schedule-contract.ts`.
 */

import { t } from "./i18n.js"

export interface FeedEvent {
  seq: number
  type: string
  actor_kind: 'agent' | 'human' | 'system'
  schedule_id: string | null
  run_id: string | null
  /** El core envía `null` cuando el evento no trae título. */
  title: string | null
  project_id: string | null
  /** Presente en `run.persisted`. */
  artifact_kind?: string
}

export interface ActiveRun {
  run_id: string
  phase: string
  deadline_at?: string | null
}

export interface FeedResponse {
  events: FeedEvent[]
  /** Mayor `seq` visto por el core al responder; sin `after` es el punto de partida y `events` viene vacío. */
  cursor: number
  active_runs?: ActiveRun[]
}

export interface Notice {
  title: string
  body: string
  /** Ruta de la consola que abre el clic (ver `navigation.ts`). */
  route: string
}

export interface FeedPollerDeps {
  fetchFeed(after: number | null): Promise<FeedResponse>
  onEvents(events: FeedEvent[]): void
  onActiveRuns(runs: ActiveRun[]): void
}

export class FeedPoller {
  private cursor: number | null = null

  constructor(private readonly deps: FeedPollerDeps) {}

  /** Una vuelta; los errores de red los absorbe quien llama (el próximo ciclo reintenta con el mismo cursor). */
  async poll(): Promise<void> {
    const response = await this.deps.fetchFeed(this.cursor)
    const fresh = this.cursor === null ? [] : response.events.filter(event => event.seq > this.cursor!)
    this.cursor = Math.max(this.cursor ?? 0, response.cursor, ...response.events.map(event => event.seq))
    if (fresh.length) this.deps.onEvents(fresh)
    this.deps.onActiveRuns(response.active_runs ?? [])
  }
}

const SCHEDULE_CHANGES: Record<string, 'created' | 'updated' | 'cancelled'> = {
  'schedule.created': 'created',
  'schedule.updated': 'updated',
  'schedule.cancelled': 'cancelled',
}

/** Aviso de una entrega lista (`run.persisted` de un brief o un cierre); `null` para cualquier otro evento. */
export function deliveryNotice(event: FeedEvent): Notice | null {
  if (event.type !== 'run.persisted' || !event.run_id) return null
  if (event.artifact_kind !== 'brief' && event.artifact_kind !== 'close') return null
  return { title: t(event.artifact_kind === "close" ? "schedules.closeReady" : "schedules.briefReady"), body: event.title ?? t("schedules.openDelivery"), route: `/deliveries/${event.run_id}` }
}

function describeChanges(changes: { kind: 'created' | 'updated' | 'cancelled'; event: FeedEvent }[]): Notice {
  const [first] = changes
  const named = (event: FeedEvent): string => event.title ?? t("schedules.unnamed")
  if (changes.length === 1 && first) {
    const { kind, event } = first
    const route = event.schedule_id ? `/schedules?focus=${event.schedule_id}` : "/schedules"
    if (kind === "created") return { title: t("schedules.created", { name: named(event) }), body: t("schedules.createdBody"), route }
    if (kind === "updated") return { title: t("schedules.updated", { name: named(event) }), body: t("schedules.updatedBody"), route }
    return { title: t("schedules.cancelled", { name: named(event) }), body: t("schedules.cancelledBody"), route }
  }
  const kinds = new Set(changes.map(change => change.kind))
  const key = kinds.size > 1 ? "schedules.batchUpdated" : kinds.has("created") ? "schedules.batchCreated" : kinds.has("cancelled") ? "schedules.batchCancelled" : "schedules.batchUpdated"
  return { title: t(key, { count: changes.length }), body: t("schedules.batchBody"), route: "/schedules" }
}

export interface NoticeBatcherDeps {
  setTimer(callback: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  emit(notice: Notice): void
  /** Ventana de agrupación desde el primer cambio. */
  windowMs: number
}

/** Agrupa los cambios de schedules hechos por un agente: una sola notificación por ventana. */
export class ScheduleNoticeBatcher {
  private buffer: { kind: 'created' | 'updated' | 'cancelled'; event: FeedEvent }[] = []
  private timer: unknown = null

  constructor(private readonly deps: NoticeBatcherDeps) {}

  /** Sólo cuentan los cambios de un agente; las ediciones humanas y del sistema no notifican. */
  add(events: readonly FeedEvent[]): void {
    for (const event of events) {
      const kind = SCHEDULE_CHANGES[event.type]
      if (kind && event.actor_kind === 'agent') this.buffer.push({ kind, event })
    }
    if (this.buffer.length && this.timer === null) this.timer = this.deps.setTimer(() => this.flush(), this.deps.windowMs)
  }

  flush(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
    if (!this.buffer.length) return
    const batch = this.buffer
    this.buffer = []
    this.deps.emit(describeChanges(batch))
  }

  dispose(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
    this.buffer = []
  }
}
