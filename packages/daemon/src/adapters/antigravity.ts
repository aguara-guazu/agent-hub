/** Google Antigravity app, IDE and CLI share one global MCP configuration and policy. */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { detectDrift, Manifest, planJsonValue, region, samePath, type DriftItem, type DriftReport, type FileChange, type ManagedRegion } from './atomic.js'
import { isStdio, SERVER_ALIAS, stdioEntry, type CliAdapter, type DetectionResult, type GatewayEndpoint, type Snapshot } from './base.js'
import { planSkills, skillsDriftTargets, skillsRoot } from './skills.js'

export const CLI_KIND = 'antigravity'
const MCP_KEY = ['mcpServers', SERVER_ALIAS]

export class AntigravityAdapter implements CliAdapter {
  readonly cliKind = CLI_KIND

  configPath(home: string): string { return join(home, '.gemini/config/mcp_config.json') }

  /** Keep existing pre-migration installations connected without moving personal settings. */
  configPaths(home: string): string[] {
    return [this.configPath(home), ...['antigravity', 'antigravity-cli', 'antigravity-ide']
      .map(name => join(home, '.gemini', name, 'mcp_config.json')).filter(existsSync)]
  }

  skillsRoots(home: string): string[] {
    const legacyRoot = join(home, '.gemini/antigravity/skills')
    return [skillsRoot(CLI_KIND, home), join(home, '.gemini/antigravity-cli/skills'),
      ...(existsSync(legacyRoot) || existsSync(join(home, '.gemini/antigravity/mcp_config.json')) ? [legacyRoot] : [])]
  }

  detect(home: string): DetectionResult | null {
    const candidates = [this.configPath(home), ...['antigravity', 'antigravity-cli', 'antigravity-ide'].map(name => join(home, '.gemini', name)),
      join(home, '.antigravity'), join(home, '.antigravity-ide'), join(home, 'Applications/Antigravity.app'),
      join(home, 'AppData/Local/Programs/Antigravity'), join(home, 'AppData/Local/agy/bin/agy.exe')]
    if (samePath(home, homedir()) && process.platform === 'darwin') candidates.push('/Applications/Antigravity.app', '/Applications/Antigravity IDE.app')
    const evidence = candidates.find(existsSync)
    return evidence ? { cliKind: CLI_KIND, home, configPath: this.configPath(home), evidence, version: '' } : null
  }

  serverEntry(endpoint: GatewayEndpoint): Record<string, unknown> {
    if (isStdio(endpoint)) return stdioEntry(endpoint)
    return { serverUrl: endpoint.url, ...(Object.keys(endpoint.headers).length ? { headers: { ...endpoint.headers } } : {}) }
  }

  planDetailed(snapshot: Snapshot, endpoint: GatewayEndpoint, home: string): [FileChange[], DriftItem[]] {
    const manifest = Manifest.load(home), changes: FileChange[] = [], drift: DriftItem[] = []
    for (const path of this.configPaths(home)) {
      const [change, items] = planJsonValue({ home, path, keyPath: MCP_KEY, value: this.serverEntry(endpoint), manifest,
        cliKind: CLI_KIND, mode: 0o600, summary: 'Conexión de Antigravity al hub' })
      if (change) changes.push(change)
      drift.push(...items)
    }
    const [skillChanges, skillDrift] = planSkills(snapshot, home, this.skillsRoots(home), { cliKind: CLI_KIND, manifest })
    return [[...changes, ...skillChanges], [...drift, ...skillDrift]]
  }

  plan(snapshot: Snapshot, endpoint: GatewayEndpoint, home: string): FileChange[] { return this.planDetailed(snapshot, endpoint, home)[0] }

  readDrift(home: string): DriftReport {
    const targets: Array<[string, ManagedRegion]> = this.configPaths(home).map(path => [path, region('json_value', MCP_KEY)])
    targets.push(...skillsDriftTargets(home, this.skillsRoots(home)))
    return { cliKind: CLI_KIND, items: detectDrift(home, targets) }
  }
}
