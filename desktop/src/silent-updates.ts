import { CHECK_INTERVAL_MS, type UpdateStatus } from './updater.js'

const TRIGGER_MIN_INTERVAL_MS = 60_000
/** La compuerta de core se reevalúa cada 15 s mientras la actualización está pospuesta. */
const GATE_RETRY_MS = 15_000

type Downloaded = Extract<UpdateStatus, { state: 'downloaded' }>
interface Dependencies {
  check(): Promise<UpdateStatus>
  /** false means installation must wait for active client connections. */
  apply(update: Downloaded): Promise<boolean>
  log(message: string): void
  /** Interruptor de Ajustes; apagado, no se consulta ni se aplica nada. */
  enabled?(): boolean
}

/** No UI dependency: background updates never ask for input or activate a window. */
export class SilentUpdates {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | null = null
  private pending: Downloaded | null = null
  private stopped = false
  private failures = 0
  private lastTrigger = 0
  constructor(private readonly deps: Dependencies) {}
  start() { void this.run() }
  stop() { this.stopped = true; clearTimeout(this.timer) }
  /**
   * Adelanta una verificación (por ejemplo, un par con una versión más nueva). Sólo adelanta: la
   * descarga se valida contra GitHub como siempre. Máximo una por minuto.
   */
  trigger(reason: string): void {
    const now = Date.now()
    if (this.stopped || this.running || now - this.lastTrigger < TRIGGER_MIN_INTERVAL_MS) return
    this.lastTrigger = now
    this.deps.log(`verificación anticipada (${reason})`)
    void this.run()
  }
  run(): Promise<void> {
    if (this.running) return this.running
    if (this.stopped) return Promise.resolve()
    clearTimeout(this.timer)
    this.running = this.update().finally(() => { this.running = null })
    return this.running
  }
  private schedule(delay: number) {
    if (this.stopped) return
    this.timer = setTimeout(() => { void this.run() }, delay)
    this.timer.unref()
  }
  private async update() {
    try {
      if (this.deps.enabled && !this.deps.enabled()) { this.pending = null; return }
      if (!this.pending) {
        const status = await this.deps.check()
        if (this.stopped) return
        if (status.state === 'failed') throw new Error(status.error)
        if (status.state === 'disabled') return
        if (status.state !== 'downloaded') {
          if (status.state === 'available') this.deps.log(`v${status.version}: este formato requiere instalación externa`)
          this.failures = 0; this.schedule(CHECK_INTERVAL_MS); return
        }
        this.pending = status
      }
      if (this.stopped) return
      // Keep the download while waiting for Windows MCP bridges to finish.
      if (!await this.deps.apply(this.pending)) { this.schedule(GATE_RETRY_MS); return }
      this.pending = null; this.failures = 0
    } catch (error) {
      this.pending = null
      this.deps.log(error instanceof Error ? error.message : String(error))
      this.schedule(Math.min(15 * 60_000, 60_000 * 2 ** Math.min(this.failures++, 4)))
    }
  }
}

export function hiddenUpdateLaunch(args: string[]) { return args.includes('--hidden') || args.includes('--updated') }
export function updateRelaunchArgs(args: string[]) { return [...args.filter(a => a !== '--hidden' && a !== '--updated'), '--hidden', '--updated'] }
