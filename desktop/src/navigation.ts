/**
 * Navegación pedida por el proceso principal (clic en una notificación, tray).
 *
 * El renderer sólo acepta rutas de esta lista blanca: el proceso principal nunca
 * le pasa una ruta arbitraria ni una URL. Si el renderer todavía no escucha
 * (la ventana se está cargando o recargando por un reinicio del core), la ruta
 * queda pendiente y se entrega cuando el renderer se declara listo.
 */

const ROUTE_PATTERNS: readonly RegExp[] = [
  /^\/deliveries$/,
  /^\/deliveries\/[A-Za-z0-9_-]{1,80}$/,
  /^\/schedules(\?focus=[A-Za-z0-9_-]{1,80})?$/,
  /^\/settings$/,
]

/** Devuelve la ruta si está permitida; cualquier otra cosa (incluidas URLs, fragmentos y consultas distintas de `focus`) da `null`. */
export function allowedRoute(input: unknown): string | null {
  if (typeof input !== 'string') return null
  return ROUTE_PATTERNS.some(pattern => pattern.test(input)) ? input : null
}

export class NavigationRelay {
  private listening = false
  private pending: string | null = null

  constructor(private readonly send: (route: string) => void) {}

  /** `false` si la ruta no está permitida. Sólo se conserva la última ruta pendiente. */
  request(route: unknown): boolean {
    const allowed = allowedRoute(route)
    if (!allowed) return false
    if (this.listening) this.send(allowed)
    else this.pending = allowed
    return true
  }

  /** El renderer ya escucha: devuelve la ruta que quedó pendiente, si la hay. */
  attach(): string | null {
    this.listening = true
    const route = this.pending
    this.pending = null
    return route
  }

  /** La página se recarga: hasta que el renderer vuelva a declararse listo, las rutas quedan pendientes. */
  detach(): void {
    this.listening = false
  }
}
