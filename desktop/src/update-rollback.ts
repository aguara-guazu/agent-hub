/**
 * Confirmación de salud de la versión recién aplicada. Sin Electron: procesos, disco y reloj son inyectables. El vigía y la
 * recuperación del arranque son de `update-watchdog.ts` y `update-recovery.ts`; aquí sólo se decide cuándo una versión nueva está sana.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { advancePhase, clearTransactionFiles, healthyFile, readTransaction, startedFile, writeJsonDurable, type UpdateTransaction } from "./update-transaction.js"

/** Arranque de core y sesión del escritorio: igual a `SESSION_TIMEOUT_MS` de main.ts. */
export const HEALTH_STARTUP_MS = 60_000
/** Core, daemon, sesión y sonda MCP deben mantenerse sanos este tiempo seguido antes de confirmar. */
export const HEALTH_STABLE_MS = 30_000
/** Tope de una sonda `tools/list`. */
export const HEALTH_PROBE_TIMEOUT_MS = 15_000
/** Holgura para planificación, E/S y reintentos de la sonda. */
export const HEALTH_MARGIN_MS = 75_000
/** Plazo que tiene la versión nueva para confirmar salud antes de volver a la anterior: arranque + ventana estable + sonda + holgura (180 s). */
export const HEALTH_DEADLINE_MS = HEALTH_STARTUP_MS + HEALTH_STABLE_MS + HEALTH_PROBE_TIMEOUT_MS + HEALTH_MARGIN_MS

/** Hora de inicio de un proceso (`ps -o lstart=`); junto con el PID identifica al proceso aunque el PID se recicle. */
export async function processStartTime(pid: number): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5_000, windowsHide: true })
    return String(stdout).trim() || null
  } catch {
    return null
  }
}

export interface StableHealth {
  /** `true` cuando core, daemon, sesión y la sonda MCP están sanos. Sólo lee: no cambia ningún estado. */
  healthy: () => boolean | Promise<boolean>
  now?: () => number
  pollMs?: number
  stableMs?: number
  /** Tras este tiempo sin lograrlo se deja de intentar. */
  giveUpMs?: number
}

/** Observa sin mutar nada y avisa una sola vez cuando la salud se mantiene durante la ventana estable. Devuelve la función que lo detiene. */
export function whenStablyHealthy(deps: StableHealth, onHealthy: () => void | Promise<void>): () => void {
  const now = deps.now ?? Date.now
  const startedAt = now()
  let healthySince: number | null = null
  let done = false
  let busy = false
  const tick = async (): Promise<void> => {
    const current = now()
    if (current - startedAt > (deps.giveUpMs ?? 5 * 60_000)) { stop(); return }
    const sane = await Promise.resolve(deps.healthy()).catch(() => false)
    if (done) return
    if (!sane) { healthySince = null; return }
    healthySince ??= now()
    if (now() - healthySince < (deps.stableMs ?? HEALTH_STABLE_MS)) return
    done = true
    stop()
    await onHealthy()
  }
  // Una sola evaluación a la vez: una sonda lenta no se solapa con la siguiente.
  const timer = setInterval(() => {
    if (done || busy) return
    busy = true
    void tick().catch(() => undefined).finally(() => { busy = false })
  }, deps.pollMs ?? 2_000)
  timer.unref()
  function stop(): void { clearInterval(timer) }
  return stop
}

export interface HealthDeps extends StableHealth {
  /** `<stateDir>/update`. */
  updateDir: string
  transaction: UpdateTransaction
  pid: number
  startTime: string
  /** Borra el respaldo de forma durable (rechaza si algo quedó o el fsync falla). */
  discardBackup: () => Promise<void>
  /** Persists trust and other state before health is declared. */
  onConfirmed?: () => void
  /** Runs only after healthy/done and transaction cleanup are durable. */
  onCompleted?: () => void
  log: (line: string) => void
}

/**
 * Se arma al arrancar la versión recién instalada. Registra su PID y hora de inicio (`started-<id>.json`, fase `launched`) y,
 * con core, daemon y sesión sanos durante la ventana estable: persiste lo que traía, escribe `healthy-<id>.json`, avanza a
 * `healthy`, borra el respaldo de forma durable y recién entonces cierra la transacción. Cada paso es repetible; si algo falla no
 * se declara sana, se conserva el respaldo y el vigía revierte al vencer su plazo.
 */
export function confirmWhenHealthy(deps: HealthDeps): () => void {
  const now = deps.now ?? Date.now
  const { updateDir, transaction: tx } = deps
  writeJsonDurable(startedFile(updateDir, tx.transaction_id), { transaction_id: tx.transaction_id, version: tx.to.version, pid: deps.pid, start: deps.startTime })
  const current = readTransaction(updateDir)
  if (current.kind !== "ok" || current.tx.transaction_id !== tx.transaction_id) throw new Error("la transacción cambió antes de registrar la app nueva")
  const identity = { new_app: { pid: deps.pid, start: deps.startTime } }
  if (current.tx.phase === "swapped") advancePhase(updateDir, tx.transaction_id, "launched", identity)
  else if (["launched", "admitting", "admitted"].includes(current.tx.phase)) advancePhase(updateDir, tx.transaction_id, current.tx.phase, identity)
  else throw new Error(`la fase ${current.tx.phase} no admite una app nueva`)
  return whenStablyHealthy(deps, async () => {
    try {
      deps.onConfirmed?.()
      writeJsonDurable(healthyFile(updateDir, tx.transaction_id), { transaction_id: tx.transaction_id, version: tx.to.version, at: new Date(now()).toISOString() })
      advancePhase(updateDir, tx.transaction_id, "healthy")
      await deps.discardBackup()
      advancePhase(updateDir, tx.transaction_id, "done")
      clearTransactionFiles(updateDir, tx.transaction_id)
      deps.onCompleted?.()
      deps.log(`[updater] v${tx.to.version}: actualización confirmada (${tx.transaction_id})`)
    } catch (error) {
      deps.log(`[updater] no se confirmó la actualización; se conserva el respaldo y la evidencia: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
