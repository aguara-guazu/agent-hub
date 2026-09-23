import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron'

import { CoreSupervisor } from './supervisor.js'
import { resolvePaths, type PathContext } from './paths.js'
import { windowOptions, isAllowedNavigation } from './window.js'
import { buildTrayTemplate, TRAY_TOOLTIP, type TrayAction } from './tray.js'
import { AutostartManager, type LinuxAutostartFs } from './autostart.js'
import { IPC, type CoreStatus } from './ipc.js'
import { AutoUpdater, CHECK_INTERVAL_MS, type UpdateStatus } from './updater.js'
import { defaultClientDeps, isClientRunning, restartClient, supportsClientRestart } from './clients.js'
import { DaemonApp, loadConfig } from '@agenthub/daemon'

const APP_NAME = 'Agent Hub'
const CORE_HOST = '127.0.0.1'
const CORE_PORT = Number(process.env.AGENTHUB_HUB_PORT ?? '8765')
const CORE_BASE_URL = `http://${CORE_HOST}:${CORE_PORT}`
app.setName(APP_NAME)
// Agent Hub vive en la barra de menú: sin ícono en el Dock ni en Cmd+Tab. El bundle
// empaquetado ya lo declara con LSUIElement; esto cubre `npm run dev`.
if (process.platform === 'darwin') app.dock?.hide()
if (process.env.AGENTHUB_DESKTOP_STATE_DIR) app.setPath('userData', process.env.AGENTHUB_DESKTOP_STATE_DIR)
// Finder launches apps with a minimal PATH; include common local CLI locations.
process.env.PATH = [...new Set([process.env.PATH ?? '', join(app.getPath('home'), '.local/bin'),
  join(app.getPath('home'), '.cargo/bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean))].join(process.platform === 'win32' ? ';' : ':')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let stopped = false
let maintenance: Promise<void> | null = null
/** Tope para el apagado ordenado; pasado este tiempo la app sale igual. */
const QUIT_DEADLINE_MS = 20_000
const APP_BUNDLE_ID = 'io.craftech.agenthub'
/** Actualización ya descargada, pendiente de reiniciar. */
let pendingUpdate: Extract<UpdateStatus, { state: 'downloaded' }> | null = null
/** Hay versión nueva pero esta instalación (zip, .deb, bundle sin permisos) sólo puede avisar. */
let availableUpdate: { version: string; page: string } | null = null
let checkingUpdates = false
let relaunchAfterQuit = false

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
    get: () => ({ openAtLogin: app.getLoginItemSettings().openAtLogin }),
    set: (settings) => app.setLoginItemSettings(settings),
  },
  linuxFs,
})

const updater = new AutoUpdater({
  currentVersion: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  execPath: process.execPath,
  env: process.env,
  bundleId: APP_BUNDLE_ID,
  enabled: app.isPackaged,
  // Para probar contra un servidor propio sin publicar una release.
  ...(process.env.AGENTHUB_UPDATE_API ? { apiBase: process.env.AGENTHUB_UPDATE_API } : {}),
  ...(process.env.AGENTHUB_UPDATE_REPO ? { repo: process.env.AGENTHUB_UPDATE_REPO } : {}),
  log: (line) => console.error(line),
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
  if (checkingUpdates || quitting) return
  checkingUpdates = true
  refreshTray()
  try {
    const status = await updater.check()
    if (status.state === 'downloaded') {
      pendingUpdate = status
      availableUpdate = null
      if (!mainWindow?.isVisible()) {
        await applyUpdate()
        return
      }
      notify('Actualización lista', `Agent Hub v${status.version} se instala al cerrar la ventana o desde el menú de la barra.`)
    } else if (status.state === 'available') {
      availableUpdate = { version: status.version, page: status.page }
      if (reason !== 'timer') notify('Nueva versión disponible', `Agent Hub v${status.version}. Esta instalación no se actualiza sola: abrí la release desde el menú de la barra.`)
    } else if (status.state === 'failed') {
      console.error(`[updater] v${status.version}: ${status.error}`)
      if (reason === 'manual') notify('No se pudo descargar la actualización', status.error)
    } else if (reason === 'manual') {
      notify('Agent Hub está al día', `Versión ${app.getVersion()}.`)
    }
  } finally {
    checkingUpdates = false
    refreshTray()
  }
}

async function applyUpdate(): Promise<void> {
  const update = pendingUpdate
  if (!update || quitting) return
  try {
    const outcome = await updater.apply(update)
    relaunchAfterQuit = outcome === 'relaunch'
    console.error(`[updater] v${update.version} instalada; ${relaunchAfterQuit ? 'reiniciando' : 'el instalador vuelve a abrir la app'}`)
    await quit()
  } catch (error) {
    pendingUpdate = null
    const message = error instanceof Error ? error.message : String(error)
    console.error('[updater] la instalación falló:', message)
    notify('No se pudo instalar la actualización', message)
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
    update: pendingUpdate ? { version: pendingUpdate.version, state: 'ready' } : availableUpdate ? { version: availableUpdate.version, state: 'available' } : null,
    checkingUpdates,
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
  tray.setToolTip(TRAY_TOOLTIP)
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
  else if (action === 'apply-update') void applyUpdate()
  else if (action === 'open-release' && availableUpdate) void shell.openExternal(availableUpdate.page)
  else if (action === 'quit') void quit()
  refreshTray()
}
function showWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  // Una app accesoria (sin Dock) no pasa sola al frente al mostrar su ventana.
  if (process.platform === 'darwin') app.focus({ steal: true })
}
function hideWindow(): void {
  mainWindow?.hide()
  // Sin ventanas visibles una app accesoria seguiría activa y se quedaría con el
  // teclado; devolver el foco a la app anterior evita esa sensación de bloqueo.
  if (process.platform === 'darwin') app.hide()
  refreshTray()
  // La ventana se cerró: buen momento para aplicar una actualización ya descargada.
  if (pendingUpdate) void applyUpdate()
}
function consoleUrl(token: string): string {
  const base = paths.renderer.kind === 'url' ? paths.renderer.url : CORE_BASE_URL
  const url = new URL(base)
  url.searchParams.set('sso_token', token)
  return url.toString()
}
function createWindow(token: string): void {
  const win = new BrowserWindow(windowOptions(paths.preloadPath, paths.iconPath))
  mainWindow = win
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    hideWindow()
  })
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
  // `--hidden`: arranca en la bandeja sin abrir la ventana (autostart de Linux, pruebas).
  if (!process.argv.includes('--hidden')) win.once('ready-to-show', () => win.show())
}
function createTray(): void {
  // nativeImage reads PNG; the macOS .icns bundle icon is not a supported input.
  const trayIcon = join(dirname(paths.iconPath), 'icon.png')
  const image = existsSync(trayIcon) ? nativeImage.createFromPath(trayIcon).resize({ width: 22, height: 22 }) : nativeImage.createEmpty()
  tray = new Tray(image)
  tray.on('click', showWindow)
  refreshTray()
}
function registerIpc(): void {
  ipcMain.handle(IPC.getSession, waitForSession)
  ipcMain.handle(IPC.syncNow, syncNow)
  ipcMain.handle(IPC.getCoreStatus, coreStatus)
  ipcMain.handle(IPC.restartCore, restartCore)
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
async function waitForSession(): Promise<string> {
  let lastError = 'core no disponible'
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const health = await fetch(`${CORE_BASE_URL}/health`)
      if (health.ok) {
        const response = await fetch(`${CORE_BASE_URL}/api/auth/desktop-session`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${desktopBootstrap}` },
        })
        if (!response.ok) {
          throw new Error(`sesión local: HTTP ${response.status}. Otro proceso responde en ${CORE_BASE_URL}; ` +
            'si es un Agent Hub anterior que quedó huérfano, ciérrelo antes de volver a abrir la app.')
        }
        const payload = await response.json() as { access_token?: string }
        if (payload.access_token) return payload.access_token
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(lastError)
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
    coreSupervisor.on('error', (error) => console.error('[core]', error.message))
    daemonSupervisor.on('error', (error) => console.error('[daemon]', error.message))
    coreSupervisor.start()
    const token = await waitForSession()
    sessionToken = token
    daemonSupervisor.start()
    registerIpc()
    createTray()
    createWindow(token)
    app.on('activate', showWindow)
    void updater.cleanup()
    announceVersionChange()
    void checkForUpdates('startup')
    setInterval(() => void checkForUpdates('timer'), CHECK_INTERVAL_MS).unref()
    setInterval(() => void pollPendingRestarts(), PENDING_RESTART_POLL_MS).unref()
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    // Sin esto la app desaparecía en silencio y parecía que "no abría".
    dialog.showErrorBox('Agent Hub no pudo iniciar', message)
    app.quit()
  })
  app.on('window-all-closed', () => undefined)
  app.on('before-quit', event => {
    if (!stopped) { event.preventDefault(); void quit() }
  })
}

export { pathContext, coreStatus }
