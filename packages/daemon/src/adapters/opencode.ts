/**
 * Adaptador de OpenCode.
 *
 * - `~/.config/opencode/opencode.json`, o `$XDG_CONFIG_HOME/opencode/opencode.json` cuando la
 *   variable está definida y el home es el real. Clave `mcp`; la entrada es
 *   `{ type: "local", command: [comando, ...args], enabled: true, environment }` o
 *   `{ type: "remote", url, headers }`. OpenCode también carga `opencode.jsonc` y lo fusiona
 *   por encima del `.json`; el hub sólo administra el `.json`.
 * - `~/.config/opencode/skills/<slug>/SKILL.md`. OpenCode exige que `name` cumpla
 *   `^[a-z0-9]+(-[a-z0-9]+)*$`: una skill con `.` o `_` en el slug se enlaza igual, pero
 *   OpenCode la ignora. También lee `~/.claude/skills` y `~/.agents/skills`.
 * - No relee la configuración en caliente: los cambios llegan con la sesión siguiente.
 * - Nombra las herramientas `<server>_<tool>`: el modelo ve `hub_<exposed_name>`.
 *
 * Fuentes: https://opencode.ai/docs/config/, https://opencode.ai/docs/mcp-servers/ y
 * https://opencode.ai/docs/skills/
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

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
  type CliAdapter,
  type DetectionResult,
  type GatewayEndpoint,
  type Snapshot,
} from './base.js'
import { planSkills, skillsDriftTargets } from './skills.js'

export const CLI_KIND = 'opencode'

const CONFIG_DIR_RELPATH = '.config/opencode'
const CONFIG_FILENAME = 'opencode.json'
const SKILLS_SUBDIR = 'skills'

const MCP_KEY = ['mcp', SERVER_ALIAS]
const MCP_REGION: ManagedRegion = region('json_value', MCP_KEY)

export class OpenCodeAdapter implements CliAdapter {
  readonly cliKind = CLI_KIND

  /** `XDG_CONFIG_HOME` sólo se respeta para el home real; un home de prueba queda determinista. */
  configDir(home: string): string {
    const xdg = process.env['XDG_CONFIG_HOME']?.trim()
    if (xdg && resolve(home) === resolve(homedir())) return join(xdg, 'opencode')
    return join(home, CONFIG_DIR_RELPATH)
  }

  configPath(home: string): string {
    return join(this.configDir(home), CONFIG_FILENAME)
  }

  skillsRoot(home: string): string {
    return join(this.configDir(home), SKILLS_SUBDIR)
  }

  detect(home: string): DetectionResult | null {
    for (const candidate of [this.configPath(home), this.configDir(home)]) {
      if (existsSync(candidate)) {
        return { cliKind: CLI_KIND, home, configPath: this.configPath(home), evidence: candidate, version: '' }
      }
    }
    return null
  }

  /**
   * La ÚNICA entrada de MCP server que baja al cliente.
   *
   * `enabled` va siempre en true: el prendido y apagado lo decide el panel web a través
   * del snapshot, no un campo que la persona pueda tocar de costado.
   */
  serverEntry(endpoint: GatewayEndpoint): Record<string, unknown> {
    if (isStdio(endpoint)) {
      const entry: Record<string, unknown> = { type: 'local', command: [endpoint.command, ...endpoint.args], enabled: true }
      if (Object.keys(endpoint.env).length > 0) entry['environment'] = { ...endpoint.env }
      return entry
    }
    const remote: Record<string, unknown> = { type: 'remote', url: endpoint.url, enabled: true }
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
      summary: `puntero al gateway en ${CONFIG_DIR_RELPATH}/${CONFIG_FILENAME}`,
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
