/**
 * Intención de parada coordinada del Hub que sobrevive a un reinicio del escritorio (`update/stop-intent.json`). Guarda el
 * `source_id` con el que se pidió la parada (la misma solicitud devuelve la misma parada), el `transaction_id` de una
 * actualización que el core nuevo debe admitir, y el enfriamiento posterior a una parada que no llegó al commit. Sin Electron.
 */
import type { HubStopOutcome, HubStopReason, HubStopView } from "./hub-stop.js"

export type StopStrategy = "dmg" | "nsis" | "appimage"

export interface StopIntent {
  schema: 1
  source_id: string
  reason: HubStopReason
  strategy?: StopStrategy
  /** Sólo en actualizaciones: identifica la transacción que el core nuevo admite al arrancar. */
  transaction_id?: string
  target_version?: string
  stop_id?: string
  /** Sólo NSIS: el instalador falló tras el commit y se relanzó esta versión, que puede admitir la transacción de la parada aplicada. */
  recovery_version?: string
  /** La parada terminó sin commit: el próximo intento usa otro `source_id` y no empieza antes de esta hora (ISO 8601). */
  cooldown_until?: string
}

/** Tiempo mínimo entre una parada de update que no llegó al commit y la siguiente cuando el backend no indica otro. */
export const STOP_COOLDOWN_MS = 30 * 60_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_ID = /^[A-Za-z0-9._-]{1,100}$/
const KEYS = new Set(["schema", "source_id", "reason", "strategy", "transaction_id", "target_version", "stop_id", "cooldown_until", "recovery_version"])

const isoOrNull = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null

/** Parser estricto: una clave desconocida o un valor fuera de forma invalida todo el archivo. */
export function parseStopIntent(value: unknown): StopIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => !KEYS.has(key))) return null
  if (raw.schema !== 1 || typeof raw.source_id !== "string" || !UUID.test(raw.source_id)) return null
  if (raw.reason !== "update" && raw.reason !== "quit") return null
  if (raw.strategy !== undefined && raw.strategy !== "dmg" && raw.strategy !== "nsis" && raw.strategy !== "appimage") return null
  for (const key of ["transaction_id", "stop_id"] as const) if (raw[key] !== undefined && (typeof raw[key] !== "string" || !SAFE_ID.test(raw[key] as string))) return null
  if (raw.target_version !== undefined && (typeof raw.target_version !== "string" || !SAFE_ID.test(raw.target_version))) return null
  if (raw.cooldown_until !== undefined && isoOrNull(raw.cooldown_until) === null) return null
  if (raw.recovery_version !== undefined && (typeof raw.recovery_version !== "string" || !SAFE_ID.test(raw.recovery_version) || raw.reason !== "update" || raw.strategy !== "nsis")) return null
  if (raw.reason === "update" && (!raw.transaction_id || !raw.target_version || !raw.strategy)) return null
  if (raw.reason === "quit" && (raw.transaction_id !== undefined || raw.target_version !== undefined || raw.cooldown_until !== undefined || raw.recovery_version !== undefined)) return null
  return raw as unknown as StopIntent
}

/** Hora (ms desde epoch) hasta la cual no se pide otra parada de update, o 0 si no hay enfriamiento. */
export function cooldownUntilMs(intent: StopIntent | null): number {
  const at = intent?.cooldown_until ? Date.parse(intent.cooldown_until) : 0
  return Number.isFinite(at) ? at : 0
}

/** El intento puede continuar con el mismo `source_id` (misma parada) sólo si no terminó y describe la misma actualización. */
export function sameAttempt(intent: StopIntent | null, wanted: { reason: HubStopReason; strategy?: StopStrategy; transactionId?: string; targetVersion?: string }): intent is StopIntent {
  return Boolean(intent) && !intent!.cooldown_until && intent!.reason === wanted.reason && intent!.strategy === wanted.strategy
    && intent!.transaction_id === wanted.transactionId && intent!.target_version === wanted.targetVersion
}

/**
 * Enfriamiento tras una parada que no llegó al commit. Un `postponed` manda la hora que fijó el backend (`retry_not_before`);
 * cancelada o fallida, y un `postponed` sin esa hora, esperan `STOP_COOLDOWN_MS`.
 */
export function cooldownAfter(outcome: Exclude<HubStopOutcome, { kind: "committed" }>, now: number): string {
  const backend = outcome.kind === "postponed" ? outcome.view.retryNotBefore : null
  const at = backend ? Date.parse(backend) : NaN
  return new Date(Number.isFinite(at) && at > now ? at : now + STOP_COOLDOWN_MS).toISOString()
}

/** ¿Esta versión puede abrir el core de la actualización aplicada? La destino siempre; en NSIS también la que quedó tras un instalador fallido. */
export function intentOpensCore(intent: StopIntent, runningVersion: string): boolean {
  return intent.reason === "update" && Boolean(intent.transaction_id)
    && (intent.target_version === runningVersion || (intent.strategy === "nsis" && intent.recovery_version === runningVersion))
}

/** Marca de forma estricta que el instalador NSIS falló y que `currentVersion` debe poder admitir la transacción ya aplicada. */
export function withInstallerFailure(intent: StopIntent, currentVersion: string): StopIntent {
  return intent.reason === "update" && intent.strategy === "nsis" ? { ...intent, recovery_version: currentVersion } : intent
}

/** Transacción que el core recién arrancado debe admitir; sin intención manda el journal, con ella sólo una versión que pueda abrirlo (en macOS, además, la del journal). */
export function startupTransactionFor(intent: StopIntent | null, journalId: string, runningVersion: string): string {
  if (!intent) return journalId
  if (!intentOpensCore(intent, runningVersion)) return ""
  if (intent.strategy === "dmg") return journalId === intent.transaction_id ? journalId : ""
  return intent.transaction_id!
}
/** Resultado de leer la intención: ausente y dañada se distinguen, porque ninguna de las dos puede abrir un core de actualización. */
export type StopIntentRead = { kind: "ok"; intent: StopIntent } | { kind: "missing" } | { kind: "corrupt" }

/**
 * Reconstruye la intención de una actualización aplicada a partir de la parada activa del backend, sólo si coincide con lo que
 * corre: reason update, estado applied, versión destino igual a la de esta app y un transaction_id que el backend recuperó.
 * En macOS la estrategia es dmg y el journal manda; allí no se reconstruye.
 */
export function intentFromActiveStop(view: HubStopView | null, runningVersion: string, platform: NodeJS.Platform): StopIntent | null {
  if (!view || view.reason !== "update" || view.state !== "applied" || !view.sourceId || !view.transactionId || view.targetVersion !== runningVersion) return null
  const strategy: StopStrategy | null = platform === "win32" ? "nsis" : platform === "linux" ? "appimage" : null
  if (!strategy) return null
  return parseStopIntent({ schema: 1, source_id: view.sourceId, reason: "update", strategy, transaction_id: view.transactionId, target_version: view.targetVersion, stop_id: view.stopId })
}

