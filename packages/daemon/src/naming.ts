/**
 * Gramática de nombres expuestos hacia los CLIs.
 *
 * El nombre que ve el modelo es `<prefijo del cliente><exposed_name>`. El techo
 * duro es 64 caracteres CONTANDO el prefijo, y Kiro lo cuenta así. Además el parser
 * de políticas de Gemini corta en el primer guion bajo después de `mcp_`, por eso el
 * alias del server hacia los clientes es `hub`, sin guion bajo.
 *
 * Comparte las reglas de nombres canónicos con `@agenthub/shared`.
 * `buildExposedName`/`slugifySegment` de `@agenthub/shared` donde aplica.
 */

import type { CliKind } from '@agenthub/shared'

/** Alias único con el que el hub se registra en cada CLI. Sin guion bajo, a propósito. */
export const SERVER_ALIAS = 'hub'

/** Prefijo que agrega cada cliente al nombre de la herramienta. */
export const CLIENT_PREFIXES: Readonly<Record<CliKind, string>> = {
  claude_code: `mcp__${SERVER_ALIAS}__`,
  codex_cli: `${SERVER_ALIAS}__`,
  gemini_cli: `${SERVER_ALIAS}__`,
  kiro: `${SERVER_ALIAS}___`,
}

const DEFAULT_PREFIX = `${SERVER_ALIAS}__`

export function finalNameFor(cliKind: string, exposedName: string): string {
  const prefix = (CLIENT_PREFIXES as Record<string, string>)[cliKind] ?? DEFAULT_PREFIX
  return prefix + exposedName
}
