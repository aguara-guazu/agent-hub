/**
 * Adaptador de Claude Code.
 *
 * - `~/.claude.json`, clave top-level `mcpServers`: ahí va la única entrada, el
 *   puntero al gateway. La configuración de MCP NO se recarga en caliente.
 * - `~/.claude/settings.json`, `permissions.deny`: es la única vía de apagado en
 *   caliente que existe, porque los settings SÍ se releen sin reiniciar. Los deny
 *   van por nombre literal `mcp__hub__<exposed_name>`.
 * - `~/.claude/skills/<slug>/SKILL.md`, y Claude Code sigue symlinks.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { finalNameFor } from '../naming.js'
import {
  detectDrift,
  Manifest,
  planJsonPrefixedList,
  planJsonValue,
  region,
  type DriftItem,
  type DriftReport,
  type FileChange,
  type ManagedRegion,
} from './atomic.js'
import {
  deniedToolNames,
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

export const CLI_KIND = 'claude_code'

const CONFIG_RELPATH = '.claude.json'
const SETTINGS_RELPATH = '.claude/settings.json'
const HOME_DIR_RELPATH = '.claude'

const MCP_KEY = ['mcpServers', SERVER_ALIAS]
const DENY_KEY = ['permissions', 'deny']

const MCP_REGION: ManagedRegion = region('json_value', MCP_KEY)

/** `mcp__hub__`, derivado de la gramática de nombres y no escrito a mano. */
const DENY_PREFIX = finalNameFor(CLI_KIND, '')
const DENY_REGION: ManagedRegion = region('json_prefixed_list', DENY_KEY, DENY_PREFIX)

export class ClaudeCodeAdapter implements CliAdapter {
  readonly cliKind = CLI_KIND

  configPath(home: string): string {
    return join(home, CONFIG_RELPATH)
  }

  settingsPath(home: string): string {
    return join(home, SETTINGS_RELPATH)
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
    if (isStdio(endpoint)) return { type: 'stdio', ...stdioEntry(endpoint) }
    const entry: Record<string, unknown> = { type: 'http', url: endpoint.url }
    if (Object.keys(endpoint.headers).length > 0) entry['headers'] = { ...endpoint.headers }
    return entry
  }

  planDetailed(snapshot: Snapshot, endpoint: GatewayEndpoint, home: string): [FileChange[], DriftItem[]] {
    const manifest = Manifest.load(home)
    const changes: FileChange[] = []
    const drift: DriftItem[] = []

    const [mcpChange, mcpItems] = planJsonValue({
      home,
      path: this.configPath(home),
      keyPath: MCP_KEY,
      value: this.serverEntry(endpoint),
      manifest,
      cliKind: CLI_KIND,
      mode: 0o600,
      summary: 'puntero al gateway en ~/.claude.json',
    })
    if (mcpChange !== null) changes.push(mcpChange)
    drift.push(...mcpItems)

    const [denyChange, denyItems] = planJsonPrefixedList({
      home,
      path: this.settingsPath(home),
      keyPath: DENY_KEY,
      prefix: DENY_PREFIX,
      values: deniedToolNames(snapshot, CLI_KIND),
      manifest,
      cliKind: CLI_KIND,
      mode: 0o600,
      summary: 'herramientas apagadas en ~/.claude/settings.json',
    })
    if (denyChange !== null) changes.push(denyChange)
    drift.push(...denyItems)

    const [skillChanges, skillDrift] = planSkills(snapshot, home, [this.skillsRoot(home)], { cliKind: CLI_KIND, manifest })
    changes.push(...skillChanges)
    drift.push(...skillDrift)
    return [changes, drift]
  }

  plan(snapshot: Snapshot, endpoint: GatewayEndpoint, home: string): FileChange[] {
    return this.planDetailed(snapshot, endpoint, home)[0]
  }

  readDrift(home: string): DriftReport {
    const targets: Array<[string, ManagedRegion]> = [
      [this.configPath(home), MCP_REGION],
      [this.settingsPath(home), DENY_REGION],
    ]
    targets.push(...skillsDriftTargets(home, [this.skillsRoot(home)]))
    return { cliKind: CLI_KIND, items: detectDrift(home, targets) }
  }
}

export { gatewayEndpoint }
