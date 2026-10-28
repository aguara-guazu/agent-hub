import type { FeedEvent } from './schedule-feed.js'

/**
 * Oferta única de «Iniciar al ingresar» cuando aparece la primera automatización.
 *
 * El reloj del scheduler sólo corre con la app abierta, así que sin autostart el brief de la mañana no sale si la
 * persona no abrió Agent Hub. La oferta se muestra una sola vez (acepte o no) y nunca si el inicio automático ya está activo.
 */

export interface AutostartOfferDeps {
  isEnabled(): boolean
  setEnabled(enabled: boolean): void
  wasOffered(): boolean
  markOffered(): void
  /** Muestra la pregunta; `true` si la persona aceptó. */
  ask(): Promise<boolean>
}

export class AutostartOffer {
  private asking = false

  constructor(private readonly deps: AutostartOfferDeps) {}

  /** Considera los eventos nuevos del feed; ofrece sólo ante un `schedule.created` (de cualquier autor). */
  async consider(events: readonly FeedEvent[]): Promise<void> {
    if (this.asking || !events.some(event => event.type === 'schedule.created')) return
    if (this.deps.wasOffered() || this.deps.isEnabled()) return
    this.asking = true
    try {
      this.deps.markOffered()
      if (await this.deps.ask()) this.deps.setEnabled(true)
    } finally {
      this.asking = false
    }
  }
}
