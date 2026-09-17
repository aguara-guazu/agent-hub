/**
 * Contrato común de los adaptadores de CLI.
 *
 * Un adaptador traduce el snapshot de exposición a los archivos nativos de un CLI.
 * La regla que ningún adaptador puede romper: baja UNA SOLA entrada de MCP server,
 * el puntero al gateway local. Las definiciones de los servers upstream se quedan en
 * el daemon y nunca llegan al archivo del cliente, ni siquiera comentadas.
 *
 * `plan` y `apply` están separados a propósito: permite mostrar el diff antes de
 * escribir y deja los tests del planificador independientes del filesystem real.
 */

import type { PolicySnapshot } from '@agenthub/shared'

import { buildExposedName, slugifySegment } from '@agenthub/shared'

import { finalNameFor, SERVER_ALIAS } from '../naming.js'
import type { DriftItem, DriftReport, FileChange } from './atomic.js'

export { SERVER_ALIAS }

export const CLI_KINDS = ['claude_code', 'codex_cli', 'gemini_cli', 'kiro', 'claude_desktop', 'opencode'] as const

const TRANSPORT_STDIO = 'stdio'

const RESOURCE_MCP_TOOL = 'mcp_tool'

/** El snapshot que consume el daemon es exactamente el `PolicySnapshot` compartido. */
export type Snapshot = PolicySnapshot

/**
 * Cómo llega un CLI al gateway local del daemon.
 *
 * stdio es el transporte que los cuatro CLIs soportan sin discusión, y el que usa el
 * daemon por defecto. El token viaja en `env` o en `headers`, y por eso los archivos
 * de configuración se escriben con permisos 0600.
 */
export interface GatewayEndpoint {
  transport: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  url: string
  headers: Record<string, string>
}

export function gatewayEndpoint(partial: Partial<GatewayEndpoint> = {}): GatewayEndpoint {
  return {
    transport: TRANSPORT_STDIO,
    command: '',
    args: [],
    env: {},
    cwd: '',
    url: '',
    headers: {},
    ...partial,
  }
}

export function isStdio(endpoint: GatewayEndpoint): boolean {
  return endpoint.transport === TRANSPORT_STDIO
}

export function carriesSecret(endpoint: GatewayEndpoint): boolean {
  return Object.keys(endpoint.env).length > 0 || Object.keys(endpoint.headers).length > 0
}

/** Entrada base stdio compartida por los adaptadores. */
export function stdioEntry(endpoint: GatewayEndpoint): Record<string, unknown> {
  const entry: Record<string, unknown> = { command: endpoint.command, args: [...endpoint.args] }
  if (Object.keys(endpoint.env).length > 0) entry['env'] = { ...endpoint.env }
  if (endpoint.cwd) entry['cwd'] = endpoint.cwd
  return entry
}

/** Un CLI encontrado en la máquina. */
export interface DetectionResult {
  cliKind: string
  home: string
  configPath: string
  evidence: string
  version: string
}

/** Lo que el daemon le pide a cualquier adaptador. */
export interface CliAdapter {
  readonly cliKind: string
  detect(home: string): DetectionResult | null
  plan(snapshot: Snapshot, endpoint: GatewayEndpoint, home: string): FileChange[]
  planDetailed(snapshot: Snapshot, endpoint: GatewayEndpoint, home: string): [FileChange[], DriftItem[]]
  readDrift(home: string): DriftReport
}

/**
 * Nombre expuesto de una herramienta denegada. El snapshot identifica la herramienta
 * por `slug` = `<server>/<tool>`. Se reconstruye con la misma gramática que usó el
 * catálogo, no con una inventada.
 */
export function exposedNameOf(denied: { slug?: string; exposed?: string }): string {
  const slug = denied.slug ?? ''
  const [serverSlug, toolName] = splitOnce(slug, '/')
  if (serverSlug && toolName) return buildExposedName(serverSlug, toolName)
  return slugifySegment(slug)
}

function splitOnce(value: string, sep: string): [string, string] {
  const idx = value.indexOf(sep)
  if (idx < 0) return [value, '']
  return [value.slice(0, idx), value.slice(idx + 1)]
}

/** Nombres literales, tal como los ve el modelo, de las herramientas apagadas. */
export function deniedToolNames(snapshot: Snapshot, cliKind: string): string[] {
  const names: string[] = []
  for (const item of snapshot.denied ?? []) {
    if (item.resource_type !== RESOURCE_MCP_TOOL) continue
    names.push(finalNameFor(cliKind, exposedNameOf(item)))
  }
  return [...new Set(names)].sort()
}
