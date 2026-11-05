/**
 * Escucha de pistas de actualización de otros hubs: un long-poll a core, una sola solicitud a la vez.
 * Reabre de inmediato tras un 204; ante errores espera con backoff y jitter (1 s a 30 s). Sin Electron.
 */
const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000
/** Una pista repetida no debe convertirse en un bucle apretado. */
const AFTER_HINT_MS = 1_000

export interface UpdateHintDeps {
  /** Abre una solicitud a `update-hint` con la consulta indicada; core la mantiene hasta ~25 s. Se aborta con la señal. */
  open: (signal: AbortSignal, query: string) => Promise<Response>
  /** Hay una pista nueva (otro hub anunció algo): sólo adelanta la verificación contra GitHub, no trae versión ni URL. */
  onHint: () => void
  /** `false` mientras core no está listo o la app se apaga: no se abren solicitudes. */
  ready: () => boolean
  random?: () => number
}

export class UpdateHintListener {
  private controller: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = true
  private failures = 0
  /** Última generación de pistas vista; las pistas anteriores a ella no se repiten. `null` hasta la lectura inicial. */
  private after: number | null = null

  constructor(private readonly deps: UpdateHintDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.loop()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.controller?.abort()
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = setTimeout(resolve, ms)
      this.timer.unref()
    })
  }

  private backoff(): number {
    const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(this.failures++, 5))
    return Math.round(base / 2 + (this.deps.random ?? Math.random)() * (base / 2))
  }

  /** Contrato con core: lectura inicial sin esperar (`wait=0`), luego `after=<generación>&wait=25000` en bucle. */
  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (!this.deps.ready()) { await this.wait(BASE_DELAY_MS * 2); continue }
      const controller = new AbortController()
      this.controller = controller
      const initial = this.after === null
      try {
        const response = await this.deps.open(controller.signal, initial ? "wait=0" : `after=${this.after}&wait=25000`)
        if (response.status === 204) {
          await response.body?.cancel().catch(() => undefined)
          this.failures = 0
          if (initial) this.after = 0
          continue
        }
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); await this.wait(this.backoff()); continue }
        this.failures = 0
        const body = await response.json().catch(() => null) as { generation?: unknown } | null
        const generation = body?.generation
        if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) { await this.wait(this.backoff()); continue }
        const previous = this.after
        this.after = generation
        // La lectura inicial sólo fija el punto de partida: una pista anterior al arranque no dispara nada.
        if (!initial && generation > (previous ?? 0)) this.deps.onHint()
        await this.wait(AFTER_HINT_MS)
      } catch {
        if (this.stopped) return
        await this.wait(this.backoff())
      } finally {
        if (this.controller === controller) this.controller = null
      }
    }
  }
}
