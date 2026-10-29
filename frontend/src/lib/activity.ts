import { getToken } from "./api"
import { memoryCall } from "./memory"
import type { ChipTone } from "../components/ui"
import type { ToolCallLog } from "./types"

/** `/api/audit/tool-calls` serializa también estos ids técnicos; `lib/types` no los declara. */
export interface ToolCall extends ToolCallLog {
  principal?: string | null
  run_id?: string | null
  intent_id?: string | null
  call_id?: string | null
}

export type CallResult = "executed" | "error" | "blocked"

/** Bloqueada = la política la denegó (no llegó al servidor); Error = el servidor falló. Nunca comparten tono. */
export function callResult(call: Pick<ToolCallLog, "decision" | "error">): CallResult {
  if (call.decision !== "allow") return "blocked"
  return call.error ? "error" : "executed"
}

export const CALL_TONE: Record<CallResult, ChipTone> = { executed: "ok", error: "danger", blocked: "locked" }

const SENSITIVE_KEY = /secret|token|password|passwd|credential|authorization|cookie|api[-_]?key|private[-_]?key|client[-_]?secret|bearer/i
const SENSITIVE_VALUE = /\b(?:bearer\s+[\w.~+/-]+=*|sk-[\w-]{12,}|gh[pousr]_[\w]{20,}|xox[abpr]-[\w-]{10,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/gi

/** Copia apta para mostrar: claves sensibles y valores con forma de credencial quedan como «•••». */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "…"
  if (typeof value === "string") return value.replace(SENSITIVE_VALUE, "•••")
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "•••" : redact(item, depth + 1)]))
  }
  return value
}

export function redactText(text: string): string {
  return text.replace(SENSITIVE_VALUE, "•••")
}

/* ------------------------------------------------------------------------------------------- jobs */

/** Tipos de trabajo que muestra Procesamiento; coincide con `processing_status` del backend. */
export const JOB_KINDS = "process,describe_source,dedupe_people,index_entities,tidy_memory,media"

export type JobState = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"
export const JOB_STATES: readonly JobState[] = ["queued", "running", "waiting", "completed", "failed", "cancelled"]
export const ACTIVE_STATES: readonly JobState[] = ["queued", "running", "waiting"]

export interface Job {
  id: string
  kind: string
  state: JobState
  attempts: number
  max_attempts: number
  error?: string | null
  entity_id?: string | null
  source_title?: string | null
  connector_name?: string | null
  payload: Record<string, any>
  progress?: Record<string, any> | null
  created_at: string
  updated_at: string
}

export interface ProcessingStatus {
  states: Partial<Record<JobState, number>>
  usage?: { input_tokens: number; output_tokens: number }
  coverage?: { sources: number; extracted: number }
}

/** La fuente excluye el procesamiento remoto: es una política, se muestra como bloqueo y no como falla. */
export function jobLocked(job: Job): boolean {
  return job.progress?.extraction === "disabled_for_source"
}

export function jobTone(job: Job): ChipTone {
  if (job.state === "failed") return "danger"
  if (job.state === "cancelled") return "off"
  if (job.state === "completed") return jobLocked(job) ? "locked" : "ok"
  return "info"
}

export const isActive = (job: Pick<Job, "state">) => ACTIVE_STATES.includes(job.state)
export const canRetry = (job: Pick<Job, "state">) => job.state === "failed" || job.state === "cancelled" || job.state === "waiting"

/** Avance conocido del trabajo según su etapa; `null` si la etapa no informa un total. */
export function jobProgress(job: Job): { done: number; total: number; percent: number } | null {
  const p = job.progress ?? {}
  const pairs: Record<string, [number | undefined, number | undefined]> = {
    identity_inference: [p.identity_batch ?? 0, p.identity_batches],
    dedupe_people: [p.dedupe_batch ?? 0, p.dedupe_batches],
    extraction: [p.batch ?? 0, p.total_batches],
    embeddings: [p.embeddings ?? 0, p.embedding_total],
  }
  const [done = 0, total] = pairs[p.stage as string] ?? [0, undefined]
  if (!total || total <= 0) return null
  return { done, total, percent: Math.min(100, Math.floor((done / total) * 100)) }
}

/** Segundos desde el inicio hasta el fin (o hasta ahora si sigue activo). */
export function jobElapsed(job: Job, now = Date.now()): number | null {
  const p = job.progress ?? {}
  if (!p.started_at) return null
  const end = p.finished_at ? Date.parse(p.finished_at) : isActive(job) ? now : Date.parse(job.updated_at)
  return Math.max(0, Math.floor((end - Date.parse(p.started_at)) / 1000))
}

export type JobTitleKey =
  | "tidy" | "index" | "dedupe" | "syncPast" | "sync" | "gmail" | "googleRepair" | "googleDocument" | "deletedSource"

/** Título propio de la fuente si existe; si no, la clave del tipo de trabajo. */
export function jobTitle(job: Job): { text: string } | { key: JobTitleKey } {
  if (job.kind === "tidy_memory") return { key: "tidy" }
  if (job.kind === "index_entities") return { key: "index" }
  if (job.kind === "dedupe_people") return { key: "dedupe" }
  const own = job.source_title ?? job.progress?.source_title
  if (own) return { text: own }
  if (job.kind === "sync") return { key: job.payload?.since ? "syncPast" : "sync" }
  if (job.kind === "gmail") return { key: "gmail" }
  if (job.kind === "google_repair") return { key: "googleRepair" }
  if (job.kind === "google_document") return { key: "googleDocument" }
  return { key: "deletedSource" }
}

/** Nombres propios de proveedores: no se traducen. */
export const PROVIDERS: Record<string, string> = { deepseek: "DeepSeek", ollama: "Ollama", opencode: "OpenCode", claude_code: "Claude Code", codex_cli: "Codex", kiro: "Kiro CLI" }

export type JobModeKey = "media" | "maintenance" | "indexOnly" | "local" | "starting" | "source"

/** Cómo se procesa: proveedor con nombre propio o una clave traducible. */
export function jobMode(job: Job): { provider: string } | { key: JobModeKey } {
  const p = job.progress ?? {}
  if (job.kind === "media") return { key: "media" }
  if (job.kind === "tidy_memory") return { key: "maintenance" }
  if (job.kind === "index_entities" || p.index_only || job.payload?.index_only) return { key: "indexOnly" }
  const deepseek = p.provider ? p.provider === "deepseek" : Boolean(p.model?.startsWith?.("deepseek")) && p.extraction !== "not_configured"
  if (deepseek) return { provider: PROVIDERS.deepseek! }
  if (p.provider && PROVIDERS[p.provider]) return { provider: PROVIDERS[p.provider]! }
  if (job.kind === "process") return { key: p.provider === "disabled" ? "local" : "starting" }
  return { key: "source" }
}

/* ------------------------------------------------------------------------------- deferred cancel */

interface PendingCancel { onFail: (error: unknown) => void; onDone: () => void }

/** Cancelaciones en espera del toast. `cancel_job` no tiene vuelta exacta (reintentar reinicia los intentos),
 *  así que la llamada se difiere: Deshacer simplemente no la envía. Vive fuera de React para sobrevivir al desmontaje. */
const pendingCancels = new Map<string, PendingCancel>()

export function scheduleCancel(id: string, onFail: (error: unknown) => void, onDone: () => void): void {
  pendingCancels.set(id, { onFail, onDone })
}

export function undoCancel(id: string): boolean {
  return pendingCancels.delete(id)
}

export function isCancelPending(id: string): boolean {
  return pendingCancels.has(id)
}

/** Idempotente: el toast, el desmontaje y pagehide pueden llamarlo para el mismo id. */
export async function commitCancel(id: string): Promise<void> {
  const entry = pendingCancels.get(id)
  if (!entry) return
  pendingCancels.delete(id)
  try {
    await memoryCall("cancel_job", { id })
    entry.onDone()
  } catch (error) {
    entry.onFail(error)
  }
}

export function commitAllCancels(): Promise<void[]> {
  return Promise.all([...pendingCancels.keys()].map(id => commitCancel(id)))
}

/** La página se descarga: `keepalive` deja salir la petición aunque el documento no sobreviva a la promesa. */
function flushOnPageHide(): void {
  const token = getToken()
  for (const id of pendingCancels.keys()) {
    void fetch("/api/memory/call", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ operation: "cancel_job", input: { id } }),
    })
  }
  pendingCancels.clear()
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushOnPageHide)
  window.addEventListener("beforeunload", flushOnPageHide)
}

/* --------------------------------------------------------------------------- reviewed proposals */

export type Resolver = "ai" | "person" | "agent" | "merge" | "settled" | "unknown"

/** Quién resolvió una propuesta, a partir de `reviewed_by` («ai», «ai:auto», «user», «agent:…», «system:merge»). */
export function resolverOf(reviewedBy: unknown): Resolver {
  if (typeof reviewedBy !== "string" || !reviewedBy) return "unknown"
  if (reviewedBy.startsWith("ai")) return "ai"
  if (reviewedBy === "system:merge") return "merge"
  if (reviewedBy === "system:settled") return "settled"
  if (reviewedBy.startsWith("agent:")) return "agent"
  if (reviewedBy.startsWith("system:")) return "unknown"
  return "person"
}
