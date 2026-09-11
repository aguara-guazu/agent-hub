/**
 * Detección del runtime de contenedores y elección explicable de runtime.
 *
 * El daemon no puede asumir que la máquina de la persona tiene contenedores. Este
 * módulo averigua qué hay realmente instalado y RESPONDIENDO, y traduce ese hallazgo
 * en una decisión por transporte que se puede explicar en `status`:
 *
 *     stdio  -> `toolhive` si hay motor de contenedores y binario `thv`;
 *               `host_process` en cualquier otro caso.
 *     http   -> `remote_http` siempre: el server ya corre en otro lado.
 *
 * POR QUÉ SE PRUEBA EL MOTOR Y NO SOLO EL BINARIO: `which podman` solo dice que el
 * binario existe. En macOS podman corre en una VM que puede estar apagada, y docker
 * puede estar instalado sin demonio. Cada motor se prueba con un comando que obliga
 * a hablar con el demonio.
 */

import { spawnSync } from 'node:child_process'

export const DEFAULT_PROBE_TIMEOUT = 8

export const ENGINE_PODMAN = 'podman'
export const ENGINE_DOCKER = 'docker'
export const ENGINE_COLIMA = 'colima'

export const TOOLHIVE_BINARY = 'thv'

export const RUNTIME_TOOLHIVE = 'toolhive'
export const RUNTIME_HOST_PROCESS = 'host_process'
export const RUNTIME_REMOTE_HTTP = 'remote_http'

export const TRANSPORT_STDIO = 'stdio'
export const TRANSPORT_HTTP = 'http'

export const ISOLATION_ENV_VAR = 'AGENTHUB_ISOLATION'

/** Motor -> comando que prueba que el demonio responde, en orden de preferencia. */
export const ENGINE_PROBES: ReadonlyArray<readonly [string, readonly string[]]> = [
  [ENGINE_PODMAN, ['podman', 'info', '--format', '{{.Version.Version}}']],
  [ENGINE_DOCKER, ['docker', 'version', '--format', '{{.Server.Version}}']],
  [ENGINE_COLIMA, ['colima', 'status']],
]

/** Comando que devuelve la versión de ToolHive. No habla con ningún demonio. */
export const TOOLHIVE_PROBE: readonly string[] = [TOOLHIVE_BINARY, 'version']

export interface ProbeResult {
  ok: boolean
  output: string
  error: string
}

/** Corre un comando de sonda. Se inyecta en las pruebas para no depender de la máquina. */
export type Prober = (argv: readonly string[], timeout: number) => ProbeResult

/** Localiza un binario en el PATH, o `null`. Inyectable en pruebas. */
export type Which = (cmd: string) => string | null

function firstLine(text: string | null | undefined): string {
  for (const line of (text ?? '').split('\n')) {
    const stripped = line.trim()
    if (stripped) return stripped
  }
  return ''
}

/** Ejecuta la sonda y normaliza todos los fallos a `ProbeResult`. Nunca propaga. */
export function runProbe(argv: readonly string[], timeout: number): ProbeResult {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    encoding: 'utf-8',
    timeout: timeout * 1000,
  })
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return { ok: false, output: '', error: 'no está instalado' }
    if (err.code === 'ETIMEDOUT') return { ok: false, output: '', error: `no respondió en ${timeout}s` }
    return { ok: false, output: '', error: `no se pudo ejecutar: ${err.message}` }
  }
  const stdout = firstLine(result.stdout)
  const stderr = firstLine(result.stderr)
  if (result.status !== 0) {
    return { ok: false, output: stdout, error: stderr || `salió con código ${result.status}` }
  }
  return { ok: true, output: stdout || stderr, error: '' }
}

/** Localizador por defecto: usa `which`/`where` del sistema vía la sonda misma. */
export function defaultWhich(cmd: string): string | null {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(finder, [cmd], { encoding: 'utf-8' })
  if (result.status !== 0) return null
  return firstLine(result.stdout) || null
}

export interface ToolStatus {
  name: string
  available: boolean
  path: string
  version: string
  detail: string
}

export function describeTool(tool: ToolStatus): string {
  if (tool.available) {
    const version = tool.version ? ` ${tool.version}` : ''
    return `${tool.name}${version} disponible en ${tool.path || 'PATH'}`
  }
  return `${tool.name} no disponible: ${tool.detail || 'motivo desconocido'}`
}

export interface RuntimeAvailability {
  engines: ToolStatus[]
  toolhive: ToolStatus
  forcedOff: boolean
}

/** Primer motor que respondió, en el orden de preferencia de `ENGINE_PROBES`. */
export function activeEngine(availability: RuntimeAvailability): ToolStatus | null {
  return availability.engines.find((tool) => tool.available) ?? null
}

export function isolationAvailable(availability: RuntimeAvailability): boolean {
  return !availability.forcedOff && activeEngine(availability) !== null && availability.toolhive.available
}

/** Una línea que explica por qué hay o no hay aislamiento. */
export function availabilityReason(availability: RuntimeAvailability): string {
  if (availability.forcedOff) return `aislamiento apagado a mano con ${ISOLATION_ENV_VAR}=off`
  const engine = activeEngine(availability)
  if (engine === null) {
    const names = availability.engines.map((tool) => tool.name).join(', ') || 'ninguno'
    return `no hay motor de contenedores que responda (probados: ${names})`
  }
  if (!availability.toolhive.available) {
    return `hay motor de contenedores (${engine.name}) pero falta ToolHive: ${availability.toolhive.detail}`
  }
  const version = availability.toolhive.version ? ` ${availability.toolhive.version}` : ''
  return `aislamiento disponible con ${engine.name} y ToolHive${version}`
}

export function availabilitySummary(availability: RuntimeAvailability): string[] {
  const lines = [availabilityReason(availability)]
  for (const tool of availability.engines) lines.push(`  ${describeTool(tool)}`)
  lines.push(`  ${describeTool(availability.toolhive)}`)
  return lines
}

export interface RuntimePlan {
  availability: RuntimeAvailability
  byTransport: Record<string, string>
  reasonByTransport: Record<string, string>
}

export function runtimeFor(plan: RuntimePlan, transport: string): string {
  return plan.byTransport[transport] ?? ''
}

export function planIsolationAvailable(plan: RuntimePlan): boolean {
  return isolationAvailable(plan.availability)
}

export function planSummary(plan: RuntimePlan): string[] {
  const lines = availabilitySummary(plan.availability)
  for (const transport of Object.keys(plan.byTransport).sort()) {
    lines.push(`  transporte ${transport}: ${plan.byTransport[transport]} (${plan.reasonByTransport[transport] ?? ''})`)
  }
  return lines
}

interface DetectOptions {
  which?: Which
  prober?: Prober
  timeout?: number
  env?: Record<string, string | undefined>
}

function probeTool(
  name: string,
  argv: readonly string[],
  opts: { which: Which; prober: Prober; timeout: number; versionPrefix?: string },
): ToolStatus {
  const path = opts.which(argv[0]!)
  if (!path) return { name, available: false, path: '', version: '', detail: 'no está en el PATH' }
  const result = opts.prober(argv, opts.timeout)
  if (!result.ok) {
    return { name, available: false, path, version: '', detail: result.error || 'la sonda falló' }
  }
  let version = result.output
  if (opts.versionPrefix && version.startsWith(opts.versionPrefix)) {
    version = version.slice(opts.versionPrefix.length).trim()
  }
  return { name, available: true, path, version, detail: '' }
}

/** Prueba motores de contenedores y ToolHive, y devuelve la foto de la máquina. */
export function detectRuntimes(options: DetectOptions = {}): RuntimeAvailability {
  const which = options.which ?? defaultWhich
  const prober = options.prober ?? runProbe
  const timeout = options.timeout ?? DEFAULT_PROBE_TIMEOUT
  const environ = options.env ?? process.env
  const raw = (environ[ISOLATION_ENV_VAR] ?? '').trim().toLowerCase()
  const forcedOff = raw === 'off' || raw === '0' || raw === 'false' || raw === 'no'

  const engines = ENGINE_PROBES.map(([name, argv]) => probeTool(name, argv, { which, prober, timeout }))
  const toolhive = probeTool(TOOLHIVE_BINARY, TOOLHIVE_PROBE, {
    which,
    prober,
    timeout,
    versionPrefix: 'ToolHive',
  })
  return { engines, toolhive, forcedOff }
}

/** Traduce la foto de la máquina en un runtime por transporte. */
export function planRuntimes(availability: RuntimeAvailability): RuntimePlan {
  let stdioRuntime: string
  let stdioReason: string
  if (isolationAvailable(availability)) {
    stdioRuntime = RUNTIME_TOOLHIVE
    stdioReason = availabilityReason(availability)
  } else {
    stdioRuntime = RUNTIME_HOST_PROCESS
    stdioReason = `sin aislamiento: ${availabilityReason(availability)}`
  }
  return {
    availability,
    byTransport: { [TRANSPORT_STDIO]: stdioRuntime, [TRANSPORT_HTTP]: RUNTIME_REMOTE_HTTP },
    reasonByTransport: {
      [TRANSPORT_STDIO]: stdioReason,
      [TRANSPORT_HTTP]: 'el server remoto ya corre fuera de esta máquina',
    },
  }
}

/** Atajo: detecta y planifica de una sola vez. */
export function detectPlan(options: DetectOptions = {}): RuntimePlan {
  return planRuntimes(detectRuntimes(options))
}
