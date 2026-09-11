/**
 * Gramática de nombres expuestos hacia los CLIs.
 *
 * Nombres portables que comparten catálogo, daemon y gateway.
 * `<prefijo del cliente><exposed_name>`; el techo duro es 64 caracteres contando el
 * prefijo, y lo fija el cliente con el prefijo más largo (Kiro). El alias del server
 * es `hub`, sin guion bajo, porque el parser de políticas de Gemini corta en el primer
 * `_` después de `mcp_`.
 */
import { createHash } from 'node:crypto'

/** Alias único con el que el hub se registra en cada CLI. Sin guion bajo, a propósito. */
export const SERVER_ALIAS = 'hub'

/** Prefijo que agrega cada cliente al nombre de la herramienta. */
export const CLIENT_PREFIXES: Record<string, string> = {
  claude_code: `mcp__${SERVER_ALIAS}__`,
  codex_cli: `${SERVER_ALIAS}__`,
  gemini_cli: `${SERVER_ALIAS}__`,
  kiro: `${SERVER_ALIAS}___`,
}

export const HARD_LIMIT = 64
/** El presupuesto lo fija el cliente con el prefijo más largo. */
export const MAX_EXPOSED_LEN =
  HARD_LIMIT - Math.max(...Object.values(CLIENT_PREFIXES).map((prefix) => prefix.length))

const VALID = /^[a-z][a-z0-9_]*$/

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Normaliza un segmento a [a-z0-9_], empezando por letra. */
export function slugifySegment(value: string): string {
  let out = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  out = out.replace(/_+/g, '_')
  if (!out) out = 'x'
  if (!/^[a-z]/.test(out)) out = `t_${out}`
  return out
}

export function isValidExposedName(name: string): boolean {
  return VALID.test(name) && name.length <= MAX_EXPOSED_LEN
}

function rstripUnderscore(value: string): string {
  return value.replace(/_+$/g, '')
}

/**
 * Construye el nombre expuesto de una herramienta, único dentro del snapshot.
 *
 * Si `<server>_<tool>` no entra en el presupuesto se trunca y se le agrega un sufijo
 * derivado del nombre completo, estable entre corridas. Espeja exactamente la versión
 * del contrato: de este cálculo dependen el `snapshot_hash` y la asignación de nombres.
 */
export function buildExposedName(
  serverSlug: string,
  toolName: string,
  taken?: ReadonlySet<string>,
): string {
  const used = taken ?? new Set<string>()
  let base = `${slugifySegment(serverSlug)}_${slugifySegment(toolName)}`

  if (base.length > MAX_EXPOSED_LEN) {
    const digest = sha256Hex(`${serverSlug}/${toolName}`).slice(0, 6)
    base = `${rstripUnderscore(base.slice(0, MAX_EXPOSED_LEN - 7))}_${digest}`
  }

  let candidate = base
  let n = 2
  while (used.has(candidate)) {
    const suffix = `_${n}`
    candidate = `${rstripUnderscore(base.slice(0, MAX_EXPOSED_LEN - suffix.length))}${suffix}`
    n += 1
  }
  return candidate
}

export function finalNameFor(cliKind: string, exposedName: string): string {
  return (CLIENT_PREFIXES[cliKind] ?? `${SERVER_ALIAS}__`) + exposedName
}

export function nameFitsEverywhere(exposedName: string): boolean {
  return Object.values(CLIENT_PREFIXES).every((prefix) => (prefix + exposedName).length <= HARD_LIMIT)
}
