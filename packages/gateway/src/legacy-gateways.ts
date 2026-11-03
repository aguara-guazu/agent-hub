/**
 * Gateways heredados: procesos `--agenthub-headless` vivos cuyo ejecutable no está bajo
 * `<runtime>/versions/`. Siguen atados al bundle `/Applications/...` que una actualización
 * reemplaza, así que la compuerta de actualización los trata como bloqueo.
 *
 * Ante cualquier duda (sin runtime, `ps` fallido, salida ilegible) devuelve `error` y el
 * llamador debe bloquear.
 */

import { execFile } from "node:child_process"
import { realpathSync } from "node:fs"
import { join, sep } from "node:path"

export interface LegacyProcess {
  pid: number
  /** `lstart` de `ps`, para distinguir un PID reutilizado. */
  started: string
  kind: "gateway" | "hook" | "chat"
}

export interface LegacyGateways {
  count: number
  processes: LegacyProcess[]
  error?: string
}

export type PsRunner = () => Promise<string>

const MARKER = "--agenthub-headless"
const PS_TIMEOUT_MS = 5_000
const LINE = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/

const defaultPs: PsRunner = () => new Promise((resolve, reject) => {
  execFile("/bin/ps", ["-axww", "-o", "pid=,lstart=,args="], { timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout)))
})

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"])

/** El proceso es un ejecutable de la app (`…/X.app/Contents/MacOS/X`), no el shell que lo envuelve ni el lanzador antes de su exec. */
function isAppExecutable(args: string): boolean {
  if (!args.startsWith("/")) return false
  const first = args.split(/\s/, 1)[0] ?? ""
  if (SHELLS.has(first.slice(first.lastIndexOf("/") + 1))) return false
  return args.includes(".app/Contents/MacOS/")
}

function kindOf(args: string): LegacyProcess["kind"] {
  if (/\s--agenthub-memory-hook(\s|$)/.test(args) || /\smemory-hook(\s|$)/.test(args)) return "hook"
  if (/\schat(\s|$)/.test(args)) return "chat"
  return "gateway"
}

function versionsPrefixes(runtimeDir: string): string[] {
  const prefixes = new Set([join(runtimeDir, "versions") + sep])
  try {
    prefixes.add(join(realpathSync(runtimeDir), "versions") + sep)
  } catch {
    // Sin realpath se compara solo con la ruta recibida.
  }
  return [...prefixes]
}

export async function legacyGateways(runtimeDir: string | undefined | null, ps: PsRunner = defaultPs, selfPid: number = process.pid): Promise<LegacyGateways> {
  const none: LegacyGateways = { count: 0, processes: [] }
  if (!runtimeDir?.trim()) return { ...none, error: "falta el directorio del runtime" }
  if (process.platform === "win32") return { ...none, error: "plataforma sin detección de gateways heredados" }
  let output: string
  try {
    output = await ps()
  } catch (error) {
    return { ...none, error: `no se pudo listar procesos: ${(error as Error).message}` }
  }
  const prefixes = versionsPrefixes(runtimeDir)
  const processes: LegacyProcess[] = []
  for (const raw of output.split("\n")) {
    if (!raw.trim()) continue
    const match = LINE.exec(raw)
    if (!match) {
      // Una línea con el marcador que no se puede leer cuenta como bloqueo, no como ausencia.
      if (raw.includes(MARKER)) return { ...none, error: "salida de ps ilegible" }
      continue
    }
    const pid = Number(match[1])
    const args = match[3]!
    if (pid === selfPid || !(` ${args} `).includes(` ${MARKER} `) || !isAppExecutable(args)) continue
    if (prefixes.some((prefix) => args.startsWith(prefix))) continue
    processes.push({ pid, started: match[2]!.replace(/\s+/g, " "), kind: kindOf(args) })
  }
  return { count: processes.length, processes }
}
