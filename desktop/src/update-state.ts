/**
 * Estado persistente del actualizador, bajo `<stateDir>/update`. Sin Electron: el directorio es inyectable.
 *
 * - `state.json`: versión máxima instalada alguna vez, lista negra `{version,digest}` de lo que falló, preferencia, firma
 *   obligatoria y claves adoptadas.
 * - El journal de la actualización en curso (`transaction.json`), sus marcadores y la lista negra lateral los define y
 *   lee `update-transaction.ts` (contrato único compartido con el vigía y la recuperación); aquí sólo se registra el
 *   `staged` inicial.
 * Toda escritura es durable y atómica: archivo temporal + fsync + rename + fsync del directorio.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"
import { compareVersions } from "./updater.js"
import { blocked, isStrictSemver, journalFile, mergeBlacklistSidecars, parseBlacklist, parseTransaction, readTransaction, removeDurable, validateLayout, writeJsonDurable, type BlacklistEntry, type UpdateTransaction } from "./update-transaction.js"
import { parseStopIntent, type StopIntent } from "./stop-intent.js"
import { parseTrustSet, type TrustSet } from "./update-trust.js"

/** `state.json` existe pero no es válido: se bloquea la actualización y se conserva como evidencia, nunca se reescribe. */
export class UpdateStateCorruptError extends Error {
  constructor() {
    super("el estado de las actualizaciones está dañado")
    this.name = "UpdateStateCorruptError"
  }
}

export interface UpdateStateFile {
  /** Versión más alta que esta máquina llegó a instalar; una descarga nunca baja de ella. */
  maxInstalled: string
  /** Versiones (con su artefacto) que fallaron tras instalarse; las cadenas heredadas bloquean la versión entera. */
  blacklist: BlacklistEntry[]
  /** Interruptor de Ajustes. Activado por defecto. */
  enabled: boolean
  /** Una vez que una versión con claves quedó sana, ninguna versión sin firma válida se aplica. Irreversible. */
  requireSignature: boolean
  /** Conjunto de claves adoptado tras una rotación (reemplaza al embebido). */
  trust: TrustSet | null
}

const EMPTY: UpdateStateFile = { maxInstalled: "0.0.0", blacklist: [], enabled: true, requireSignature: false, trust: null }

export function updateDirOf(stateDir: string): string {
  return join(stateDir, "update")
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`
  const fd = openSync(temp, "w", 0o600)
  try {
    writeSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
  const directory = openSync(join(path, ".."), "r")
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

export class UpdateStore {
  readonly dir: string

  constructor(stateDir: string) {
    this.dir = updateDirOf(stateDir)
  }

  private file(name: string): string {
    return join(this.dir, name)
  }

  private ensure(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  /**
   * Estado persistente. Sin archivo, los valores iniciales. Con archivo ilegible o inválido lanza
   * `UpdateStateCorruptError`: degradar a los valores iniciales perdería `requireSignature`, la lista negra
   * y la versión máxima instalada.
   */
  read(): UpdateStateFile {
    let text: string
    try {
      text = readFileSync(this.file("state.json"), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY, blacklist: [] }
      throw new UpdateStateCorruptError()
    }
    let stored: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("forma")
      stored = parsed as Record<string, unknown>
    } catch {
      throw new UpdateStateCorruptError()
    }
    const trust = stored.trust === null || stored.trust === undefined ? null : parseTrustSet(stored.trust)
    const blacklist = parseBlacklist(stored.blacklist)
    const valid = typeof stored.maxInstalled === "string" && isStrictSemver(stored.maxInstalled) && blacklist !== null
      && typeof stored.enabled === "boolean" && typeof stored.requireSignature === "boolean"
      && (stored.trust === null || stored.trust === undefined || trust !== null)
    if (!valid) throw new UpdateStateCorruptError()
    return { maxInstalled: stored.maxInstalled as string, blacklist: blacklist!, enabled: stored.enabled as boolean, requireSignature: stored.requireSignature as boolean, trust }
  }

  private write(state: UpdateStateFile): void {
    this.ensure()
    writeJsonAtomic(this.file("state.json"), state)
  }

  /** Registra la versión que está corriendo como la máxima instalada si supera a la guardada. */
  noteInstalled(version: string): void {
    const state = this.read()
    if (compareVersions(version, state.maxInstalled) > 0) this.write({ ...state, maxInstalled: version })
  }

  /**
   * Incorpora al estado las entradas de lista negra que dejó el vigía en archivos laterales. Las que no se pudieron
   * incorporar (estado ausente o ilegible) se devuelven y `allows` las trata como bloqueadas.
   */
  private pendingBlacklist(): BlacklistEntry[] {
    return mergeBlacklistSidecars(this.dir).pending
  }

  /** Una versión ya instalada o más vieja que la máxima instalada nunca se descarga; la lista negra la bloquea (por versión, o por versión y artefacto cuando se conoce el digest). */
  allows(candidate: string, current: string, digest?: string): boolean {
    const pending = this.pendingBlacklist()
    const state = this.read()
    return isStrictSemver(candidate) && isStrictSemver(current)
      && compareVersions(candidate, current) > 0
      && compareVersions(candidate, state.maxInstalled) > 0
      && !blocked(state.blacklist, candidate, digest)
      && !blocked(pending, candidate, digest)
  }

  isEnabled(): boolean {
    return this.read().enabled
  }

  setEnabled(enabled: boolean): void {
    this.write({ ...this.read(), enabled })
  }

  /** Fija la obligatoriedad de la firma de forma atómica y definitiva. */
  setRequireSignature(): void {
    const state = this.read()
    if (!state.requireSignature) this.write({ ...state, requireSignature: true })
  }

  adoptTrust(trust: TrustSet): void {
    this.write({ ...this.read(), trust })
  }

  /** Intención de parada coordinada. Ausente o ilegible: `null` (sólo guarda un `source_id` y un enfriamiento, nada irrecuperable). */
  readStopIntent(): StopIntent | null {
    try { return parseStopIntent(JSON.parse(readFileSync(this.file("stop-intent.json"), "utf8"))) } catch { return null }
  }

  writeStopIntent(intent: StopIntent): void {
    const checked = parseStopIntent(JSON.parse(JSON.stringify(intent)))
    if (!checked) throw new Error("la intención de parada no cumple el esquema")
    this.ensure()
    writeJsonDurable(this.file("stop-intent.json"), checked)
  }

  clearStopIntent(): void {
    removeDurable(this.file("stop-intent.json"))
  }

  /**
   * Registra el `staged` inicial de una actualización. Una transacción nueva sólo reemplaza a una ausente, terminal o todavía en
   * `staged`; un journal ilegible o más avanzado nunca se pisa. Valida con el parser estricto del contrato antes de escribir.
   */
  stageTransaction(transaction: UpdateTransaction): void {
    const checked = parseTransaction(JSON.parse(JSON.stringify(transaction)))
    // Las rutas tienen que seguir el layout esperado (stage junto al bundle, runtime anterior bajo el estado) antes de que algo dependa de ellas.
    validateLayout(checked, dirname(this.dir))
    const current = readTransaction(this.dir)
    if (current.kind === "corrupt") throw new Error("el journal de la actualización está dañado; no se sobrescribe")
    // Sólo una transacción todavía en `staged` se reemplaza; cualquier otra fase (o un rollback sin cerrar) la resuelve la recuperación.
    if (current.kind === "ok" && current.tx.phase !== "staged") throw new Error("hay otra actualización en curso")
    this.ensure()
    writeJsonDurable(journalFile(this.dir), checked)
  }
}
