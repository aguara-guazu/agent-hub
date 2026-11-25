/**
 * Reuniones próximas sin transcripción que el core publica en `GET /api/memory/recordings/upcoming`.
 *
 * El módulo es puro: decide cuándo una reunión se ofrece para grabar y cuándo se avisa. Nada de esto inicia una
 * grabación; sólo la persona lo hace al aceptar la oferta.
 */

export interface UpcomingAttendee { email?: string; name?: string; self?: boolean; response?: string }

export interface UpcomingEvent {
  key: string
  connector_id: string
  calendar: string
  event_id: string
  title: string
  start: string | null
  end: string | null
  platform: string | null
  attendees: UpcomingAttendee[]
}

export interface OfferSettings { enabled: boolean; notify: boolean; lead_minutes: number }
export interface UpcomingResponse { settings?: Partial<OfferSettings>; events?: UpcomingEvent[]; verifiedCalendars?: Pick<UpcomingEvent, "connector_id" | "calendar">[] }

/** Tiempo después del inicio durante el cual una reunión todavía se ofrece: llegar tarde es lo habitual. */
export const OFFER_LATE_MS = 15 * 60_000

export class RecordingOffers {
  private events = new Map<string, UpcomingEvent>()
  private settings: OfferSettings = { enabled: false, notify: true, lead_minutes: 2 }
  private readonly announced = new Set<string>()
  private readonly dismissed = new Set<string>()
  private readonly accepted = new Set<string>()
  private verified: NonNullable<UpcomingResponse["verifiedCalendars"]> = []

  get enabled(): boolean { return this.settings.enabled }

  setEnabled(enabled: boolean): void {
    this.settings.enabled = enabled
    if (!enabled) { this.events.clear(); this.verified = [] }
  }

  update(response: UpcomingResponse): void {
    this.setEnabled(response.settings?.enabled ?? true)
    if (!this.enabled) return
    this.settings.notify = response.settings?.notify ?? true
    this.settings.lead_minutes = response.settings?.lead_minutes ?? 2
    this.events = new Map((response.events ?? []).filter(event => event.start).map(event => [event.key, event]))
    this.verified = response.verifiedCalendars ?? []
  }

  get(key: string): UpcomingEvent | undefined {
    return this.events.get(key)
  }

  verifiedCalendar(event: UpcomingEvent): boolean {
    return this.verified.some(source => source.connector_id === event.connector_id && source.calendar === event.calendar)
  }

  /** Match the instant recording started, even if the calendar arrived later or the opening offer expired. */
  matchAt(started: number): UpcomingEvent[] {
    const active: UpcomingEvent[] = [], upcoming: UpcomingEvent[] = []
    for (const event of this.events.values()) {
      const start = Date.parse(event.start ?? ""), end = Date.parse(event.end ?? "")
      if (this.dismissed.has(event.key) || !(start < end && started < end)) continue
      if (start <= started) active.push(event)
      else if (start - started <= this.settings.lead_minutes * 60_000) upcoming.push(event)
    }
    return [...active, ...upcoming]
  }

  /** Ofertas vigentes en `now`: desde `lead_minutes` antes del inicio hasta `OFFER_LATE_MS` después, sin pasar el fin. */
  open(now: number): UpcomingEvent[] {
    return [...this.events.values()].filter(event => {
      if (this.dismissed.has(event.key) || this.accepted.has(event.key)) return false
      const start = Date.parse(event.start!), end = event.end ? Date.parse(event.end) : Infinity
      return now >= start - this.settings.lead_minutes * 60_000 && now <= Math.min(start + OFFER_LATE_MS, end)
    })
  }

  /** Ofertas vigentes que todavía no se avisaron; cada una se entrega una sola vez. Con los avisos apagados no entrega ninguna. */
  due(now: number): UpcomingEvent[] {
    if (!this.settings.notify) return []
    const fresh = this.open(now).filter(event => !this.announced.has(event.key))
    for (const event of fresh) this.announced.add(event.key)
    return fresh
  }

  dismiss(key: string): void {
    this.dismissed.add(key)
  }

  accept(key: string): void { this.accepted.add(key) }
}
