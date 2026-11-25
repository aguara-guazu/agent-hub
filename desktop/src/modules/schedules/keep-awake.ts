/**
 * Mantiene la computadora despierta mientras hay trabajo programado en curso.
 *
 * Usa un único `powerSaveBlocker('prevent-app-suspension')`: evita el sueño por inactividad y deja que
 * la pantalla se apague. No cubre el cierre de la tapa de un portátil, que el sistema trata como sueño
 * forzado (Apple QA1340: «it is not possible to prevent forced sleep, only delay it»).
 *
 * Cada razón (un run en curso) tiene su propio tope de tiempo: si el core deja de informar o muere sin
 * liberar, el bloqueo no queda activo para siempre. Los efectos se inyectan para poder probarlo sin Electron.
 */

export interface PowerBlocker {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
}

export interface KeepAwakeDeps {
  blocker: PowerBlocker
  setTimer(callback: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** Tope por defecto de cada razón. */
  maxHoldMs: number
}

export class KeepAwake {
  private readonly reasons = new Map<string, unknown>()
  /** Razones cuyo tope venció mientras el core aún las lista: `sync` no las vuelve a tomar. */
  private readonly expired = new Set<string>()
  private blockerId: number | null = null

  constructor(private readonly deps: KeepAwakeDeps) {}

  get active(): boolean {
    return this.blockerId !== null
  }

  /** Registra o renueva una razón; con el mismo `reason` el tope se reinicia. */
  hold(reason: string, maxMs: number = this.deps.maxHoldMs): void {
    const previous = this.reasons.get(reason)
    if (previous !== undefined) this.deps.clearTimer(previous)
    this.reasons.set(reason, this.deps.setTimer(() => { this.expired.add(reason); this.release(reason) }, maxMs))
    if (this.blockerId === null) this.blockerId = this.deps.blocker.start('prevent-app-suspension')
  }

  release(reason: string): void {
    const handle = this.reasons.get(reason)
    if (handle === undefined) return
    this.deps.clearTimer(handle)
    this.reasons.delete(reason)
    if (this.reasons.size === 0 && this.blockerId !== null) {
      this.deps.blocker.stop(this.blockerId)
      this.blockerId = null
    }
  }

  /**
   * Alinea las razones con la lista vigente del core: libera las que ya no están y toma las nuevas.
   * Una razón que sigue no renueva su tope, así un run que el core nunca cierra no mantiene la Mac despierta sin límite.
   */
  sync(current: readonly (string | { reason: string; maxMs?: number })[]): void {
    const limits = new Map(current.map(entry => typeof entry === 'string' ? [entry, undefined] as const : [entry.reason, entry.maxMs] as const))
    for (const reason of [...this.reasons.keys()]) if (!limits.has(reason)) this.release(reason)
    for (const reason of [...this.expired]) if (!limits.has(reason)) this.expired.delete(reason)
    for (const [reason, maxMs] of limits) if (!this.reasons.has(reason) && !this.expired.has(reason)) this.hold(reason, maxMs)
  }

  dispose(): void {
    for (const reason of [...this.reasons.keys()]) this.release(reason)
    this.expired.clear()
  }
}

/**
 * Tope de una razón a partir del `deadline_at` que informa el core: el run no puede seguir vivo después de su plazo, así que
 * el bloqueo dura hasta el plazo más un margen. Sin plazo válido rige `fallbackMs`.
 */
export function holdLimitFor(deadlineAt: string | null | undefined, now: number, fallbackMs: number, marginMs = 120_000, ceilingMs = 2 * 3_600_000): number {
  const deadline = deadlineAt ? Date.parse(deadlineAt) : Number.NaN
  if (!Number.isFinite(deadline)) return fallbackMs
  return Math.min(Math.max(deadline - now + marginMs, marginMs), ceilingMs)
}
