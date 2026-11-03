import { randomUUID } from "node:crypto"
import { MemoryError } from "./contracts.js"

/** Subsystems that start work which would be lost or repeated if core stopped in the middle of it. */
export type AdmissionKind = "fleet" | "schedule" | "job" | "sync" | "backup"

/** Longest an update drain lease lives; `update-drain` expires the lease with this value and the desktop sizes its work against it. */
export const UPDATE_LEASE_TTL_MS = 10 * 60_000
/** A closed gate that nobody reopens frees itself, so a vanished desktop cannot leave core refusing work. Always longer than the lease. */
export const ADMISSION_MAX_CLOSED_MS = UPDATE_LEASE_TTL_MS + 60_000
/** `settings` row that publishes a closed gate to the worker process: `{ token, until }` with `until` in epoch milliseconds. */
export const ADMISSION_SETTING = "update_admission"

const REFUSAL = "Agent Hub se está actualizando; reintente en unos segundos"

/** Publishes the closed state outside this process (the worker reads it from `settings`); `null` means reopened. */
export type AdmissionPublisher = (state: { token: string; until: number } | null) => Promise<void>

/**
 * Process-wide switch for new non-MCP admissions during a silent update. `close()` is synchronous: nothing admitted
 * after it returns can start, and everything admitted before it is already visible in the counters read afterwards.
 * The publication to the worker is asynchronous; `flush()` resolves once it is durable, and the blocker counters
 * wait for it, so a count is never read while a worker claim could still slip in.
 */
export class AdmissionGate {
  private token: symbol | null = null
  private expiry: ReturnType<typeof setTimeout> | undefined
  private published: Promise<void> = Promise.resolve()
  private failure: unknown
  private readonly tracked = new Map<AdmissionKind, number>()

  constructor(private readonly publisher?: AdmissionPublisher) {}

  /** Throws when already closed: closures never nest. */
  close(): symbol {
    if (this.token) throw new MemoryError(409, "La compuerta de admisión ya está cerrada", false, "already_draining")
    const token = Symbol(randomUUID())
    this.token = token
    this.expiry = setTimeout(() => this.reopen(token), ADMISSION_MAX_CLOSED_MS)
    this.expiry.unref()
    this.publish({ token: token.description!, until: Date.now() + ADMISSION_MAX_CLOSED_MS })
    return token
  }

  /** A token that is not the current one changes nothing and is logged: a stale holder never reopens somebody else's closure. */
  reopen(token: symbol): void {
    if (this.token !== token) { console.error("[admission] reopen ignorado: el token no es el vigente"); return }
    clearTimeout(this.expiry)
    this.token = null
    this.publish(null)
  }

  isClosed(): boolean { return this.token !== null }

  /** `false` while closed: the caller postpones (the work stays queued) and does not throw. */
  admit(_kind?: AdmissionKind): boolean { return this.token === null }

  /** Throwing check for callers that answer a request; `503` is retried by every client of core. */
  require(): void {
    if (this.token) throw new MemoryError(503, REFUSAL, true, "draining")
  }

  /** Runs a short operation that must not be cut by a stop; refused outright while the gate is closed. */
  async track<T>(kind: AdmissionKind, work: () => Promise<T>): Promise<T> {
    this.require()
    this.tracked.set(kind, (this.tracked.get(kind) ?? 0) + 1)
    try { return await work() } finally {
      const left = (this.tracked.get(kind) ?? 1) - 1
      if (left > 0) this.tracked.set(kind, left); else this.tracked.delete(kind)
    }
  }

  /** Operations currently running inside `track`. */
  active(kind?: AdmissionKind): number {
    if (kind) return this.tracked.get(kind) ?? 0
    let total = 0
    for (const count of this.tracked.values()) total += count
    return total
  }

  /** Resolves when the last publication finished; rejects when it failed (the caller must treat the blockers as unknown). */
  flush(): Promise<void> { return this.published }

  /**
   * `reopen` plus confirmation: resolves `true` once the worker row is gone, `false` when the deletion failed. In that case the
   * gate is open in this process but the worker keeps refusing claims until the row expires (`ADMISSION_MAX_CLOSED_MS`), so the
   * caller must not report the update system as reopened.
   */
  async reopenConfirmed(token: symbol): Promise<boolean> {
    this.reopen(token)
    try { await this.flush(); return !this.failure } catch { return false }
  }

  /** Last publication error, cleared by the next successful one. */
  get publicationError(): unknown { return this.failure }

  private publish(state: { token: string; until: number } | null): void {
    if (!this.publisher) return
    const publisher = this.publisher
    // Publications are chained so a reopen can never be overtaken by the close that preceded it.
    this.published = this.published.catch(() => undefined).then(() => publisher(state)).then(
      () => { this.failure = undefined },
      error => {
        this.failure = error
        console.error(`[admission] no se pudo publicar ${state ? "el cierre" : "la reapertura"} al worker: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      })
    // A failed publication is surfaced by flush(); this keeps it from being an unhandled rejection meanwhile.
    this.published.catch(() => undefined)
  }
}
