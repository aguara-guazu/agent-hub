/**
 * Adaptadores de CLI: traducen el snapshot a los archivos nativos de cada cliente.
 *
 * Invariante que ninguno rompe: por CLI se escribe UNA SOLA entrada de MCP server,
 * el puntero al gateway local, bajo el alias `hub`. Las definiciones de los servers
 * upstream se quedan en el daemon.
 *
 *     const changes = planFor(cliKind, snapshot, endpoint, home)
 *     const result = applyChanges(changes)
 */

import { CLI_KINDS, type CliAdapter, type DetectionResult, type GatewayEndpoint, type Snapshot } from './base.js'
import { ClaudeCodeAdapter } from './claude_code.js'
import { CodexCliAdapter } from './codex_cli.js'
import { GeminiCliAdapter } from './gemini_cli.js'
import { KiroAdapter } from './kiro.js'
import type { FileChange } from './atomic.js'

export * from './atomic.js'
export * from './base.js'
export * from './skills.js'
export { ClaudeCodeAdapter } from './claude_code.js'
export { CodexCliAdapter } from './codex_cli.js'
export { GeminiCliAdapter } from './gemini_cli.js'
export { KiroAdapter } from './kiro.js'

/** Un adaptador por CLI soportado. La clave es el `cli_kind` del control plane. */
export const ADAPTERS: Record<string, CliAdapter> = {
  claude_code: new ClaudeCodeAdapter(),
  codex_cli: new CodexCliAdapter(),
  gemini_cli: new GeminiCliAdapter(),
  kiro: new KiroAdapter(),
}

export function adapterFor(cliKind: string): CliAdapter {
  const adapter = ADAPTERS[cliKind]
  if (adapter === undefined) throw new Error(`no hay adaptador para el CLI '${cliKind}'`)
  return adapter
}

export function allAdapters(): CliAdapter[] {
  return CLI_KINDS.map((kind) => ADAPTERS[kind]!)
}

export function detectAll(home: string): DetectionResult[] {
  return allAdapters()
    .map((adapter) => adapter.detect(home))
    .filter((item): item is DetectionResult => item !== null)
}

export function planFor(cliKind: string, snapshot: Snapshot, endpoint: GatewayEndpoint, home: string): FileChange[] {
  return adapterFor(cliKind).plan(snapshot, endpoint, home)
}

/** Planifica varios CLIs de una. `applyChanges` deduplica la raíz compartida. */
export function planMany(
  cliKinds: readonly string[],
  snapshot: Snapshot,
  endpoint: GatewayEndpoint,
  home: string,
): FileChange[] {
  const changes: FileChange[] = []
  for (const kind of cliKinds) changes.push(...planFor(kind, snapshot, endpoint, home))
  return changes
}
