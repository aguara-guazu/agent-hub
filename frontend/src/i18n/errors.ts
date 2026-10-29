import { ApiError } from "../lib/api"
import type { Resources } from "./types"

/** Códigos con que `save_task` rechaza escribir en Jira un ticket que no es de la persona (`packages/memory/src/tasks.ts`). */
export const JIRA_GUARD_CODES = ["issue_unassigned", "assignee_mismatch", "account_mismatch", "assignee_unverified", "identity_unverified"] as const
export type JiraGuardCode = typeof JIRA_GUARD_CODES[number]

/** Claves del namespace `errors` que describen una falla general, más las del guard de Jira. */
export type ErrorKey = Extract<keyof Resources["errors"],
  "network" | "timeout" | "unauthorized" | "forbidden" | "notFound" | "conflict" | "tooLarge" | "invalid" | "rateLimited" | "server" | "unknown">
  | `jira.${JiraGuardCode}`

/**
 * Clave de `errors` para un error de la API o de red, para mostrar con `t(errorKey(error), { ns: "errors" })`.
 * El mensaje propio del servidor (`error.message`) queda como detalle secundario, no como texto principal.
 */
export function errorKey(error: unknown): ErrorKey {
  if (error instanceof ApiError) {
    // El código cerrado manda sobre el estado: el guard de Jira responde 409 o 502 según la causa.
    if (error.code && (JIRA_GUARD_CODES as readonly string[]).includes(error.code)) return `jira.${error.code as JiraGuardCode}`
    if (error.status === 401) return "unauthorized"
    if (error.status === 403) return "forbidden"
    if (error.status === 404 || error.status === 410) return "notFound"
    if (error.status === 408 || error.status === 504) return "timeout"
    if (error.status === 409 || error.status === 412) return "conflict"
    if (error.status === 413) return "tooLarge"
    if (error.status === 429) return "rateLimited"
    if (error.status === 400 || error.status === 422) return "invalid"
    if (error.status >= 500) return "server"
    return "unknown"
  }
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout"
  if (error instanceof TypeError) return "network"
  return "unknown"
}
