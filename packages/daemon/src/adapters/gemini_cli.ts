/**
 * Adaptador de Gemini CLI.
 *
 * - `~/.gemini/settings.json`, clave `mcpServers`.
 * - `~/.agents/skills/<slug>/SKILL.md`, la misma raíz que Codex CLI: una sola
 *   materialización cubre a los dos y no se duplica.
 *
 * El alias del server es `hub`, sin guion bajo, justamente por este CLI: su parser
 * de políticas corta en el primer guion bajo después de `mcp_`.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  detectDrift,
  Manifest,
  planJsonValue,
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
  stdioEntry,
  type CliAdapter,
  type DetectionResult,
  type GatewayEndpoint,
  type Snapshot,
} from './base.js'
import { planSkills, skillsDriftTargets, skillsRoot } from './skills.js'

export const CLI_KIND = 'gemini_cli'

const CONFIG_RELPATH = '.gemini/settings.json'
const HOME_DIR_RELPATH = '.gemini'

const MCP_KEY = ['mcpServers', SERVER_ALIAS]
const MCP_REGION: ManagedRegion = region('json_value', MCP_KEY)

export class GeminiCliAdapter implements CliAdapter {
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
    if (isStdio(endpoint)) return stdioEntry(endpoint)
    const entry: Record<string, unknown> = { httpUrl: endpoint.url }
    if (Object.keys(endpoint.headers).length > 0) entry['headers'] = { ...endpoint.headers }
    return entry
  }

  planDetailed(snapshot: Snapshot, endpoint: GatewayEndpoint, home: string): [FileChange[], DriftItem[]] {
    const manifest = Manifest.load(home)
    const changes: FileChange[] = []
    const drift: DriftItem[] = []

    const [change, items] = planJsonValue({
      home,
      path: this.configPath(home),
      keyPath: MCP_KEY,
      value: this.serverEntry(endpoint),
      manifest,
      cliKind: CLI_KIND,
      mode: 0o600,
      summary: 'puntero al gateway en ~/.gemini/settings.json',
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
