/**
 * Despertar del reloj del scheduler a partir de los eventos de energía y de pantalla.
 *
 * `resume` (salida de suspensión) y `unlock-screen` suelen llegar juntos y a veces antes de que vuelva la red,
 * así que se agrupan en un solo aviso con una espera corta. Los efectos se inyectan para probarlo sin Electron.
 */

export interface ClockWakeDeps {
  /** Pide al core que reevalúe lo vencido (misfire incluido). Los errores los absorbe quien llama. */
  wake(): Promise<void>
  setTimer(callback: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** Espera tras el último evento antes de avisar. */
  settleMs: number
}

export class ClockWake {
  private timer: unknown = null

  constructor(private readonly deps: ClockWakeDeps) {}

  /** Cada evento reinicia la espera: una ráfaga produce un único aviso. */
  trigger(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = this.deps.setTimer(() => {
      this.timer = null
      void this.deps.wake().catch(() => undefined)
    }, this.deps.settleMs)
  }

  dispose(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
  }
}
