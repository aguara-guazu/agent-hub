/**
 * Recuperación de una transacción de actualización interrumpida (macOS), a partir del journal del contrato B.
 *
 * Se ejecuta al arrancar cualquier versión de la app. Es idempotente y conservadora: borra únicamente lo que el journal válido
 * señala (`.incoming-<transaction_id>` junto al bundle instalado) y solo cuando las versiones de las dos rutas confirman de qué
 * lado quedó cada una. Ausencia o corrupción del journal con restos `.incoming-*`, rutas inesperadas o versiones que no
 * coinciden son ambiguos: no se borra nada ni se declara salud.
 */
import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import {
  addToBlacklist, advancePhase, bundleVersion, clearTransactionFiles, hasIncomingRemnants, inspectSides, readTransaction, removeDurable, removeTreeDurable,
  startedFile, validateLayout, writeJsonDurable, type UpdateTransaction as Transaction,
} from "./update-transaction.js"
import { sameProcess, startTimeOf } from "./update-watchdog.js"

export { settled } from "./update-watchdog.js"

export type Recovery = "none" | "cleaned" | "monitor" | "waiting_watchdog" | "rolled_back_cleaned" | "rolled_back_pending_watchdog" | "ambiguous"

export interface RecoveryDeps {
  stateDir: string
  /** `<stateDir>/update`. */
  updateDir: string
  /** Bundle instalado de esta app (`/Applications/Agent Hub.app`). */
  installed: string
  /** Versión de la app que está corriendo ahora. */
  version: string
  /** Borrado de un árbol; se inyecta para poder simularlo. Por defecto `rm -rf`. */
  removeTree?: (path: string) => Promise<void>
  /** PID de esta app, para el marcador de arranque tras un rollback. Por defecto `process.pid`. */
  pid?: number
  /** Identidad de proceso: por defecto compara PID e inicio con `ps`. */
  isAlive?: (identity: { pid: number; start: string }) => boolean
  log: (line: string) => void
}

const defaultRemove = async (path: string): Promise<void> => { rmSync(path, { recursive: true, force: true }) }

export async function recoverTransaction(deps: RecoveryDeps): Promise<Recovery> {
  const { log } = deps
  const remove = deps.removeTree ?? defaultRemove
  const alive = deps.isAlive ?? sameProcess
  const journal = readTransaction(deps.updateDir)

  if (journal.kind === "corrupt") {
    log(`[updater] el journal de actualización es ilegible (${journal.reason}); se conserva todo y no se declara salud`)
    return "ambiguous"
  }
  if (journal.kind === "missing") {
    if (hasIncomingRemnants(deps.installed)) {
      log("[updater] hay restos .incoming-* sin journal; pueden ser el único respaldo de la versión anterior: no se borró nada")
      return "ambiguous"
    }
    // Sin transacción ni restos, los marcadores sueltos no refieren a nada.
    try {
      for (const name of readdirSync(deps.updateDir)) if (/^(started|healthy|watchdog-ready)-[A-Za-z0-9-]+\.json$|^watchdog-[A-Za-z0-9-]+$/.test(name)) removeDurable(join(deps.updateDir, name))
    } catch { /* el directorio puede no existir */ }
    return "none"
  }

  const tx = journal.tx
  const ambiguous = (reason: string): Recovery => { log(`[updater] transacción ${tx.transaction_id} (${tx.phase}) ambigua: ${reason}; no se borró nada`); return "ambiguous" }
  try { validateLayout(tx, deps.stateDir) } catch (error) { return ambiguous(`rutas inesperadas (${error instanceof Error ? error.message : String(error)})`) }
  if (tx.paths.installed !== deps.installed) return ambiguous("el bundle instalado no coincide con el del journal")

  /** Borra el respaldo señalado por el journal y, solo si el borrado quedó durable, cierra la transacción. */
  const finish = async (): Promise<boolean> => {
    try { await removeTreeDurable(tx.paths.incoming, remove) } catch (error) {
      log(`[updater] no se pudo borrar el respaldo ${tx.paths.incoming}: ${error instanceof Error ? error.message : String(error)}; se conserva la transacción`)
      return false
    }
    clearTransactionFiles(deps.updateDir, tx.transaction_id)
    return true
  }
  const running = deps.version

  switch (tx.phase) {
    case "staged":
    case "watchdog_ready":
      // El intercambio nunca empezó: lo que hay junto al bundle es una descarga preparada.
      if (running !== tx.from.version) return ambiguous("la app que corre no es la que preparó el stage")
      if (bundleVersion(tx.paths.installed) !== tx.from.version) return ambiguous("el bundle instalado no es la versión anterior")
      return (await finish()) ? "cleaned" : ambiguous("el respaldo no se pudo borrar de forma durable")

    case "swap_intent": {
      const sides = inspectSides(tx)
      if (sides === "not_swapped" && running === tx.from.version) return (await finish()) ? "cleaned" : ambiguous("el respaldo no se pudo borrar de forma durable")
      if (sides === "swapped" && running === tx.to.version) {
        // El intercambio ocurrió y se cortó antes de anotarlo: la fase se alcanza y la versión nueva sigue su confirmación.
        advancePhase(deps.updateDir, tx.transaction_id, "swapped")
        return "monitor"
      }
      return ambiguous("las versiones de las dos rutas no permiten saber cómo quedó el intercambio")
    }

    case "swapped":
    case "launched": {
      if (running === tx.to.version && inspectSides(tx) === "swapped") return "monitor"
      if (running === tx.from.version && inspectSides(tx) === "not_swapped") {
        // El vigía ya devolvió la versión anterior y se cortó antes de anotarlo.
        return finishRollback(deps, tx, remove)
      }
      if (tx.watchdog && alive(tx.watchdog)) return "waiting_watchdog"
      return ambiguous("la versión que corre no es ninguna de las dos o el intercambio quedó a medias")
    }

    case "healthy":
    case "done":
      if (running !== tx.to.version || inspectSides(tx) !== "swapped") return ambiguous("la app que corre no es la confirmada")
      return (await finish()) ? "cleaned" : ambiguous("el respaldo no se pudo borrar de forma durable")

    case "rolled_back":
      if (running !== tx.from.version || inspectSides(tx) !== "not_swapped") return ambiguous("la app que corre no es la versión restaurada")
      return finishRollback(deps, tx, remove)

    default:
      return ambiguous("el rollback no se completó")
  }
}

/**
 * Cierra un rollback ya hecho: la versión fallida queda en la lista negra con su digest, esta app (la restaurada) deja su marcador
 * `started-<id>.json` con su PID e inicio exactos —es la prueba que espera el vigía— y se borra el respaldo fallido. El journal solo
 * se cierra si el vigía ya no existe; si sigue vivo, él lo cierra al ver el marcador.
 */
async function finishRollback(deps: RecoveryDeps, tx: Transaction, remove: (path: string) => Promise<void>): Promise<Recovery> {
  const alive = deps.isAlive ?? sameProcess
  const where = addToBlacklist(deps.updateDir, { version: tx.to.version, digest: tx.to.digest }, tx.transaction_id)
  // Con la lista negra en un archivo lateral (state.json ilegible) el journal se conserva: ese archivo es la única constancia.
  if (where === "sidecar") deps.log(`[updater] v${tx.to.version} quedó registrada en un archivo aparte porque state.json no es legible; se conserva la transacción`)
  const pid = deps.pid ?? process.pid, start = startTimeOf(pid)
  if (start) writeJsonDurable(startedFile(deps.updateDir, tx.transaction_id), { transaction_id: tx.transaction_id, version: deps.version, pid, start })
  if (tx.phase !== "rolled_back") advancePhase(deps.updateDir, tx.transaction_id, "rolled_back")
  try { await removeTreeDurable(tx.paths.incoming, remove) } catch (error) {
    deps.log(`[updater] no se pudo borrar el respaldo fallido: ${error instanceof Error ? error.message : String(error)}; se conserva la transacción`)
    return "ambiguous"
  }
  if (where === "sidecar") return "ambiguous"
  deps.log(`[updater] v${tx.to.version} quedó en lista negra tras el rollback (${tx.transaction_id})`)
  if (tx.watchdog && alive(tx.watchdog)) return "rolled_back_pending_watchdog"
  clearTransactionFiles(deps.updateDir, tx.transaction_id)
  return "rolled_back_cleaned"
}
