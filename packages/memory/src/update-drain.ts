import { randomUUID, timingSafeEqual } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { check, parse } from "./contracts.js"
import { UPDATE_LEASE_TTL_MS } from "./admission-gate.js"
import type { MemoryService } from "./service.js"
import { hubLog } from "./report.js"

/** Delays before each read of the stop state at startup: the first is immediate, then 250 ms, 1 s and 2 s. */
const STARTUP_STATE_RETRY_MS = [0, 250, 1_000, 2_000]

/** The MCP upstream used by every gateway; the only HTTP admission refused by the hook itself. */
const MCP_PATH = "/api/memory/mcp"
/** A lease nobody cancels or consumes frees core on its own; the single source of the value is the admission gate module. */
export const LEASE_TTL_MS = UPDATE_LEASE_TTL_MS

/** Header carrying the desktop's ephemeral update secret. */
/** Tope del cierre de core tras un commit; pasado este tiempo core sale solo (el lease garantiza que nada queda en curso). */
export const CORE_CLOSE_CAP_MS = 5_000
/** A granted lease must leave more time than the desktop's safety margin. */
const MIN_LEASE_REMAINING_MS = 60_000

export const UPDATE_SECRET_HEADER = "x-agenthub-update-secret"

/** Stable reason codes; the desktop shows them and logs them once per change. */
export type DrainCode =
  | "already_draining"
  | "mcp_inflight"
  | "fleet_live"
  | "jobs_nonresumable"
  | "blockers_unknown"
  | "drain_lease_lost"

export interface DrainReason { code: DrainCode; count?: number }
export type DrainResult =
  | { ok: true; lease: string; generation: number; expires_in_ms: number; boot_id: string }
  | { ok: false; reasons: DrainReason[] }

export interface ShutdownStatus {
  inflight: number
  draining: boolean
  boot_id: string
  startup_transaction: string | null
  admitted_transaction: string | null
  fleet_live: number
  jobs_nonresumable: number
  blockers_known: boolean
}

/** Shared gate of the memory service for non-MCP admissions (fleet, schedules, jobs of the worker, backup). */
export interface AdmissionGateLike {
  /** Synchronous: nothing admitted after it returns can start. Throws with `code: "already_draining"` when somebody else holds it. */
  close(): symbol
  /** Reopens only the closure `token` opened and resolves `true` only once the worker has been told; `false` means it was not confirmed. */
  reopenConfirmed(token: symbol): Promise<boolean>
  isClosed?(): boolean
  flush?(): Promise<void>
}

export interface NonMcpBlockers { fleet_live: number; jobs_nonresumable: number }

/** `not_applicable` solo lo fija la rama explícita de una plataforma sin runtime versionado; la ausencia del escáner nunca equivale a cero. */
export interface LegacyGatewayScan { count: number; error?: string; not_applicable?: boolean }

export interface DrainDependencies {
  /** Resolved on every acquire so a service that gains the gate later is picked up. */
  gate(): AdmissionGateLike | undefined
  /** Waits for the closure to reach the worker before counting; rejects when it cannot. */
  nonMcpBlockers(): (() => Promise<NonMcpBlockers>) | undefined
}

/**
 * Atomic admission gate for a silent update. `acquire` either answers with stable reasons at once (nothing is
 * waited on, no HTTP request stays open) or leaves core refusing new admissions (MCP with `503` +
 * `x-agenthub-draining` before any handler runs, plus the shared gate for fleet, schedules, jobs and backup)
 * until `cancel` or the lease expires.
 *
 * Order, all inside one `try` that releases exactly what was acquired on every path: refuse MCP and close the
 * shared gate without awaiting, then read each blocker (the counter waits for the worker to see the closure),
 * and last the MCP calls in flight. Gateways started from a pre-runtime bundle never block: the swap keeps them
 * running from the renamed bundle and they reconnect or need a client-side reconnect.
 *
 * The grant carries a `boot_id` that is fixed for the life of this core process: a lease can only be confirmed
 * by the same process that granted it, so a restart of core is a lost lease.
 */
export class UpdateDrain {
  readonly bootId = randomUUID()
  private inflight = 0
  private draining = false
  private acquiring = false
  private lease: string | null = null
  private generation = 0
  private token: symbol | null = null
  private gate: AdmissionGateLike | undefined
  private expiresAt = 0
  private expiry: ReturnType<typeof setTimeout> | undefined
  private committed = false
  /** A blocker-bearing attempt keeps both admission gates closed so existing work converges to zero. */
  private pending = false
  private pendingVersion = 0
  /** A manual quit waits for MCP calls in flight; it closes nothing but MCP and ends only when core exits or the quit is cancelled. */
  private shutdown = false
  private shutdownGate: AdmissionGateLike | undefined
  private shutdownToken: symbol | null = null
  /** Core born closed for the first start of a new version: MCP and the shared gate stay shut until the desktop admits it. */
  private startup: { transactionId: string; gate: AdmissionGateLike | undefined; token: symbol | null } | null = null
  private startupExpiry: ReturnType<typeof setTimeout> | undefined
  private admittedTransaction: string | null = null
  private committedStop: (() => void | Promise<void>) | undefined
  private commitAbandoned: ((reason: string, reopened: boolean) => void | Promise<void>) | undefined
  private committedStopRequested = false

  constructor(private readonly deps: DrainDependencies, private readonly ttlMs = LEASE_TTL_MS, private readonly now: () => number = Date.now) {}

  get isDraining(): boolean { return this.draining }
  get inflightCount(): number { return this.inflight }
  get hasPendingAttempt(): boolean { return this.pending && !this.lease && !this.committed }

  configureCommittedStop(stop: () => void | Promise<void>, abandoned?: (reason: string, reopened: boolean) => void | Promise<void>): void {
    this.committedStop = stop
    this.commitAbandoned = abandoned
  }

  isCommittedLease(lease: string, generation: number, bootId: string): boolean {
    return this.committed && this.lease === lease && this.generation === generation && this.bootId === bootId
  }

  /** Schedules the configured core stop once, after the caller durably recorded the commit. */
  requestCommittedStop(): boolean {
    if (!this.committed || !this.committedStop) return false
    if (this.committedStopRequested) return true
    this.committedStopRequested = true
    const timer = setTimeout(() => { void Promise.resolve(this.committedStop!()).catch(() => undefined) }, 50)
    timer.unref()
    return true
  }

  /** Takes ownership of an already-closed non-MCP gate without reopening it between the coordinated stop and MCP drain. */
  adoptAdmission(gate: AdmissionGateLike, token: symbol): boolean {
    if (this.startup || this.lease || this.acquiring || this.pending || this.committed) return false
    this.pending = true
    this.pendingVersion++
    this.gate = gate
    this.token = token
    this.expiresAt = this.now() + this.ttlMs
    clearTimeout(this.expiry)
    this.expiry = setTimeout(() => { void this.release("vencimiento de parada coordinada") }, this.ttlMs)
    this.expiry.unref()
    return true
  }

  /** `false` while draining: the caller answers 503 without running anything. */
  admit(): boolean {
    if (this.draining) return false
    this.inflight++
    return true
  }

  leave(): void {
    if (this.inflight > 0) this.inflight--
  }

  /** Reopens the shared gate and reports whether the worker confirmed it; a failure is logged and never reported as reopened. */
  private async reopenGate(gate: AdmissionGateLike | undefined, token: symbol | null, why: string): Promise<boolean> {
    if (!gate || !token) return true
    let confirmed = false
    try { confirmed = await gate.reopenConfirmed(token) } catch { confirmed = false }
    if (!confirmed) console.error(`[update-drain] la reapertura de admisiones no se confirmó (${why}); el worker la recupera al vencer el cierre`)
    return confirmed
  }

  private async reopenStartup(startup: { gate: AdmissionGateLike | undefined; token: symbol | null }, why: string): Promise<boolean> {
    if (startup.gate?.isClosed?.() === false) {
      try { await startup.gate.flush?.(); return true } catch { return false }
    }
    return this.reopenGate(startup.gate, startup.token, why)
  }

  private async confirmStartupReopen(startup: { gate: AdmissionGateLike | undefined; token: symbol | null }, why: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.reopenStartup(startup, why),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5_000); timer.unref() }),
      ])
    } finally { clearTimeout(timer) }
  }

  private finishStartup(startup: { transactionId: string; gate: AdmissionGateLike | undefined; token: symbol | null }): void {
    if (this.startup !== startup) return
    clearTimeout(this.startupExpiry)
    this.startupExpiry = undefined
    this.startup = null
    this.admittedTransaction = startup.transactionId
    this.draining = this.shutdown
  }

  private async expireStartup(startup: { transactionId: string; gate: AdmissionGateLike | undefined; token: symbol | null }): Promise<void> {
    if (this.startup !== startup) return
    this.draining = this.shutdown
    const reopened = await this.confirmStartupReopen(startup, "vencimiento del arranque cerrado")
    if (this.startup !== startup) return
    if (reopened) { this.finishStartup(startup); return }
    console.error(`[update-drain] el arranque ${startup.transactionId} venció sin confirmar la reapertura del worker; MCP queda abierto y se reintenta`)
    clearTimeout(this.startupExpiry)
    this.startupExpiry = setTimeout(() => { if (this.startup === startup) void this.expireStartup(startup) }, 5_000)
    this.startupExpiry.unref()
  }

  /**
   * Starts closed, synchronously, before the listener exists: MCP answers 503 and the shared gate is closed under a token of its
   * own while `/health` keeps answering. Nothing reopens it but `admitStartup` for the same transaction and this process.
   */
  beginStartup(transactionId: string): void {
    this.draining = true
    this.admittedTransaction = null
    let gate: AdmissionGateLike | undefined
    let token: symbol | null = null
    try {
      gate = this.deps.gate()
      token = gate ? gate.close() : null
    } catch (error) {
      console.error(`[update-drain] no se pudo cerrar la compuerta al arrancar: ${error instanceof Error ? error.message : String(error)}`)
      token = null
    }
    this.startup = { transactionId, gate, token }
    clearTimeout(this.startupExpiry)
    this.startupExpiry = setTimeout(() => { if (this.startup) void this.expireStartup(this.startup) }, this.ttlMs)
    this.startupExpiry.unref()
  }

  /** Reopens MCP and the gate once, only if the worker confirms it; otherwise core stays closed and the caller may retry. */
  async admitStartup(transactionId: string, bootId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const startup = this.startup
    if (!startup) return { ok: false, reason: "not_starting" }
    if (startup.transactionId !== transactionId) return { ok: false, reason: "transaction_mismatch" }
    if (bootId !== this.bootId) return { ok: false, reason: "boot_mismatch" }
    if (!await this.confirmStartupReopen(startup, "admisión del arranque")) return { ok: false, reason: "reopen_not_confirmed" }
    if (this.startup !== startup) return { ok: false, reason: "not_starting" }
    this.finishStartup(startup)
    return { ok: true }
  }

  async acquire(): Promise<DrainResult> {
    if (this.startup) return { ok: false, reasons: [{ code: "already_draining" }] }
    if (this.lease || this.acquiring) return { ok: false, reasons: [{ code: "already_draining" }] }
    this.acquiring = true
    // Synchronous from here to the first await: MCP is refused before anything else happens.
    this.draining = true
    let gate = this.pending ? this.gate : undefined
    let token = this.pending ? this.token : null
    let version = this.pendingVersion
    const releaseAttempt = async (why: string): Promise<void> => {
      if (!this.pending || version !== this.pendingVersion) return
      clearTimeout(this.expiry)
      this.pending = false
      this.pendingVersion++
      this.expiresAt = 0
      this.gate = undefined
      this.token = null
      this.draining = this.shutdown
      await this.reopenGate(gate, token, why)
    }
    try {
      if (!this.pending) {
        gate = this.deps.gate()
        if (!gate) { this.draining = this.shutdown; return { ok: false, reasons: [{ code: "blockers_unknown" }] } }
        try {
          token = gate.close()
        } catch (error) {
          token = null
          this.draining = this.shutdown
          return { ok: false, reasons: [{ code: (error as { code?: string } | null)?.code === "already_draining" ? "already_draining" : "blockers_unknown" }] }
        }
        this.pending = true
        version = ++this.pendingVersion
        this.gate = gate
        this.token = token
        this.expiresAt = this.now() + this.ttlMs
        this.expiry = setTimeout(() => { void this.release("vencimiento") }, this.ttlMs)
        this.expiry.unref()
      }
      const reasons: DrainReason[] = []
      const counter = this.deps.nonMcpBlockers()
      if (!counter) reasons.push({ code: "blockers_unknown" })
      else {
        try {
          const counts = await counter()
          if (counts.fleet_live > 0) reasons.push({ code: "fleet_live", count: counts.fleet_live })
          if (counts.jobs_nonresumable > 0) reasons.push({ code: "jobs_nonresumable", count: counts.jobs_nonresumable })
        } catch {
          reasons.push({ code: "blockers_unknown" })
        }
      }
      if (!this.pending || version !== this.pendingVersion) return { ok: false, reasons: [{ code: "already_draining" }] }
      if (reasons.some(reason => reason.code === "fleet_live")) {
        const stable = dedupe(reasons)
        await releaseAttempt("flota viva")
        return { ok: false, reasons: stable }
      }
      if (reasons.some(reason => reason.code === "jobs_nonresumable")) {
        this.draining = false
        return { ok: false, reasons: dedupe(reasons) }
      }
      // In-flight is read last and synchronously with the grant: with MCP refused it can only have fallen.
      if (this.inflight > 0) reasons.push({ code: "mcp_inflight", count: this.inflight })
      if (!this.pending || version !== this.pendingVersion) return { ok: false, reasons: [{ code: "already_draining" }] }
      if (reasons.length > 0) {
        const stable = dedupe(reasons)
        const converging = !stable.some(reason => reason.code === "fleet_live")
          && stable.every(reason => ["jobs_nonresumable", "mcp_inflight"].includes(reason.code))
        if (!converging) await releaseAttempt("bloqueos no convergentes")
        else this.draining = stable.some(reason => reason.code === "mcp_inflight")
        return { ok: false, reasons: stable }
      }
      const remaining = this.expiresAt - this.now()
      if (remaining <= MIN_LEASE_REMAINING_MS) {
        await releaseAttempt("vencimiento antes del lease")
        return { ok: false, reasons: [{ code: "already_draining" }] }
      }
      this.pending = false
      this.shutdown = false
      this.committed = false
      this.committedStopRequested = false
      this.lease = randomUUID()
      this.generation++
      clearTimeout(this.expiry)
      this.expiry = setTimeout(() => { void this.release("vencimiento") }, remaining)
      this.expiry.unref()
      return { ok: true, lease: this.lease, generation: this.generation, expires_in_ms: remaining, boot_id: this.bootId }
    } catch {
      await releaseAttempt("error inesperado")
      return { ok: false, reasons: [{ code: "blockers_unknown" }] }
    } finally {
      this.acquiring = false
    }
  }

  /** Cancels a blocker-bearing attempt before a lease exists, reopening both gates exactly once. */
  async cancelPending(): Promise<{ ok: boolean; reopened: boolean }> {
    if (!this.pending || this.lease || this.committed) return { ok: false, reopened: false }
    return { ok: true, reopened: await this.release("cancelación pendiente") }
  }

  /** Whether this exact lease still belongs to this core and has usable time left. */
  ownsLease(lease: string, generation: number, bootId: string): boolean {
    return this.confirm(lease, generation, bootId).ok
  }

  /** The same lease, generation and core process, still unexpired and not yet committed. */
  confirm(lease: string, generation: number, bootId: string): { ok: true; remaining_ms: number } | { ok: false } {
    const remaining = this.expiresAt - this.now()
    if (!this.lease || this.committed || this.lease !== lease || this.generation !== generation || bootId !== this.bootId || remaining <= 0) return { ok: false }
    return { ok: true, remaining_ms: remaining }
  }

  /**
   * The lease owner takes core down for the swap: valid only for the confirmed lease, and irreversible. After it core
   * refuses everything and the caller stops it; the desktop swaps only after it saw this exact process exit.
   * Nothing was in flight when the lease was granted and nothing could enter since, so no call is cut.
   */
  commit(lease: string, generation: number, bootId: string): boolean {
    if (!this.confirm(lease, generation, bootId).ok) return false
    this.committed = true
    clearTimeout(this.expiry)
    return true
  }

  /**
   * The commit could not complete the stop of core before its listener closed: reopen MCP and the shared gate, forget the lease
   * (a later confirm gets 409) and leave a record. Core never stays alive and closed.
   */
  async abandon(why: string): Promise<boolean> {
    if (!this.committed) return false
    console.error(`[update-drain] commit abandonado: ${why}`)
    this.committed = false
    this.committedStopRequested = false
    const reopened = await this.release("commit abandonado")
    await this.commitAbandoned?.(why, reopened)
    return reopened
  }

  /**
   * Quit by the person uses the same non-MCP gate as updates. A pending update closure is adopted rather than reopened,
   * so new fleet/jobs/schedules cannot enter while existing work converges to zero.
   */
  async beginShutdown(): Promise<ShutdownStatus> {
    if (!this.shutdown && !this.lease && !this.startup) {
      this.shutdown = true
      this.draining = true
      if (this.pending) {
        clearTimeout(this.expiry)
        this.shutdownGate = this.gate
        this.shutdownToken = this.token
        this.pending = false
        this.pendingVersion++
        this.gate = undefined
        this.token = null
        this.expiresAt = 0
      } else if (!this.acquiring) {
        try {
          this.shutdownGate = this.deps.gate()
          this.shutdownToken = this.shutdownGate ? this.shutdownGate.close() : null
        } catch {
          this.shutdownGate = undefined
          this.shutdownToken = null
        }
      }
    }
    return this.shutdownStatus()
  }

  async endShutdown(): Promise<ShutdownStatus> {
    if (this.shutdown) {
      this.shutdown = false
      const gate = this.shutdownGate, token = this.shutdownToken
      this.shutdownGate = undefined
      this.shutdownToken = null
      await this.reopenGate(gate, token, "cancelación del cierre")
      if (!this.lease && !this.acquiring && !this.pending && !this.startup) this.draining = false
    }
    return this.shutdownStatus()
  }

  status(): { inflight: number; draining: boolean; boot_id: string; startup_transaction: string | null; admitted_transaction: string | null } {
    return { inflight: this.inflight, draining: this.draining, boot_id: this.bootId,
      startup_transaction: this.startup?.transactionId ?? null, admitted_transaction: this.admittedTransaction }
  }

  async shutdownStatus(): Promise<ShutdownStatus> {
    let fleet = 0, jobs = 0, known = true
    if (this.shutdown || this.pending) {
      const counter = this.deps.nonMcpBlockers()
      if (!counter) known = false
      else try {
        const blockers = await counter()
        fleet = blockers.fleet_live
        jobs = blockers.jobs_nonresumable
      } catch { known = false }
    }
    return { ...this.status(), fleet_live: fleet, jobs_nonresumable: jobs, blockers_known: known }
  }

  async cancel(lease: string, generation: number): Promise<{ ok: boolean; reopened: boolean }> {
    if (!this.lease || this.committed || this.lease !== lease || this.generation !== generation) return { ok: false, reopened: false }
    return { ok: true, reopened: await this.release("cancelación") }
  }

  // A manual shutdown owns its gate separately; update lease release must not reopen it.
  private async release(why: string): Promise<boolean> {
    if (this.committed) return true
    clearTimeout(this.expiry)
    const { gate, token } = this
    this.pending = false
    this.pendingVersion++
    this.lease = null
    this.gate = undefined
    this.token = null
    this.expiresAt = 0
    this.committedStopRequested = false
    this.draining = this.shutdown
    return this.reopenGate(gate, token, why)
  }
}

function dedupe(reasons: DrainReason[]): DrainReason[] {
  const seen = new Set<string>()
  return reasons.filter((reason) => !seen.has(reason.code) && seen.add(reason.code))
}

function sameSecret(expected: string, received: unknown): boolean {
  if (typeof received !== "string" || received.length === 0) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Authorization exclusive to the desktop: an ephemeral secret handed to core through its environment and sent
 * in a header. The owner's JWT is not enough, so a client holding it cannot hold core in drain. Without a
 * secret every request is refused.
 */
export function updateSecretAuthorizer(secret: string | undefined): (request: FastifyRequest) => Promise<void> {
  return async (request) => {
    const header = request.headers[UPDATE_SECRET_HEADER]
    check(Boolean(secret) && sameSecret(secret!, Array.isArray(header) ? header[0] : header), "No autorizado para actualizar", 403)
  }
}

type ServiceExtras = {
  admissionGate?: AdmissionGateLike
  nonMcpBlockers?: () => Promise<NonMcpBlockers>
}

export interface UpdateDrainOptions {
  authorize: (request: FastifyRequest) => Promise<unknown>
  /** Stops this core after a commit. The default closes the listener and the app with a 5 s cap and then exits unconditionally. */
  shutdown?: (drain: UpdateDrain) => void | Promise<void>
  /** Transaction of the update that launched this core: it starts closed until `POST /api/internal/update-admit`. */
  startupTransaction?: string
  /** Validates durable stop evidence before reopening the startup gate. */
  beforeStartupAdmit?: (transactionId: string, bootId: string) => void | Promise<void>
  /** Called only after the new core confirmed reopening its startup gate. */
  startupAdmitted?: (transactionId: string, bootId: string) => void | Promise<void>
}

/** Gate hook and routes; call before the MCP route is registered so the hook covers it. */
export function registerUpdateDrain(app: FastifyInstance, service: MemoryService, options: UpdateDrainOptions): UpdateDrain {
  const extras = service as unknown as ServiceExtras
  const drain = new UpdateDrain({
    gate: () => extras.admissionGate,
    nonMcpBlockers: () => (extras.nonMcpBlockers ? () => extras.nonMcpBlockers!() : undefined),
  })
  /**
   * Default stop after a commit. The lease already proved no MCP call in flight and no non-MCP work, so exiting unconditionally
   * after a 5 s cap is safe. If closing fails while the listener is still open, nothing was stopped: the commit is abandoned
   * (MCP and admissions reopen) so core never stays alive and closed.
   */
  const stopCore = options.shutdown ?? (async (current: UpdateDrain): Promise<void> => {
    const hard = setTimeout(() => process.exit(0), CORE_CLOSE_CAP_MS)
    try {
      await app.close()
    } catch (error) {
      if (app.server.listening) {
        clearTimeout(hard)
        await current.abandon(`el cierre falló antes de cerrar el listener: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }
    process.exit(0)
  })
  drain.configureCommittedStop(() => stopCore(drain), async (reason, reopened) => { await (await service.get()).stop.recoverAbandonedCommit(reason, reopened) })
  app.addHook("onReady", async () => {
    // An applied update read here must close MCP before listening, so a service that cannot be read is retried. Without that
    // state and without the launcher's transaction the core refuses to listen (fail-closed) and its supervisor restarts it.
    let durable: string | null = null, failure: unknown
    for (const delayMs of STARTUP_STATE_RETRY_MS) {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
      try {
        const current = await service.get()
        durable = (await current.stop?.appliedTransaction?.()) ?? null
        failure = undefined
        break
      } catch (error) { failure = error }
    }
    if (failure !== undefined) {
      const detail = failure instanceof Error ? failure.message : String(failure)
      try { hubLog(service.directory).event("update_drain", "startup_state_unavailable", { cause: "startup_state_unavailable", fallback: Boolean(options.startupTransaction) }) } catch { /* The decision below does not depend on the log. */ }
      console.error(`[update-drain] no se pudo leer el estado de la parada al arrancar: ${detail}`)
      if (!options.startupTransaction) throw failure
    }
    const transaction = durable ?? options.startupTransaction
    if (transaction) drain.beginStartup(transaction)
  })
  const guard = { preHandler: async (request: FastifyRequest) => { await options.authorize(request) } }
  const leaseBody = z.object({ lease: z.string().min(1).max(100), generation: z.number().int().nonnegative(), boot_id: z.string().min(1).max(100) }).strict()
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.split("?")[0] !== MCP_PATH) return
    if (!drain.admit()) {
      return reply.code(503).header("x-agenthub-draining", "1").header("retry-after", "2").send({ detail: "Agent Hub se está actualizando; reintente en unos segundos" })
    }
    let left = false
    const leave = () => { if (!left) { left = true; drain.leave() } }
    reply.raw.once("close", leave)
    reply.raw.once("finish", leave)
  })
  app.post("/api/internal/update-admit", guard, async (request, reply) => {
    const input = parse(z.object({ transaction_id: z.string().min(1).max(100), boot_id: z.string().min(1).max(100) }).strict(), request.body)
    await options.beforeStartupAdmit?.(input.transaction_id, drain.bootId)
    const result = await drain.admitStartup(input.transaction_id, input.boot_id)
    const alreadyAdmitted = !result.ok && result.reason === "not_starting" && input.boot_id === drain.bootId
      && drain.status().admitted_transaction === input.transaction_id
    if (result.ok || alreadyAdmitted) await options.startupAdmitted?.(input.transaction_id, drain.bootId)
    return result.ok || alreadyAdmitted ? { admitted: true } : reply.code(409).send({ admitted: false, reason: result.reason })
  })
  app.post("/api/internal/update-drain", guard, async (_request, reply) => {
    const result = await drain.acquire()
    return result.ok ? result : reply.code(409).send(result)
  })
  app.post("/api/internal/update-drain/pending/cancel", guard, async (request, reply) => {
    const result = await drain.cancelPending()
    return result.ok ? result : reply.code(409).send(result)
  })
  app.post("/api/internal/update-drain/confirm", guard, async (request, reply) => {
    const input = parse(leaseBody, request.body)
    const result = drain.confirm(input.lease, input.generation, input.boot_id)
    return result.ok ? result : reply.code(409).send({ ok: false, reasons: [{ code: "drain_lease_lost" }] })
  })
  app.post("/api/internal/update-drain/commit", guard, async (request, reply) => {
    const input = parse(leaseBody, request.body)
    if (!drain.commit(input.lease, input.generation, input.boot_id) && !drain.isCommittedLease(input.lease, input.generation, input.boot_id))
      return reply.code(409).send({ ok: false, reasons: [{ code: "drain_lease_lost" }] })
    check(drain.requestCommittedStop(), "No se pudo programar el cierre del core", 503)
    return { ok: true, pid: process.pid, boot_id: drain.bootId }
  })
  app.post("/api/internal/update-drain/shutdown", guard, async () => drain.beginShutdown())
  app.post("/api/internal/update-drain/shutdown/cancel", guard, async () => drain.endShutdown())
  app.get("/api/internal/update-drain/status", guard, async () => drain.shutdownStatus())
  app.post("/api/internal/update-drain/cancel", guard, async (request) => {
    const input = parse(z.object({ lease: z.string().min(1).max(100), generation: z.number().int().nonnegative() }).strict(), request.body)
    const result = await drain.cancel(input.lease, input.generation)
    check(result.ok, "El drenaje no corresponde a este lease", 409)
    return { ok: true, reopened: result.reopened }
  })
  return drain
}
