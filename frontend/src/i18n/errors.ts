import { ApiError } from "../lib/api"
import type { Resources } from "./types"

/** Claves de primer nivel del namespace `errors` que describen una falla general. */
export type ErrorKey = Extract<keyof Resources["errors"],
  "network" | "timeout" | "unauthorized" | "forbidden" | "notFound" | "conflict" | "tooLarge" | "server" | "unknown">

/**
 * Clave de `errors` para un error de la API o de red, para mostrar con `t(errorKey(error), { ns: "errors" })`.
 * El mensaje propio del servidor (`error.message`) queda como detalle secundario, no como texto principal.
 */
export function errorKey(error: unknown): ErrorKey {
  if (error instanceof ApiError) {
    if (error.status === 401) return "unauthorized"
    if (error.status === 403) return "forbidden"
    if (error.status === 404 || error.status === 410) return "notFound"
    if (error.status === 408 || error.status === 504) return "timeout"
    if (error.status === 409 || error.status === 412) return "conflict"
    if (error.status === 413) return "tooLarge"
    if (error.status >= 500) return "server"
    return "unknown"
  }
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout"
  if (error instanceof TypeError) return "network"
  return "unknown"
}
