/**
 * Estado visible de la actualización y reglas puras del proceso principal. Sin Electron.
 */
import { sep } from "node:path"
import type { TrustState } from "./update-trust.js"

/** Razón estable por la que una actualización espera; `count` es opcional (sesiones, trabajadores). */
export interface UpdateReason { code: string; count?: number }

export interface UpdateReport {
  phase: "idle" | "checking" | "available" | "downloading" | "ready" | "postponed" | "applying" | "failed" | "disabled"
  version?: string
  trust?: TrustState
  reasons?: UpdateReason[]
  error?: string
}

/** Línea estable para el registro: mismas razones, mismo texto, sin importar el orden. */
export function postponedLine(reasons: UpdateReason[]): string {
  return [...reasons].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((reason) => (reason.count === undefined ? reason.code : `${reason.code}=${reason.count}`)).join(",")
}

export interface OverrideCheck {
  install: string
  state: string
  home: string
  realInstall: string
  realState: string
  realHome: string
}

const withSeparator = (path: string): string => (path.endsWith(sep) ? path : path + sep)

/** Dos rutas se pisan si son la misma o una contiene a la otra. */
function overlaps(a: string, b: string): boolean {
  return a === b || withSeparator(a).startsWith(withSeparator(b)) || withSeparator(b).startsWith(withSeparator(a))
}

/**
 * Con un servidor de pruebas en loopback, ni la instalación, ni el estado, ni el HOME pueden ser los reales
 * ni quedar dentro (o por encima) de ellos. Las rutas llegan ya resueltas con `realpath`, de modo que un
 * symlink hacia lo real también se rechaza.
 */
export function overrideIsSafe(check: OverrideCheck): boolean {
  return !overlaps(check.install, check.realInstall) && !overlaps(check.state, check.realState) && !overlaps(check.home, check.realHome)
}
