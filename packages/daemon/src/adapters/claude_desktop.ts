/**
 * Adaptador de Claude Desktop: la app de chat de Anthropic para macOS y Windows, no
 * Claude Code.
 *
 * - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`.
 *   Windows: `%APPDATA%\Claude\claude_desktop_config.json`, es decir `AppData/Roaming/Claude`
 *   bajo el home. Clave `mcpServers`; la única entrada es el puntero al gateway. El
 *   archivo sólo admite servers stdio (`command`, `args`, `env`): no hay campo de URL,
 *   así que un gateway http no se puede configurar y se reporta como deriva. En Linux la
 *   ruta no está documentada y el cliente no se detecta.
 * - La app relee el archivo sólo al salir por completo y volver a abrirla.
 * - No carga skills desde el disco: se suben como ZIP desde su interfaz. La pestaña Code
 *   de la app es Claude Code y lee `~/.claude/skills`, que administra el adaptador de
 *   Claude Code; por eso acá no se planifican skills.
 *
 * Fuentes: https://modelcontextprotocol.io/docs/develop/connect-local-servers,
 * https://support.claude.com/en/articles/12512180-use-skills-in-claude y
 * https://code.claude.com/docs/en/desktop
 */

import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'

import {
  detectDrift,
  driftItem,
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

export const CLI_KIND = 'claude_desktop'

const CONFIG_FILENAME = 'claude_desktop_config.json'

/** Directorio de datos de la app relativo al home, sólo en las plataformas documentadas. */
const DATA_DIRS: Readonly<Record<string, string>> = {
  darwin: 'Library/Application Support/Claude',
  win32: 'AppData/Roaming/Claude',
}
const FALLBACK_DATA_DIR = '.config/Claude'

const MCP_KEY = ['mcpServers', SERVER_ALIAS]
const MCP_REGION: ManagedRegion = region('json_value', MCP_KEY)

export class ClaudeDesktopAdapter implements CliAdapter {
  readonly cliKind = CLI_KIND

  configPath(home: string): string {
    return join(home, DATA_DIRS[platform()] ?? FALLBACK_DATA_DIR, CONFIG_FILENAME)
  }

  detect(home: string): DetectionResult | null {
    if (!Object.hasOwn(DATA_DIRS, platform())) return null
    const config = this.configPath(home)
    for (const candidate of [config, dirname(config)]) {
      if (existsSync(candidate)) {
        return { cliKind: CLI_KIND, home, configPath: config, evidence: candidate, version: '' }
      }
    }
    return null
  }

  /** La ÚNICA entrada de MCP server que baja al cliente; el archivo sólo entiende stdio. */
  serverEntry(endpoint: GatewayEndpoint): Record<string, unknown> {
    return stdioEntry(endpoint)
  }

  planDetailed(_snapshot: Snapshot, endpoint: GatewayEndpoint, home: string): [FileChange[], DriftItem[]] {
    const path = this.configPath(home)
    if (!isStdio(endpoint)) {
      const reason = `Claude Desktop sólo admite servers stdio en ${CONFIG_FILENAME}; el gateway http no se puede configurar ahí`
      return [[], [driftItem(path, MCP_KEY.join('.'), reason)]]
    }
    const [change, items] = planJsonValue({
      home,
      path,
      keyPath: MCP_KEY,
      value: this.serverEntry(endpoint),
      manifest: Manifest.load(home),
      cliKind: CLI_KIND,
      mode: 0o600,
      summary: `puntero al gateway en ${CONFIG_FILENAME}`,
    })
    return [change === null ? [] : [change], items]
  }

  plan(snapshot: Snapshot, endpoint: GatewayEndpoint, home: string): FileChange[] {
    return this.planDetailed(snapshot, endpoint, home)[0]
  }

  readDrift(home: string): DriftReport {
    return { cliKind: CLI_KIND, items: detectDrift(home, [[this.configPath(home), MCP_REGION]]) }
  }
}

export { gatewayEndpoint }
