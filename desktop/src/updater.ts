/**
 * Actualización automática desde las releases de GitHub.
 *
 * Mismo enfoque que escalidrau: sin Squirrel ni electron-updater, porque los binarios
 * no van firmados y Squirrel.Mac rechaza actualizar una app sin firma. El proceso
 * principal consulta la última release, baja el instalador de esta plataforma con el
 * `fetch` de Node (que, a diferencia del navegador, no marca el archivo con
 * `com.apple.quarantine`) y lo instala:
 *
 * - macOS: monta el dmg, verifica el bundle id, prepara el bundle nuevo al lado del
 *   actual y lo intercambia en un solo movimiento, con copia de respaldo.
 * - Windows con instalador NSIS: corre el instalador nuevo en modo silencioso; él
 *   reemplaza la instalación y vuelve a abrir la app.
 * - Linux AppImage: reemplaza el archivo .AppImage en su lugar y lo vuelve a abrir.
 * - Otros formatos (zip de Windows, .deb): sólo avisa, con enlace a la release.
 *
 * Nada acá importa Electron; red, procesos y disco son inyectables para probarlo.
 */
import { spawn as nodeSpawn, execFile } from 'node:child_process'
import { accessSync, constants as fsConstants, createReadStream, createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

export const DEFAULT_REPO = 'aguara-guazu/agent-hub'
export const DEFAULT_API_BASE = 'https://api.github.com'
export const CHECK_TIMEOUT_MS = 8_000
/** Un instalador real pesa más de 80 MB; algo menor es una descarga rota o una página HTML. */
export const MIN_ASSET_BYTES = 20 * 1024 * 1024
/** Cada cuánto vuelve a mirar una app que vive en segundo plano. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export type Strategy = 'dmg' | 'nsis' | 'appimage' | 'notify'

export interface ReleaseInfo {
  version: string
  notes: string
  page: string
  assets: Array<{ name: string; url: string }>
}

export type UpdateStatus =
  | { state: 'disabled' }
  | { state: 'up-to-date'; version: string }
  | { state: 'available'; version: string; page: string }
  | { state: 'downloaded'; version: string; path: string; strategy: Exclude<Strategy, 'notify'> }
  | { state: 'failed'; version: string; error: string }

export type ApplyOutcome = 'relaunch' | 'external'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>
export type RunFn = (command: string, args: readonly string[]) => Promise<{ stdout: string }>
export type SpawnFn = (command: string, args: readonly string[]) => void

function parseVersion(value: string): number[] {
  return value.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
}

/** Positivo cuando `a` es más nueva que `b`. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

/** Nombre del artefacto que publica `electron-builder.yml` para esta plataforma. */
export function assetNameFor(strategy: Strategy, arch: string): string | null {
  const cpu = arch === 'arm64' ? 'arm64' : 'x64'
  switch (strategy) {
    case 'dmg': return `AgentHub-${cpu}.dmg`
    case 'nsis': return `AgentHub-Setup-${cpu}.exe`
    case 'appimage': return `AgentHub-${cpu === 'x64' ? 'x86_64' : 'arm64'}.AppImage`
    default: return null
  }
}

export interface StrategyInput {
  platform: NodeJS.Platform
  execPath: string
  env: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
}

/** Bundle `.app` que contiene al ejecutable, o `null` si no corre desde un bundle. */
export function bundlePathFrom(execPath: string): string | null {
  const marker = '/Contents/MacOS/'
  const index = execPath.indexOf(marker)
  return index > 0 ? execPath.slice(0, index) : null
}

/** Cómo puede actualizarse esta instalación, o `notify` si sólo se puede avisar. */
export function detectStrategy(input: StrategyInput): Strategy {
  const exists = input.exists ?? existsSync
  if (input.platform === 'darwin') return bundlePathFrom(input.execPath) ? 'dmg' : 'notify'
  if (input.platform === 'win32') {
    // El instalador deja su desinstalador al lado del ejecutable; el zip portable no.
    return exists(join(dirname(input.execPath), 'Uninstall Agent Hub.exe')) ? 'nsis' : 'notify'
  }
  if (input.platform === 'linux') return input.env.APPIMAGE ? 'appimage' : 'notify'
  return 'notify'
}

export async function fetchLatestRelease(options: {
  repo?: string
  apiBase?: string
  fetchFn?: FetchFn
  timeoutMs?: number
} = {}): Promise<ReleaseInfo | null> {
  const repo = options.repo ?? DEFAULT_REPO
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const fetchFn = options.fetchFn ?? fetch
  try {
    const response = await fetchFn(`${apiBase}/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-hub-updater' },
      signal: AbortSignal.timeout(options.timeoutMs ?? CHECK_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const release = await response.json() as {
      tag_name?: string
      body?: string
      html_url?: string
      assets?: Array<{ name?: string; browser_download_url?: string }>
    }
    if (!release.tag_name || !/^v?\d+(\.\d+)*/.test(release.tag_name)) return null
    return {
      version: release.tag_name.replace(/^v/, ''),
      notes: release.body?.trim() ?? '',
      page: release.html_url ?? `https://github.com/${repo}/releases/latest`,
      assets: (release.assets ?? [])
        .filter((asset) => asset.name && asset.browser_download_url)
        .map((asset) => ({ name: asset.name!, url: asset.browser_download_url! })),
    }
  } catch {
    return null
  }
}

/** Baja el artefacto a `target` y rechaza descargas truncadas o que no sean un binario. */
export async function downloadAsset(url: string, target: string, options: {
  fetchFn?: FetchFn
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  minBytes?: number
} = {}): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch
  const response = await fetchFn(url, { redirect: 'follow', ...(options.signal ? { signal: options.signal } : {}) })
  if (!response.ok || !response.body) throw new Error(`la descarga falló con HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (total > 0) options.onProgress?.(Math.min(1, received / total))
  })
  await pipeline(source, createWriteStream(target))
  const written = await stat(target)
  const minBytes = options.minBytes ?? MIN_ASSET_BYTES
  if (written.size < minBytes) {
    await rm(target, { force: true })
    throw new Error(`el archivo descargado pesa ${written.size} bytes; no parece un instalador`)
  }
}

const defaultRun: RunFn = async (command, args) => {
  const { stdout } = await promisify(execFile)(command, [...args])
  return { stdout: String(stdout) }
}
const defaultSpawn: SpawnFn = (command, args) => {
  nodeSpawn(command, [...args], { detached: true, stdio: 'ignore' }).unref()
}

// fs.rm no siempre termina de borrar un bundle cuyo binario está mapeado por un
// proceso vivo (deja un esqueleto); los borrados van por /bin/rm.
const removeTree = (run: RunFn, path: string) => run('/bin/rm', ['-rf', path]).catch(() => undefined)

/** Borra los bundles de preparación y respaldo que dejó una actualización anterior. */
export async function cleanupLeftovers(bundlePath: string, run: RunFn = defaultRun): Promise<void> {
  await removeTree(run, `${bundlePath}.previous`)
  await removeTree(run, `${bundlePath}.incoming`)
}

/**
 * macOS: monta el dmg, prepara el bundle nuevo al lado del actual y lo intercambia en
 * un solo movimiento, para que una copia fallida nunca deje una app a medias.
 */
export async function installDmg(dmgPath: string, bundlePath: string, expectedBundleId: string, run: RunFn = defaultRun): Promise<void> {
  const mountPoint = await mkdtemp(join(tmpdir(), 'agenthub-mount-'))
  try {
    await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath])
    const { stdout } = await run('/bin/ls', [mountPoint])
    const appName = stdout.split('\n').map((entry) => entry.trim()).find((entry) => entry.endsWith('.app'))
    if (!appName) throw new Error('la imagen de disco no contiene ninguna aplicación')
    const source = join(mountPoint, appName)
    const plist = await readFile(join(source, 'Contents', 'Info.plist'), 'utf8')
    if (!plist.includes(expectedBundleId)) throw new Error('la imagen de disco no contiene esta aplicación')
    const staged = `${bundlePath}.incoming`
    const backup = `${bundlePath}.previous`
    await removeTree(run, staged)
    await removeTree(run, backup)
    await run('ditto', [source, staged])
    await run('xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => undefined)
    // El bundle viejo se aparta en vez de borrarse: si el intercambio falla, se vuelve atrás.
    await run('/bin/mv', [bundlePath, backup])
    try {
      await run('/bin/mv', [staged, bundlePath])
    } catch (error) {
      await run('/bin/mv', [backup, bundlePath]).catch(() => undefined)
      throw error
    }
    // El respaldo es el bundle desde el que corre este proceso: macOS puede negarse a
    // borrar partes; no debe hacer fallar la actualización (se limpia al próximo arranque).
    await removeTree(run, backup)
  } finally {
    await run('hdiutil', ['detach', mountPoint, '-force']).catch(() => undefined)
    await rm(mountPoint, { recursive: true, force: true }).catch(() => undefined)
    await rm(dirname(dmgPath), { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Windows: el instalador NSIS de electron-builder en modo silencioso reemplaza la
 * instalación por usuario y, con `--force-run`, vuelve a abrir la app. Son los mismos
 * argumentos que usa electron-updater.
 */
export function installNsis(installerPath: string, spawnFn: SpawnFn = defaultSpawn): void {
  spawnFn(installerPath, ['--updated', '/S', '--force-run'])
}

/** Linux: reemplaza el .AppImage en su lugar (mismo directorio, rename atómico) y lo vuelve a abrir. */
export async function installAppImage(downloadedPath: string, appImagePath: string, spawnFn: SpawnFn = defaultSpawn): Promise<void> {
  const staged = `${appImagePath}.incoming`
  await rm(staged, { force: true })
  await rename(downloadedPath, staged).catch(async () => {
    // Otro filesystem: copiar y borrar.
    await pipeline(createReadStream(downloadedPath), createWriteStream(staged))
    await rm(downloadedPath, { force: true })
  })
  await chmod(staged, 0o755)
  await rename(staged, appImagePath)
  spawnFn(appImagePath, [])
}

export interface AutoUpdaterDeps {
  currentVersion: string
  platform: NodeJS.Platform
  arch: string
  execPath: string
  env: NodeJS.ProcessEnv
  /** Bundle id esperado en el dmg (macOS). */
  bundleId: string
  /** `false` fuera del bundle empaquetado: en desarrollo nunca se actualiza. */
  enabled: boolean
  repo?: string
  apiBase?: string
  fetchFn?: FetchFn
  run?: RunFn
  spawnFn?: SpawnFn
  exists?: (path: string) => boolean
  tmpDir?: string
  /** Sólo para pruebas: tamaño mínimo aceptado para un artefacto. */
  minAssetBytes?: number
  log?: (line: string) => void
}

export class AutoUpdater {
  private readonly deps: AutoUpdaterDeps
  private readonly log: (line: string) => void
  readonly strategy: Strategy
  private downloading: Promise<UpdateStatus> | null = null

  constructor(deps: AutoUpdaterDeps) {
    this.deps = deps
    this.log = deps.log ?? (() => undefined)
    this.strategy = detectStrategy({ platform: deps.platform, execPath: deps.execPath, env: deps.env, ...(deps.exists ? { exists: deps.exists } : {}) })
  }

  /** Consulta la última release y, si se puede autoinstalar, la baja. Nunca lanza. */
  async check(): Promise<UpdateStatus> {
    if (!this.deps.enabled || this.deps.env.AGENTHUB_NO_AUTO_UPDATE === '1') return { state: 'disabled' }
    if (this.downloading) return this.downloading
    this.downloading = this.checkOnce().finally(() => { this.downloading = null })
    return this.downloading
  }

  private async checkOnce(): Promise<UpdateStatus> {
    const release = await fetchLatestRelease({
      ...(this.deps.repo ? { repo: this.deps.repo } : {}),
      ...(this.deps.apiBase ? { apiBase: this.deps.apiBase } : {}),
      ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}),
    })
    if (!release) return { state: 'up-to-date', version: this.deps.currentVersion }
    if (compareVersions(release.version, this.deps.currentVersion) <= 0) return { state: 'up-to-date', version: this.deps.currentVersion }
    const assetName = assetNameFor(this.strategy, this.deps.arch)
    const asset = assetName ? release.assets.find((entry) => entry.name === assetName) : undefined
    if (this.strategy === 'notify' || !asset || !this.canWriteInstall()) {
      return { state: 'available', version: release.version, page: release.page }
    }
    try {
      const directory = await mkdtemp(join(this.deps.tmpDir ?? tmpdir(), 'agenthub-update-'))
      const target = join(directory, basename(asset.name))
      this.log(`[updater] bajando ${asset.name} (v${release.version})`)
      await downloadAsset(asset.url, target, {
        ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}),
        ...(this.deps.minAssetBytes !== undefined ? { minBytes: this.deps.minAssetBytes } : {}),
      })
      return { state: 'downloaded', version: release.version, path: target, strategy: this.strategy }
    } catch (error) {
      return { state: 'failed', version: release.version, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Instala lo descargado. Devuelve cómo debe terminar el proceso actual. */
  async apply(update: Extract<UpdateStatus, { state: 'downloaded' }>): Promise<ApplyOutcome> {
    if (update.strategy === 'dmg') {
      const bundle = bundlePathFrom(this.deps.execPath)
      if (!bundle) throw new Error('la app no corre desde un bundle .app')
      await installDmg(update.path, bundle, this.deps.bundleId, this.deps.run ?? defaultRun)
      return 'relaunch'
    }
    if (update.strategy === 'nsis') {
      installNsis(update.path, this.deps.spawnFn ?? defaultSpawn)
      return 'external'
    }
    const appImage = this.deps.env.APPIMAGE
    if (!appImage) throw new Error('falta la variable APPIMAGE')
    await installAppImage(update.path, appImage, this.deps.spawnFn ?? defaultSpawn)
    return 'external'
  }

  /** Limpieza al arrancar de lo que dejó una actualización anterior (macOS). */
  async cleanup(): Promise<void> {
    if (this.strategy !== 'dmg') return
    const bundle = bundlePathFrom(this.deps.execPath)
    if (bundle) await cleanupLeftovers(bundle, this.deps.run ?? defaultRun)
  }

  private canWriteInstall(): boolean {
    const exists = this.deps.exists ?? existsSync
    if (this.strategy === 'dmg') {
      const bundle = bundlePathFrom(this.deps.execPath)
      return Boolean(bundle && exists(dirname(bundle)) && isWritable(dirname(bundle)))
    }
    if (this.strategy === 'appimage') return Boolean(this.deps.env.APPIMAGE && isWritable(dirname(this.deps.env.APPIMAGE)))
    return true
  }
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}
