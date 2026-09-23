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
 * - No carga skills desde el disco: se suben como ZIP desde su interfaz y las sesiones de
 *   chat y Cowork cargan las habilitadas en la cuenta de claude.ai. La pestaña Code de la
 *   app es Claude Code y lee `~/.claude/skills`, que administra el adaptador de Claude
 *   Code; por eso acá no se planifican skills: el gateway se las entrega por la
 *   herramienta `use_skill`.
 * - La app guarda una caché de las skills de la cuenta en
 *   `local-agent-mode-sessions/skills-plugin/<org>/<usuario>/` (`manifest.json` más
 *   `skills/<nombre>/`). Es de sólo lectura para el hub: sirve para decir si una skill del
 *   hub ya está subida a la cuenta y si está al día, nunca para escribir ahí.
 *
 * Fuentes: https://modelcontextprotocol.io/docs/develop/connect-local-servers,
 * https://support.claude.com/en/articles/12512180-use-skills-in-claude,
 * https://code.claude.com/docs/en/skills#skills-in-cowork-and-cloud-sessions y
 * https://code.claude.com/docs/en/desktop
 */

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { platform } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'

import { canonicalJson, sha256, SKILL_FILENAME, type SnapshotSkill } from '@agenthub/shared'

import { parseFrontmatter } from '../external_skills.js'
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

const ACCOUNT_SKILLS_DIR = 'local-agent-mode-sessions/skills-plugin'
const ACCOUNT_MANIFEST = 'manifest.json'

export type AccountSkillStatus = 'synced' | 'stale'

/** Qué skills del snapshot están en la cuenta de claude.ai y si coinciden con el hub. */
export interface AccountSkillsReport {
  checked_at: string
  skills: { slug: string; status: AccountSkillStatus }[]
}

/** Carpetas `skills/` de la caché de la cuenta, una por organización y usuario con sesión. */
function accountSkillDirs(dataDir: string): string[] {
  const base = join(dataDir, ACCOUNT_SKILLS_DIR)
  const found: string[] = []
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter((name) => !name.startsWith('.') && statSync(join(dir, name)).isDirectory())
    } catch {
      return []
    }
  }
  for (const org of list(base)) {
    for (const user of list(join(base, org))) {
      const plugin = join(base, org, user)
      if (existsSync(join(plugin, ACCOUNT_MANIFEST))) found.push(join(plugin, 'skills'))
    }
  }
  return found
}

/**
 * Huella de lo que el modelo lee de una skill: `name`, `description` y cuerpo del SKILL.md
 * ya parseados, más el contenido de los demás archivos. Se compara así y no byte a byte
 * porque claude.ai reescribe el frontmatter al subir la skill (por ejemplo quita las
 * comillas de `name`), y eso no la vuelve distinta.
 */
interface SkillFingerprint {
  name: string
  description: string
  body: string
  files: Record<string, string>
}

function fingerprintDigest(fingerprint: SkillFingerprint): string {
  return sha256(canonicalJson(fingerprint))
}

/** Huella de una carpeta de skill en disco; `null` si no tiene SKILL.md legible. */
function folderFingerprint(dir: string): string | null {
  let text: string
  try {
    text = readFileSync(join(dir, SKILL_FILENAME), 'utf-8')
  } catch {
    return null
  }
  const { fields, body } = parseFrontmatter(text)
  const files: Record<string, string> = {}
  const walk = (current: string): void => {
    let names: string[]
    try {
      names = readdirSync(current).sort()
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const child = join(current, name)
      const info = lstatSync(child)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) walk(child)
      else if (info.isFile()) {
        const rel = relative(dir, child).split(sep).join('/')
        if (rel !== SKILL_FILENAME) files[rel] = sha256(readFileSync(child))
      }
    }
  }
  walk(dir)
  return fingerprintDigest({ name: fields['name'] ?? '', description: fields['description'] ?? '', body: body.trim(), files })
}

/** Huella de la skill tal como la exporta el hub en el ZIP. */
function expectedFingerprint(skill: SnapshotSkill): string | null {
  if (skill.source === 'external' && skill.source_path) return folderFingerprint(skill.source_path)
  return fingerprintDigest({
    name: skill.slug,
    description: skill.description || skill.display_name || skill.slug,
    body: (skill.body ?? '').trim(),
    files: {},
  })
}

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

  /**
   * Archivos de la caché que deciden el reporte; su fecha sirve para no recalcular huellas
   * en cada pasada del daemon.
   */
  accountCacheStamp(home: string): string {
    const parts: string[] = []
    for (const dir of accountSkillDirs(dirname(this.configPath(home)))) {
      for (const path of [join(dirname(dir), ACCOUNT_MANIFEST), dir]) {
        try {
          parts.push(`${path}:${statSync(path).mtimeMs}`)
        } catch {
          parts.push(`${path}:-`)
        }
      }
    }
    return parts.join('|')
  }

  /** `null` cuando la app no tiene caché de cuenta: no hay nada que informar. */
  readAccountSkills(snapshot: Snapshot, home: string, checkedAt = new Date().toISOString()): AccountSkillsReport | null {
    const dirs = accountSkillDirs(dirname(this.configPath(home)))
    if (dirs.length === 0) return null
    const skills: AccountSkillsReport['skills'] = []
    for (const skill of snapshot.skills ?? []) {
      const cached = dirs.map((dir) => join(dir, skill.slug)).find((path) => existsSync(path))
      if (cached === undefined) continue
      const expected = expectedFingerprint(skill)
      const found = folderFingerprint(cached)
      skills.push({ slug: skill.slug, status: expected !== null && expected === found ? 'synced' : 'stale' })
    }
    return { checked_at: checkedAt, skills }
  }
}

export { gatewayEndpoint }
