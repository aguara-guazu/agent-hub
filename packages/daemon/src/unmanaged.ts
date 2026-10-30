/**
 * Inventario de lo que cada cliente carga por fuera del hub: entradas de MCP server distintas de
 * `hub` en sus archivos de configuración y carpetas de skills que el manifiesto no registra como
 * propias. Solo lectura y solo nombres y rutas: nunca comandos, URLs, encabezados ni variables.
 */
import { lstatSync, readdirSync, readlinkSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"

import { UNMANAGED_MAX_ITEMS, UNMANAGED_MAX_NAME, UNMANAGED_MAX_PATH, type UnmanagedInventory } from "@agenthub/shared"

import { ConfigParseError, Manifest, readRegion, region, storeRoot, type ManagedRegion } from "./adapters/index.js"
import { SERVER_ALIAS } from "./naming.js"

interface InventoryTargets {
  configs: Array<{ path: string; region: ManagedRegion }>
  skillRoots: string[]
}

export interface PathAdapter {
  configPath?(home: string): string
  configPaths?(home: string): string[]
  skillsRoot?(home: string): string
  skillsRoots?(home: string): string[]
}

/** Contenedor de servers MCP por cliente, tal como lo usa su adaptador para la entrada `hub`. */
const CONTAINER: Record<string, ManagedRegion> = {
  claude_code: region("json_value", ["mcpServers"]),
  codex_cli: region("toml_table", ["mcp_servers"]),
  gemini_cli: region("json_value", ["mcpServers"]),
  antigravity: region("json_value", ["mcpServers"]),
  kiro: region("json_value", ["mcpServers"]),
  claude_desktop: region("json_value", ["mcpServers"]),
  opencode: region("json_value", ["mcp"]),
}

export function inventoryTargets(cliKind: string, source: PathAdapter | object, home: string): InventoryTargets {
  const adapter = source as PathAdapter
  const container = CONTAINER[cliKind]
  const paths = adapter.configPaths?.(home) ?? (adapter.configPath ? [adapter.configPath(home)] : [])
  const skillRoots = adapter.skillsRoots?.(home) ?? (adapter.skillsRoot ? [adapter.skillsRoot(home)] : [])
  return { configs: container ? paths.map((path) => ({ path, region: container })) : [], skillRoots }
}

function linksInto(link: string, root: string): boolean {
  try {
    const target = resolve(dirname(link), readlinkSync(link))
    return target === root || target.startsWith(root + sep)
  } catch {
    return false
  }
}

/**
 * Motivo sin texto libre: un mensaje de parser o de sistema puede copiar valores del archivo (tokens en `env`, `headers`).
 * Viaja solo un código fijo, la posición de un error de parseo o el código errno.
 */
function failureReason(error: unknown): string {
  if (error instanceof ConfigParseError) {
    const match = /\((toml|json)_parse_error(?:, fila (\d+), columna (\d+))?\)/.exec(error.message)
    if (match) return match[2] ? `${match[1]}_parse_error: fila ${match[2]}, columna ${match[3]}` : `${match[1]}_parse_error`
    return "parse_error"
  }
  const code = (error as NodeJS.ErrnoException)?.code
  return typeof code === "string" && /^E[A-Z]+$/.test(code) ? `read_error: ${code}` : "read_error"
}

const clip = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value)

export function readUnmanaged(cliKind: string, adapter: PathAdapter | object, home: string, now: () => Date = () => new Date()): UnmanagedInventory {
  const targets = inventoryTargets(cliKind, adapter, home)
  const manifest = Manifest.load(home)
  const store = storeRoot(home)
  const inventory: UnmanagedInventory = { checked_at: now().toISOString(), servers: [], skills: [], errors: [], truncated: false }
  const room = (): boolean => {
    if (inventory.servers.length + inventory.skills.length < UNMANAGED_MAX_ITEMS) return true
    inventory.truncated = true
    return false
  }

  for (const { path, region: container } of targets.configs) {
    let value: unknown
    try {
      value = readRegion(path, container)
    } catch (error) {
      inventory.errors.push({ path: clip(path, UNMANAGED_MAX_PATH), reason: failureReason(error) })
      continue
    }
    if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) continue
    for (const name of Object.keys(value as Record<string, unknown>).sort()) {
      if (name === SERVER_ALIAS) continue
      if (!room()) break
      inventory.servers.push({ name: clip(name, UNMANAGED_MAX_NAME), path: clip(path, UNMANAGED_MAX_PATH) })
    }
  }

  for (const root of targets.skillRoots) {
    const own = new Set(manifest.skillsFor(root))
    let names: string[]
    try {
      names = readdirSync(root).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") inventory.errors.push({ path: clip(root, UNMANAGED_MAX_PATH), reason: failureReason(error) })
      continue
    }
    for (const name of names) {
      if (name.startsWith(".") || own.has(name)) continue
      const path = join(root, name)
      let linked: boolean
      try {
        const info = lstatSync(path)
        linked = info.isSymbolicLink()
        if (!linked && !info.isDirectory()) continue
      } catch {
        continue
      }
      // Un enlace al store del daemon es del hub aunque el manifiesto lo haya perdido.
      if (linked && linksInto(path, store)) continue
      if (!room()) break
      inventory.skills.push({ slug: clip(name, UNMANAGED_MAX_NAME), path: clip(path, UNMANAGED_MAX_PATH), linked })
    }
  }
  return inventory
}
