/**
 * Adaptador de Codex CLI.
 *
 * - `~/.codex/config.toml`, tabla `[mcp_servers.hub]`. El archivo se edita
 *   conservando lo demás: nunca se reescribe desde cero, porque ahí también viven
 *   las preferencias de la persona.
 * - `~/.agents/skills/<slug>/SKILL.md`, compartido con Gemini CLI.
 *
 * Codex no tiene lista de denegación por herramienta, así que el apagado fino lo
 * hace el gateway: la herramienta sigue listada hasta que el CLI reinicia y la
 * llamada se rechaza en el gateway (propagación `applied_stale_list`).
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  detectDrift,
  Manifest,
  planTomlTable,
  region,
  type DriftItem,
  type DriftReport,
  type FileChange,
  type ManagedRegion,
} from './atomic.js'
import {
  gatewayEndpoint,
  isStdio,
  SERVER_ALIAS,
  type CliAdapter,
  type DetectionResult,
  type GatewayEndpoint,
  type Snapshot,
} from './base.js'
import { planSkills, skillsDriftTargets, skillsRoot } from './skills.js'

export const CLI_KIND = 'codex_cli'

const CONFIG_RELPATH = '.codex/config.toml'
const HOME_DIR_RELPATH = '.codex'

const MCP_KEY = ['mcp_servers', SERVER_ALIAS]
const MCP_REGION: ManagedRegion = region('toml_table', MCP_KEY)

export class CodexCliAdapter implements CliAdapter {
  readonly cliKind = CLI_KIND

  configPath(home: string): string {
    return join(home, CONFIG_RELPATH)
  }

  skillsRoot(home: string): string {
    return skillsRoot(CLI_KIND, home)
  }

  detect(home: string): DetectionResult | null {
    for (const candidate of [this.configPath(home), join(home, HOME_DIR_RELPATH)]) {
      if (existsSync(candidate)) {
        return { cliKind: CLI_KIND, home, configPath: this.configPath(home), evidence: candidate, version: '' }
      }
    }
    return null
  }

  /** La ÚNICA entrada de MCP server que baja al cliente. */
  serverEntry(endpoint: GatewayEndpoint): Record<string, unknown> {
    if (isStdio(endpoint)) {
      const entry: Record<string, unknown> = { command: endpoint.command, args: [...endpoint.args] }
      if (Object.keys(endpoint.env).length > 0) entry['env'] = { ...endpoint.env }
      return entry
    }
    const remote: Record<string, unknown> = { url: endpoint.url }
    if (Object.keys(endpoint.headers).length > 0) remote['http_headers'] = { ...endpoint.headers }
    return remote
  }

  planDetailed(snapshot: Snapshot, endpoint: GatewayEndpoint, home: string): [FileChange[], DriftItem[]] {
    const manifest = Manifest.load(home)
    const changes: FileChange[] = []
    const drift: DriftItem[] = []

    const [change, items] = planTomlTable({
      home,
      path: this.configPath(home),
      keyPath: MCP_KEY,
      value: this.serverEntry(endpoint),
      manifest,
      cliKind: CLI_KIND,
      mode: 0o600,
      summary: 'puntero al gateway en ~/.codex/config.toml',
    })
    if (change !== null) changes.push(change)
    drift.push(...items)

    const [skillChanges, skillDrift] = planSkills(snapshot, home, [this.skillsRoot(home)], { cliKind: CLI_KIND, manifest })
    changes.push(...skillChanges)
    drift.push(...skillDrift)
    return [changes, drift]
  }

  plan(snapshot: Snapshot, endpoint: GatewayEndpoint, home: string): FileChange[] {
    return this.planDetailed(snapshot, endpoint, home)[0]
  }

  readDrift(home: string): DriftReport {
    const targets: Array<[string, ManagedRegion]> = [[this.configPath(home), MCP_REGION]]
    targets.push(...skillsDriftTargets(home, [this.skillsRoot(home)]))
    return { cliKind: CLI_KIND, items: detectDrift(home, targets) }
  }
}

export { gatewayEndpoint }
