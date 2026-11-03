import { randomUUID } from "node:crypto"
import { MemoryError } from "./contracts.js"

/** Subsystems that start work which would be lost or repeated if core stopped in the middle of it. */
export type AdmissionKind = "fleet" | "schedule" | "job" | "backup"

/** A closed gate that nobody reopens frees itself, so a vanished desktop cannot leave core refusing work. */
export const ADMISSION_MAX_CLOSED_MS = 11 * 60_000

/** `settings` row that publishes a closed gate to the worker process: `{ token, until }` with `until` in epoch milliseconds. */
export const ADMISSION_SETTING = "update_admission"

const REFUSAL = "Agent Hub se está actualizando; reintente en unos segundos"

/**
 * Process-wide switch for new non-MCP admissions during a silent update. `close()` is synchronous: nothing admitted
 * after it returns can start, and everything admitted before it is already visible in the counters read afterwards.
 * Holders of long-lived work register it in their own counters; short operations go through `track`.
 */
export class AdmissionGate {
  private token: string | null = null
  private expiry: ReturnType<typeof setTimeout> | undefined
  private readonly tracked = new Map<AdmissionKind, number>()

  get closed(): boolean { return this.token !== null }

  /** Returns the reopen token, or `null` when the gate is already closed (the caller reports `already_draining`). */
  close(): string | null {
    if (this.token) return null
    const token = randomUUID()
    this.token = token
    this.expiry = setTimeout(() => this.reopen(token), ADMISSION_MAX_CLOSED_MS)
    this.expiry.unref()
    return token
  }

  /** `false` when the token is not the current one: a stale holder never reopens somebody else's closure. */
  reopen(token: string): boolean {
    if (this.token !== token) return false
    clearTimeout(this.expiry)
    this.token = null
    return true
  }

  isClosed(): boolean { return this.closed }

  /** Non-throwing check for callers that postpone instead of failing (the work stays queued). */
  admit(): boolean { return !this.closed }

  /** Throwing check for callers that answer a request; `503` is retried by every client of core. */
  require(): void {
    if (this.closed) throw new MemoryError(503, REFUSAL, true, "draining")
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
}
