/**
 * Cliente del drenaje de core para una actualización: adquiere el lease, lo confirma antes de cada paso irreversible,
 * le pide a core que se detenga bajo ese lease (commit) y espera a que salga ese mismo proceso. Sin Electron: la red, el
 * reloj y los procesos son inyectables.
 */
import type { UpdateReason } from "./update-report.js"

/** Margen con el que el escritorio da por perdido un lease antes de que core lo libere solo. */
export const LEASE_SAFETY_MS = 60_000
/** TTL contractual del lease en core (`UPDATE_LEASE_TTL_MS`): una respuesta con más es inválida. */
export const LEASE_TTL_MAX_MS = 10 * 60_000
export const DRAIN_SECRET_HEADER = "x-agenthub-update-secret"
/**
 * Tiempo que core tiene para salir solo, de forma ordenada, tras el commit. Es corto a propósito: los gateways reintentan
 * sólo 45 s. Pasado este plazo se aborta sin swap; nunca se detiene a core a la fuerza para completar una actualización.
 */
export const CORE_EXIT_WAIT_MS = 10_000

export interface DrainLease { lease: string; generation: number; bootId: string; deadline: number }

/** Core aceptó el commit pero no salió dentro del plazo: no se intercambia nada y se deja que termine solo (el supervisor lo relanza). */
export class CoreDidNotExit extends Error {
  constructor() { super("core no salió tras el commit; no se intercambia nada"); this.name = "CoreDidNotExit" }
}

export class DrainLeaseLost extends Error {
  constructor() { super("drain_lease_lost"); this.name = "DrainLeaseLost" }
}

/** Resultado de hablar con core: distingue un 409 («ese lease ya no existe») de un 403 o de un fallo de red. */
export type DrainCall = "ok" | "gone" | "forbidden" | "unreachable"

export interface DrainClientDeps {
  /** Pedido autenticado al core local (token de sesión incluido). */
  call: (path: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) => Promise<Response>
  secret: string
  log: (line: string) => void
  core: { readonly pid: number | undefined; readonly state: string }
  /** Hora de inicio de un proceso, o `null` si ya no existe. */
  startTimeOf: (pid: number) => Promise<string | null>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  exitWaitMs?: number
}

export class DrainClient {
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: DrainClientDeps) {
    this.now = deps.now ?? (() => performance.now())
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  private headers(json = false): Record<string, string> {
    return { [DRAIN_SECRET_HEADER]: this.deps.secret, ...(json ? { "Content-Type": "application/json" } : {}) }
  }

  /** El lease sigue siendo válido en el reloj local; no basta para actuar: antes de cada paso irreversible se llama a `confirm`. */
  held(lease: DrainLease): boolean {
    return this.now() < lease.deadline
  }

  /** Compuerta atómica de core: o devuelve razones estables, o deja a core drenando con un lease. Sin forzado por tiempo. */
  async acquire(): Promise<{ lease: DrainLease } | { reasons: UpdateReason[] }> {
    try {
      const requestedAt = this.now()
      const response = await this.deps.call("/api/internal/update-drain", { method: "POST", headers: this.headers() })
      const body = await response.json().catch(() => null) as { lease?: unknown; generation?: unknown; expires_in_ms?: unknown; boot_id?: unknown; reasons?: unknown } | null
      if (response.ok) {
        const expires = body?.expires_in_ms
        const valid = typeof body?.lease === "string" && body.lease.length > 0 && Number.isSafeInteger(body.generation) && (body.generation as number) >= 0
          && typeof body.boot_id === "string" && body.boot_id.length > 0 && Number.isSafeInteger(expires) && (expires as number) > LEASE_SAFETY_MS && (expires as number) <= LEASE_TTL_MAX_MS
        if (valid) {
          // El plazo cuenta desde el pedido, no desde la respuesta: la hora en que core concedió el lease es anterior a ésta.
          return { lease: { lease: body!.lease as string, generation: body!.generation as number, bootId: body!.boot_id as string, deadline: requestedAt + (expires as number) - LEASE_SAFETY_MS } }
        }
        this.deps.log("[updater] respuesta de drenaje inválida; se ignora y se cancela lo que haya concedido")
        if (typeof body?.lease === "string" && Number.isSafeInteger(body.generation)) await this.cancel({ lease: body.lease, generation: body.generation as number })
        return { reasons: [{ code: "core_unreachable" }] }
      }
      if (Array.isArray(body?.reasons)) {
        const reasons = body.reasons.flatMap((entry): UpdateReason[] => {
          const reason = entry as { code?: unknown; count?: unknown }
          return typeof reason.code === "string" && /^[a-z_]{1,40}$/.test(reason.code) ? [{ code: reason.code, ...(Number.isSafeInteger(reason.count) ? { count: reason.count as number } : {}) }] : []
        })
        if (reasons.length) return { reasons }
      }
    } catch { /* core ocupado o reiniciando */ }
    return { reasons: [{ code: "core_unreachable" }] }
  }

  /** Reopens a blocker-bearing attempt when updates are disabled or the app is leaving for another reason. */
  async cancelPending(): Promise<void> {
    try {
      const response = await this.deps.call("/api/internal/update-drain/pending/cancel", { method: "POST", headers: this.headers() })
      if (!response.ok && response.status !== 409) this.deps.log(`[updater] no se pudo cancelar el drenaje pendiente (HTTP ${response.status})`)
      await response.body?.cancel().catch(() => undefined)
    } catch (error) {
      this.deps.log(`[updater] no se pudo cancelar el drenaje pendiente: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Opens a transaction-started core only after observing this process's boot id and receiving its explicit acknowledgement. */
  async admitStartup(transactionId: string): Promise<boolean> {
    try {
      const status = await this.deps.call("/api/internal/update-drain/status", { method: "GET", headers: this.headers() })
      const current = await status.json().catch(() => null) as { boot_id?: unknown } | null
      if (!status.ok || typeof current?.boot_id !== "string" || !current.boot_id) {
        await status.body?.cancel().catch(() => undefined)
        return false
      }
      const response = await this.deps.call("/api/internal/update-admit", {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ transaction_id: transactionId, boot_id: current.boot_id }),
      })
      const admitted = await response.json().catch(() => null) as { admitted?: unknown } | null
      return response.ok && admitted?.admitted === true
    } catch (error) {
      this.deps.log(`[updater] no se pudo admitir el core nuevo: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  private async post(path: string, lease: { lease: string; generation: number; bootId?: string }): Promise<{ result: DrainCall; remainingMs?: number; reopened?: boolean }> {
    try {
      const response = await this.deps.call(path, { method: "POST", headers: this.headers(true), body: JSON.stringify({ lease: lease.lease, generation: lease.generation, ...(!path.endsWith("/cancel") && lease.bootId ? { boot_id: lease.bootId } : {}) }) })
      if (response.ok) {
        const body = await response.json().catch(() => null) as { remaining_ms?: unknown; reopened?: unknown } | null
        return { result: "ok", ...(Number.isSafeInteger(body?.remaining_ms) ? { remainingMs: body!.remaining_ms as number } : {}), ...(typeof body?.reopened === "boolean" ? { reopened: body.reopened } : {}) }
      }
      await response.body?.cancel().catch(() => undefined)
      return { result: response.status === 409 ? "gone" : response.status === 403 ? "forbidden" : "unreachable" }
    } catch (error) {
      this.deps.log(`[updater] ${path}: ${error instanceof Error ? error.message : String(error)}`)
      return { result: "unreachable" }
    }
  }

  async cancel(lease: { lease: string; generation: number; bootId?: string }): Promise<void> {
    const { result, reopened } = await this.post("/api/internal/update-drain/cancel", lease)
    if (result === "ok" && reopened === false) this.deps.log("[updater] core canceló el drenaje pero no confirmó la reapertura de admisiones; el worker las recupera al vencer el cierre")
    // «gone»: ya no había lease (venció o core se reinició); lo demás es un cancel que no se pudo confirmar y core lo libera por TTL.
    if (result === "forbidden" || result === "unreachable") this.deps.log(`[updater] no se pudo cancelar el drenaje (${result}); core lo libera solo al vencer`)
  }

  /**
   * Confirma justo antes de un paso irreversible que ESTE lease sigue vigente en el MISMO proceso de core. Cualquier
   * otra respuesta, incluido un fallo de red, es lease perdido. Renueva el plazo local con el que informa core.
   */
  async confirm(lease: DrainLease, step: string): Promise<void> {
    const { result, remainingMs } = await this.post("/api/internal/update-drain/confirm", lease)
    if (result !== "ok" || !remainingMs || remainingMs <= LEASE_SAFETY_MS) {
      this.deps.log(`[updater] lease de drenaje perdido antes de ${step} (${result})`)
      throw new DrainLeaseLost()
    }
    lease.deadline = this.now() + remainingMs - LEASE_SAFETY_MS
  }

  /**
   * Último paso antes de lo irreversible: confirma el lease y le pide a core que se detenga BAJO ESE LEASE (commit).
   * El swap sólo ocurre después de haber visto salir a ese mismo proceso (PID e inicio exactos): si core muriera antes,
   * el commit no se acepta y no hay swap; y si no sale solo dentro del plazo corto, se aborta (`CoreDidNotExit`).
   * Devuelve la identidad que salió.
   */
  async commit(lease: DrainLease): Promise<{ pid: number; start: string }> {
    const { core } = this.deps
    const pid = core.pid
    const start = pid ? await this.deps.startTimeOf(pid) : null
    if (!pid || !start || core.state !== "running") { this.deps.log("[updater] core no está corriendo bajo el lease"); throw new DrainLeaseLost() }
    await this.confirm(lease, "detener core")
    const { result } = await this.post("/api/internal/update-drain/commit", lease)
    if (result !== "ok") { this.deps.log(`[updater] el commit del drenaje no se aceptó (${result})`); throw new DrainLeaseLost() }
    const exited = async (): Promise<boolean> => await this.deps.startTimeOf(pid) !== start
    const limit = this.deps.exitWaitMs ?? CORE_EXIT_WAIT_MS
    for (let waited = 0; waited < limit && !await exited(); waited += 250) await this.sleep(250)
    // Nunca se mata a core para completar la actualización: si no salió solo y rápido, se aborta sin swap.
    if (!await exited()) {
      this.deps.log("[updater] core no salió solo tras el commit; se aborta sin intercambiar nada")
      throw new CoreDidNotExit()
    }
    return { pid, start }
  }
}
