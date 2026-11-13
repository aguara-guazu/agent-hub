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

export interface OfferSettings { notify: boolean; lead_minutes: number }
export interface UpcomingResponse { settings?: Partial<OfferSettings>; events?: UpcomingEvent[] }

/** Tiempo después del inicio durante el cual una reunión todavía se ofrece: llegar tarde es lo habitual. */
export const OFFER_LATE_MS = 15 * 60_000

export class RecordingOffers {
  private events = new Map<string, UpcomingEvent>()
  private settings: OfferSettings = { notify: true, lead_minutes: 2 }
  private readonly announced = new Set<string>()
  private readonly dismissed = new Set<string>()

  update(response: UpcomingResponse): void {
    this.settings = { notify: response.settings?.notify ?? true, lead_minutes: response.settings?.lead_minutes ?? 2 }
    this.events = new Map((response.events ?? []).filter(event => event.start).map(event => [event.key, event]))
  }

  get(key: string): UpcomingEvent | undefined {
    return this.events.get(key)
  }

  /** Ofertas vigentes en `now`: desde `lead_minutes` antes del inicio hasta `OFFER_LATE_MS` después, sin pasar el fin. */
  open(now: number): UpcomingEvent[] {
    return [...this.events.values()].filter(event => {
      if (this.dismissed.has(event.key)) return false
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
}
