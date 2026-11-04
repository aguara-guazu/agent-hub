/**
 * Contrato del journal de actualización y de la lista negra: tipos, validación estricta y nombres. Solo módulos de Node y ningún
 * import del proyecto, para que el vigía lo lleve junto a su copia. Es la ÚNICA definición: el escritorio (Updater), la
 * recuperación y el vigía (Gateway) la importan.
 *
 * `<stateDir>/update/transaction.json`:
 *   { schema:1, transaction_id, phase, from:{version,digest}, to:{version,digest,size,auth}, paths:{installed,incoming,runtime_old},
 *     old_app:{pid,start}, new_app:{pid,start}|null, watchdog:{pid,start}|null, next_trust?, updated_at }
 */
import { basename, dirname, isAbsolute, join, sep } from "node:path"

export const PHASES = ["staged", "watchdog_ready", "swap_intent", "swapped", "launched", "healthy", "done"] as const
export const TERMINAL_PHASES = ["rolled_back", "ambiguous"] as const
export type Phase = (typeof PHASES)[number] | (typeof TERMINAL_PHASES)[number]
export type TrustAuth = "integrity_only" | "publisher_authenticated"

export interface Identity { pid: number; start: string }
export interface TrustKey { id: string; ed25519_spki_b64: string }
/** Claves que anuncia una versión firmada; solo viaja con `publisher_authenticated`. La validación criptográfica es del Updater (`parseTrustSet`). */
export interface NextTrust { keys: TrustKey[]; revoked: string[] }
export interface UpdateTransaction {
  schema: 1
  transaction_id: string
  phase: Phase
  from: { version: string; digest: string }
  to: { version: string; digest: string; size: number; auth: TrustAuth }
  paths: { installed: string; incoming: string; runtime_old: string }
  old_app: Identity
  new_app: Identity | null
  watchdog: Identity | null
  next_trust?: NextTrust
  updated_at: string
}
/** Alias histórico dentro del Gateway. */
export type Transaction = UpdateTransaction

export type JournalRead = { kind: "missing" } | { kind: "corrupt"; reason: string } | { kind: "ok"; tx: UpdateTransaction }

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const TX_ID = /^[A-Za-z0-9-]{8,64}$/
export const HEX64 = /^[a-f0-9]{64}$/
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/

/** SemVer canónico MAJOR.MINOR.PATCH, igual que el del Updater: sin ceros a la izquierda, prerelease ni metadatos de build. */
export const isStrictSemver = (value: unknown): value is string => typeof value === "string" && SEMVER.test(value) && value.split(".").every((part) => Number.isSafeInteger(Number(part)))


/** Respaldo / stage de una transacción: `<bundle>.incoming-<id>` junto al bundle instalado. Único lugar que arma ese nombre. */
export const incomingPath = (installed: string, txId: string): string => join(dirname(installed), `${basename(installed)}.incoming-${txId}`)
export const incomingPrefix = (installed: string): string => `${basename(installed)}.incoming-`

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}: campo desconocido ${key}`)
}

function identity(value: unknown, label: string): Identity {
  if (!isObject(value)) throw new Error(`${label} inválido`)
  onlyKeys(value, ["pid", "start"], label)
  if (!Number.isInteger(value.pid) || (value.pid as number) <= 1 || typeof value.start !== "string" || !value.start) throw new Error(`${label} inválido`)
  return { pid: value.pid as number, start: value.start }
}

function nextTrust(value: unknown): NextTrust {
  if (!isObject(value)) throw new Error("next_trust inválido")
  onlyKeys(value, ["keys", "revoked"], "next_trust")
  if (!Array.isArray(value.keys) || !Array.isArray(value.revoked)) throw new Error("next_trust inválido")
  const ids = new Set<string>()
  const keys = value.keys.map((entry): TrustKey => {
    if (!isObject(entry)) throw new Error("next_trust: clave inválida")
    onlyKeys(entry, ["id", "ed25519_spki_b64"], "next_trust.keys")
    if (typeof entry.id !== "string" || !KEY_ID.test(entry.id) || ids.has(entry.id) || typeof entry.ed25519_spki_b64 !== "string" || !BASE64.test(entry.ed25519_spki_b64)) throw new Error("next_trust: clave inválida")
    ids.add(entry.id)
    return { id: entry.id, ed25519_spki_b64: entry.ed25519_spki_b64 }
  })
  if (!value.revoked.every((id) => typeof id === "string" && KEY_ID.test(id))) throw new Error("next_trust: revocación inválida")
  return { keys, revoked: [...new Set(value.revoked as string[])] }
}

/** Valida forma, valores y campos del journal; lanza con el motivo si algo no corresponde al contrato. No admite campos desconocidos. */
export function parseTransaction(raw: unknown): UpdateTransaction {
  if (!isObject(raw)) throw new Error("no es un objeto")
  onlyKeys(raw, ["schema", "transaction_id", "phase", "from", "to", "paths", "old_app", "new_app", "watchdog", "next_trust", "updated_at"], "journal")
  if (raw.schema !== 1) throw new Error("schema desconocido")
  if (typeof raw.transaction_id !== "string" || !TX_ID.test(raw.transaction_id)) throw new Error("transaction_id inválido")
  if (typeof raw.phase !== "string" || ![...PHASES, ...TERMINAL_PHASES].includes(raw.phase as Phase)) throw new Error("fase desconocida")
  const { from, to, paths } = raw
  if (!isObject(from) || !isObject(to) || !isObject(paths)) throw new Error("from, to o paths inválidos")
  onlyKeys(from, ["version", "digest"], "from")
  onlyKeys(to, ["version", "digest", "size", "auth"], "to")
  onlyKeys(paths, ["installed", "incoming", "runtime_old"], "paths")
  if (!isStrictSemver(from.version) || typeof from.digest !== "string" || !HEX64.test(from.digest)) throw new Error("from inválido")
  if (!isStrictSemver(to.version) || typeof to.digest !== "string" || !HEX64.test(to.digest) || !Number.isSafeInteger(to.size) || (to.size as number) <= 0
    || (to.auth !== "integrity_only" && to.auth !== "publisher_authenticated")) throw new Error("to inválido")
  if (![paths.installed, paths.incoming, paths.runtime_old].every((path) => typeof path === "string" && isAbsolute(path))) throw new Error("rutas inválidas")
  if (typeof raw.updated_at !== "string" || !ISO_UTC.test(raw.updated_at) || !Number.isFinite(Date.parse(raw.updated_at))) throw new Error("updated_at inválido")
  const trust = raw.next_trust === undefined ? undefined : nextTrust(raw.next_trust)
  if (trust && to.auth !== "publisher_authenticated") throw new Error("next_trust solo con publisher_authenticated")
  return {
    schema: 1, transaction_id: raw.transaction_id, phase: raw.phase as Phase,
    from: { version: from.version, digest: from.digest as string },
    to: { version: to.version, digest: to.digest as string, size: to.size as number, auth: to.auth as TrustAuth },
    paths: { installed: paths.installed as string, incoming: paths.incoming as string, runtime_old: paths.runtime_old as string },
    old_app: identity(raw.old_app, "old_app"),
    new_app: raw.new_app === null ? null : identity(raw.new_app, "new_app"),
    watchdog: raw.watchdog === null ? null : identity(raw.watchdog, "watchdog"),
    ...(trust ? { next_trust: trust } : {}),
    updated_at: raw.updated_at,
  }
}

/** Las rutas absolutas deben tener exactamente el layout esperado antes de cualquier borrado o intercambio. */
export function validateLayout(tx: UpdateTransaction, stateDir: string): void {
  const { installed, incoming, runtime_old: runtimeOld } = tx.paths
  const clean = (path: string): boolean => path === join(path) && !path.split(sep).includes("..")
  if (![installed, incoming, runtimeOld].every(clean)) throw new Error("ruta sin normalizar")
  if (!basename(installed).endsWith(".app")) throw new Error("installed no es un .app")
  if (incoming !== incomingPath(installed, tx.transaction_id)) throw new Error("incoming no corresponde a la transacción")
  if (runtimeOld !== join(stateDir, "runtime", "versions", tx.from.version, basename(installed))) throw new Error("runtime_old no corresponde a la versión anterior")
}


/** Una fase de la secuencia nunca retrocede; las terminales no se sobreescriben con otra y se alcanzan desde cualquier fase. */
export function canAdvance(from: Phase, to: Phase): boolean {
  if ((TERMINAL_PHASES as readonly string[]).includes(from)) return from === to
  if ((TERMINAL_PHASES as readonly string[]).includes(to)) return true
  return phaseRank(to) >= phaseRank(from)
}
export const phaseRank = (phase: Phase): number => (PHASES as readonly string[]).indexOf(phase)

/** `digest: null` solo en entradas migradas de cadenas antiguas: bloquean la versión sin importar el artefacto. */
export interface BlacklistEntry { version: string; digest: string | null }

/**
 * Lee `state.blacklist` aceptando el esquema único y, para migrar, las cadenas antiguas (versión estricta). Devuelve `null` si
 * hay cualquier otra forma: quien llama trata el estado como no legible y no lo toca.
 */
export function parseBlacklist(value: unknown): BlacklistEntry[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const entries: BlacklistEntry[] = []
  for (const item of value) {
    if (isStrictSemver(item)) { entries.push({ version: item, digest: null }); continue }
    if (!isObject(item) || Object.keys(item).some((key) => key !== "version" && key !== "digest") || !isStrictSemver(item.version)) return null
    if (item.digest !== null && (typeof item.digest !== "string" || !HEX64.test(item.digest))) return null
    entries.push({ version: item.version, digest: item.digest })
  }
  return entries
}

/** ¿Bloquea la lista negra a esta versión? Con digest conocido, una entrada con otro digest (artefacto distinto) no la bloquea. */
export function blocked(entries: readonly BlacklistEntry[], version: string, digest?: string): boolean {
  return entries.some((entry) => entry.version === version && (entry.digest === null || digest === undefined || entry.digest === digest))
}


// ---------------------------------------------------------------------------------------------------------------------
// Marcadores por transacción

/** `started-<transaction_id>.json`: lo escribe la app que arrancó (la nueva, o la restaurada tras un rollback) con su identidad exacta. */
export interface StartedMarker { transaction_id: string; version: string; pid: number; start: string }
/** `healthy-<transaction_id>.json`: la versión nueva confirma core, daemon y sesión sanos durante la ventana estable. */
export interface HealthyMarker { transaction_id: string; version: string; at: string }

export function parseStartedMarker(raw: unknown): StartedMarker | null {
  if (!isObject(raw) || Object.keys(raw).some((key) => !["transaction_id", "version", "pid", "start"].includes(key))) return null
  if (typeof raw.transaction_id !== "string" || !TX_ID.test(raw.transaction_id) || !isStrictSemver(raw.version) || !Number.isInteger(raw.pid) || (raw.pid as number) <= 1 || typeof raw.start !== "string" || !raw.start) return null
  return { transaction_id: raw.transaction_id, version: raw.version, pid: raw.pid as number, start: raw.start }
}

export function parseHealthyMarker(raw: unknown): HealthyMarker | null {
  if (!isObject(raw) || Object.keys(raw).some((key) => !["transaction_id", "version", "at"].includes(key))) return null
  if (typeof raw.transaction_id !== "string" || !TX_ID.test(raw.transaction_id) || !isStrictSemver(raw.version) || typeof raw.at !== "string" || !ISO_UTC.test(raw.at)) return null
  return { transaction_id: raw.transaction_id, version: raw.version, at: raw.at }
}
