/**
 * Configuración del daemon local.
 *
 * Todo lo que acá se resuelve es *ubicación y comportamiento*, nunca identidad: el
 * token de la máquina no vive en esta clase sino en `state.Credentials`. La única
 * excepción es `AGENTHUBD_TOKEN`, un escape para correr el daemon en un contenedor
 * sin enrolar: se lee del entorno, se usa en memoria y no se escribe nunca en disco.
 *
 * Prefijo de entorno: `AGENTHUBD_`.
 */

import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const APP_NAME = 'agenthub'
export const ENV_PREFIX = 'AGENTHUBD_'

export const DEFAULT_CONTROL_PLANE_URL = 'http://127.0.0.1:8765'
export const DEFAULT_GATEWAY_HOST = '127.0.0.1'
export const DEFAULT_GATEWAY_BASE_PORT = 8787
export const DEFAULT_GATEWAY_PATH = '/mcp'
export const DEFAULT_POLL_SECONDS = 25
export const DEFAULT_REQUEST_TIMEOUT = 40
export const DEFAULT_ROSTER_SECONDS = 30

export const DEFAULT_HUB_HOST = '127.0.0.1'
export const DEFAULT_HUB_PORT = 8765

export const TRANSPORT_STDIO = 'stdio'
export const TRANSPORT_HTTP = 'http'
export const GATEWAY_TRANSPORTS = [TRANSPORT_STDIO, TRANSPORT_HTTP] as const
export const DEFAULT_GATEWAY_TRANSPORT = TRANSPORT_STDIO

export const DAEMON_EXECUTABLE_NAME = 'agenthub'

/** Directorio de estado del daemon según el sistema operativo. */
export function defaultStateDir(): string {
  const home = homedir()
  const desktopState = platform() === 'darwin' ? join(home, 'Library', 'Application Support', 'Agent Hub')
    : platform() === 'win32' ? join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Agent Hub')
      : join(process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'Agent Hub')
  if (existsSync(join(desktopState, 'credentials.json'))) return desktopState
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', APP_NAME)
  if (platform() === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), APP_NAME, APP_NAME)
  }
  const base = process.env['XDG_STATE_HOME'] ?? join(home, '.local', 'state')
  return join(base, APP_NAME)
}

/**
 * URL base de la API a partir de la URL del control plane. Se acepta con o sin el
 * sufijo `/api` para que `--url http://hub.interno` y `.../api` signifiquen lo mismo.
 */
export function apiBase(controlPlaneUrl: string): string {
  const base = controlPlaneUrl.trim().replace(/\/+$/, '')
  if (!base) throw new Error('la URL del control plane no puede estar vacía')
  return base.endsWith('/api') ? base : `${base}/api`
}

/** Cómo lanza un CLI el puente stdio: comando, argumentos previos y entorno. */
export interface GatewayLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface GatewayLaunchContext {
  /** El proceso actual corre sobre el runtime Electron (con o sin `ELECTRON_RUN_AS_NODE`). */
  electron: boolean
  execPath: string
  /** Ruta al archivo .AppImage (variable `APPIMAGE`), o `null` fuera de un AppImage. */
  appImagePath: string | null
  /** Raíz `app/` del bundle empaquetado, o `null` en desarrollo. */
  packagedAppRoot: string | null
  /** `desktop/dist/entry.js` del repositorio; sólo se usa en desarrollo. */
  devEntry: string
  /** Binario Node autocontenido (`pkg`). */
  pkg: boolean
  /** `dist/cli.js` del daemon para un Node del sistema. */
  cliEntry: string
}

/**
 * Comando con el que un CLI relanza el gateway por stdio.
 *
 * Dentro de Electron el mismo ejecutable corre `desktop/dist/entry.js` con
 * `ELECTRON_RUN_AS_NODE=1`: es Node puro, sin Chromium, sin ícono en el Dock y sin
 * registrarse en LaunchServices como una instancia de la app. Si el puente corriera
 * como app gráfica, macOS lo tomaría por "Agent Hub ya abierto" y no lanzaría la app
 * real al hacer doble clic mientras algún CLI tuviera el puente vivo.
 */
/**
 * Dentro de un AppImage el ejecutable se monta en una ruta distinta cada vez, así que la
 * configuración del CLI apunta al archivo .AppImage y el propio proceso resuelve dónde
 * quedó montado `entry.js` a partir de su `process.execPath`.
 */
export const APPIMAGE_BOOTSTRAP =
  "const p=require('node:path');import(p.join(p.dirname(process.execPath),'resources','app','desktop','dist','entry.js'))"

export function resolveGatewayLaunch(ctx: GatewayLaunchContext): GatewayLaunch {
  if (ctx.electron) {
    if (ctx.appImagePath) {
      return { command: ctx.appImagePath, args: ['-e', APPIMAGE_BOOTSTRAP, '--', '--agenthub-headless'], env: { ELECTRON_RUN_AS_NODE: '1' } }
    }
    const entry = ctx.packagedAppRoot ? join(ctx.packagedAppRoot, 'desktop', 'dist', 'entry.js') : ctx.devEntry
    return { command: ctx.execPath, args: [entry, '--agenthub-headless'], env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  if (ctx.pkg) return { command: ctx.execPath, args: [], env: {} }
  return { command: ctx.execPath, args: [ctx.cliEntry], env: {} }
}

/** Raíz `app/` del bundle Electron empaquetado (macOS o Windows/Linux), o `null`. */
export function packagedAppRoot(execPath: string): string | null {
  const executableDir = dirname(execPath)
  for (const root of [join(executableDir, '..', 'Resources', 'app'), join(executableDir, 'resources', 'app')]) {
    if (existsSync(join(root, 'package.json'))) return root
  }
  return null
}

export function daemonCommand(): GatewayLaunch {
  return resolveGatewayLaunch({
    electron: Boolean(process.versions.electron),
    execPath: process.execPath,
    appImagePath: process.env['APPIMAGE']?.trim() || null,
    packagedAppRoot: packagedAppRoot(process.execPath),
    devEntry: resolve(fileURLToPath(new URL('../../../desktop/dist/entry.js', import.meta.url))),
    pkg: Boolean((process as { pkg?: unknown }).pkg),
    cliEntry: fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
  })
}

export interface DaemonConfig {
  controlPlaneUrl: string
  stateDir: string
  home: string
  gatewayHost: string
  gatewayBasePort: number
  gatewayPath: string
  gatewayTransport: string
  pollSeconds: number
  rosterSeconds: number
  requestTimeout: number
  tokenFromEnv: string
  local: boolean
  hubHost: string
  hubPort: number
  consoleDist: string
}

export function configApiBase(config: DaemonConfig): string {
  return apiBase(config.controlPlaneUrl)
}

export function hubUrl(config: DaemonConfig): string {
  return `http://${config.hubHost}:${config.hubPort}`
}

/** `true` cuando el CLI lanza el puente y no hay ningún puerto abierto. */
export function stdioGateway(config: DaemonConfig): boolean {
  return config.gatewayTransport === TRANSPORT_STDIO
}

export function gatewayUrl(config: DaemonConfig, port: number): string {
  return `http://${config.gatewayHost}:${port}${config.gatewayPath}`
}

/** Comando, argumentos y entorno con los que un CLI levanta el puente stdio de un agente. */
export function gatewayArgs(config: DaemonConfig, agentId: string): GatewayLaunch {
  const launch = daemonCommand()
  return { ...launch, args: [...launch.args, 'gateway', '--agent', agentId, '--state-dir', config.stateDir] }
}

function envRaw(name: string, def = ''): string {
  return (process.env[`${ENV_PREFIX}${name}`] ?? def).trim()
}

function envInt(name: string, def: number): number {
  const raw = envRaw(name)
  if (!raw) return def
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n)) throw new Error(`${ENV_PREFIX}${name} tiene que ser un número entero, no ${JSON.stringify(raw)}`)
  return n
}

function envFloat(name: string, def: number): number {
  const raw = envRaw(name)
  if (!raw) return def
  const n = Number.parseFloat(raw)
  if (Number.isNaN(n)) throw new Error(`${ENV_PREFIX}${name} tiene que ser un número, no ${JSON.stringify(raw)}`)
  return n
}

function envBool(name: string, def = false): boolean {
  const raw = envRaw(name).toLowerCase()
  if (!raw) return def
  return !['0', 'false', 'no'].includes(raw)
}

export interface LoadConfigOptions {
  controlPlaneUrl?: string
  stateDir?: string
  home?: string
  local?: boolean
}

/** Combina argumentos explícitos, entorno y valores por defecto (en esa precedencia). */
export function loadConfig(options: LoadConfigOptions = {}): DaemonConfig {
  const esLocal = options.local || envBool('LOCAL')
  const hubHost = envRaw('HUB_HOST', DEFAULT_HUB_HOST)
  const hubPort = envInt('HUB_PORT', DEFAULT_HUB_PORT)
  let url = options.controlPlaneUrl || envRaw('URL')
  if (!url) url = esLocal ? `http://${hubHost}:${hubPort}` : DEFAULT_CONTROL_PLANE_URL

  const transport = (envRaw('GATEWAY_TRANSPORT') || DEFAULT_GATEWAY_TRANSPORT).toLowerCase()
  if (!(GATEWAY_TRANSPORTS as readonly string[]).includes(transport)) {
    throw new Error(
      `${ENV_PREFIX}GATEWAY_TRANSPORT tiene que ser uno de ${GATEWAY_TRANSPORTS.join(', ')}, no ${JSON.stringify(transport)}`,
    )
  }

  return {
    controlPlaneUrl: url,
    stateDir: options.stateDir ?? (envRaw('STATE_DIR') || defaultStateDir()),
    home: options.home ?? (envRaw('HOME_DIR') || homedir()),
    gatewayHost: envRaw('GATEWAY_HOST', DEFAULT_GATEWAY_HOST),
    gatewayBasePort: envInt('GATEWAY_PORT', DEFAULT_GATEWAY_BASE_PORT),
    gatewayPath: envRaw('GATEWAY_PATH', DEFAULT_GATEWAY_PATH),
    gatewayTransport: transport,
    pollSeconds: envInt('POLL_SECONDS', DEFAULT_POLL_SECONDS),
    rosterSeconds: envInt('ROSTER_SECONDS', DEFAULT_ROSTER_SECONDS),
    requestTimeout: envFloat('REQUEST_TIMEOUT', DEFAULT_REQUEST_TIMEOUT),
    tokenFromEnv: envRaw('TOKEN'),
    local: esLocal,
    hubHost,
    hubPort,
    consoleDist: envRaw('CONSOLE_DIST'),
  }
}
