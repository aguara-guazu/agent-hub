/**
 * Actualización automática desde las releases de GitHub.
 *
 * Mismo enfoque que escalidrau: sin Squirrel ni electron-updater, porque los binarios
 * no van firmados y Squirrel.Mac rechaza actualizar una app sin firma. El proceso
 * principal consulta la última release, baja el instalador de esta plataforma con el
 * `fetch` de Node (que, a diferencia del navegador, no marca el archivo con
 * `com.apple.quarantine`) y lo instala:
 *
 * - macOS: monta el dmg y deja el bundle nuevo verificado en un stage único al lado del
 *   actual (`<bundle>.incoming-<id>`); al aplicar, `agenthub-swap` los intercambia de forma
 *   atómica y el stage queda con la versión anterior como respaldo. Sin helper no se aplica.
 * - Windows con instalador NSIS: corre el instalador nuevo en modo silencioso cuando la
 *   app ya detuvo core y daemon; él reemplaza la instalación y vuelve a abrir la app.
 * - Linux AppImage: reemplaza el archivo .AppImage en su lugar y lo vuelve a abrir.
 * - Otros formatos (zip de Windows, .deb): deja el resultado en logs, sin notificaciones.
 *
 * Nada acá importa Electron; red, procesos y disco son inyectables para probarlo.
 */
import { createHash, randomBytes } from 'node:crypto'
import { spawn as nodeSpawn, execFile } from 'node:child_process'
import { accessSync, constants as fsConstants, createReadStream, createWriteStream, existsSync, realpathSync } from 'node:fs'
import { chmod, mkdtemp, open as openFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { t } from "./i18n.js"
import { incomingPath } from "./update-contract.js"
import { isStrictSemver, verifyManifest, type TrustKey, type TrustSet, type TrustState } from "./update-trust.js"

export const DEFAULT_REPO = 'aguara-guazu/agent-hub'
export const DEFAULT_API_BASE = 'https://api.github.com'
export const CHECK_TIMEOUT_MS = 8_000
export const DOWNLOAD_TIMEOUT_MS = 15 * 60_000
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000
/** Un instalador real pesa más de 80 MB; algo menor es una descarga rota o una página HTML. */
export const MIN_ASSET_BYTES = 20 * 1024 * 1024
/** Cada cuánto vuelve a mirar una app que vive en segundo plano. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Manifiesto firmado de la release (ver `update-trust.ts`) y su firma. */
export const MANIFEST_NAME = 'AgentHub-update.json'
const MANIFEST_MAX_BYTES = 256 * 1024
const MAX_REDIRECTS = 5

/** Origen de las consultas y descargas; sólo el repositorio fijo o, en pruebas, un servidor en loopback. */
export interface Feed { apiBase: string; repo: string; loopback: boolean }

/** Sólo literales: `localhost` se resuelve por DNS/hosts y no prueba que el destino sea esta máquina. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]'])

export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

/** Ignora (y registra) cualquier override de API o repositorio que no apunte a loopback. */
export function resolveFeed(input: { apiBase?: string | undefined; repo?: string | undefined }, log: (line: string) => void = () => undefined): Feed {
  if (input.apiBase && isLoopbackUrl(input.apiBase)) return { apiBase: input.apiBase.replace(/\/+$/, ''), repo: input.repo || DEFAULT_REPO, loopback: true }
  if (input.apiBase) {
    let host: string
    try { host = new URL(input.apiBase, 'http://invalid').hostname } catch { host = input.apiBase }
    log(`[updater] se ignora AGENTHUB_UPDATE_API: sólo se admite loopback (${host})`)
  }
  if (input.repo && input.repo !== DEFAULT_REPO) log('[updater] se ignora AGENTHUB_UPDATE_REPO: sólo se admite junto con un servidor en loopback')
  return { apiBase: DEFAULT_API_BASE, repo: DEFAULT_REPO, loopback: false }
}

/** Descargas sólo desde github.com o *.githubusercontent.com por https; en pruebas, el mismo origen loopback del feed. */
export function isTrustedDownload(url: URL, feed: Feed): boolean {
  if (feed.loopback) return url.origin === new URL(feed.apiBase).origin
  return url.protocol === 'https:' && (url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com'))
}

/** Identificador corto y único de una transacción de actualización. */
export function newTransactionId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

export type Strategy = 'dmg' | 'nsis' | 'appimage' | 'notify'

export interface ReleaseInfo {
  version: string
  notes: string
  page: string
  assets: Array<{ name: string; url: string; size?: number; digest?: string }>
}

export interface DownloadProgress { receivedBytes: number; totalBytes: number | null }
export type UpdateProgress = { state: 'available'; version: string; page: string }
  | ({ state: 'downloading'; version: string; page: string } & DownloadProgress)

export type UpdateStatus =
  | { state: 'disabled' }
  | { state: 'up-to-date'; version: string }
  | { state: 'available'; version: string; page: string }
  | { state: 'downloaded'; version: string; path: string; strategy: Exclude<Strategy, 'notify'>; sha256?: string; size?: number; trust?: TrustState; nextTrust?: TrustSet; stage?: { id: string; path: string } }
  | { state: 'failed'; version: string; error: string }

export type ApplyOutcome = 'relaunch' | 'external'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>
export type RunFn = (command: string, args: readonly string[]) => Promise<{ stdout: string }>
/** Lanza un proceso independiente; si devuelve una promesa, se rechaza cuando el ejecutable no pudo iniciarse. */
export type SpawnFn = (command: string, args: readonly string[]) => void | Promise<void>

/** Componentes de un SemVer canónico (con `v` opcional); lanza ante cualquier otra forma, nunca interpreta basura. */
function parseVersion(value: string): [number, number, number] {
  const bare = value.replace(/^v/, '')
  if (!isStrictSemver(bare)) throw new Error(t("updater.versionInvalid", { version: value.slice(0, 40) }))
  const [major, minor, patch] = bare.split('.').map(Number) as [number, number, number]
  return [major, minor, patch]
}

/** Positivo cuando `a` es más nueva que `b`. Ambas deben ser SemVer canónico. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let index = 0; index < 3; index += 1) {
    const diff = left[index]! - right[index]!
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

/** `fsync` de un archivo o directorio: el rename es atómico, pero sin esto no sobrevive a un corte de energía. */
export async function fsyncPath(path: string): Promise<void> {
  const handle = await openFile(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** `fsync` de todos los archivos y directorios de un árbol (sin seguir symlinks) y de su padre. */
export async function fsyncTree(root: string): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) await fsyncPath(path)
    }
    await fsyncPath(directory)
  }
  await walk(root)
  await fsyncPath(dirname(root))
}

/** Vuelve a calcular SHA-256 y tamaño de un archivo descargado justo antes de aplicarlo: pudo cambiar mientras esperaba su turno. */
export async function revalidateArtifact(path: string, sha256: string | undefined, size: number | undefined): Promise<void> {
  if (!sha256 || !size) throw new Error(t("updater.digestMissing"))
  const info = await stat(path)
  if (info.size !== size) throw new Error(t("updater.incomplete"))
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== sha256.toLowerCase()) throw new Error(t("updater.hashMismatch"))
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

/** Igual que `bundlePathFrom`, resuelto a su ruta real: el stage y el intercambio nunca pasan por enlaces simbólicos. */
export function realBundlePath(execPath: string): string | null {
  const bundle = bundlePathFrom(execPath)
  if (!bundle) return null
  try { return realpathSync(bundle) } catch { return bundle }
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
  const api = new URL(apiBase)
  // La consulta sólo puede terminar en la API de GitHub (o, en pruebas, en el mismo origen loopback), también tras redirecciones.
  const allowApi = (url: URL): boolean => url.origin === api.origin || (!isLoopbackUrl(apiBase) && url.protocol === 'https:' && url.hostname === new URL(DEFAULT_API_BASE).hostname)
  try {
    const response = await fetchTrusted(fetchFn, `${apiBase}/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-hub-updater' },
      signal: AbortSignal.timeout(options.timeoutMs ?? CHECK_TIMEOUT_MS),
    }, allowApi)
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return null }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(t("updater.githubHttp", { status: response.status })) }
    const release = await response.json() as {
      tag_name?: string
      body?: string
      html_url?: string
      assets?: Array<{ name?: string; browser_download_url?: string; size?: number; digest?: string }>
    }
    if (!release.tag_name || !isStrictSemver(release.tag_name.replace(/^v/, ''))) throw new Error(t("updater.githubInvalid"))
    return {
      version: release.tag_name.replace(/^v/, ''),
      notes: release.body?.trim() ?? '',
      page: release.html_url ?? `https://github.com/${repo}/releases/latest`,
      assets: (release.assets ?? [])
        .filter((asset) => asset.name && asset.browser_download_url)
        .map((asset) => ({ name: asset.name!, url: asset.browser_download_url!, ...(asset.size ? { size: asset.size } : {}), ...(asset.digest ? { digest: asset.digest } : {}) })),
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('GitHub')) throw error
    throw new Error(t("updater.githubUnreachable"))
  }
}

/** Sigue las redirecciones a mano para validar cada salto contra la lista de orígenes permitidos. */
async function fetchTrusted(fetchFn: FetchFn, url: string, init: RequestInit, allow: ((url: URL) => boolean) | undefined): Promise<Response> {
  if (!allow) return fetchFn(url, { ...init, redirect: 'follow' })
  let current = new URL(url)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allow(current)) throw new Error(t("updater.untrustedUrl", { host: current.hostname }))
    const response = await fetchFn(current.href, { ...init, redirect: 'manual' })
    if (response.status < 300 || response.status >= 400) return response
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (!location) throw new Error(t("updater.downloadHttp", { status: response.status }))
    current = new URL(location, current)
  }
  throw new Error(t("updater.tooManyRedirects"))
}

async function fetchSmall(fetchFn: FetchFn, url: string, allow: (url: URL) => boolean): Promise<Buffer> {
  const response = await fetchTrusted(fetchFn, url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }, allow)
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(t("updater.downloadHttp", { status: response.status })) }
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length > MANIFEST_MAX_BYTES) throw new Error(t("updater.manifestInvalid"))
  return body
}

/** Stream directly to disk; resume interrupted transfers only with a pinned SHA-256. */
export async function downloadAsset(url: string, target: string, options: {
  fetchFn?: FetchFn
  onProgress?: (progress: DownloadProgress) => void
  signal?: AbortSignal
  minBytes?: number
  timeoutMs?: number
  idleTimeoutMs?: number
  expectedBytes?: number
  digest?: string
  /** Valida el origen inicial y cada redirección; sin esto sigue las redirecciones sin restricción. */
  allowUrl?: (url: URL) => boolean
} = {}): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS)
  const expectedHash = options.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase()
  for (let attempt = 0; ; attempt++) {
    const idle = new AbortController()
    const signal = AbortSignal.any([idle.signal, timeout, ...(options.signal ? [options.signal] : [])])
    let timer: ReturnType<typeof setTimeout> | undefined, transport = true
    const touch = () => {
      clearTimeout(timer)
      timer = setTimeout(() => idle.abort(), options.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS)
      timer.unref()
    }
    try {
      let offset = attempt ? (await stat(target).catch(() => ({ size: 0 }))).size : 0
      let hash = createHash('sha256')
      // Only after an interrupted transfer: disk writes can lag stream chunks, so
      // seed the hash from the actual file, not the failed stream's byte counter.
      if (offset) for await (const chunk of createReadStream(target)) hash.update(chunk)
      touch()
      const response = await fetchTrusted(fetchFn, url, { signal, ...(offset ? { headers: { Range: `bytes=${offset}-` } } : {}) }, options.allowUrl)
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(t("updater.downloadHttp", { status: response.status })) }
      if (response.status === 206) {
        const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
        if (!range || Number(range[1]) !== offset || (options.expectedBytes && Number(range[3]) !== options.expectedBytes)) {
          await response.body.cancel(); transport = false; throw new Error(t("updater.badRange"))
        }
      } else { offset = 0; hash = createHash('sha256') } // Server ignored Range; start clean.
      const length = Number(response.headers.get('content-length') ?? 0)
      const totalBytes = options.expectedBytes ?? (Number.isFinite(length) && length > 0 ? offset + length : null)
      let receivedBytes = offset
      options.onProgress?.({ receivedBytes, totalBytes })
      const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      source.on('data', (chunk: Buffer) => {
        touch(); hash.update(chunk); receivedBytes += chunk.length
        options.onProgress?.({ receivedBytes, totalBytes })
      })
      await pipeline(source, createWriteStream(target, { flags: offset ? 'a' : 'w' }), { signal })
      const written = await stat(target)
      if (totalBytes !== null && written.size !== totalBytes) throw new Error(t("updater.incomplete"))
      transport = false
      if (written.size < (options.minBytes ?? MIN_ASSET_BYTES)) throw new Error(t("updater.tooSmall", { bytes: written.size }))
      if (expectedHash && hash.digest('hex') !== expectedHash) throw new Error(t("updater.hashMismatch"))
      return
    } catch (error) {
      const partial = (await stat(target).catch(() => ({ size: 0 }))).size
      if (transport && expectedHash && partial > 0 && attempt < 2 && !timeout.aborted && !options.signal?.aborted && (!options.expectedBytes || partial < options.expectedBytes)) continue
      await rm(target, { force: true }).catch(() => undefined)
      if (options.signal?.aborted) throw options.signal.reason
      if (idle.signal.aborted) throw new Error(t("updater.stalled"))
      if (timeout.aborted) throw new Error(t("updater.timedOut"))
      throw error
    } finally { clearTimeout(timer) }
  }
}

const defaultRun: RunFn = async (command, args) => {
  const { stdout } = await promisify(execFile)(command, [...args], { timeout: 120_000, windowsHide: true })
  return { stdout: String(stdout) }
}
// Sin el listener de 'error', un instalador que el antivirus puso en cuarentena sería una excepción no capturada
// del proceso principal en medio del apagado.
const defaultSpawn: SpawnFn = (command, args) => new Promise((resolve, reject) => {
  const child = nodeSpawn(command, [...args], { detached: true, stdio: 'ignore', windowsHide: true })
  child.once('error', reject)
  child.once('spawn', () => { child.unref(); resolve() })
})

// fs.rm no siempre termina de borrar un bundle cuyo binario está mapeado por un
// proceso vivo (deja un esqueleto); los borrados van por /bin/rm.
const removeTree = (run: RunFn, path: string) => run('/bin/rm', ['-rf', path]).catch(() => undefined)

export interface BundleExpectation { version: string; arch: string }

const MACHO_ARCH: Record<string, string> = { arm64: 'arm64', x64: 'x86_64' }

/** Info.plist del bundle como JSON exacto (plutil), no como búsqueda de texto. */
async function readInfo(run: RunFn, bundle: string): Promise<Record<string, unknown>> {
  const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', join(bundle, 'Contents', 'Info.plist')])
  try { return JSON.parse(stdout) as Record<string, unknown> } catch { throw new Error(t("updater.bundleMismatch")) }
}

/** Identidad exacta del bundle preparado, firma interna coherente y arquitectura nativa antes de intercambiarlo. */
export async function verifyStagedBundle(staged: string, expectedBundleId: string, expected: BundleExpectation, run: RunFn = defaultRun): Promise<void> {
  const info = await readInfo(run, staged)
  if (info.CFBundleIdentifier !== expectedBundleId) throw new Error(t("updater.bundleMismatch"))
  if (info.CFBundleShortVersionString !== expected.version) throw new Error(t("updater.versionMismatch"))
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]).catch(() => { throw new Error(t("updater.codesignInvalid")) })
  const executable = info.CFBundleExecutable
  if (typeof executable !== 'string' || !executable || executable.includes('/')) throw new Error(t("updater.bundleMismatch"))
  const { stdout } = await run('/usr/bin/lipo', ['-archs', join(staged, 'Contents', 'MacOS', executable)])
  if (!stdout.trim().split(/\s+/).includes(MACHO_ARCH[expected.arch] ?? expected.arch)) throw new Error(t("updater.archMismatch"))
}

/** Ruta única del stage de una transacción: siempre al lado del bundle para que el intercambio sea atómico. */
export function stagePathFor(bundlePath: string, transactionId: string): string {
  return incomingPath(bundlePath, transactionId)
}

/**
 * macOS: monta el dmg, copia la app a un stage único, la verifica y desmonta. No toca el bundle instalado:
 * si algo falla se borra el stage y la instalación queda intacta.
 */
export async function stageDmg(dmgPath: string, stagePath: string, expectedBundleId: string, expected: BundleExpectation, run: RunFn = defaultRun): Promise<void> {
  const mountPoint = await mkdtemp(join(tmpdir(), 'agenthub-mount-'))
  let staged = false
  try {
    await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath])
    const { stdout } = await run('/bin/ls', [mountPoint])
    const appName = stdout.split('\n').map((entry) => entry.trim()).find((entry) => entry.endsWith('.app'))
    if (!appName) throw new Error(t("updater.bundleMismatch"))
    await removeTree(run, stagePath)
    try {
      await run('ditto', [join(mountPoint, appName), stagePath])
      await run('xattr', ['-dr', 'com.apple.quarantine', stagePath]).catch(() => undefined)
      await verifyStagedBundle(stagePath, expectedBundleId, expected, run)
      // El stage tiene que ser durable antes de que el journal o el swap dependan de él.
      if (existsSync(stagePath)) await fsyncTree(stagePath)
      staged = true
    } catch (error) {
      await removeTree(run, stagePath)
      throw error
    }
  } finally {
    await run('hdiutil', ['detach', mountPoint, '-force']).catch(() => undefined)
    await rm(mountPoint, { recursive: true, force: true }).catch(() => undefined)
    if (staged) await rm(dirname(dmgPath), { recursive: true, force: true }).catch(() => undefined)
  }
}

/** El helper de intercambio debe existir, ser ejecutable, nativo y tener firma estructural coherente. */
export async function verifyHelper(helperPath: string, arch: string, run: RunFn = defaultRun): Promise<void> {
  try {
    accessSync(helperPath, fsConstants.X_OK)
    const { stdout } = await run('/usr/bin/lipo', ['-archs', helperPath])
    if (!stdout.trim().split(/\s+/).includes(MACHO_ARCH[arch] ?? arch)) throw new Error('arquitectura')
    await run('/usr/bin/codesign', ['--verify', '--strict', helperPath])
  } catch {
    throw new Error(t("updater.helperInvalid"))
  }
}

/**
 * Windows: el instalador NSIS de electron-builder en modo silencioso reemplaza la
 * instalación por usuario y, con `--force-run`, vuelve a abrir la app con `--updated`.
 * Son los mismos argumentos que usa electron-updater. Con `--updated` el instalador
 * cierra con Stop-Process todo proceso que corra desde la carpeta de instalación
 * (`allowOnlyOneInstallerInstance.nsh`), así que se lanza recién cuando la app ya
 * detuvo core y daemon; si alguno no se deja cerrar, el instalador sale sin instalar.
 */
export async function installNsis(installerPath: string, spawnFn: SpawnFn = defaultSpawn): Promise<void> {
  await spawnFn(installerPath, ['--updated', '/S', '--force-run'])
}

/**
 * Windows: puentes MCP (`--agenthub-headless`) que Claude Desktop, Claude Code u otro
 * cliente lanzaron con el ejecutable de esta instalación. El instalador NSIS los cierra
 * y el cliente pierde el hub hasta reiniciarlos. Si no se puede consultar, pospone la instalación para proteger las conexiones.
 */
export async function liveBridges(execPath: string, run: RunFn = defaultRun): Promise<number> {
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`
  const script = `@(Get-CimInstance Win32_Process -Filter ${literal(`Name='${basename(execPath).replace(/'/g, "\\'")}'`)} | ` +
    `Where-Object { $_.ProcessId -ne ${process.pid} -and $_.ExecutablePath -eq ${literal(execPath)} -and $_.CommandLine -like '*--agenthub-headless*' -and $_.CommandLine -notlike '*memory-hook*' }).Count`
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])
    const count = Number(stdout.trim())
    return stdout.trim() && Number.isSafeInteger(count) && count >= 0 ? count : Infinity
  } catch {
    return Infinity
  }
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
  await spawnFn(appImagePath, ['--hidden', '--updated'])
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
  onProgress?: (progress: UpdateProgress) => void
  downloadTimeoutMs?: number
  downloadIdleTimeoutMs?: number
  /** Claves vigentes y obligatoriedad de la firma; sin él, sólo integridad. */
  trust?: TrustProvider
  /** Ruta de `agenthub-swap`; sin él (o sin archivo) en macOS no se aplica la actualización. */
  swapHelper?: () => string
  /** Identificador de la transacción nueva; inyectable para pruebas. */
  newTransactionId?: () => string
  /** Política de versiones y preferencia de la persona; sin él sólo cuenta `version > actual`. */
  gate?: UpdateGate
}

export interface TrustProvider {
  current(): TrustSet
  requireSignature(): boolean
}

export interface UpdateGate {
  isEnabled(): boolean
  /** Con el digest del artefacto, una entrada de lista negra con otro digest no bloquea; sin él, bloquea por versión; con `null` sólo bloquean las entradas sin digest. */
  allows(candidate: string, current: string, digest?: string | null): boolean
}

export class AutoUpdater {
  private readonly deps: AutoUpdaterDeps
  private readonly log: (line: string) => void
  readonly strategy: Strategy
  private readonly feed: Feed
  private downloading: Promise<UpdateStatus> | null = null

  constructor(deps: AutoUpdaterDeps) {
    this.deps = deps
    this.log = deps.log ?? (() => undefined)
    this.feed = resolveFeed({ apiBase: deps.apiBase, repo: deps.repo }, this.log)
    this.strategy = detectStrategy({ platform: deps.platform, execPath: deps.execPath, env: deps.env, ...(deps.exists ? { exists: deps.exists } : {}) })
  }

  /** Consulta la última release y, si se puede autoinstalar, la baja. Nunca lanza. */
  async check(): Promise<UpdateStatus> {
    if (!this.deps.enabled || this.deps.env.AGENTHUB_NO_AUTO_UPDATE === '1' || this.deps.gate?.isEnabled() === false) return { state: 'disabled' }
    if (this.downloading) return this.downloading
    this.downloading = this.checkOnce().catch((error: unknown): UpdateStatus => ({ state: 'failed', version: this.deps.currentVersion,
      error: error instanceof Error ? error.message : t("updater.checkFailed") })).finally(() => { this.downloading = null })
    return this.downloading
  }

  private async checkOnce(): Promise<UpdateStatus> {
    const release = await fetchLatestRelease({
      repo: this.feed.repo,
      apiBase: this.feed.apiBase,
      ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}),
    })
    if (!release) return { state: 'up-to-date', version: this.deps.currentVersion }
    if (compareVersions(release.version, this.deps.currentVersion) <= 0) return { state: 'up-to-date', version: this.deps.currentVersion }
    // Nunca bajar de la versión máxima instalada ni reintentar una que ya falló.
    if (this.deps.gate && !this.deps.gate.allows(release.version, this.deps.currentVersion, null)) {
      this.log(`[updater] v${release.version}: omitida (ya instalada antes o marcada como fallida)`)
      return { state: 'up-to-date', version: this.deps.currentVersion }
    }
    this.deps.onProgress?.({ state: 'available', version: release.version, page: release.page })
    const assetName = assetNameFor(this.strategy, this.deps.arch)
    const asset = assetName ? release.assets.find((entry) => entry.name === assetName) : undefined
    if (this.strategy === 'notify' || !asset || !this.canWriteInstall()) {
      return { state: 'available', version: release.version, page: release.page }
    }
    // Sin helper de intercambio válido no tiene sentido bajar ni preparar nada.
    if (this.strategy === 'dmg') {
      try { await verifyHelper(this.deps.swapHelper?.() ?? '', this.deps.arch, this.deps.run ?? defaultRun) } catch (error) {
        this.log(`[updater] v${release.version}: no se descarga, el helper de intercambio no es válido (${error instanceof Error ? error.message : String(error)})`)
        return { state: 'available', version: release.version, page: release.page }
      }
    }
    let directory: string | undefined
    try {
      const integrity = await this.resolveIntegrity(release, asset)
      if (this.deps.gate && !this.deps.gate.allows(release.version, this.deps.currentVersion, integrity.sha256)) {
        this.log(`[updater] v${release.version}: omitida (lista negra de ese artefacto)`)
        return { state: 'up-to-date', version: this.deps.currentVersion }
      }
      directory = await mkdtemp(join(this.deps.tmpDir ?? tmpdir(), 'agenthub-update-'))
      const target = join(directory, basename(asset.name))
      this.log(`[updater] bajando ${asset.name} (v${release.version})`)
      this.deps.onProgress?.({ state: 'downloading', version: release.version, page: release.page, receivedBytes: 0, totalBytes: null })
      await downloadAsset(asset.url, target, {
        ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}),
        expectedBytes: integrity.size,
        digest: `sha256:${integrity.sha256}`,
        allowUrl: (url) => isTrustedDownload(url, this.feed),
        ...(this.deps.minAssetBytes !== undefined ? { minBytes: this.deps.minAssetBytes } : {}),
        ...(this.deps.downloadTimeoutMs !== undefined ? { timeoutMs: this.deps.downloadTimeoutMs } : {}),
        ...(this.deps.downloadIdleTimeoutMs !== undefined ? { idleTimeoutMs: this.deps.downloadIdleTimeoutMs } : {}),
        onProgress: progress => this.deps.onProgress?.({ state: 'downloading', version: release.version, page: release.page, ...progress }),
      })
      this.log(integrity.trust === 'publisher_authenticated' ? `[updater] v${release.version}: publicador autenticado (clave ${integrity.keyId})` : `[updater] v${release.version}: integridad sin autenticación del publicador`)
      return { state: 'downloaded', version: release.version, path: target, strategy: this.strategy, sha256: integrity.sha256, size: integrity.size, trust: integrity.trust, ...(integrity.nextTrust ? { nextTrust: integrity.nextTrust } : {}) }
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      return { state: 'failed', version: release.version, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * SHA-256, tamaño y estado de autenticidad del artefacto. Sin SHA-256 no se aplica nada. Con claves
   * vigentes (o la firma ya exigida) sólo vale el manifiesto firmado; sin ellas, el digest de GitHub o un
   * manifiesto sin firma aportan integridad pero no autentican al publicador.
   */
  private async resolveIntegrity(release: ReleaseInfo, asset: ReleaseInfo['assets'][number]): Promise<{ sha256: string; size: number; trust: TrustState; nextTrust?: TrustSet; keyId?: string }> {
    const fetchFn = this.deps.fetchFn ?? fetch
    const allow = (url: URL) => isTrustedDownload(url, this.feed)
    const trust = this.deps.trust?.current() ?? { keys: [] as TrustKey[], revoked: [] }
    const required = (this.deps.trust?.requireSignature() ?? false) || trust.keys.length > 0
    const manifestAsset = release.assets.find((entry) => entry.name === MANIFEST_NAME)
    const signatureAsset = release.assets.find((entry) => entry.name === `${MANIFEST_NAME}.sig`)
    let verified: ReturnType<typeof verifyManifest> | undefined
    if (required || manifestAsset) {
      if (!manifestAsset || (required && !signatureAsset)) throw new Error(t("updater.manifestMissing"))
      const raw = await fetchSmall(fetchFn, manifestAsset.url, allow)
      const signature = signatureAsset ? await fetchSmall(fetchFn, signatureAsset.url, allow) : null
      verified = verifyManifest(raw, signature, trust, required)
      // Igualdad textual canónica entre la etiqueta de la release y el manifiesto, no una comparación numérica.
      if (verified.manifest.version !== release.version) throw new Error(t("updater.manifestInvalid"))
    }
    const entry = verified?.manifest.assets.find((candidate) => candidate.name === asset.name)
    if (verified && !entry) throw new Error(t("updater.manifestMissing"))
    const published = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase()
    if (entry && published && entry.sha256 !== published) throw new Error(t("updater.hashMismatch"))
    if (entry && asset.size && entry.size !== asset.size) throw new Error(t("updater.incomplete"))
    // En integrity_only SHA-256 y tamaño son ambos obligatorios; sin cualquiera de los dos no se descarga.
    const sha256 = entry?.sha256 ?? published
    if (!sha256) throw new Error(t("updater.digestMissing"))
    const size = entry?.size ?? asset.size
    if (!size || !Number.isSafeInteger(size) || size <= 0) throw new Error(t("updater.sizeMissing"))
    const state: TrustState = verified?.trust ?? 'integrity_only'
    return { sha256, size, trust: state, ...(verified?.manifest.next_trust ? { nextTrust: verified.manifest.next_trust } : {}), ...(verified?.keyId ? { keyId: verified.keyId } : {}) }
  }

  /**
   * macOS: deja listo lo que hace falta ANTES de pedir el drenaje, porque copiar y verificar un bundle lleva más que lo
   * que los gateways esperan: el helper de intercambio tiene que ser válido (si no, se pospone con una razón estable), el
   * DMG se vuelve a verificar (SHA-256 y tamaño) justo antes de copiarlo y se prepara el stage único. Idempotente: con
   * el stage ya preparado no repite nada. Otras estrategias no necesitan preparación.
   */
  async prepare(update: Extract<UpdateStatus, { state: 'downloaded' }>): Promise<{ state: 'ready' } | { state: 'postponed'; reasons: Array<{ code: string }> }> {
    if (update.strategy !== 'dmg' || update.stage) return { state: 'ready' }
    const run = this.deps.run ?? defaultRun
    try { await verifyHelper(this.deps.swapHelper?.() ?? '', this.deps.arch, run) } catch { return { state: 'postponed', reasons: [{ code: 'swap_helper_unavailable' }] } }
    const bundle = realBundlePath(this.deps.execPath)
    if (!bundle) throw new Error('la app no corre desde un bundle .app')
    await revalidateArtifact(update.path, update.sha256, update.size)
    const id = (this.deps.newTransactionId ?? newTransactionId)()
    const stage = { id, path: stagePathFor(bundle, id) }
    await stageDmg(update.path, stage.path, this.deps.bundleId, { version: update.version, arch: this.deps.arch }, run)
    update.stage = stage
    update.path = stage.path
    return { state: 'ready' }
  }

  /** Instala lo descargado. Devuelve cómo debe terminar el proceso actual. */
  async apply(update: Extract<UpdateStatus, { state: 'downloaded' }>): Promise<ApplyOutcome> {
    // macOS: el intercambio del bundle es del vigía, que corre desde la copia de runtime anterior; el Updater nunca lo invoca.
    if (update.strategy === 'dmg') throw new Error('en macOS el intercambio lo hace el vigía, no la aplicación')
    if (update.strategy === 'nsis') {
      await installNsis(update.path, this.deps.spawnFn ?? defaultSpawn)
      return 'external'
    }
    const appImage = this.deps.env.APPIMAGE
    if (!appImage) throw new Error('falta la variable APPIMAGE')
    await installAppImage(update.path, appImage, this.deps.spawnFn ?? defaultSpawn)
    return 'external'
  }

  /** Puentes MCP vivos que cerraría el instalador; sólo aplica a NSIS. */
  async bridgesAtRisk(): Promise<number> {
    return this.strategy === 'nsis' ? liveBridges(this.deps.execPath, this.deps.run ?? defaultRun) : 0
  }

  /**
   * Limpieza al arrancar de lo que dejó una actualización anterior: bundles de respaldo
   * en macOS y descargas en la carpeta temporal. En Windows el instalador NSIS corre
   * desde ahí y nada lo borra después; uno que todavía corre no se puede borrar y queda
   * para el próximo arranque.
   */
  async cleanup(): Promise<void> {
    const temp = this.deps.tmpDir ?? tmpdir()
    for (const entry of await readdir(temp).catch(() => [] as string[])) {
      if (entry.startsWith('agenthub-update-')) await rm(join(temp, entry), { recursive: true, force: true }).catch(() => undefined)
    }
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
