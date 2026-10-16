import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { release } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron'
import { buildReport, LogFile, tailLog } from '@agenthub/memory/report'

import { waitForDesktopSession } from './session.js'
import { CoreSupervisor } from './supervisor.js'
import { resolvePaths, type PathContext } from './paths.js'
import { windowOptions, isAllowedNavigation } from './window.js'
import { buildTrayTemplate, TRAY_TOOLTIP, type TrayAction } from './tray.js'
import { AutostartManager, type LinuxAutostartFs } from './autostart.js'
import { IPC, type CoreStatus, type OpenFileResult } from './ipc.js'
import { AutoUpdater, CHECK_INTERVAL_MS, type UpdateStatus, type UpdateProgress } from './updater.js'
import { defaultClientDeps, isClientRunning, restartClient, supportsClientRestart } from './clients.js'
import { DaemonApp, loadConfig } from '@agenthub/daemon'

const APP_NAME = 'Agent Hub'
const APP_BUNDLE_ID = 'io.craftech.agenthub'
const SHOW_WINDOW_SHORTCUT = 'Control+Alt+H'
const SHOW_WINDOW_SHORTCUT_LABEL = process.platform === 'darwin' ? '⌃⌥H' : 'Ctrl + Alt + H'
let showWindowShortcutRegistered = false
const CORE_HOST = '127.0.0.1'
const DEFAULT_CORE_PORT = 8765
/** Alternativas cuando el puerto habitual no se puede usar: Windows reserva rangos para Hyper-V, WSL y Docker. */
const FALLBACK_CORE_PORTS = [18765, 28765, 38765, 48765]
app.setName(APP_NAME)
// Windows sólo muestra notificaciones de una app con AppUserModelId; el instalador NSIS
// asigna `appId` al acceso directo, así que tiene que ser el mismo valor.
if (process.platform === 'win32') app.setAppUserModelId(APP_BUNDLE_ID)
// Agent Hub vive en la barra de menú: sin ícono en el Dock ni en Cmd+Tab. El bundle
// empaquetado ya lo declara con LSUIElement; esto cubre `npm run dev`.
if (process.platform === 'darwin') app.dock?.hide()
if (process.env.AGENTHUB_DESKTOP_STATE_DIR) app.setPath('userData', process.env.AGENTHUB_DESKTOP_STATE_DIR)
// Finder launches apps with a minimal PATH; include common local CLI locations. On Windows the POSIX prefixes would
// resolve to C:\opt\... and C:\usr\..., folders any local user can create.
process.env.PATH = [...new Set([process.env.PATH ?? '', join(app.getPath('home'), '.local', 'bin'), join(app.getPath('home'), '.cargo', 'bin'),
  ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin'])].filter(Boolean))].join(delimiter)

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let stopped = false
let maintenance: Promise<void> | null = null
/** Tope para el apagado ordenado; pasado este tiempo la app sale igual. */
const QUIT_DEADLINE_MS = 20_000
/** Actualización ya descargada, pendiente de reiniciar. */
let pendingUpdate: Extract<UpdateStatus, { state: 'downloaded' }> | null = null
/** Hay versión nueva pero esta instalación (zip, .deb, bundle sin permisos) sólo puede avisar. */
let availableUpdate: { version: string; page: string } | null = null
let checkingUpdates = false
let downloadingUpdate: Extract<UpdateProgress, { state: 'downloading' }> | null = null
let installingUpdate: string | null = null
let updateError: string | null = null
let lastDownloadRefresh = 0
let relaunchAfterQuit = false
/** Instalador NSIS que corre recién después de detener core y daemon (ver `installNsis`). */
let installOnQuit: Extract<UpdateStatus, { state: 'downloaded' }> | null = null
/** Ya se avisó que la instalación automática espera por puentes MCP abiertos. */
let bridgesNotified = false

/** Forma de `GET /api/local/pending-restarts`, calcada de `packages/core/src/restart.ts`. */
interface PendingRestart {
  agent_id: string
  cli_kind: string
  snapshot_hash: string
  changes: {
    skills: { added: string[]; removed: string[]; changed: string[]; auto: string[] }
    servers: { added: string[]; removed: string[] }
  } | null
}
/** Claude Desktop sigue con una lista vieja; se ofrece reiniciarla desde el tray y la consola. */
let pendingClientRestart: PendingRestart | null = null
/** Skills automáticas por las que ya se avisó a cada cliente: se repite sólo si entra una nueva. */
const offeredRestarts = new Map<string, Set<string>>()
/** Cada cuánto el proceso principal pregunta al core si algún cliente quedó con una lista vieja. */
const PENDING_RESTART_POLL_MS = 10_000
let sessionToken = ''
let restartingClient = false
const clientDeps = defaultClientDeps()

const appDir = dirname(fileURLToPath(import.meta.url))
const pathContext = (): PathContext => ({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  repoRoot: app.isPackaged ? process.resourcesPath : join(appDir, '..', '..'),
  appDir,
  rendererDevServerUrl: process.env.AGENTHUB_CONSOLE_URL,
})
const paths = resolvePaths(pathContext())
const stateDir = app.getPath('userData')
/** Salida del core, del daemon y del worker de memoria; el diálogo de arranque y los reportes de trabajos leen su final. */
const logsDir = join(stateDir, 'logs')
const coreLog = new LogFile(join(logsDir, 'core.log'))
const daemonLog = new LogFile(join(logsDir, 'daemon.log'))
const SESSION_TIMEOUT_MS = 60_000
/** Puerto elegido en un arranque anterior porque el habitual no se podía usar; queda fijo porque las URLs de OAuth lo incluyen. */
const portFile = join(stateDir, 'hub-port')
const CORE_PORT = Number.parseInt(process.env.AGENTHUB_HUB_PORT ?? (existsSync(portFile) ? readFileSync(portFile, 'utf8') : ''), 10) || DEFAULT_CORE_PORT
const CORE_BASE_URL = `http://${CORE_HOST}:${CORE_PORT}`
/** Estado de la ventana y de los puentes MCP al lanzar el instalador NSIS; lo lee el arranque con `--updated`. */
const updateMarker = join(stateDir, 'update-relaunch.json')

function persistentSecret(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (existsSync(path)) return readFileSync(path, 'utf8').trim()
  const value = randomBytes(32).toString('base64url')
  writeFileSync(path, value, { mode: 0o600 })
  chmodSync(path, 0o600)
  return value
}

const jwtSecret = persistentSecret(join(stateDir, 'jwt.secret'))
const desktopBootstrap = randomBytes(32).toString('base64url')
const sharedEnv: NodeJS.ProcessEnv = {
  ELECTRON_RUN_AS_NODE: '1',
  AGENTHUB_DESKTOP_BOOTSTRAP_TOKEN: desktopBootstrap,
  AGENTHUB_LOG_DIR: logsDir,
}
const coreSupervisor = new CoreSupervisor({
  command: paths.coreCommand,
  args: paths.coreArgs,
  env: {
    ...sharedEnv,
    AGENTHUB_HUB_HOST: CORE_HOST,
    AGENTHUB_HUB_PORT: String(CORE_PORT),
    AGENTHUB_LOCAL_MODE: '1',
    AGENTHUB_DATABASE_PATH: join(stateDir, 'hub.db'),
    AGENTHUB_JWT_SECRET: jwtSecret,
    AGENTHUB_CONSOLE_DIST: dirname(paths.rendererIndex),
    // Credenciales OAuth de los MCP servers: mismo directorio que lee el gateway.
    AGENTHUB_OAUTH_DIR: join(stateDir, 'oauth'),
    AGENTHUB_OAUTH_REDIRECT_URL: `${CORE_BASE_URL}/api/oauth/callback`,
  },
})
const daemonSupervisor = new CoreSupervisor({
  command: paths.daemonCommand,
  args: [...paths.daemonArgs, 'run', '--local'],
  env: {
    ...sharedEnv,
    AGENTHUBD_LOCAL: '1',
    AGENTHUBD_URL: CORE_BASE_URL,
    AGENTHUBD_STATE_DIR: stateDir,
    AGENTHUBD_REQUEST_TIMEOUT: '3',
    AGENTHUB_ISOLATION: 'off',
  },
})

/**
 * En Windows la entrada de inicio lleva `--hidden` para arrancar en la bandeja. Electron
 * compara path y args al leerla: `openAtLogin` sólo es true con los mismos valores.
 */
const loginItemOptions = process.platform === 'win32' ? { path: process.execPath, args: ['--hidden'] } : {}
const linuxFs: LinuxAutostartFs = {
  configHome: process.env.XDG_CONFIG_HOME ?? join(app.getPath('home'), '.config'),
  exists: existsSync,
  write: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents, { mode: 0o644 })
  },
  remove: (path) => rmSync(path, { force: true }),
}
const autostart = new AutostartManager({
  platform: process.platform,
  // En un AppImage el binario vive en un punto de montaje distinto en cada ejecución;
  // el archivo .AppImage sí es estable.
  execPath: process.env.APPIMAGE ?? app.getPath('exe'),
  appName: APP_NAME,
  loginItem: {
    get: () => ({ openAtLogin: app.getLoginItemSettings(loginItemOptions).openAtLogin }),
    set: (settings) => app.setLoginItemSettings({ ...settings, ...loginItemOptions }),
  },
  linuxFs,
})

const updater = new AutoUpdater({
  currentVersion: app.getVersion(),
  platform: process.platform,
  // Un build x64 corriendo emulado en Windows on ARM o en Rosetta pasa al nativo con la próxima versión.
  arch: app.runningUnderARM64Translation ? 'arm64' : process.arch,
  execPath: process.execPath,
  env: process.env,
  bundleId: APP_BUNDLE_ID,
  enabled: app.isPackaged,
  // Para probar contra un servidor propio sin publicar una release.
  ...(process.env.AGENTHUB_UPDATE_API ? { apiBase: process.env.AGENTHUB_UPDATE_API } : {}),
  ...(process.env.AGENTHUB_UPDATE_REPO ? { repo: process.env.AGENTHUB_UPDATE_REPO } : {}),
  log: (line) => console.error(line),
  onProgress: progress => {
    availableUpdate = { version: progress.version, page: progress.page }
    if (progress.state === 'downloading') {
      downloadingUpdate = progress
      const now = Date.now()
      if (progress.receivedBytes > 0 && progress.receivedBytes !== progress.totalBytes && now - lastDownloadRefresh < 500) return
      lastDownloadRefresh = now
    }
    refreshTray()
  },
})

function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  } catch {
    // Sin centro de notificaciones no pasa nada: el menú de la barra muestra lo mismo.
  }
}

/**
 * Busca una versión nueva y, si esta instalación puede autoinstalarla, la baja. Con la
 * ventana oculta se instala en el acto; con la ventana visible queda pendiente hasta
 * que se cierre o hasta que la persona lo elija en el menú.
 */
async function checkForUpdates(reason: 'startup' | 'timer' | 'manual'): Promise<void> {
  if (checkingUpdates || installingUpdate || quitting) return
  if (pendingUpdate) {
    if (reason === 'manual') notify('Actualización lista', `Agent Hub v${pendingUpdate.version}. Elegí «Reiniciar para actualizar» en el menú de la barra.`)
    return
  }
  checkingUpdates = true
  updateError = null
  downloadingUpdate = null
  refreshTray()
  try {
    const status = await updater.check()
    if (status.state === 'downloaded') {
      pendingUpdate = status
      availableUpdate = null
      if (!mainWindow?.isVisible()) {
        await applyUpdate('auto')
        return
      }
      notify('Actualización lista', `Agent Hub v${status.version} se instala al cerrar la ventana o desde el menú de la barra.`)
    } else if (status.state === 'available') {
      availableUpdate = { version: status.version, page: status.page }
      if (reason !== 'timer') notify('Nueva versión disponible', `Agent Hub v${status.version}. Esta instalación no se actualiza sola: abrí la release desde el menú de la barra.`)
    } else if (status.state === 'failed') {
      updateError = status.error
      console.error(`[updater] v${status.version}: ${status.error}`)
      if (reason === 'manual') notify('No se pudo completar la actualización', status.error)
    } else if (reason === 'manual') {
      notify('Agent Hub está al día', `Versión ${app.getVersion()}.`)
    }
  } finally {
    checkingUpdates = false
    downloadingUpdate = null
    refreshTray()
  }
}

/**
 * `auto` viene de la ventana oculta o recién cerrada. En Windows el instalador cierra los
 * puentes MCP que los clientes lanzaron desde la carpeta de instalación, así que con
 * puentes vivos la instalación automática espera a que la persona la elija en el menú.
 */
async function applyUpdate(origin: 'auto' | 'manual' = 'manual'): Promise<void> {
  const update = pendingUpdate
  if (!update || installingUpdate || quitting) return
  if (update.strategy === 'nsis') {
    const bridges = await updater.bridgesAtRisk()
    if (bridges > 0 && origin === 'auto') {
      if (!bridgesNotified) notify('Actualización lista', `Agent Hub v${update.version} se instala cuando la elija en el menú de la barra. ` +
        `Instalarla cierra la conexión de ${bridges === 1 ? 'un agente abierto' : `${bridges} agentes abiertos`} con el hub.`)
      bridgesNotified = true
      return
    }
    writeFileSync(updateMarker, JSON.stringify({ window: Boolean(mainWindow?.isVisible()), bridges }))
    installOnQuit = update
    installingUpdate = update.version
    refreshTray()
    console.error(`[updater] v${update.version} se instala al terminar el apagado`)
    await quit()
    return
  }
  installingUpdate = update.version
  downloadingUpdate = null
  refreshTray()
  try {
    const outcome = await updater.apply(update)
    relaunchAfterQuit = outcome === 'relaunch'
    console.error(`[updater] v${update.version} instalada; ${relaunchAfterQuit ? 'reiniciando' : 'el instalador vuelve a abrir la app'}`)
    await quit()
  } catch (error) {
    pendingUpdate = null
    const message = error instanceof Error ? error.message : String(error)
    updateError = message
    console.error('[updater] la instalación falló:', message)
    notify('No se pudo instalar la actualización', message)
  } finally {
    installingUpdate = null
    refreshTray()
  }
}

/** Tras una actualización, avisa una sola vez con qué versión quedó la app. */
function announceVersionChange(): void {
  const marker = join(stateDir, 'last-version')
  const previous = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : ''
  const current = app.getVersion()
  if (previous && previous !== current) notify('Agent Hub se actualizó', `Ahora corre la versión ${current}.`)
  if (previous !== current) writeFileSync(marker, current)
}

function coreStatus(): CoreStatus {
  return { state: coreSupervisor.state, apiBaseUrl: CORE_BASE_URL, pid: coreSupervisor.pid, daemonState: daemonSupervisor.state }
}

function describePending(entry: PendingRestart): string {
  const changes = entry.changes
  if (!changes) return 'la lista de herramientas cambió'
  const parts = [
    changes.skills.added.length ? `skills nuevas: ${changes.skills.added.join(', ')}` : '',
    changes.skills.changed.length ? `skills actualizadas: ${changes.skills.changed.join(', ')}` : '',
    changes.skills.removed.length ? `skills retiradas: ${changes.skills.removed.join(', ')}` : '',
    changes.servers.added.length ? `MCP servers nuevos: ${changes.servers.added.join(', ')}` : '',
    changes.servers.removed.length ? `MCP servers retirados: ${changes.servers.removed.join(', ')}` : '',
  ].filter(Boolean)
  return parts.length ? parts.join('; ') : 'la lista de herramientas cambió'
}

/**
 * Copia un PDF de la memoria a una carpeta temporal privada y lo abre con la aplicación que el sistema asocia a PDF.
 * Sólo se aceptan PDFs verificados por su firma y se fuerza la extensión `.pdf`, así un archivo guardado nunca se
 * ejecuta como programa. Devuelve `ok: false` con el motivo cuando no hay aplicación asociada.
 */
async function openStoredPdf(versionId: unknown): Promise<OpenFileResult> {
  if (typeof versionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(versionId)) return { ok: false, detail: 'identificador de archivo inválido' }
  const request = (token: string): Promise<Response> => fetch(`${CORE_BASE_URL}/api/memory/files/${versionId}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!sessionToken) sessionToken = await waitForSession()
  let response = await request(sessionToken)
  if (response.status === 401) {
    sessionToken = await waitForSession()
    response = await request(sessionToken)
  }
  if (!response.ok) return { ok: false, detail: `no se pudo leer el archivo (HTTP ${response.status})` }
  const data = Buffer.from(await response.arrayBuffer())
  if (data.subarray(0, 5).toString() !== '%PDF-') return { ok: false, detail: 'el archivo no es un PDF' }
  const disposition = /filename\*=UTF-8''([^;]+)/.exec(response.headers.get('content-disposition') ?? '')?.[1]
  let name = 'documento'
  try { if (disposition) name = decodeURIComponent(disposition) } catch { /* keep the generic name */ }
  // Characters and device names (NUL.pdf, COM1.pdf) Windows rejects, and trailing dots or spaces it strips.
  name = name.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/\.pdf$/i, '').slice(0, 120).replace(/[. ]+$/, '') || 'documento'
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i.test(name)) name = `_${name}`
  const directory = join(app.getPath('temp'), 'agent-hub-files', versionId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${name}.pdf`)
  // A version's content never changes, and on Windows rewriting fails while a viewer still has the previous copy open.
  if (!existsSync(path) || statSync(path).size !== data.length) await writeFile(path, data, { mode: 0o600 })
  const error = await shell.openPath(path)
  return error ? { ok: false, detail: error } : { ok: true, detail: path }
}

async function fetchPendingRestarts(): Promise<PendingRestart[]> {
  const request = (token: string): Promise<Response> => fetch(`${CORE_BASE_URL}/api/local/pending-restarts`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000),
  })
  if (!sessionToken) sessionToken = await waitForSession()
  let response = await request(sessionToken)
  if (response.status === 401) {
    sessionToken = await waitForSession()
    response = await request(sessionToken)
  }
  if (!response.ok) throw new Error(`pending-restarts: HTTP ${response.status}`)
  return await response.json() as PendingRestart[]
}

/**
 * Pregunta al core si Claude Desktop quedó con una lista vieja. Si el cambio entró solo
 * (una skill de la biblioteca) y la app está abierta, avisa una vez por snapshot con una
 * notificación que ofrece reiniciarla; el tray y la consola muestran el mismo botón.
 */
async function pollPendingRestarts(): Promise<void> {
  if (quitting || coreSupervisor.state !== 'running') return
  let list: PendingRestart[]
  try {
    list = await fetchPendingRestarts()
  } catch {
    return
  }
  const desktop = list.find((entry) => entry.cli_kind === 'claude_desktop' && supportsClientRestart(entry.cli_kind, process.platform)) ?? null
  const before = pendingClientRestart?.snapshot_hash ?? ''
  pendingClientRestart = desktop
  if ((desktop?.snapshot_hash ?? '') !== before) refreshTray()
  if (!desktop) {
    // La app ya cargó lo vigente: el próximo cambio vuelve a avisar.
    offeredRestarts.clear()
    return
  }
  if (!desktop.changes || desktop.changes.skills.auto.length === 0) return
  const offered = offeredRestarts.get(desktop.agent_id) ?? new Set<string>()
  const fresh = desktop.changes.skills.auto.filter((slug) => !offered.has(slug))
  if (fresh.length === 0) return
  for (const slug of desktop.changes.skills.auto) offered.add(slug)
  offeredRestarts.set(desktop.agent_id, offered)
  if (!(await isClientRunning('claude_desktop', clientDeps))) return
  const skills = fresh.join(', ')
  try {
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title: `Skill instalada: ${skills}`,
      body: 'Claude Desktop tiene que reiniciarse para verla. Hacé clic para reiniciarla ahora.',
    })
    notification.on('click', () => void confirmAndRestartClient())
    notification.show()
  } catch {
    // Sin centro de notificaciones queda el botón del tray y de la consola.
  }
}

/** Diálogo de confirmación y reinicio: nunca se cierra la app de la persona sin preguntar. */
async function confirmAndRestartClient(): Promise<void> {
  if (restartingClient) return
  const entry = pendingClientRestart
  const detail = entry ? `Cambios pendientes: ${describePending(entry)}. Se cierra y se vuelve a abrir Claude Desktop; guardá lo que tengas a medias en la app.` : 'Se cierra y se vuelve a abrir Claude Desktop; guardá lo que tengas a medias en la app.'
  const choice = await dialog.showMessageBox({
    type: 'question',
    message: 'Reiniciar Claude Desktop',
    detail,
    buttons: ['Reiniciar ahora', 'Más tarde'],
    defaultId: 0,
    cancelId: 1,
  })
  if (choice.response !== 0) return
  restartingClient = true
  try {
    const result = await restartClient('claude_desktop', clientDeps)
    notify(result.ok ? 'Claude Desktop reiniciada' : 'No se pudo reiniciar Claude Desktop', result.detail)
  } finally {
    restartingClient = false
  }
}
function safeAutostart(): boolean {
  try { return autostart.isEnabled() } catch { return false }
}
function refreshTray(): void {
  if (!tray) return
  const template = buildTrayTemplate({
    coreState: coreSupervisor.state,
    windowVisible: Boolean(mainWindow?.isVisible()),
    autostartEnabled: safeAutostart(),
    showShortcut: { label: SHOW_WINDOW_SHORTCUT_LABEL, registered: showWindowShortcutRegistered },
    update: pendingUpdate ? { version: pendingUpdate.version, state: 'ready' } : availableUpdate ? { version: availableUpdate.version, state: 'available' } : null,
    checkingUpdates,
    downloadingUpdate,
    installingUpdate,
    updateError,
    clientRestart: pendingClientRestart ? { label: 'Reiniciar Claude Desktop (cambios sin cargar)' } : null,
  })
  tray.setContextMenu(Menu.buildFromTemplate(template.map((item): Electron.MenuItemConstructorOptions => {
    if (item.type === 'separator') return { type: 'separator' }
    const entry: Electron.MenuItemConstructorOptions = { label: item.label ?? '' }
    if (item.type) entry.type = item.type
    if (item.enabled !== undefined) entry.enabled = item.enabled
    if (item.checked !== undefined) entry.checked = item.checked
    if (item.id) entry.click = () => handleTrayAction(item.id!)
    return entry
  })))
  tray.setToolTip(showWindowShortcutRegistered ? `${TRAY_TOOLTIP} — Mostrar/ocultar: ${SHOW_WINDOW_SHORTCUT_LABEL}` : TRAY_TOOLTIP)
}
function broadcastCoreState(): void {
  mainWindow?.webContents.send(IPC.coreStateChanged, coreStatus())
  refreshTray()
}
async function restartCore(): Promise<void> {
  if (maintenance) return maintenance
  maintenance = (async () => {
  await daemonSupervisor.stop()
  await coreSupervisor.stop()
  coreSupervisor.start()
  const token = await waitForSession()
  daemonSupervisor.start()
  if (token && mainWindow) void mainWindow.loadURL(consoleUrl(token))
  })().finally(() => { maintenance = null })
  return maintenance
}
async function syncNow(): Promise<void> {
  if (maintenance) return maintenance
  maintenance = (async () => {
    await daemonSupervisor.stop()
    try {
      const daemon = new DaemonApp({ ...loadConfig({ stateDir, controlPlaneUrl: CORE_BASE_URL, local: true,
        home: process.env.AGENTHUBD_HOME_DIR ?? app.getPath('home') }), requestTimeout: 3 }, { maxAttempts: 1 })
      if (!daemon.state.loadCredentials()) await daemon.enrollLocal(desktopBootstrap)
      const report = await daemon.syncOnce({ apply: true, wait: 0 })
      if (report.bootstrapError) throw new Error(report.bootstrapError)
    } finally { if (!quitting) daemonSupervisor.start() }
  })().finally(() => { maintenance = null })
  return maintenance
}
function handleTrayAction(action: TrayAction): void {
  if (action === 'show') showWindow()
  else if (action === 'hide') hideWindow()
  else if (action === 'toggle-autostart') autostart.setEnabled(!safeAutostart())
  else if (action === 'restart-core') void restartCore()
  else if (action === 'restart-client') void confirmAndRestartClient()
  else if (action === 'check-updates') void checkForUpdates('manual')
  else if (action === 'apply-update') void applyUpdate('manual')
  else if (action === 'open-release' && availableUpdate) void shell.openExternal(availableUpdate.page)
  else if (action === 'quit') void quit()
  refreshTray()
}
function showWindow(): void {
  if (quitting || !mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  // Una app accesoria (sin Dock) no pasa sola al frente al mostrar su ventana.
  if (process.platform === 'darwin') app.focus({ steal: true })
}
function toggleWindowFromShortcut(): void {
  if (quitting || !mainWindow || mainWindow.isDestroyed()) return
  // Estar visible no implica tener el foco: detrás de otra app debe pasar al frente.
  if (mainWindow.isVisible() && mainWindow.isFocused() && !mainWindow.isMinimized()) hideWindow()
  else showWindow()
}
function registerShowWindowShortcut(): void {
  try {
    showWindowShortcutRegistered = globalShortcut.register(SHOW_WINDOW_SHORTCUT, toggleWindowFromShortcut)
  } catch (error) {
    console.error('[shortcut]', error)
  }
  if (!showWindowShortcutRegistered) {
    const message = `No se pudo activar ${SHOW_WINDOW_SHORTCUT_LABEL} para abrir Agent Hub. Puede estar reservado por otra app o no estar permitido por el sistema. Podés abrir Agent Hub desde el menú de aplicaciones del sistema o desde su icono.`
    coreLog.write(`[shortcut] ${message}`)
    if (Notification.isSupported()) {
      try {
        const notification = new Notification({ title: 'Atajo de Agent Hub no disponible', body: message })
        notification.on('click', showWindow)
        notification.show()
      } catch (error) {
        console.error('[shortcut notification]', error)
      }
    }
  }
  refreshTray()
}
function hideWindow(): void {
  mainWindow?.hide()
  // Sin ventanas visibles una app accesoria seguiría activa y se quedaría con el
  // teclado; devolver el foco a la app anterior evita esa sensación de bloqueo.
  if (process.platform === 'darwin') app.hide()
  refreshTray()
  // La ventana se cerró: buen momento para aplicar una actualización ya descargada.
  if (pendingUpdate) void applyUpdate('auto')
}
function consoleUrl(token: string): string {
  const base = paths.renderer.kind === 'url' ? paths.renderer.url : CORE_BASE_URL
  const url = new URL(base)
  url.searchParams.set('sso_token', token)
  return url.toString()
}
function createWindow(token: string, hidden: boolean): void {
  const win = new BrowserWindow(windowOptions(paths.preloadPath, paths.iconPath))
  mainWindow = win
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    hideWindow()
  })
  // Windows no emite before-quit al cerrar sesión o apagar: sin esto no corre la última sincronización.
  win.on('session-end', () => { void quit() })
  win.on('show', refreshTray)
  win.on('hide', refreshTray)
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(win.webContents.getURL(), url)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  void win.loadURL(consoleUrl(token))
  if (!hidden) win.once('ready-to-show', () => win.show())
}
function createTray(): void {
  // nativeImage reads PNG and ICO; the macOS .icns bundle icon is not a supported input. Windows picks the 16/32 px
  // frames of the .ico for the notification area instead of a resized PNG.
  const windows = process.platform === 'win32'
  const trayIcon = windows ? paths.iconPath : join(dirname(paths.iconPath), 'icon.png')
  const source = existsSync(trayIcon) ? nativeImage.createFromPath(trayIcon) : nativeImage.createEmpty()
  const image = windows || source.isEmpty() ? source : source.resize({ width: 22, height: 22 })
  tray = new Tray(image)
  tray.on('click', showWindow)
  refreshTray()
}
function registerIpc(): void {
  ipcMain.handle(IPC.getSession, waitForSession)
  ipcMain.handle(IPC.syncNow, syncNow)
  ipcMain.handle(IPC.getCoreStatus, coreStatus)
  ipcMain.handle(IPC.restartCore, restartCore)
  ipcMain.handle(IPC.openStoredPdf, (_event, versionId: unknown) => openStoredPdf(versionId).catch((error: unknown) =>
    ({ ok: false, detail: error instanceof Error ? error.message : String(error) })))
  ipcMain.handle(IPC.restartClient, async (_event, cliKind: string) => {
    if (restartingClient) return { ok: false, detail: 'ya hay un reinicio en curso' }
    restartingClient = true
    try {
      return await restartClient(String(cliKind), clientDeps)
    } finally {
      restartingClient = false
    }
  })
  ipcMain.handle(IPC.getAutostart, safeAutostart)
  ipcMain.handle(IPC.setAutostart, (_event, enabled: boolean) => {
    autostart.setEnabled(Boolean(enabled))
    return safeAutostart()
  })
}
/** Plazo medido en tiempo (cuánto tarda una conexión rechazada depende del sistema); corta antes si el core ya no se reinicia. */
function waitForSession(): Promise<string> {
  return waitForDesktopSession(CORE_BASE_URL, desktopBootstrap, () => coreSupervisor.state === 'failed', SESSION_TIMEOUT_MS)
}
function environment(): Record<string, string> {
  return { Versión: app.getVersion(), Sistema: `${process.platform} ${release()} (${process.arch})`,
    Electron: process.versions.electron ?? '-', Node: process.versions.node, Empaquetada: app.isPackaged ? 'sí' : 'no' }
}
/** Error de arranque con la causa real del log del core y un reporte filtrado para GitHub (copiar o issue prellenado). */
async function showStartupFailure(message: string): Promise<void> {
  const core = tailLog(join(logsDir, 'core.log'), 200)
  const platformName = ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' } as Record<string, string>)[process.platform] ?? process.platform
  const report = buildReport({
    title: `Agent Hub ${app.getVersion()} no inicia en ${platformName}: ${message.split('\n')[0]!.slice(0, 120)}`,
    summary: 'Al abrir la app apareció «Agent Hub no pudo iniciar».',
    error: message,
    environment: environment(),
    logs: [{ name: 'core', lines: core }, { name: 'daemon', lines: tailLog(join(logsDir, 'daemon.log'), 60) }],
    home: app.getPath('home'),
  })
  const cause = core.filter(line => /error|exception|fall[oó]/i.test(line)).slice(-3).map(line => line.replace(/^\S+ /, ''))
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'Agent Hub no pudo iniciar',
    message: 'Agent Hub no pudo iniciar',
    detail: [message, ...(cause.length ? ['', 'Último error del core:', ...cause] : []), '', `Registros: ${logsDir}`,
      'El reporte filtra credenciales conocidas, emails y la carpeta del usuario. Revisalo antes de publicarlo en GitHub.'].join('\n'),
    buttons: ['Abrir issue en GitHub', 'Copiar reporte', 'Cerrar'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })
  if (response === 0 || response === 1) clipboard.writeText(report.text)
  if (response === 0) await shell.openExternal(report.url)
}
/** `null` si el puerto se puede usar; si no, el código del error (EACCES en un rango reservado, EADDRINUSE si está ocupado). */
function bindProblem(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'))
    server.listen({ host: CORE_HOST, port, exclusive: true }, () => server.close(() => resolve(null)))
  })
}
async function answersAsHub(): Promise<boolean> {
  try {
    const response = await fetch(`${CORE_BASE_URL}/health`, { signal: AbortSignal.timeout(1500) })
    return response.ok && (await response.json() as { service?: string }).service === 'agenthub-control-plane'
  } catch {
    return false
  }
}
/**
 * Windows reserva rangos de puertos para Hyper-V, WSL y Docker (`netsh interface ipv4 show
 * excludedportrange protocol=tcp`) y el bind falla con EACCES aunque nadie escuche. Si el
 * puerto no sirve y no lo ocupa otro Agent Hub (eso lo informa `waitForSession`), se guarda
 * uno alternativo y la app se reinicia con él. Las URLs de redirección OAuth registradas con
 * el puerto anterior dejan de valer y esas cuentas se vuelven a autorizar.
 */
async function ensureCorePort(): Promise<void> {
  if (process.env.AGENTHUB_HUB_PORT) return
  const problem = await bindProblem(CORE_PORT)
  if (!problem || (problem === 'EADDRINUSE' && await answersAsHub())) return
  for (const port of [DEFAULT_CORE_PORT, ...FALLBACK_CORE_PORTS]) {
    if (port === CORE_PORT || await bindProblem(port)) continue
    writeFileSync(portFile, String(port))
    coreLog.write(`[desktop] el puerto ${CORE_PORT} no se puede usar (${problem}); la app se reinicia con el ${port}`)
    app.relaunch()
    app.exit(0)
    return new Promise(() => undefined)
  }
  throw new Error(`el puerto ${CORE_PORT} no se puede usar (${problem}) y tampoco ${FALLBACK_CORE_PORTS.join(', ')}. ` +
    'En Windows, los rangos reservados se ven con «netsh interface ipv4 show excludedportrange protocol=tcp».')
}
/** Los puentes MCP leen la URL del hub de las credenciales del daemon: tiene que seguir al puerto actual. */
function syncDaemonUrl(): void {
  try {
    const daemon = new DaemonApp({ ...loadConfig({ stateDir, controlPlaneUrl: CORE_BASE_URL, local: true,
      home: process.env.AGENTHUBD_HOME_DIR ?? app.getPath('home') }), requestTimeout: 3 }, { maxAttempts: 1 })
    const credentials = daemon.state.loadCredentials()
    if (credentials && credentials.controlPlaneUrl !== CORE_BASE_URL) daemon.state.saveCredentials({ ...credentials, controlPlaneUrl: CORE_BASE_URL })
  } catch (error) {
    daemonLog.write(`[desktop] no se pudo actualizar la URL del hub en las credenciales: ${error instanceof Error ? error.message : String(error)}`)
  }
}
/**
 * Entradas de inicio de versiones anteriores en Windows: sin `--hidden` (abrían la ventana al
 * iniciar sesión) y con el nombre de valor previo al AppUserModelId, que dejaría dos entradas.
 */
function migrateWindowsLoginItem(): void {
  if (process.platform !== 'win32') return
  const items = app.getLoginItemSettings(loginItemOptions).launchItems ?? []
  const legacy = items.filter((item) => item.path.toLowerCase() === process.execPath.toLowerCase() && !item.args.includes('--hidden'))
  for (const item of legacy) app.setLoginItemSettings({ openAtLogin: false, path: item.path, args: item.args, name: item.name })
  if (legacy.length) app.setLoginItemSettings({ openAtLogin: true, ...loginItemOptions })
}
/** Lo que dejó `applyUpdate` antes de lanzar el instalador NSIS; se consume una sola vez. */
function readUpdateMarker(): { window: boolean; bridges: number } | null {
  if (!existsSync(updateMarker)) return null
  try {
    const value = JSON.parse(readFileSync(updateMarker, 'utf8')) as { window?: unknown; bridges?: unknown }
    return { window: value.window === true, bridges: typeof value.bridges === 'number' ? value.bridges : 0 }
  } catch {
    return null
  } finally {
    rmSync(updateMarker, { force: true })
  }
}
function notifyClosedBridges(count: number): void {
  try {
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title: 'Agent Hub se actualizó',
      body: `La actualización cerró la conexión de ${count === 1 ? 'un agente' : `${count} agentes`} con el hub. ` +
        'Haga clic aquí para reiniciar Claude Desktop; las sesiones abiertas de Claude Code u otros agentes se reconectan al reiniciarlas.',
    })
    notification.on('click', () => void confirmAndRestartClient())
    notification.show()
  } catch {
    // Sin centro de notificaciones no hay a quién avisar; los clientes muestran el servidor desconectado.
  }
}
async function quit(): Promise<void> {
  if (quitting) return
  quitting = true
  // Si algo se cuelga al cerrar, la app sale igual: un proceso que no termina obliga a
  // forzar el cierre y dejaba core y daemon huérfanos bloqueando el próximo arranque.
  const deadline = setTimeout(() => {
    console.error(`[quit] apagado ordenado excedió ${QUIT_DEADLINE_MS} ms; saliendo`)
    stopped = true
    app.exit(1)
  }, QUIT_DEADLINE_MS)
  try {
    await maintenance?.catch(() => undefined)
    // Flush the last saved switches before stopping the authority used by offline gateways.
    if (coreSupervisor.state === 'running') await syncNow().catch(error => console.error('[sync on quit]', error.message))
    await daemonSupervisor.stop()
    await coreSupervisor.stop()
    if (installOnQuit) {
      try {
        await updater.apply(installOnQuit)
      } catch (error) {
        // The installed version stays; reopen it instead of leaving the person without the hub.
        console.error('[updater] no se pudo iniciar el instalador:', error instanceof Error ? error.message : String(error))
        rmSync(updateMarker, { force: true })
        relaunchAfterQuit = true
      }
    }
  } finally {
    clearTimeout(deadline)
    stopped = true
    // Tras intercambiar el bundle en macOS, la misma ruta ya es la versión nueva.
    if (relaunchAfterQuit) app.relaunch()
    app.quit()
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
else {
  process.once('SIGTERM', () => { void quit() })
  process.once('SIGINT', () => { void quit() })
  app.on('second-instance', showWindow)
  app.whenReady().then(async () => {
    coreSupervisor.on('state', broadcastCoreState)
    daemonSupervisor.on('state', broadcastCoreState)
    for (const [name, supervisor, log] of [['core', coreSupervisor, coreLog], ['daemon', daemonSupervisor, daemonLog]] as const) {
      supervisor.on('log', line => log.write(line))
      supervisor.on('error', (error) => {
        console.error(`[${name}]`, error.message)
        log.write(`[supervisor] ${error.message}`)
      })
      supervisor.on('exit', (code, signal) => log.write(`[supervisor] el proceso terminó (código ${code ?? '-'}, señal ${signal ?? '-'})`))
    }
    coreLog.write(`[desktop] Agent Hub ${app.getVersion()} en ${process.platform} ${release()} (${process.arch})`)
    const updated = readUpdateMarker()
    // `--hidden`: autostart y pruebas. `--updated`: el instalador NSIS reabre la app tras una
    // actualización, que corre justamente con la ventana oculta salvo que se haya pedido con ella abierta.
    const hidden = process.argv.includes('--hidden') || (process.argv.includes('--updated') && !updated?.window)
    migrateWindowsLoginItem()
    await ensureCorePort()
    syncDaemonUrl()
    coreSupervisor.start()
    const token = await waitForSession()
    sessionToken = token
    daemonSupervisor.start()
    registerIpc()
    createTray()
    createWindow(token, hidden)
    registerShowWindowShortcut()
    if (updated?.bridges) notifyClosedBridges(updated.bridges)
    app.on('activate', showWindow)
    void updater.cleanup()
    announceVersionChange()
    void checkForUpdates('startup')
    setInterval(() => void checkForUpdates('timer'), CHECK_INTERVAL_MS).unref()
    setInterval(() => void pollPendingRestarts(), PENDING_RESTART_POLL_MS).unref()
  }).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    coreLog.write(`[desktop] no pudo iniciar: ${message}`)
    // Sin esto la app desaparecía en silencio y parecía que "no abría".
    await showStartupFailure(message).catch(() => dialog.showErrorBox('Agent Hub no pudo iniciar', message))
    app.quit()
  })
  app.on('window-all-closed', () => undefined)
  app.on('will-quit', () => globalShortcut.unregisterAll())
  app.on('before-quit', event => {
    if (!stopped) { event.preventDefault(); void quit() }
  })
}

export { pathContext, coreStatus }
