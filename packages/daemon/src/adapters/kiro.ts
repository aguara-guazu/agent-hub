/**
 * Adaptador de Kiro.
 *
 * - `~/.kiro/settings/mcp.json`, clave `mcpServers`, con el campo `disabled`.
 * - `~/.kiro/skills/<slug>/SKILL.md`.
 *
 * Kiro relee el archivo apenas se guarda. Una escritura no atómica le deja ver un
 * JSON a medio escribir y le tumba TODOS los servers del scope, no solo el del hub:
 * por eso el temp + rename de `atomic.ts` acá no es una optimización, es un requisito.
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

export const CLI_KIND = 'kiro'

const CONFIG_RELPATH = '.kiro/settings/mcp.json'
const HOME_DIR_RELPATH = '.kiro'

const MCP_KEY = ['mcpServers', SERVER_ALIAS]
const MCP_REGION: ManagedRegion = region('json_value', MCP_KEY)

export class KiroAdapter implements CliAdapter {
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

  /**
   * La ÚNICA entrada de MCP server que baja al cliente.
   *
   * `disabled` va siempre en false: el prendido y apagado lo decide el panel web a
   * través del snapshot, no un campo que la persona pueda tocar de costado.
   */
  serverEntry(endpoint: GatewayEndpoint): Record<string, unknown> {
    if (isStdio(endpoint)) return { ...stdioEntry(endpoint), disabled: false }
    const remote: Record<string, unknown> = { url: endpoint.url, disabled: false }
    if (Object.keys(endpoint.headers).length > 0) remote['headers'] = { ...endpoint.headers }
    return remote
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
      summary: 'puntero al gateway en ~/.kiro/settings/mcp.json',
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
