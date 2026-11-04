/**
 * Cliente y orquestador de la parada coordinada del Hub (`/api/internal/hub-stop`) para una actualización o un cierre de la
 * persona. Core lleva los plazos; aquí sólo se crea la parada, se sondea, se adquiere el lease cuando está `ready` y se hace
 * commit. Sin Electron: la red, el reloj y los procesos son inyectables.
 */
import type { UpdateReason, UpdateStopReport } from "./update-report.js"
import { CORE_EXIT_WAIT_MS, CoreDidNotExit, DRAIN_SECRET_HEADER, DrainLeaseLost, LEASE_SAFETY_MS, LEASE_TTL_MAX_MS, type DrainLease } from "./update-lease.js"

export type HubStopReason = "update" | "quit"
export type HubStopState = "requested" | "notifying" | "waiting_confirmations" | "waiting_members" | "stopping_fleet" | "ready" | "applied" | "resumed" | "postponed" | "cancelled"
export type HubStopAction = "retry" | "cancel" | "commit"

const STATES: readonly HubStopState[] = ["requested", "notifying", "waiting_confirmations", "waiting_members", "stopping_fleet", "ready", "applied", "resumed", "postponed", "cancelled"]

export interface HubStopView {
  stopId: string
  sourceId: string | null
  reason: HubStopReason
  state: HubStopState
  deadlineAt: string | null
  forceAt: string | null
  graceStartedAt: string | null
  /** Después de un `postponed`, hasta cuándo el backend devuelve esa misma parada en vez de crear otra. */
  retryNotBefore: string | null
  ready: boolean
  forced: boolean
  waitingFor: { coordinators: string[]; leadersInTurn: string[]; members: string[] }
  error: { code: string; detail: string | null; actions: HubStopAction[] } | null
}

export type HubStopDrain =
  | { kind: "lease"; lease: DrainLease }
  | { kind: "converging"; reasons: string[] }
  | { kind: "refused"; reasons: string[] }
  | { kind: "unavailable" }

export interface HubStopClientDeps {
  call: (path: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) => Promise<Response>
  secret: string
  log: (line: string) => void
  now?: () => number
}

const text = (value: unknown): string | null => typeof value === "string" && value ? value : null
const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

/** Valida lo mínimo que el desktop usa de la vista; cualquier otra forma se descarta como no confiable. */
export function parseStopView(body: unknown): HubStopView | null {
  const view = body as Record<string, any> | null
  const stopId = text(view?.stop_id)
  if (!view || !stopId || (view.reason !== "update" && view.reason !== "quit") || !STATES.includes(view.state)) return null
  const waiting = view.waiting_for ?? {}
  const error = view.error && typeof view.error === "object" ? view.error as Record<string, any> : null
  const actions = list(error?.actions).filter((action): action is HubStopAction => action === "retry" || action === "cancel" || action === "commit")
  return {
    stopId, sourceId: text(view.source_id), reason: view.reason, state: view.state,
    deadlineAt: text(view.deadline_at), forceAt: text(view.force_at), graceStartedAt: text(view.grace_started_at), retryNotBefore: text(view.retry_not_before),
    ready: view.ready === true, forced: view.forced === true,
    waitingFor: {
      coordinators: list(waiting.coordinators), leadersInTurn: list(waiting.leaders_in_turn),
      members: Array.isArray(waiting.members) ? waiting.members.flatMap((member: any) => text(member?.member_id) ? [member.member_id as string] : []) : [],
    },
    error: error && text(error.code) ? { code: error.code, detail: text(error.detail), actions } : null,
  }
}

export class HubStopClient {
  private readonly now: () => number

  constructor(private readonly deps: HubStopClientDeps) {
    this.now = deps.now ?? (() => performance.now())
  }

  private headers(json: boolean): Record<string, string> {
    return { [DRAIN_SECRET_HEADER]: this.deps.secret, ...(json ? { "Content-Type": "application/json" } : {}) }
  }

  private async view(path: string, method: "GET" | "POST", body?: Record<string, unknown>): Promise<{ view: HubStopView | null; status: number | null }> {
    try {
      const response = await this.deps.call(path, { method, headers: this.headers(body !== undefined), ...(body ? { body: JSON.stringify(body) } : {}) })
      const parsed = await response.json().catch(() => null)
      return { view: response.ok ? parseStopView(parsed) : null, status: response.status }
    } catch (error) {
      this.deps.log(`[hub-stop] ${path}: ${error instanceof Error ? error.message : String(error)}`)
      return { view: null, status: null }
    }
  }

  /** Crea o reutiliza la parada de este `sourceId`. */
  request(sourceId: string, reason: HubStopReason, targetVersion?: string) {
    return this.view("/api/internal/hub-stop", "POST", { source_id: sourceId, reason, ...(targetVersion ? { target_version: targetVersion } : {}) })
  }
  /** Sin `stopId`, la parada activa que tenga el backend. */
  status(stopId?: string) { return this.view(stopId ? `/api/internal/hub-stop/status?stop_id=${encodeURIComponent(stopId)}` : "/api/internal/hub-stop/status", "GET") }
  retry(stopId: string) { return this.view("/api/internal/hub-stop/retry", "POST", { stop_id: stopId }) }
  cancel(stopId: string, reason: string) { return this.view("/api/internal/hub-stop/cancel", "POST", { stop_id: stopId, reason }) }
  commit(stopId: string, transactionId?: string) {
    return this.view("/api/internal/hub-stop/commit", "POST", { stop_id: stopId, ...(transactionId ? { transaction_id: transactionId } : {}) })
  }

  /** Con la parada `ready`: adquiere el lease de no-MCP. Un 409 con razones convergentes se repite; otro 409 vuelve a esperar. */
  async drain(stopId: string): Promise<HubStopDrain> {
    try {
      const requestedAt = this.now()
      const response = await this.deps.call("/api/internal/hub-stop/drain", { method: "POST", headers: this.headers(true), body: JSON.stringify({ stop_id: stopId }) })
      const body = await response.json().catch(() => null) as Record<string, unknown> | null
      if (response.ok) {
        const expires = body?.expires_in_ms
        const valid = typeof body?.lease === "string" && body.lease.length > 0 && Number.isSafeInteger(body.generation) && (body.generation as number) >= 0
          && typeof body.boot_id === "string" && body.boot_id.length > 0 && Number.isSafeInteger(expires) && (expires as number) > LEASE_SAFETY_MS && (expires as number) <= LEASE_TTL_MAX_MS
        if (!valid) { this.deps.log("[hub-stop] lease inválido; se cancela la parada"); return { kind: "unavailable" } }
        return { kind: "lease", lease: { lease: body!.lease as string, generation: body!.generation as number, bootId: body!.boot_id as string, deadline: requestedAt + (expires as number) - LEASE_SAFETY_MS } }
      }
      const reasons = Array.isArray(body?.reasons) ? (body.reasons as unknown[]).flatMap((entry) => text((entry as { code?: unknown } | null)?.code) ?? []) : []
      if (response.status === 409 && reasons.length) return { kind: reasons.every((code) => code === "jobs_nonresumable" || code === "mcp_inflight") ? "converging" : "refused", reasons }
      if (response.status === 409) return { kind: "refused", reasons: [] }
    } catch (error) {
      this.deps.log(`[hub-stop] drain: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { kind: "unavailable" }
  }
}

export type HubStopOutcome =
  | { kind: "committed"; stopId: string; pid: number; start: string }
  | { kind: "postponed"; view: HubStopView }
  | { kind: "cancelled"; view: HubStopView | null }
  | { kind: "failed"; code: string; view: HubStopView | null }

export interface HubStopRunDeps {
  client: HubStopClient
  core: { readonly pid: number | undefined; readonly state: string }
  startTimeOf: (pid: number) => Promise<string | null>
  log: (line: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  exitWaitMs?: number
  /** Fallos de red seguidos que se toleran sondeando antes de rendirse. */
  maxUnreachable?: number
  /** Reintentos del commit mientras core responde que el cierre todavía no quedó programado. */
  maxCommitAttempts?: number
  /** Retiene a core mientras se tiene el lease (no se relanza solo); devuelve la función que lo libera. */
  holdCore?: () => () => void
}

export interface HubStopRunInput {
  sourceId: string
  reason: HubStopReason
  targetVersion?: string
  /** Obligatorio para actualizaciones: identifica la transacción que se admite al volver a arrancar. */
  transactionId?: string
  onView?: (view: HubStopView) => void
  /** Último paso antes del commit (con el lease ya tomado). Si lanza, la parada se cancela y no se hace commit. */
  beforeCommit?: () => Promise<void>
}

/** Una ejecución de la parada. `cancel()` y `retry()` valen mientras no haya commit; después sólo se espera la salida de core. */
export class HubStopRun {
  private readonly sleep: (ms: number) => Promise<void>
  private stopId: string | null = null
  private cancelRequested: string | null = null
  private committing = false
  private release: (() => void) | null = null
  private wake: (() => void) | null = null
  readonly done: Promise<HubStopOutcome>

  constructor(private readonly deps: HubStopRunDeps, private readonly input: HubStopRunInput) {
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); this.wake = () => { clearTimeout(timer); resolve() } }))
    this.done = this.run().then((outcome) => { if (outcome.kind !== "committed") this.releaseCore(); return outcome }).catch((error): HubStopOutcome => {
      this.releaseCore()
      this.deps.log(`[hub-stop] ${error instanceof Error ? error.message : String(error)}`)
      return error instanceof CoreDidNotExit ? { kind: "failed", code: "core_did_not_exit", view: null } : { kind: "failed", code: error instanceof DrainLeaseLost ? "drain_lease_lost" : "unexpected", view: null }
    })
  }

  private releaseCore(): void {
    const release = this.release
    this.release = null
    release?.()
  }

  /** Pide cancelar. Devuelve false si el commit ya empezó: desde ahí no se puede volver atrás. */
  cancel(reason = "cancelled_by_user"): boolean {
    if (this.committing) return false
    this.cancelRequested = reason
    this.wake?.()
    return true
  }

  async retry(): Promise<void> {
    if (this.stopId && !this.committing) await this.deps.client.retry(this.stopId)
    this.wake?.()
  }

  private async run(): Promise<HubStopOutcome> {
    const { client } = this.deps
    const pollMs = this.deps.pollMs ?? 2_000
    const maxUnreachable = this.deps.maxUnreachable ?? 30
    let unreachable = 0
    let last: HubStopView | null = null
    let first = await client.request(this.input.sourceId, this.input.reason, this.input.targetVersion)
    for (let attempt = 0; !first.view && attempt < 3; attempt++) { await this.sleep(pollMs); first = await client.request(this.input.sourceId, this.input.reason, this.input.targetVersion) }
    if (!first.view) return { kind: "failed", code: "stop_not_created", view: null }
    this.stopId = first.view.stopId
    let current: HubStopView | null = first.view
    for (;;) {
      if (current) {
        unreachable = 0
        last = current
        this.input.onView?.(current)
        if (current.state === "postponed") return { kind: "postponed", view: current }
        if (current.state === "cancelled") return { kind: "cancelled", view: current }
        if (current.state === "resumed") return { kind: "failed", code: "stop_resumed", view: current }
      } else if (++unreachable >= maxUnreachable) {
        return { kind: "failed", code: "core_unreachable", view: last }
      }
      if (this.cancelRequested) {
        const cancelled = await client.cancel(this.stopId, this.cancelRequested)
        this.cancelRequested = null
        if (cancelled.view) { this.input.onView?.(cancelled.view); return { kind: "cancelled", view: cancelled.view } }
      } else if (current && (current.state === "ready" || current.state === "applied" || current.error?.actions.includes("commit"))) {
        const committed = await this.finish(current)
        if (committed) return committed
      }
      await this.sleep(pollMs)
      current = (await client.status(this.stopId)).view
    }
  }

  /** Desde `ready`: lease, identidad de core y commit. Devuelve el resultado final o null para seguir sondeando. */
  private async finish(view: HubStopView): Promise<HubStopOutcome | null> {
    const { client, core } = this.deps
    const stopId = view.stopId
    if (view.state !== "applied" && !view.error?.actions.includes("commit")) {
      if (this.input.reason === "update" && !this.input.transactionId) return { kind: "failed", code: "transaction_required", view }
      const drained = await client.drain(stopId)
      if (drained.kind === "converging") return null
      if (drained.kind === "lease" && !this.release) this.release = this.deps.holdCore?.() ?? null
      if (drained.kind !== "lease") { this.deps.log(`[hub-stop] drain ${drained.kind}${"reasons" in drained && drained.reasons.length ? `: ${drained.reasons.join(",")}` : ""}`); return null }
    }
    // La identidad de core se toma antes del commit: la salida se espera de ese mismo proceso (PID e inicio).
    const pid = core.pid
    const start = pid ? await this.deps.startTimeOf(pid) : null
    if (!pid || !start || core.state !== "running") { this.deps.log("[hub-stop] core no está corriendo bajo la parada"); return null }
    if (this.cancelRequested) return null
    if (this.input.beforeCommit) {
      try { await this.input.beforeCommit() } catch (error) {
        this.deps.log(`[hub-stop] antes del commit: ${error instanceof Error ? error.message : String(error)}`)
        await client.cancel(stopId, "before_commit_failed")
        return { kind: "failed", code: "before_commit_failed", view }
      }
    }
    this.committing = true
    const maxAttempts = this.deps.maxCommitAttempts ?? 5
    let result = await client.commit(stopId, this.input.transactionId)
    for (let attempt = 1; !result.view && result.status !== null && result.status >= 500 && attempt < maxAttempts; attempt++) {
      await this.sleep(this.deps.pollMs ?? 2_000)
      result = await client.commit(stopId, this.input.transactionId)
    }
    if (!result.view) {
      // 4xx: la parada ya no admite el commit (cancelada, vencida). Hasta aquí core no recibió la orden de salir.
      this.committing = false
      this.deps.log(`[hub-stop] commit no aceptado (HTTP ${result.status ?? "red"})`)
      return result.status !== null && result.status < 500 ? { kind: "failed", code: "commit_refused", view } : null
    }
    this.input.onView?.(result.view)
    const exited = async (): Promise<boolean> => await this.deps.startTimeOf(pid) !== start
    const limit = this.deps.exitWaitMs ?? CORE_EXIT_WAIT_MS
    for (let waited = 0; waited < limit && !await exited(); waited += 250) await this.sleep(250)
    // Nunca se mata a core: si no salió solo, se informa y no se intercambia nada.
    if (!await exited()) throw new CoreDidNotExit()
    return { kind: "committed", stopId, pid, start }
  }
}

/** Lo que la consola ve de la parada: estado, plazos y a quién se espera. */
export function stopReportOf(view: HubStopView): UpdateStopReport {
  return {
    state: view.state,
    ...(view.deadlineAt ? { deadlineAt: view.deadlineAt } : {}),
    ...(view.forceAt ? { forceAt: view.forceAt } : {}),
    ...(view.graceStartedAt ? { graceStartedAt: view.graceStartedAt } : {}),
    waiting: { coordinators: view.waitingFor.coordinators.length, leadersInTurn: view.waitingFor.leadersInTurn.length, members: view.waitingFor.members.length },
    ...(view.error ? { errorCode: view.error.code, actions: view.error.actions } : {}),
  }
}

/** Razones estables, con el mismo formato que las del drenaje, para el texto de «pospuesta». */
export function stopReasons(view: HubStopView): UpdateReason[] {
  const reasons: UpdateReason[] = []
  if (view.error) reasons.push({ code: view.error.code })
  if (view.waitingFor.leadersInTurn.length) reasons.push({ code: "stop_waiting_leaders", count: view.waitingFor.leadersInTurn.length })
  if (view.waitingFor.coordinators.length) reasons.push({ code: "stop_waiting_coordinators", count: view.waitingFor.coordinators.length })
  if (view.waitingFor.members.length) reasons.push({ code: "stop_waiting_members", count: view.waitingFor.members.length })
  return reasons.length ? reasons : [{ code: `stop_state_${view.state}` }]
}

export type QuitPhase = { phase: "waiting" | "grace" | "forced" | "closing"; remainingMs: number | null }

/** Fase visible de un cierre de la persona: espera, gracia con cuenta regresiva, cierre forzado o cierre en curso. */
export function quitPhaseOf(view: HubStopView, now: number): QuitPhase {
  const remaining = (iso: string | null): number | null => {
    const at = iso ? Date.parse(iso) : NaN
    return Number.isFinite(at) ? Math.max(0, at - now) : null
  }
  if (view.forced) return { phase: "forced", remainingMs: 0 }
  if (view.state === "stopping_fleet" || view.state === "ready" || view.state === "applied") return { phase: "closing", remainingMs: null }
  if (view.graceStartedAt) return { phase: "grace", remainingMs: remaining(view.forceAt) }
  return { phase: "waiting", remainingMs: remaining(view.deadlineAt) }
}

/** mm:ss para la cuenta regresiva; sin dato, un guion. */
export function formatCountdown(ms: number | null): string {
  if (ms === null) return "--:--"
  const total = Math.ceil(ms / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
}
