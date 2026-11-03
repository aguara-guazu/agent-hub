/**
 * Runtime versionado del gateway (macOS): desacopla a los gateways MCP, los hooks y los
 * lanzadores del bundle `/Applications/Agent Hub.app`, que se reemplaza al actualizar.
 *
 *   <stateDir>/runtime/versions/<versión>/<App>.app   copia (clonefile) inmutable de cada versión arrancada
 *   <stateDir>/runtime/current                        symlink a versions/<versión> vigente (rename atómico)
 *   <stateDir>/runtime/bin/agenthub-node              lanzador sh estable; resuelve `current` en cada ejecución
 *   <stateDir>/runtime/state.json                     { current, previous }
 *
 * Un gateway ya arrancado sigue sobre su copia intacta; los procesos nuevos (hooks, otros
 * CLIs) entran por el lanzador y toman la versión vigente. Windows y Linux no se tocan.
 */

import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { basename, dirname, join, sep } from "node:path"

export type RunFn = (command: string, args: readonly string[]) => Promise<{ stdout: string }>

const defaultRun: RunFn = (command, args) => new Promise((resolve, reject) => {
  execFile(command, [...args], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve({ stdout: String(stdout) }))
})

/** Versión del contenido del lanzador; cambia cuando cambia el guion. Se reescribe de forma atómica si difiere. */
export const LAUNCHER_VERSION_LINE = "# agenthub-node v1"
const GC_LSOF_TIMEOUT_MS = 20_000
const BUNDLE_MARKER = "/Contents/MacOS/"
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/

export interface RuntimePaths {
  root: string
  versions: string
  current: string
  bin: string
  launcher: string
  state: string
}

export interface RuntimeState {
  current: string | null
  previous: string | null
}

export interface EnsureOptions {
  stateDir: string
  /** `process.execPath` de la app que arranca. */
  execPath: string
  version: string
  platform?: NodeJS.Platform
  run?: RunFn
}

export interface EnsureResult {
  launcher: string
  versionDir: string
  appPath: string
  cloned: boolean
}

export function runtimePaths(stateDir: string): RuntimePaths {
  const root = join(stateDir, "runtime")
  return { root, versions: join(root, "versions"), current: join(root, "current"), bin: join(root, "bin"), launcher: join(root, "bin", "agenthub-node"), state: join(root, "state.json") }
}

export function bundlePathFrom(execPath: string): string | null {
  const index = execPath.indexOf(BUNDLE_MARKER)
  return index > 0 ? execPath.slice(0, index) : null
}

/** Ejecutable de la copia de una versión, para lanzar procesos (p. ej. el vigía de rollback) sin depender de /Applications. */
export function runtimeBinary(stateDir: string, version: string, execPath: string): string | null {
  const bundle = bundlePathFrom(execPath)
  if (!bundle || !SAFE_VERSION.test(version)) return null
  return join(runtimePaths(stateDir).versions, version, basename(bundle), "Contents", "MacOS", basename(execPath))
}

/** Bundle de una versión dentro del runtime: lo que el vigía y el intercambio atómico usan sin depender de /Applications. */
export function runtimeBundlePath(stateDir: string, version: string, appName: string): string | null {
  return SAFE_VERSION.test(version) ? join(runtimePaths(stateDir).versions, version, appName) : null
}

/** Helper de intercambio atómico empaquetado en cada versión (`Contents/Resources/bin/agenthub-swap`). */
export function swapHelperPath(stateDir: string, version: string, appName: string): string | null {
  const bundle = runtimeBundlePath(stateDir, version, appName)
  return bundle ? join(bundle, "Contents", "Resources", "bin", "agenthub-swap") : null
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Lanzador estable: elige la versión vigente en cada ejecución y reintenta ~3 s si `current` está en medio de un cambio. */
export function launcherScript(appName: string, executable: string): string {
  return [
    "#!/bin/sh",
    LAUNCHER_VERSION_LINE,
    "# Lanzador estable de Agent Hub: resuelve la versión vigente una sola vez por proceso y ejecuta con rutas concretas.",
    `app_name=${shellQuote(appName)}`,
    `executable=${shellQuote(executable)}`,
    "root=\"$(cd \"$(dirname \"$0\")/..\" && pwd -P)\"",
    "i=0",
    "while [ \"$i\" -lt 30 ]; do",
    "  current=\"$(cd \"$root/current\" 2>/dev/null && pwd -P)\"",
    "  app=\"$current/$app_name\"",
    "  bin=\"$app/Contents/MacOS/$executable\"",
    "  entry=\"$app/Contents/Resources/app/desktop/dist/entry.js\"",
    "  if [ -n \"$current\" ] && [ -x \"$bin\" ] && [ -f \"$entry\" ]; then",
    "    ELECTRON_RUN_AS_NODE=1 exec \"$bin\" \"$entry\" \"$@\"",
    "  fi",
    "  i=$((i + 1))",
    "  sleep 0.1",
    "done",
    "echo \"Agent Hub: no hay una versión del runtime disponible\" >&2",
    "exit 127",
    "",
  ].join("\n")
}

async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`
  await writeFile(temp, content, { mode })
  await chmod(temp, mode)
  try {
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

export async function readRuntimeState(stateDir: string): Promise<RuntimeState> {
  try {
    const parsed = JSON.parse(await readFile(runtimePaths(stateDir).state, "utf8")) as Partial<RuntimeState>
    const valid = (value: unknown): string | null => typeof value === "string" && SAFE_VERSION.test(value) ? value : null
    return { current: valid(parsed.current), previous: valid(parsed.previous) }
  } catch {
    return { current: null, previous: null }
  }
}

async function pointCurrent(paths: RuntimePaths, version: string): Promise<void> {
  const temp = `${paths.current}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`
  await symlink(join("versions", version), temp)
  try {
    await rename(temp, paths.current)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * Deja listo el runtime de la versión que arranca y la marca vigente. Devuelve `null` si no
 * aplica (no es macOS ni un bundle empaquetado). Idempotente: si la copia ya existe no la repite.
 */
export async function ensureGatewayRuntime(options: EnsureOptions): Promise<EnsureResult | null> {
  if ((options.platform ?? process.platform) !== "darwin") return null
  const bundle = bundlePathFrom(options.execPath)
  if (!bundle || !SAFE_VERSION.test(options.version)) return null
  const run = options.run ?? defaultRun
  const paths = runtimePaths(options.stateDir)
  const appName = basename(bundle)
  const executable = basename(options.execPath)
  const versionDir = join(paths.versions, options.version)
  const appPath = join(versionDir, appName)
  await mkdir(paths.versions, { recursive: true, mode: 0o700 })
  await mkdir(paths.bin, { recursive: true, mode: 0o700 })

  let cloned = false
  // Si la app ya corre desde una copia del runtime (relanzada por el vigía), esa copia es la versión.
  const inRuntime = bundle.startsWith(paths.versions + sep)
  if (!inRuntime && !existsSync(join(appPath, "Contents", "MacOS", executable))) {
    const staging = `${versionDir}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true, mode: 0o700 })
    try {
      // clonefile en APFS: instantáneo y sin duplicar bloques; ditto como respaldo en otros volúmenes.
      await run("/bin/cp", ["-cR", bundle, join(staging, appName)]).catch(async () => {
        await rm(join(staging, appName), { recursive: true, force: true })
        await run("/usr/bin/ditto", [bundle, join(staging, appName)])
      })
      await rm(versionDir, { recursive: true, force: true })
      await rename(staging, versionDir)
      cloned = true
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  const script = launcherScript(appName, executable)
  const existing = await readFile(paths.launcher, "utf8").catch(() => "")
  if (existing !== script) await writeAtomic(paths.launcher, script, 0o755)

  const state = await readRuntimeState(options.stateDir)
  const current = inRuntime ? basename(dirname(bundle)) : options.version
  await pointCurrent(paths, current)
  const next: RuntimeState = state.current === current ? state : { current, previous: state.current }
  if (next !== state) await writeAtomic(paths.state, JSON.stringify(next), 0o600)
  return { launcher: paths.launcher, versionDir: inRuntime ? dirname(bundle) : versionDir, appPath: inRuntime ? bundle : appPath, cloned }
}

/**
 * Hay algún proceso con archivos abiertos bajo `dir` (`lsof +D`). Con timeout, error de lsof o salida
 * dudosa se considera en uso: el GC nunca borra ante una duda.
 */
async function inUse(run: RunFn, dir: string): Promise<boolean> {
  try {
    const { stdout } = await Promise.race([
      run("/usr/sbin/lsof", ["-F", "p", "+D", dir]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), GC_LSOF_TIMEOUT_MS).unref?.()),
    ])
    return stdout.trim().length > 0
  } catch (error) {
    // lsof sale con 1 y sin salida cuando no encuentra procesos.
    const failure = error as { code?: number; stdout?: string; message?: string }
    return !(failure.code === 1 && !String(failure.stdout ?? "").trim())
  }
}

export interface CollectOptions {
  stateDir: string
  /** Versiones adicionales a conservar (p. ej. la que el vigía necesita para el rollback). */
  keep?: readonly string[]
  /** Nombre del ejecutable dentro de `Contents/MacOS`. */
  executable: string
  appName: string
  run?: RunFn
}

/** Borra las copias que no son vigente, previa ni pedidas y que ningún proceso usa. Devuelve las borradas. */
export async function collectRuntimes(options: CollectOptions): Promise<string[]> {
  const run = options.run ?? defaultRun
  const paths = runtimePaths(options.stateDir)
  const state = await readRuntimeState(options.stateDir)
  const keep = new Set([state.current, state.previous, ...(options.keep ?? [])].filter((value): value is string => Boolean(value)))
  const removed: string[] = []
  let entries: string[]
  try {
    entries = await readdir(paths.versions)
  } catch {
    return removed
  }
  for (const entry of entries) {
    if (keep.has(entry) || entry.includes(".tmp-") || !SAFE_VERSION.test(entry)) continue
    if (await inUse(run, join(paths.versions, entry))) continue
    try {
      await rm(join(paths.versions, entry), { recursive: true, force: true })
      removed.push(entry)
    } catch {
      // Se conserva ante cualquier error: la próxima recolección lo reintenta.
    }
  }
  return removed.sort()
}
