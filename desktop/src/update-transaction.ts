/**
 * Primitivas durables del journal de actualización (E/S en disco, avance de fase, lista negra, candado) sobre el contrato de
 * `update-contract.ts`, que define los tipos y la validación. Solo módulos de Node: el vigía lo lleva junto a su copia.
 */
import { execFileSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  HEX64, canAdvance, incomingPrefix, isStrictSemver, parseBlacklist, parseTransaction,
  type BlacklistEntry, type Identity, type Phase, type UpdateTransaction,
} from "./update-contract.js"

export * from "./update-contract.js"

export type Transaction = UpdateTransaction
export type JournalRead = { kind: "missing" } | { kind: "corrupt"; reason: string } | { kind: "ok"; tx: UpdateTransaction }

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)

export const journalFile = (dir: string): string => join(dir, "transaction.json")
export const startedFile = (dir: string, id: string): string => join(dir, `started-${id}.json`)
export const healthyFile = (dir: string, id: string): string => join(dir, `healthy-${id}.json`)
export const readyFile = (dir: string, id: string): string => join(dir, `watchdog-ready-${id}.json`)
export const rollbackRequestFile = (dir: string, id: string): string => join(dir, `rollback-request-${id}.json`)
export const rollbackReadyFile = (dir: string, id: string): string => join(dir, `rollback-ready-${id}.json`)
/** Directorio con la copia del vigía y de este módulo para una transacción. */
export const watchdogDir = (dir: string, id: string): string => join(dir, `watchdog-${id}`)
export const sidecarFile = (dir: string, id: string): string => join(dir, `blacklist-${id}.json`)


// ---------------------------------------------------------------------------------------------------------------------
// Disco durable

export function fsyncPathSync(path: string): void {
  const fd = openSync(path, "r")
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export function writeJsonDurable(path: string, value: unknown): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`
  const fd = openSync(temp, "w", 0o600)
  try { writeSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
  try { renameSync(temp, path) } catch (error) { rmSync(temp, { force: true }); throw error }
  fsyncPathSync(dirname(path))
}

export function removeDurable(path: string): void {
  rmSync(path, { recursive: true, force: true })
  try { fsyncPathSync(dirname(path)) } catch { /* el directorio puede no existir ya */ }
}

/**
 * Borra un árbol con un borrador inyectable y solo da la limpieza por hecha si el árbol ya no existe y el directorio padre
 * quedó sincronizado; si no, lanza y quien llama conserva el journal.
 */
export async function removeTreeDurable(path: string, remove: (path: string) => Promise<void>): Promise<void> {
  await remove(path)
  if (existsSync(path)) throw new Error(`no se pudo borrar ${path}`)
  fsyncPathSync(dirname(path))
}

export function readJson(path: string): { ok: true; value: unknown } | { ok: false; missing: boolean } {
  let raw: string
  try { raw = readFileSync(path, "utf8") } catch (error) { return { ok: false, missing: (error as NodeJS.ErrnoException).code === "ENOENT" } }
  try { return { ok: true, value: JSON.parse(raw) } } catch { return { ok: false, missing: false } }
}

// ---------------------------------------------------------------------------------------------------------------------
// Validación estricta del journal

export function readTransaction(dir: string): JournalRead {
  const read = readJson(journalFile(dir))
  if (!read.ok) return read.missing ? { kind: "missing" } : { kind: "corrupt", reason: "ilegible o no es JSON" }
  try { return { kind: "ok", tx: parseTransaction(read.value) } } catch (error) { return { kind: "corrupt", reason: error instanceof Error ? error.message : String(error) } }
}


/**
 * Avanza la fase de forma durable. Una fase de la secuencia nunca retrocede; las terminales se pueden escribir desde cualquier
 * fase y no se sobreescriben con otra. Devuelve el journal escrito.
 */
export function advancePhase(dir: string, expectedId: string, phase: Phase, patch: Partial<Pick<UpdateTransaction, "new_app" | "watchdog">> = {}): UpdateTransaction {
  const current = readTransaction(dir)
  if (current.kind !== "ok" || current.tx.transaction_id !== expectedId) throw new Error("el journal no corresponde a esta transacción")
  const from = current.tx.phase
  if (!canAdvance(from, phase)) throw new Error(`la fase no puede pasar de ${from} a ${phase}`)
  const next: UpdateTransaction = { ...current.tx, ...patch, phase, updated_at: new Date().toISOString() }
  writeJsonDurable(journalFile(dir), next)
  return next
}

/** Quita el journal, los marcadores, la copia del vigía y el sidecar de una transacción, con fsync del directorio. */
export function clearTransactionFiles(dir: string, id: string): void {
  for (const file of [journalFile(dir), startedFile(dir, id), healthyFile(dir, id), readyFile(dir, id), rollbackRequestFile(dir, id), rollbackReadyFile(dir, id), watchdogDir(dir, id), sidecarFile(dir, id)]) removeDurable(file)
}

// ---------------------------------------------------------------------------------------------------------------------
// Exclusión del intercambio de vuelta

const swapBackLock = (dir: string): string => join(dir, "swap-back.lock")

/**
 * Exclusión para deshacer un intercambio: quien lo hace (el vigía, o la app vieja si pierde el lease) toma este candado antes
 * de invocar el helper, para que dos intercambios de vuelta nunca se encadenen y vuelvan a dejar la versión nueva instalada.
 * Un candado cuyo dueño ya no existe se recupera. Devuelve la función que lo libera, o `null` si lo tiene otro proceso vivo.
 */
export function acquireSwapBackLock(dir: string, owner: Identity, alive: (identity: Identity) => boolean): (() => void) | null {
  const path = swapBackLock(dir)
  const nonce = randomBytes(16).toString("hex")
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600)
      try { writeSync(fd, JSON.stringify({ ...owner, nonce })); fsyncSync(fd) } finally { closeSync(fd) }
      fsyncPathSync(dir)
      return () => {
        const current = readJson(path)
        if (current.ok && isObject(current.value) && current.value.nonce === nonce) removeDurable(path)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let before: ReturnType<typeof statSync>
      try { before = statSync(path) } catch { continue }
      const holder = readJson(path)
      const value = holder.ok && isObject(holder.value) ? holder.value : null
      const identity = value && Number.isInteger(value.pid) && typeof value.start === "string"
        ? { pid: value.pid as number, start: value.start } : null
      if (identity && alive(identity)) return null
      if (!value || typeof value.nonce !== "string") {
        if (Date.now() - before.mtimeMs <= 60_000) return null
        let after: ReturnType<typeof statSync>
        try { after = statSync(path) } catch { continue }
        if (after.ino === before.ino && after.mtimeMs === before.mtimeMs && after.size === before.size) removeDurable(path)
        continue
      }
      const current = readJson(path)
      if (!current.ok || !isObject(current.value) || current.value.nonce !== value.nonce) continue
      removeDurable(path)
    }
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------------
// Bundles

export function bundleVersion(app: string): string | null {
  try { return execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", "--", join(app, "Contents", "Info.plist")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null } catch { return null }
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

/** Lado en que quedó cada versión tras un intercambio posiblemente interrumpido. */
export type Sides = "not_swapped" | "swapped" | "unknown"

export function inspectSides(tx: UpdateTransaction): Sides {
  const installed = bundleVersion(tx.paths.installed), incoming = existsSync(tx.paths.incoming) ? bundleVersion(tx.paths.incoming) : null
  if (installed === tx.from.version && incoming === tx.to.version) return "not_swapped"
  if (installed === tx.to.version && incoming === tx.from.version) return "swapped"
  return "unknown"
}

export function hasIncomingRemnants(installed: string): boolean {
  try { return readdirSync(dirname(installed)).some((name) => name.startsWith(incomingPrefix(installed))) } catch { return true }
}

// ---------------------------------------------------------------------------------------------------------------------
// Lista negra: esquema único `{version, digest}[]`

/**
 * Agrega `{version, digest}` a la lista negra de `state.json` conservando todo lo demás (ratchet, claves, versión máxima).
 * Si el estado falta, no es legible o la lista tiene otra forma, NO se reconstruye desde `{}`: la entrada queda en
 * `blacklist-<id>.json` y el estado intacto. Devuelve dónde quedó registrada.
 */
export function addToBlacklist(dir: string, entry: { version: string; digest: string }, transactionId: string): "state" | "sidecar" {
  const sidecar = (): "sidecar" => { writeJsonDurable(sidecarFile(dir, transactionId), { transaction_id: transactionId, ...entry }); return "sidecar" }
  const read = readJson(join(dir, "state.json"))
  if (!read.ok || !isObject(read.value)) return sidecar()
  const entries = parseBlacklist(read.value.blacklist)
  if (!entries) return sidecar()
  if (entries.some((item) => item.version === entry.version && (item.digest === null || item.digest === entry.digest))) return "state"
  writeJsonDurable(join(dir, "state.json"), { ...read.value, blacklist: [...entries, entry] })
  return "state"
}

/**
 * Incorpora los `blacklist-<id>.json` pendientes al estado cuando es legible. Devuelve cuántos quedan sin incorporar (estado
 * ausente o ilegible): mientras haya alguno, quien decide qué descargar debe tratar esas versiones como bloqueadas.
 */
export function mergeBlacklistSidecars(dir: string): { merged: number; pending: BlacklistEntry[] } {
  let merged = 0
  const pending: BlacklistEntry[] = []
  let names: string[] = []
  try { names = readdirSync(dir).filter((name) => /^blacklist-[A-Za-z0-9-]{4,64}\.json$/.test(name)) } catch { return { merged, pending } }
  for (const name of names) {
    const read = readJson(join(dir, name))
    const value = read.ok && isObject(read.value) ? read.value : null
    if (!value || typeof value.transaction_id !== "string" || !isStrictSemver(value.version) || typeof value.digest !== "string" || !HEX64.test(value.digest)) continue
    const where = addToBlacklist(dir, { version: value.version, digest: value.digest }, value.transaction_id)
    if (where === "state") { removeDurable(join(dir, name)); merged += 1 } else pending.push({ version: value.version, digest: value.digest })
  }
  return { merged, pending }
}
