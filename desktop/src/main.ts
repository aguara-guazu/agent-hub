import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { release, userInfo } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, powerMonitor, powerSaveBlocker, shell, Tray } from 'electron'
import { buildReport, LogFile, tailLog } from '@agenthub/memory/report'

import { waitForDesktopSession } from './session.js'
import { CoreSupervisor } from './supervisor.js'
import { resolvePaths, type PathContext } from './paths.js'
import { windowOptions, isAllowedNavigation, externalUrl } from './window.js'
import { buildTrayTemplate, trayTooltip, type TrayAction } from './tray.js'
import { activeLanguage, isLanguagePreference, onLanguageChange, resolveLanguage, setActiveLanguage, t, type LanguagePreference } from "./i18n.js"
import { AutostartManager, type LinuxAutostartFs } from './autostart.js'
import { IPC, type CoreStatus, type OpenFileResult } from './ipc.js'
import { NavigationRelay } from './navigation.js'
import { AutostartOffer } from './autostart-offer.js'
import { ClockWake } from './clock-wake.js'
import { holdLimitFor, KeepAwake } from './keep-awake.js'
import { deliveryNotice, FeedPoller, ScheduleNoticeBatcher, type FeedResponse, type Notice } from './schedule-feed.js'
import { AutoUpdater, bundlePathFrom, fetchLatestRelease, fsyncPath, realBundlePath, resolveFeed, revalidateArtifact, type UpdateStatus } from "./updater.js"
import { UpdateStateCorruptError, UpdateStore } from './update-state.js'
import { advancePhase, inspectSides, readJson, readTransaction, removeTreeDurable, rollbackRequestFile, type UpdateTransaction } from './update-transaction.js'
import { prepareWatchdog } from './update-watchdog.js'
import { recoverTransaction } from './update-recovery.js'
import { parseTrustSet } from './update-trust.js'
import { collectRuntimes, ensureGatewayRuntime, runtimeBundlePath, runtimePaths, swapHelperPath } from './gateway-runtime.js'
import { CoreDidNotExit, DRAIN_SECRET_HEADER, DrainClient, DrainLeaseLost, type DrainLease } from './update-lease.js'
import { probeMemoryMcp, memoryCredentialPath } from './update-probe.js'
import { HEALTH_DEADLINE_MS, HEALTH_PROBE_TIMEOUT_MS, confirmWhenHealthy, processStartTime, whenStablyHealthy } from './update-rollback.js'
import { effectiveTrust, loadBundledTrust, type BundledTrust, type TrustSet } from './update-trust.js'
import { UpdateHintListener } from './update-hint.js'
import { overrideIsSafe, postponedLine, type UpdateReason, type UpdateReport } from './update-report.js'
import { createVersionInfoReader } from "./version-info.js"
import { SilentUpdates, hiddenUpdateLaunch, updateRelaunchArgs } from './silent-updates.js'
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
const QUIT_DEADLINE_MS = 30_000
let relaunchAfterQuit = false
/** Instaladores externos corren después de detener core y daemon. */
let installOnQuit: Extract<UpdateStatus, { state: 'downloaded' }> | null = null

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
/** Sólo el escritorio presenta este secreto para pedir el drenaje de una actualización; vive en memoria y va únicamente al entorno de core. */
const updateDrainSecret = randomBytes(32).toString('base64url')
const sharedEnv: NodeJS.ProcessEnv = {
  ELECTRON_RUN_AS_NODE: '1',
  AGENTHUB_DESKTOP_BOOTSTRAP_TOKEN: desktopBootstrap,
  AGENTHUB_LOG_DIR: logsDir,
}
/** Entorno de core. Es un objeto vivo: el runtime versionado agrega sus variables antes de arrancar y el supervisor lo lee en cada arranque. */
const coreEnv: NodeJS.ProcessEnv = {
    ...sharedEnv,
    AGENTHUB_HUB_HOST: CORE_HOST,
    AGENTHUB_HUB_PORT: String(CORE_PORT),
    AGENTHUB_LOCAL_MODE: '1',
    AGENTHUB_DATABASE_PATH: join(stateDir, 'hub.db'),
    AGENTHUB_JWT_SECRET: jwtSecret,
    AGENTHUB_UPDATE_DRAIN_SECRET: updateDrainSecret,
    AGENTHUB_CONSOLE_DIST: dirname(paths.rendererIndex),
    // Credenciales OAuth de los MCP servers: mismo directorio que lee el gateway.
    AGENTHUB_OAUTH_DIR: join(stateDir, 'oauth'),
    AGENTHUB_OAUTH_REDIRECT_URL: `${CORE_BASE_URL}/api/oauth/callback`,
}
/**
 * Un core lanzado por una actualización nace cerrado hasta que esta app lo admite. La fuente es el journal durable, no el entorno
 * heredado del vigía: sobrevive a un reinicio del equipo y a cada reinicio de core mientras la transacción no esté admitida.
 */
function startupTransactionId(): string {
  const read = readTransaction(updateStore.dir)
  if (read.kind !== 'ok') return ''
  const { phase, to, transaction_id: id } = read.tx
  const physicallySwapped = phase === "swap_intent" && inspectSides(read.tx) === "swapped"
  return (["swapped", "launched", "admitting", "admitted"].includes(phase) || physicallySwapped) && to.version === app.getVersion() ? id : ""
}
delete process.env.AGENTHUB_UPDATE_TX
Object.defineProperty(coreEnv, 'AGENTHUB_UPDATE_TX', { enumerable: true, configurable: true, get: startupTransactionId })
const coreSupervisor = new CoreSupervisor({
  command: paths.coreCommand,
  args: paths.coreArgs,
  // Con el lease de drenaje no hay llamadas en curso; el margen cubre el cierre ordenado de core.
  stopGraceMs: 18_000,
  env: coreEnv,
})
/** Entorno del daemon; vivo por la misma razón que el de core. */
const daemonEnv: NodeJS.ProcessEnv = {
    ...sharedEnv,
    AGENTHUBD_LOCAL: '1',
    AGENTHUBD_URL: CORE_BASE_URL,
    AGENTHUBD_STATE_DIR: stateDir,
    AGENTHUBD_REQUEST_TIMEOUT: '3',
    AGENTHUB_ISOLATION: 'off',
}
const daemonSupervisor = new CoreSupervisor({
  command: paths.daemonCommand,
  args: [...paths.daemonArgs, 'run', '--local'],
  env: daemonEnv,
})

/**
 * Deja lista la copia versionada del bundle y entrega a core y al daemon el lanzador estable y su raíz. Sin copia
 * válida no se exporta nada: una variable que apunte a un archivo ausente rompería los comandos que se generan con ella,
 * y sin copia tampoco se aplica ninguna actualización (el vigía y el helper salen de ahí).
 */
async function prepareGatewayRuntime(): Promise<void> {
  if (!app.isPackaged || process.platform !== 'darwin') return
  try {
    const result = await ensureGatewayRuntime({ stateDir, execPath: process.execPath, version: app.getVersion() })
    if (!result) return
    coreEnv.AGENTHUB_GATEWAY_RUNTIME = result.launcher
    coreEnv.AGENTHUB_GATEWAY_RUNTIME_ROOT = runtimePaths(stateDir).root
    daemonEnv.AGENTHUB_GATEWAY_RUNTIME = result.launcher
    coreLog.write(`[runtime] copia versionada lista para v${app.getVersion()}`)
  } catch (error) {
    coreLog.write(`[runtime] sin copia versionada (no se aplican actualizaciones): ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * En Windows la entrada de inicio lleva `--hidden` para arrancar en la bandeja. Electron
 * compara path y args al leerla: `openAtLogin` sólo es true con los mismos valores.
 */
const loginItemOptions = process.platform === 'win32' ? { path: process.execPath, args: ['--hidden'] } : {}
/**
 * Una instancia con estado propio (`AGENTHUB_DESKTOP_STATE_DIR`: pruebas aisladas) no es la instalación de la persona:
 * no registra ni reescribe ítems de inicio de sesión, ni ofrece hacerlo. Se anota una sola vez en core.log.
 */
const isolatedInstance = Boolean(process.env.AGENTHUB_DESKTOP_STATE_DIR)
let loginItemsSkippedLogged = false
function skipLoginItems(): boolean {
  if (!isolatedInstance) return false
  if (!loginItemsSkippedLogged) { loginItemsSkippedLogged = true; coreLog.write('[autostart] instancia aislada (AGENTHUB_DESKTOP_STATE_DIR): no se registran ítems de inicio de sesión') }
  return true
}
const linuxFs: LinuxAutostartFs = {
  configHome: process.env.XDG_CONFIG_HOME ?? join(app.getPath('home'), '.config'),
  exists: existsSync,
  write: (path, contents) => {
    if (skipLoginItems()) return
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents, { mode: 0o644 })
  },
  remove: (path) => { if (!skipLoginItems()) rmSync(path, { force: true }) },
}
const autostart = new AutostartManager({
  platform: process.platform,
  // En un AppImage el binario vive en un punto de montaje distinto en cada ejecución;
  // el archivo .AppImage sí es estable.
  execPath: process.env.APPIMAGE ?? app.getPath('exe'),
  appName: APP_NAME,
  loginItem: {
    get: () => ({ openAtLogin: app.getLoginItemSettings(loginItemOptions).openAtLogin }),
    set: (settings) => { if (!skipLoginItems()) app.setLoginItemSettings({ ...settings, ...loginItemOptions }) },
  },
  linuxFs,
})

// Para probar contra un servidor propio sin publicar una release.
const updateSource = {
  ...(process.env.AGENTHUB_UPDATE_API ? { apiBase: process.env.AGENTHUB_UPDATE_API } : {}),
  ...(process.env.AGENTHUB_UPDATE_REPO ? { repo: process.env.AGENTHUB_UPDATE_REPO } : {}),
}
/** Registro técnico del actualizador: va a core.log además de stderr; nunca a notificaciones ni diálogos. */
function updaterLog(line: string): void {
  console.error(line)
  coreLog.write(line)
}
const updateStore = new UpdateStore(stateDir)
/** Trust store embebido en el build (`desktop/dist/update-trust.json`, lo genera el empaquetado); ausente, sólo integridad. */
const bundledTrust: BundledTrust = loadBundledTrust(join(appDir, 'update-trust.json'))
const trustProvider = {
  // Un archivo de claves que existe pero no es válido bloquea la actualización: degradar a «sin claves» abriría la puerta a una release sin firma.
  current: (): TrustSet => {
    if (bundledTrust.kind === 'invalid') throw new Error(t('updater.trustInvalid'))
    return effectiveTrust(bundledTrust.kind === 'ok' ? bundledTrust.trust : null, updateStore.read().trust)
  },
  requireSignature: (): boolean => bundledTrust.kind === 'invalid' || updateStore.read().requireSignature,
}
function realPathOrSelf(path: string): string {
  try { return realpathSync(path) } catch { return path }
}
/** Un servidor de pruebas en loopback nunca puede operar sobre la instalación, el estado o el HOME reales de la persona. */
const overrideSafe = ((): boolean => {
  const feed = resolveFeed({ apiBase: process.env.AGENTHUB_UPDATE_API, repo: process.env.AGENTHUB_UPDATE_REPO })
  if (!feed.loopback) return true
  const realHome = userInfo().homedir
  return overrideIsSafe({
    install: realPathOrSelf(bundlePathFrom(process.execPath) ?? process.execPath),
    state: realPathOrSelf(stateDir),
    home: realPathOrSelf(app.getPath('home')),
    realInstall: realPathOrSelf('/Applications/Agent Hub.app'),
    realState: realPathOrSelf(join(realHome, 'Library', 'Application Support', 'Agent Hub')),
    realHome: realPathOrSelf(realHome),
  })
})()

const updater = new AutoUpdater({
  currentVersion: app.getVersion(),
  platform: process.platform,
  // Un build x64 corriendo emulado en Windows on ARM o en Rosetta pasa al nativo con la próxima versión.
  arch: app.runningUnderARM64Translation ? 'arm64' : process.arch,
  execPath: process.execPath,
  env: process.env,
  bundleId: APP_BUNDLE_ID,
  enabled: app.isPackaged && overrideSafe,
  ...updateSource,
  onProgress: (progress) => setUpdateReport(progress.state === 'downloading' ? { phase: 'downloading', version: progress.version } : { phase: 'available', version: progress.version }),
  trust: trustProvider,
  // El helper sale de la copia de runtime de esta versión: con RENAME_SWAP el contenido del bundle instalado cambia justo en ese instante.
  swapHelper: () => {
    const bundle = realBundlePath(process.execPath)
    return (bundle && runtimeOldBundle(bundle) ? swapHelperPath(stateDir, app.getVersion(), basename(bundle)) : null) ?? ''
  },
  gate: updateStore,
  log: updaterLog,
})

const versionFeed = resolveFeed(updateSource, updaterLog)
const readVersionInfo = createVersionInfoReader({
  currentVersion: app.getVersion(),
  fetchRelease: () => fetchLatestRelease({ apiBase: versionFeed.apiBase, repo: versionFeed.repo }),
})

function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  } catch {
    // Sin centro de notificaciones no pasa nada: el menú de la barra muestra lo mismo.
  }
}

const navigation = new NavigationRelay(route => mainWindow?.webContents.send(IPC.navigate, route))

/**
 * Notificaciones con acción de clic retenidas hasta el clic o el fallo. Sin una referencia viva el recolector puede reclamar el objeto
 * `Notification` y con él el manejador: el clic sólo activa la app. `close` no libera: Electron no garantiza cuándo lo emite y una
 * notificación que sigue en el Centro de notificaciones todavía recibe clics. El tope acota las descartadas.
 */
const liveNotifications: Notification[] = []
const LIVE_NOTIFICATIONS_LIMIT = 20
function showRetained(notification: Notification): void {
  const release = (): void => {
    const index = liveNotifications.indexOf(notification)
    if (index >= 0) liveNotifications.splice(index, 1)
  }
  notification.once('click', release)
  notification.once('failed', release)
  notification.on('click', () => coreLog.write(`[notification] clic: ${notification.title}`))
  notification.on('failed', (_event, error) => coreLog.write(`[notification] falló: ${notification.title}: ${error}`))
  liveNotifications.push(notification)
  if (liveNotifications.length > LIVE_NOTIFICATIONS_LIMIT) liveNotifications.shift()
  notification.show()
}

/** Notificación del sistema cuyo clic abre la ventana en una ruta de la consola (ver `navigation.ts`). */
function notifyOpening(notice: Notice): void {
  try {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title: notice.title, body: notice.body })
    notification.on('click', () => openRoute(notice.route))
    showRetained(notification)
  } catch {
    // Sin centro de notificaciones el contenido sigue disponible en la consola.
  }
}

function openRoute(route: string): void {
  const accepted = navigation.request(route)
  coreLog.write(`[navigation] pedido ${route}: ${accepted ? navigation.listening ? 'renderer escuchando' : 'pendiente hasta que el renderer escuche' : 'ruta no permitida'}`)
  if (!accepted) return
  showWindow()
}

/** Ajustes de `GET /api/automations`; sin respuesta del core rigen los valores por defecto. */
interface AutomationPrefs { automations_enabled: boolean; notify_schedule_created: boolean; notify_delivery: boolean; keep_awake: boolean }
const DEFAULT_AUTOMATION_PREFS: AutomationPrefs = { automations_enabled: true, notify_schedule_created: true, notify_delivery: true, keep_awake: true }
let automationPrefs = DEFAULT_AUTOMATION_PREFS
/** Hasta leer los ajustes una vez no se sabe si la persona apagó «mantener despierta»; sin eso no se retiene la computadora. */
let automationPrefsLoaded = false
/** Cada cuánto el proceso principal consulta el feed del scheduler. */
const SCHEDULE_FEED_POLL_MS = 10_000
/** Agrupación de avisos de schedules creados o cambiados por un agente: cubre la ráfaga típica (status, brief y cierre) sin demorar el aviso. */
const SCHEDULE_NOTICE_WINDOW_MS = 15_000
/** Tope de respaldo por run cuando el core no informa `deadline_at`; con plazo, `holdLimitFor` lo ajusta al plazo real. */
const KEEP_AWAKE_MAX_MS = 20 * 60_000
/** Espera tras resume/unlock-screen: la red suele volver unos segundos después. */
const CLOCK_WAKE_SETTLE_MS = 3_000
const autostartOfferedFile = join(stateDir, 'autostart-offered')
/** Preferencia de idioma (`es`, `en` o `auto`) que elige la persona en Ajustes; el renderer la lee y la escribe por IPC. */
const languageFile = join(stateDir, "language")
let languagePreference: LanguagePreference = readLanguagePreference()

function readLanguagePreference(): LanguagePreference {
  try {
    const stored = readFileSync(languageFile, "utf8").trim()
    return isLanguagePreference(stored) ? stored : "auto"
  } catch {
    return "auto"
  }
}

/** `app.getLocale()` sólo es fiable tras `ready` (Windows): se llama desde `whenReady` y desde el IPC. */
function applyLanguagePreference(): void {
  setActiveLanguage(resolveLanguage(languagePreference, app.getLocale()))
}

function saveLanguagePreference(value: unknown): LanguagePreference {
  if (!isLanguagePreference(value)) return languagePreference
  try {
    writeFileSync(languageFile, value)
  } catch (error) {
    coreLog.write(`[language] no se pudo guardar la preferencia: ${error instanceof Error ? error.message : String(error)}`)
  }
  languagePreference = value
  applyLanguagePreference()
  return languagePreference
}

/** Pedido autenticado al core local; renueva la sesión una vez si el token venció. */
async function coreFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const request = (token: string): Promise<Response> => fetch(`${CORE_BASE_URL}${path}`, {
    ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  })
  if (!sessionToken) sessionToken = await waitForSession()
  let response = await request(sessionToken)
  if (response.status === 401) {
    sessionToken = await waitForSession()
    response = await request(sessionToken)
  }
  return response
}

const keepAwake = new KeepAwake({
  blocker: powerSaveBlocker,
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
  maxHoldMs: KEEP_AWAKE_MAX_MS,
})
const scheduleNotices = new ScheduleNoticeBatcher({
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
  emit: notifyOpening,
  windowMs: SCHEDULE_NOTICE_WINDOW_MS,
})
const autostartOffer = new AutostartOffer({
  isEnabled: safeAutostart,
  setEnabled: enabled => autostart.setEnabled(enabled),
  wasOffered: () => existsSync(autostartOfferedFile),
  markOffered: () => { try { writeFileSync(autostartOfferedFile, new Date().toISOString()) } catch { /* sin persistir, se vuelve a ofrecer */ } },
  ask: async () => {
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      message: t("autostartOffer.message"),
      detail: t("autostartOffer.detail"),
      buttons: [t("autostartOffer.accept"), t("autostartOffer.decline")],
      defaultId: 0,
      cancelId: 1,
    }
    // Con la ventana visible el diálogo cuelga de ella; sin ventana sería modal de toda la app.
    const parent = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null
    return (parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)).response === 0
  },
})
const scheduleFeed = new FeedPoller({
  fetchFeed: async (after): Promise<FeedResponse> => {
    const response = await coreFetch(`/api/memory/schedules/feed${after === null ? '' : `?after=${after}`}`)
    if (!response.ok) throw new Error(`schedules feed: HTTP ${response.status}`)
    return await response.json() as FeedResponse
  },
  onEvents: events => {
    if (!isolatedInstance) void autostartOffer.consider(events).catch(error => console.error('[autostart offer]', error))
    if (automationPrefs.notify_schedule_created) scheduleNotices.add(events)
    if (automationPrefs.notify_delivery) for (const event of events) { const notice = deliveryNotice(event); if (notice) notifyOpening(notice) }
  },
  onActiveRuns: runs => {
    if (automationPrefsLoaded && automationPrefs.automations_enabled && automationPrefs.keep_awake) keepAwake.sync(runs.map(run => ({ reason: run.run_id, maxMs: holdLimitFor(run.deadline_at, Date.now(), KEEP_AWAKE_MAX_MS) })))
    else keepAwake.dispose()
  },
})
const clockWake = new ClockWake({
  wake: async () => { await coreFetch('/api/memory/schedules/kick', { method: 'POST' }); await pollSchedules() },
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
  settleMs: CLOCK_WAKE_SETTLE_MS,
})

async function refreshAutomationPrefs(): Promise<void> {
  try {
    const response = await coreFetch('/api/automations')
    if (response.ok) { automationPrefs = { ...DEFAULT_AUTOMATION_PREFS, ...await response.json() as Partial<AutomationPrefs> }; automationPrefsLoaded = true }
  } catch {
    // Con el core caído se conservan los últimos valores conocidos.
  }
}

/** Consulta en curso: una respuesta lenta del core no debe solaparse con el ciclo siguiente ni con el despertar del reloj, o se duplicarían los avisos. */
let schedulePoll: Promise<void> | null = null

function pollSchedules(): Promise<void> {
  if (quitting || coreSupervisor.state !== 'running') return Promise.resolve()
  schedulePoll ??= (async () => {
    try {
      await refreshAutomationPrefs()
      await scheduleFeed.poll()
    } catch {
      // El próximo ciclo reintenta con el mismo cursor.
    } finally {
      schedulePoll = null
    }
  })()
  return schedulePoll
}

let updateReport: UpdateReport = { phase: 'idle' }
function setUpdateReport(next: UpdateReport): void {
  updateReport = { ...next, ...(next.trust ? {} : updateReport.trust && next.version === updateReport.version ? { trust: updateReport.trust } : {}) }
}

const silentUpdates = new SilentUpdates({
  check: async () => {
    if (updateReport.phase !== 'downloading' && updateReport.phase !== 'postponed') setUpdateReport({ phase: 'checking' })
    let status: UpdateStatus
    try {
      status = await updater.check()
    } catch (error) {
      if (error instanceof UpdateStateCorruptError) { setUpdateReport({ phase: 'failed', error: t('updater.stateCorrupt') }); updaterLog('[updater] state.json dañado: no se actualiza ni se sobrescribe') }
      throw error
    }
    if (status.state === 'disabled') setUpdateReport({ phase: 'disabled' })
    else if (status.state === 'up-to-date') setUpdateReport({ phase: 'idle' })
    else if (status.state === 'available') setUpdateReport({ phase: 'available', version: status.version })
    else if (status.state === 'failed') setUpdateReport({ phase: 'failed', version: status.version, error: status.error })
    else {
      setUpdateReport({ phase: 'ready', version: status.version, ...(status.trust ? { trust: status.trust } : {}) })
    }
    return status
  },
  apply: applyUpdate,
  log: message => updaterLog(`[updater] ${message}`),
  enabled: () => updateStore.isEnabled(),
})

/** Última pospuesta registrada: el registro sólo cambia cuando cambia la razón. */
let lastPostponed = ''
function postpone(version: string, reasons: UpdateReason[]): false {
  const line = postponedLine(reasons)
  if (line !== lastPostponed) { lastPostponed = line; updaterLog(`[updater] pospuesta: ${line}`) }
  setUpdateReport({ phase: 'postponed', version, reasons })
  return false
}

const drainClient = new DrainClient({
  call: (path, init) => coreFetch(path, init),
  secret: updateDrainSecret,
  log: updaterLog,
  core: { get pid() { return coreSupervisor.pid }, get state() { return coreSupervisor.state } },
  startTimeOf: processStartTime,
})
const acquireDrain = (): ReturnType<DrainClient['acquire']> => drainClient.acquire()
const cancelDrain = (lease: { lease: string; generation: number }): Promise<void> => drainClient.cancel(lease)
const commitCore = (lease: DrainLease): ReturnType<DrainClient['commit']> => drainClient.commit(lease)
const leaseHeld = (lease: DrainLease): boolean => drainClient.held(lease)
const drainHeaders = (json = false): Record<string, string> => ({ [DRAIN_SECRET_HEADER]: updateDrainSecret, ...(json ? { "Content-Type": "application/json" } : {}) })

async function applyUpdate(update: Extract<UpdateStatus, { state: 'downloaded' }>): Promise<boolean> {
  if (quitting || updateExiting) return false
  // NSIS closes executables in the installation folder. Wait automatically rather
  // than breaking a client's live stdio MCP connection or asking the user to act.
  if (update.strategy === 'nsis' && await updater.bridgesAtRisk() > 0) return postpone(update.version, [{ code: 'mcp_bridges' }])
  if (!updateStore.isEnabled()) return false
  let tx: UpdateTransaction | null = null
  // macOS, todo esto fuera del drenaje (los gateways esperan sólo 45 s): runtime, helper válido, DMG revalidado, stage con fsync,
  // journal `staged` y vigía preparado (`watchdog_ready`). El Updater nunca invoca el helper: el intercambio es del vigía.
  if (update.strategy === 'dmg') {
    const bundle = realBundlePath(process.execPath)
    if (!bundle || !runtimeOldBundle(bundle)) return postpone(update.version, [{ code: 'runtime_unavailable' }])
    const prepared = await updater.prepare(update)
    if (prepared.state === 'postponed') return postpone(update.version, prepared.reasons)
    if (!await recordStagedTransaction(update)) return postpone(update.version, [{ code: 'runtime_unavailable' }])
    tx = await ensureWatchdogReady(update)
  }
  const gate = await acquireDrain()
  if ("reasons" in gate) return postpone(update.version, gate.reasons)
  // Con un lease vigente core no se reinicia solo: si muere, el lease se da por perdido y se libera la retención.
  const releaseHold = coreSupervisor.hold()
  const lost = async (): Promise<false> => {
    await cancelDrain(gate.lease)
    releaseHold()
    updaterLog(`[updater] v${update.version}: el drenaje se perdió antes de aplicar; se reintenta`)
    return postpone(update.version, [{ code: "drain_lease_lost" }])
  }
  try {
    if (!leaseHeld(gate.lease)) return await lost()
    lastPostponed = ''
    if (update.strategy === 'nsis' || update.strategy === 'appimage') {
      // El instalador se vuelve a verificar justo antes de lanzarlo: pudo cambiar mientras esperaba su turno.
      await revalidateArtifact(update.path, update.sha256, update.size)
      await commitCore(gate.lease)
      installOnQuit = update
    } else {
      // Core sale bajo el lease (commit) y se observa su salida; recién entonces se anota la intención y esta app se va. El vigía
      // espera a que termine, intercambia y lanza la versión nueva.
      await commitCore(gate.lease)
      advancePhase(updateStore.dir, tx!.transaction_id, 'swap_intent')
    }
  } catch (error) {
    if (error instanceof DrainLeaseLost || error instanceof CoreDidNotExit) return await lost()
    await cancelDrain(gate.lease)
    releaseHold()
    throw error
  }
  setUpdateReport({ phase: 'applying', version: update.version, ...(update.trust ? { trust: update.trust } : {}) })
  updaterLog(`[updater] v${update.version}: reinicio silencioso`)
  if (update.strategy === 'dmg') {
    await exitForUpdate()
    return true
  }
  await quit()
  return true
}

/** Tope del cierre del daemon en una actualización: core ya salió, así que no hay nada en curso que proteger. */
const UPDATE_EXIT_DEADLINE_MS = 10_000
let updateExiting = false

/**
 * Cierre propio de una actualización de bundle: sin esperas de llamadas, sin sincronizar contra un core que ya salió y sin
 * relanzar (la versión nueva la lanza el vigía). No hay temporizador de abandono aquí: si la app no sale, el vigía lo decide
 * desde afuera (aborted, termina a esta app y vuelve a lanzar la misma versión una sola vez).
 */
async function exitForUpdate(): Promise<void> {
  updateExiting = true
  silentUpdates.stop()
  updateHints.stop()
  await Promise.race([
    daemonSupervisor.stop().catch(() => undefined),
    new Promise<void>((resolve) => { setTimeout(resolve, UPDATE_EXIT_DEADLINE_MS).unref() }),
  ])
  stopped = true
  app.exit(0)
}

/** A rollback requested after admission must drain the current core; it never lets the watchdog signal this app. */
async function exitForRollback(transaction: UpdateTransaction): Promise<void> {
  updateExiting = true
  silentUpdates.stop()
  updateHints.stop()
  const deadline = Date.now() + HEALTH_DEADLINE_MS
  while (Date.now() < deadline) {
    if (!await drainClient.admitStartup(transaction.transaction_id)) {
      await new Promise<void>(resolve => setTimeout(resolve, 1_000))
      continue
    }
    const gate = await acquireDrain()
    if ("reasons" in gate) {
      await new Promise<void>(resolve => setTimeout(resolve, 1_000))
      continue
    }
    const releaseHold = coreSupervisor.hold()
    try {
      await commitCore(gate.lease)
      releaseHold()
      await exitForUpdate()
      return
    } catch (error) {
      await cancelDrain(gate.lease)
      releaseHold()
      updaterLog(`[updater] rollback ${transaction.transaction_id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    await new Promise<void>(resolve => setTimeout(resolve, 1_000))
  }
  updaterLog(`[updater] rollback ${transaction.transaction_id}: no se logró drenar antes del plazo; el vigía conserva la evidencia`)
}

/** Borra y comprueba: rechaza si algo quedó y hace durable el borrado (fsync del padre). Quien cierra una transacción depende de ello. */
const removeTree = (path: string): Promise<void> => new Promise<void>((resolve, reject) => execFile('/bin/rm', ['-rf', path], error => error ? reject(error) : resolve()))
  .then(async () => {
    if (existsSync(path)) throw new Error(`no se pudo borrar ${path}`)
    await fsyncPath(dirname(path))
  })

/** Copia de runtime de la versión que corre (layout de `gateway-runtime`): el vigía y el helper salen de ahí, no del bundle que se reemplaza. */
const runtimeOldBundle = (bundle: string): string | null => {
  const path = runtimeBundlePath(stateDir, app.getVersion(), basename(bundle))
  return path && existsSync(path) ? path : null
}

const sha256OfFile = async (path: string): Promise<string> => createHash('sha256').update(await readFile(path)).digest('hex')

/** `runtime/current` resuelve a la copia de runtime de esta versión. */
function runtimeCurrentMatches(version: string): boolean {
  try {
    return realpathSync(join(stateDir, 'runtime', 'current')) === realpathSync(join(stateDir, 'runtime', 'versions', version))
  } catch {
    return false
  }
}

/** Hay una transacción que no es seguro pisar ni limpiar: cualquier cosa más avanzada que `staged`, o un journal ilegible. */
function transactionInFlight(): boolean {
  const read = readTransaction(updateStore.dir)
  if (read.kind === 'corrupt') return true
  return read.kind === 'ok' && read.tx.phase !== 'staged'
}

/** Registra el stage verificado en el journal (contrato v2 y el formato que aún consume el vigía) y descarta otros stages sólo si no hay una transacción en curso. */
async function recordStagedTransaction(update: Extract<UpdateStatus, { state: 'downloaded' }>): Promise<boolean> {
  const bundle = realBundlePath(process.execPath)
  if (!bundle || !update.stage || !update.sha256 || !update.size || !update.trust) return false
  try {
    const current = readTransaction(updateStore.dir)
    // Ya registrado (reintento tras una pospuesta): no se repite ni se limpia nada.
    if (current.kind === 'ok' && current.tx.transaction_id === update.stage.id && current.tx.phase === 'staged') return true
    if (transactionInFlight()) { updaterLog('[updater] hay una transacción anterior sin cerrar; no se prepara otra'); return false }
    const oldStart = await processStartTime(process.pid)
    if (!oldStart) throw new Error('no se pudo identificar este proceso')
    const runtime = runtimeOldBundle(bundle)
    if (!runtime) { updaterLog('[updater] sin copia de runtime de esta versión no se prepara la actualización'); return false }
    updateStore.stageTransaction({ schema: 1, transaction_id: update.stage.id, phase: 'staged',
      from: { version: app.getVersion(), digest: await sha256OfFile(join(bundle, 'Contents', 'Info.plist')) },
      to: { version: update.version, digest: update.sha256, size: update.size, auth: update.trust },
      paths: { installed: bundle, incoming: update.stage.path, runtime_old: runtime },
      old_app: { pid: process.pid, start: oldStart }, new_app: null, watchdog: null,
      // Las claves que anuncia una versión firmada viajan en el journal para sobrevivir a un reinicio; sólo con firma válida.
      ...(update.nextTrust && update.trust === 'publisher_authenticated' ? { next_trust: update.nextTrust } : {}),
      updated_at: new Date().toISOString() })
    const prefix = `${basename(bundle)}.incoming-`
    for (const entry of readdirSync(dirname(bundle)).filter(name => name.startsWith(prefix) && join(dirname(bundle), name) !== update.stage!.path)) void removeTree(join(dirname(bundle), entry)).catch(() => undefined)
    return true
  } catch (error) {
    updaterLog(`[updater] no se pudo registrar la transacción: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Deja preparado el vigía (desde el runtime anterior) fuera del drenaje y anota `watchdog_ready`. Idempotente: si la transacción
 * ya está en `watchdog_ready` con ese vigía vivo no repite nada.
 */
async function ensureWatchdogReady(update: Extract<UpdateStatus, { state: 'downloaded' }>): Promise<UpdateTransaction> {
  const read = readTransaction(updateStore.dir)
  if (read.kind !== 'ok' || read.tx.transaction_id !== update.stage?.id) throw new Error('el journal no corresponde al stage preparado')
  const tx = read.tx
  if (tx.old_app.pid !== process.pid || await processStartTime(process.pid) !== tx.old_app.start) throw new Error('el journal no corresponde a este proceso')
  if (tx.phase === 'watchdog_ready' && tx.watchdog && await processStartTime(tx.watchdog.pid) === tx.watchdog.start) return tx
  if (tx.phase !== 'staged') throw new Error(`la transacción está en ${tx.phase}; no se prepara el vigía`)
  const identity = await prepareWatchdog({ stateDir, updateDir: updateStore.dir, transaction: tx, timeoutMs: HEALTH_DEADLINE_MS, logFile: join(logsDir, 'core.log'), executableName: basename(process.execPath) })
  return advancePhase(updateStore.dir, tx.transaction_id, 'watchdog_ready', { watchdog: identity })
}

/** Replaces a dead watchdog after a swapped update without changing the current transaction phase. */
async function replaceRecoveryWatchdog(transaction: UpdateTransaction): Promise<UpdateTransaction> {
  const identity = await prepareWatchdog({
    stateDir,
    updateDir: updateStore.dir,
    transaction,
    timeoutMs: HEALTH_DEADLINE_MS,
    logFile: join(logsDir, "core.log"),
    executableName: basename(process.execPath),
  })
  return advancePhase(updateStore.dir, transaction.transaction_id, transaction.phase, { watchdog: identity })
}

/** Otro hub anunció una versión (long-poll a core): sólo adelanta la verificación contra GitHub; `trigger` limita a una por minuto. */
function onUpdateHint(): void {
  if (!app.isPackaged) return
  try { if (!updateStore.isEnabled()) return } catch { return }
  silentUpdates.trigger('peer')
}
const updateHints = new UpdateHintListener({
  open: async (signal, query) => {
    if (!sessionToken) sessionToken = await waitForSession()
    const request = (token: string) => fetch(`${CORE_BASE_URL}/api/internal/update-hint?${query}`, { headers: { Authorization: `Bearer ${token}`, [DRAIN_SECRET_HEADER]: updateDrainSecret }, signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]) })
    let response = await request(sessionToken)
    if (response.status === 401) { sessionToken = await waitForSession(); response = await request(sessionToken) }
    return response
  },
  onHint: onUpdateHint,
  ready: () => coreSupervisor.state === 'running' && !quitting,
})

/** Anuncia a los hubs con proyectos compartidos la versión que corre; core deduplica, repetirlo no cuesta nada. */
async function announceVersion(): Promise<void> {
  try {
    const response = await coreFetch('/api/internal/update-hint/announce', { method: 'POST', headers: drainHeaders(true), body: JSON.stringify({ version: app.getVersion() }) })
    await response.body?.cancel().catch(() => undefined)
    if (!response.ok) updaterLog(`[updater] el anuncio de versión no se aceptó (HTTP ${response.status})`)
  } catch (error) {
    updaterLog(`[updater] el anuncio de versión falló: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Interruptor de Ajustes. Al encenderlo verifica de inmediato. */
function setAutoUpdate(enabled: unknown): boolean {
  updateStore.setEnabled(Boolean(enabled))
  updaterLog(`[updater] actualizaciones automáticas ${updateStore.isEnabled() ? 'activadas' : 'desactivadas'}`)
  if (updateStore.isEnabled()) void silentUpdates.run()
  else { void drainClient.cancelPending(); setUpdateReport({ phase: 'disabled' }) }
  return updateStore.isEnabled()
}

/** Versión máxima instalada; recuperación del journal; confirmación de salud de una actualización recién aplicada; ratchet de la firma. */
async function startUpdateBookkeeping(): Promise<void> {
  // Un estado que no se puede leer o escribir impide declarar sana una versión recién aplicada: se conserva el respaldo y la evidencia.
  let stateOk = true
  try {
    updateStore.noteInstalled(app.getVersion())
  } catch (error) {
    stateOk = false
    // Un state.json ilegible no se reescribe: se conserva como evidencia y la actualización queda en pausa.
    updaterLog(`[updater] ${error instanceof UpdateStateCorruptError ? 'state.json dañado: no se sobrescribe' : error instanceof Error ? error.message : String(error)}`)
  }
  // Salud = procesos arriba, sesión del escritorio y un `tools/list` real contra el MCP de memoria con la credencial de los gateways.
  // Una versión recién aplicada también debe estar apuntada por `runtime/current`: si no, los gateways nuevos arrancarían de otra.
  let expectRuntime = false
  let startupTransaction: string | null = null
  let activeTransaction: UpdateTransaction | null = null
  let rollbackExit: Promise<void> | null = null
  const healthy = async (): Promise<boolean> => {
    if (!stateOk || coreSupervisor.state !== "running" || daemonSupervisor.state !== "running" || !sessionToken) return false
    if (expectRuntime && !runtimeCurrentMatches(app.getVersion())) return false
    if (activeTransaction) {
      const request = readJson(rollbackRequestFile(updateStore.dir, activeTransaction.transaction_id))
      const value = request.ok ? request.value as { transaction_id?: unknown; version?: unknown } : null
      if (value?.transaction_id === activeTransaction.transaction_id && value.version === activeTransaction.to.version) {
        rollbackExit ??= exitForRollback(activeTransaction).catch(error => updaterLog(`[updater] rollback: ${error instanceof Error ? error.message : String(error)}`))
        return false
      }
    }
    if (startupTransaction) {
      let current = readTransaction(updateStore.dir)
      if (current.kind !== "ok" || current.tx.transaction_id !== startupTransaction) return false
      if (current.tx.phase === "launched") {
        advancePhase(updateStore.dir, startupTransaction, "admitting")
        current = readTransaction(updateStore.dir)
      }
      if (current.kind !== "ok" || !["admitting", "admitted"].includes(current.tx.phase)) return false
      if (!await drainClient.admitStartup(startupTransaction)) return false
      if (current.tx.phase === "admitting") advancePhase(updateStore.dir, startupTransaction, "admitted")
    }
    return probeMemoryMcp({ baseUrl: CORE_BASE_URL, credentialPath: memoryCredentialPath(stateDir), timeoutMs: HEALTH_PROBE_TIMEOUT_MS })
  }
  // Una versión con claves que se mantiene sana fija la firma como obligatoria para siempre. Lanza si no se pudo persistir.
  const ratchetStrict = (): void => {
    if (bundledTrust.kind === 'ok' && bundledTrust.trust.keys.length > 0 && !updateStore.read().requireSignature) {
      updateStore.setRequireSignature()
      updaterLog('[updater] la firma del publicador pasa a ser obligatoria')
    }
  }
  const ratchet = (): void => {
    try { ratchetStrict() } catch (error) { updaterLog(`[updater] no se pudo fijar la firma obligatoria: ${error instanceof Error ? error.message : String(error)}`) }
  }
  const bundle = realBundlePath(process.execPath)
  // Recuperación idempotente de una transacción interrumpida (módulo de Gateway). Ante un journal ilegible o restos sin journal
  // no borra nada ni declara salud.
  const outcome = bundle ? await recoverTransaction({ stateDir, updateDir: updateStore.dir, installed: bundle, version: app.getVersion(), removeTree, pid: process.pid, log: updaterLog })
    .catch((error: unknown) => { updaterLog(`[updater] recuperación: ${error instanceof Error ? error.message : String(error)}`); return 'ambiguous' as const }) : 'none' as const
  if (!['none', 'cleaned', 'monitor', 'monitor_without_watchdog'].includes(outcome)) updaterLog(`[updater] la recuperación terminó en «${outcome}»`)
  const journal = outcome === 'monitor' || outcome === 'monitor_without_watchdog' ? readTransaction(updateStore.dir) : null
  let transaction = journal?.kind === 'ok' ? journal.tx : null
  if (transaction && outcome === 'monitor_without_watchdog') {
    try { transaction = await replaceRecoveryWatchdog(transaction) }
    catch (error) { updaterLog(`[updater] no se pudo reemplazar el vigía: ${error instanceof Error ? error.message : String(error)}`); return }
  }
  if (!transaction) {
    whenStablyHealthy({ healthy }, ratchet)
    // Una versión que todavía no anunció (p. ej. tras el salto desde 0.14.2) lo hace tras un arranque estable de 180 s.
    whenStablyHealthy({ healthy, stableMs: HEALTH_DEADLINE_MS }, () => { void announceVersion() })
    return
  }
  expectRuntime = true
  startupTransaction = transaction.transaction_id
  activeTransaction = transaction
  const startTime = await processStartTime(process.pid) ?? ''
  if (!startTime) { updaterLog('[updater] no se pudo identificar este proceso; no se confirma la actualización'); return }
  confirmWhenHealthy({
    updateDir: updateStore.dir,
    transaction,
    pid: process.pid,
    startTime,
    healthy,
    discardBackup: () => removeTreeDurable(transaction.paths.incoming, removeTree),
    onConfirmed: () => {
      // Todo lo que debe persistir va primero y sin tragar errores: si falla, no se declara sana ni se borra el respaldo.
      if (transaction.next_trust) {
        const trust = parseTrustSet(transaction.next_trust, { requireActive: true })
        if (!trust) throw new Error('las claves anunciadas por esta versión no son válidas')
        updateStore.adoptTrust(trust)
      }
      ratchetStrict()
      void announceVersion()
      // Con la versión confirmada, las copias de runtime que ya no hacen falta se recogen (conservando la actual, la anterior y las de la transacción).
      if (bundle) void collectRuntimes({ stateDir, executable: basename(process.execPath), appName: basename(bundle), keep: [transaction.from.version, transaction.to.version] })
        .catch((error: unknown) => updaterLog(`[updater] recolección de runtimes omitida: ${error instanceof Error ? error.message : String(error)}`))
    },
    log: updaterLog,
  })
}

function coreStatus(): CoreStatus {
  return { state: coreSupervisor.state, apiBaseUrl: CORE_BASE_URL, pid: coreSupervisor.pid, daemonState: daemonSupervisor.state }
}

function describePending(entry: PendingRestart): string {
  const changes = entry.changes
  if (!changes) return t("clientRestart.changesGeneric")
  const parts = [
    changes.skills.added.length ? t("clientRestart.skillsAdded", { list: changes.skills.added.join(", ") }) : "",
    changes.skills.changed.length ? t("clientRestart.skillsChanged", { list: changes.skills.changed.join(", ") }) : "",
    changes.skills.removed.length ? t("clientRestart.skillsRemoved", { list: changes.skills.removed.join(", ") }) : "",
    changes.servers.added.length ? t("clientRestart.serversAdded", { list: changes.servers.added.join(", ") }) : "",
    changes.servers.removed.length ? t("clientRestart.serversRemoved", { list: changes.servers.removed.join(", ") }) : "",
  ].filter(Boolean)
  return parts.length ? parts.join("; ") : t("clientRestart.changesGeneric")
}

/**
 * Copia un PDF de la memoria a una carpeta temporal privada y lo abre con la aplicación que el sistema asocia a PDF.
 * Sólo se aceptan PDFs verificados por su firma y se fuerza la extensión `.pdf`, así un archivo guardado nunca se
 * ejecuta como programa. Devuelve `ok: false` con el motivo cuando no hay aplicación asociada.
 */
async function openStoredPdf(versionId: unknown): Promise<OpenFileResult> {
  if (typeof versionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(versionId)) return { ok: false, detail: t("storedPdf.invalidId") }
  const request = (token: string): Promise<Response> => fetch(`${CORE_BASE_URL}/api/memory/files/${versionId}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!sessionToken) sessionToken = await waitForSession()
  let response = await request(sessionToken)
  if (response.status === 401) {
    sessionToken = await waitForSession()
    response = await request(sessionToken)
  }
  if (!response.ok) return { ok: false, detail: t("storedPdf.readFailed", { status: response.status }) }
  const data = Buffer.from(await response.arrayBuffer())
  if (data.subarray(0, 5).toString() !== '%PDF-') return { ok: false, detail: t("storedPdf.notPdf") }
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
  // Updated factory skills must not turn a silent relaunch into a notification.
  // The explicit restart action remains available when the person opens the tray.
  if (process.argv.includes('--updated') || !desktop.changes || desktop.changes.skills.auto.length === 0) return
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
      title: t("clientRestart.skillInstalled", { skills, count: fresh.length }),
      body: t("clientRestart.skillInstalledBody", { count: fresh.length }),
    })
    notification.on('click', () => void confirmAndRestartClient())
    showRetained(notification)
  } catch {
    // Sin centro de notificaciones queda el botón del tray y de la consola.
  }
}

/** Diálogo de confirmación y reinicio: nunca se cierra la app de la persona sin preguntar. */
async function confirmAndRestartClient(): Promise<void> {
  if (restartingClient) return
  const entry = pendingClientRestart
  const detail = entry ? t("clientRestart.confirmDetailPending", { changes: describePending(entry) }) : t("clientRestart.confirmDetail")
  const choice = await dialog.showMessageBox({
    type: 'question',
    message: t("clientRestart.confirmTitle"),
    detail,
    buttons: [t("clientRestart.confirmAccept"), t("clientRestart.confirmDecline")],
    defaultId: 0,
    cancelId: 1,
  })
  if (choice.response !== 0) return
  restartingClient = true
  try {
    const result = await restartClient('claude_desktop', clientDeps)
    notify(t(result.ok ? "clientRestart.restarted" : "clientRestart.failed"), result.detail)
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
    clientRestart: Boolean(pendingClientRestart),
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
  tray.setToolTip(trayTooltip(showWindowShortcutRegistered ? SHOW_WINDOW_SHORTCUT_LABEL : null))
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
    const message = t("shortcut.body", { shortcut: SHOW_WINDOW_SHORTCUT_LABEL })
    coreLog.write(`[shortcut] no se pudo registrar ${SHOW_WINDOW_SHORTCUT}`)
    if (!process.argv.includes('--updated') && Notification.isSupported()) {
      try {
        const notification = new Notification({ title: t("shortcut.title"), body: message })
        notification.on('click', showWindow)
        showRetained(notification)
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
  win.on('session-end', () => { forceQuit = true; void quit() })
  win.on('show', refreshTray)
  win.on('hide', refreshTray)
  // Una recarga (reinicio del core) vacía el renderer: las rutas pedidas hasta que vuelva a declararse listo quedan pendientes. Solo cuenta un
  // documento nuevo: `did-start-loading` también se emite en la navegación por hash del HashRouter, dentro del mismo documento, y el preload
  // no vuelve a declararse listo, así que las rutas quedarían pendientes hasta la próxima recarga.
  win.webContents.on('did-start-navigation', details => {
    if (!details.isMainFrame || details.isSameDocument) return
    coreLog.write('[navigation] carga de documento: rutas pendientes hasta que el renderer escuche')
    navigation.detach()
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(win.webContents.getURL(), url)) {
      event.preventDefault()
      const external = externalUrl(url)
      if (external) void shell.openExternal(external)
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalUrl(url)
    if (external) void shell.openExternal(external)
    return { action: 'deny' }
  })
  forwardLanguageToCore(win)
  void win.loadURL(consoleUrl(token))
  if (!hidden) win.once('ready-to-show', () => win.show())
}
/**
 * El core arma páginas HTML fuera de la consola (retorno de OAuth en el navegador del sistema) y no conoce la preferencia:
 * toma el idioma del `Accept-Language` de `oauth/start`. Chromium manda el locale del sistema, así que se reemplaza por el
 * idioma activo en los pedidos del renderer al core local.
 */
function forwardLanguageToCore(win: BrowserWindow): void {
  win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!details.url.startsWith(`${CORE_BASE_URL}/api/`)) return callback({})
    const requestHeaders = Object.fromEntries(Object.entries(details.requestHeaders).filter(([name]) => name.toLowerCase() !== "accept-language"))
    callback({ requestHeaders: { ...requestHeaders, "Accept-Language": activeLanguage() } })
  })
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
    if (restartingClient) return { ok: false, detail: t("clientRestart.alreadyRunning") }
    restartingClient = true
    try {
      return await restartClient(String(cliKind), clientDeps)
    } finally {
      restartingClient = false
    }
  })
  ipcMain.handle(IPC.attachNavigation, () => {
    const pending = navigation.attach()
    coreLog.write(`[navigation] renderer escuchando${pending ? `; entrega la ruta pendiente ${pending}` : ''}`)
    return pending
  })
  ipcMain.handle(IPC.getLanguage, () => languagePreference)
  ipcMain.handle(IPC.setLanguage, (_event, preference: unknown) => saveLanguagePreference(preference))
  ipcMain.handle(IPC.getVersionInfo, readVersionInfo)
  ipcMain.handle(IPC.getAppVersion, () => app.getVersion())
  ipcMain.handle(IPC.getUpdateStatus, () => ({ enabled: updateStore.isEnabled(), ...updateReport }))
  ipcMain.handle(IPC.getAutoUpdate, () => updateStore.isEnabled())
  ipcMain.handle(IPC.setAutoUpdate, (_event, enabled: unknown) => setAutoUpdate(enabled))
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
    title: t("startup.title"),
    message: t("startup.title"),
    detail: [message, ...(cause.length ? ["", t("startup.lastCoreError"), ...cause] : []), "", t("startup.logs", { path: logsDir }),
      t("startup.reportNote")].join("\n"),
    buttons: [t("startup.openIssue"), t("startup.copyReport"), t("startup.close")],
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
  throw new Error(t("startup.portUnavailable", { port: CORE_PORT, problem, fallbacks: FALLBACK_CORE_PORTS.join(", ") }))
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
  if (process.platform !== 'win32' || skipLoginItems()) return
  const items = app.getLoginItemSettings(loginItemOptions).launchItems ?? []
  const legacy = items.filter((item) => item.path.toLowerCase() === process.execPath.toLowerCase() && !item.args.includes('--hidden'))
  for (const item of legacy) app.setLoginItemSettings({ openAtLogin: false, path: item.path, args: item.args, name: item.name })
  if (legacy.length) app.setLoginItemSettings({ openAtLogin: true, ...loginItemOptions })
}
/** Un segundo pedido de cierre mientras se esperan llamadas en curso (o una señal del sistema) cierra sin esperar. */
let forceQuit = false

/** Manual quit closes the same MCP and non-MCP admissions as an update, then waits for protected work to finish. */
async function waitForProtectedWork(): Promise<void> {
  const headers = { [DRAIN_SECRET_HEADER]: updateDrainSecret }
  type State = { inflight: number; fleet_live: number; jobs_nonresumable: number; blockers_known: boolean }
  const read = async (path: string, method: "GET" | "POST"): Promise<State | null> => {
    try {
      const response = await coreFetch(path, { method, headers })
      const body = await response.json().catch(() => null) as Partial<State> | null
      const valid = response.ok && Number.isSafeInteger(body?.inflight) && Number.isSafeInteger(body?.fleet_live)
        && Number.isSafeInteger(body?.jobs_nonresumable) && typeof body?.blockers_known === "boolean"
      return valid ? body as State : null
    } catch { return null }
  }
  await drainClient.cancelPending()
  let state = await read("/api/internal/update-drain/shutdown", "POST")
  if (!state) return
  const pending = () => state!.inflight + state!.fleet_live + state!.jobs_nonresumable
  let lastLogged = 0
  while ((pending() > 0 || !state.blockers_known) && !forceQuit && coreSupervisor.state === "running") {
    if (Date.now() - lastLogged > 30_000) {
      lastLogged = Date.now()
      updaterLog(`[quit] esperando trabajo protegido: MCP=${state.inflight}, fleet=${state.fleet_live}, jobs=${state.jobs_nonresumable}; cerrar de nuevo fuerza el cierre`)
    }
    await new Promise<void>(resolve => setTimeout(resolve, 1_000))
    const next = await read("/api/internal/update-drain/status", "GET")
    if (!next) break
    state = next
  }
  if (forceQuit && (pending() > 0 || !state.blockers_known))
    updaterLog(`[quit] cierre forzado con trabajo protegido: MCP=${state.inflight}, fleet=${state.fleet_live}, jobs=${state.jobs_nonresumable}`)
}

async function quit(): Promise<void> {
  if (quitting) { forceQuit = true; return }
  quitting = true
  silentUpdates.stop()
  updateHints.stop()
  keepAwake.dispose()
  clockWake.dispose()
  scheduleNotices.dispose()
  // Un cierre de la persona espera las llamadas MCP en curso; una actualización ya tiene core drenado por su lease.
  if (!installOnQuit && !relaunchAfterQuit && coreSupervisor.state === 'running') await waitForProtectedWork()
  // Si algo se cuelga al cerrar, la app sale igual: un proceso que no termina obliga a
  // forzar el cierre y dejaba core y daemon huérfanos bloqueando el próximo arranque.
  const deadline = setTimeout(() => {
    console.error(`[quit] apagado ordenado excedió ${QUIT_DEADLINE_MS} ms; saliendo`)
    stopped = true
    if (relaunchAfterQuit || installOnQuit) app.relaunch({ args: updateRelaunchArgs(process.argv.slice(1)) })
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
        // External installers relaunch themselves; release the lock only after services stop.
        app.releaseSingleInstanceLock()
        await updater.apply(installOnQuit)
      } catch (error) {
        // The installed version stays; reopen it instead of leaving the person without the hub.
        updaterLog(`[updater] no se pudo iniciar el instalador: ${error instanceof Error ? error.message : String(error)}`)
        relaunchAfterQuit = true
      }
    }
  } finally {
    clearTimeout(deadline)
    stopped = true
    // Tras intercambiar el bundle en macOS, la misma ruta ya es la versión nueva.
    if (relaunchAfterQuit) app.relaunch({ args: updateRelaunchArgs(process.argv.slice(1)) })
    app.quit()
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
else {
  process.once('SIGTERM', () => { forceQuit = true; void quit() })
  process.once('SIGINT', () => { forceQuit = true; void quit() })
  app.on('second-instance', (_event, argv) => { if (!hiddenUpdateLaunch(argv)) showWindow() })
  app.whenReady().then(async () => {
    applyLanguagePreference()
    onLanguageChange(refreshTray)
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
    const hidden = hiddenUpdateLaunch(process.argv)
    migrateWindowsLoginItem()
    await ensureCorePort()
    syncDaemonUrl()
    await prepareGatewayRuntime()
    coreSupervisor.start()
    const token = await waitForSession()
    sessionToken = token
    daemonSupervisor.start()
    registerIpc()
    createTray()
    createWindow(token, hidden)
    registerShowWindowShortcut()
    app.on('activate', showWindow)
    // Recover any interrupted transaction and finish cleanup before a new download can create a directory it might remove.
    void startUpdateBookkeeping().then(() => updater.cleanup()).catch(error => updaterLog(`[updater] arranque: ${error instanceof Error ? error.message : String(error)}`)).then(() => silentUpdates.start())
    if (app.isPackaged && overrideSafe) updateHints.start()
    setInterval(() => void pollPendingRestarts(), PENDING_RESTART_POLL_MS).unref()
    setInterval(() => void pollSchedules(), SCHEDULE_FEED_POLL_MS).unref()
    void pollSchedules()
    // `resume` sale de la suspensión; `unlock-screen` sólo existe en macOS y Windows.
    powerMonitor.on('resume', () => clockWake.trigger())
    powerMonitor.on('unlock-screen', () => clockWake.trigger())
  }).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    coreLog.write(`[desktop] no pudo iniciar: ${message}`)
    // Sin esto la app desaparecía en silencio y parecía que "no abría".
    if (!process.argv.includes('--updated')) await showStartupFailure(message).catch(() => dialog.showErrorBox(t("startup.title"), message))
    app.quit()
  })
  app.on('window-all-closed', () => undefined)
  app.on('will-quit', () => globalShortcut.unregisterAll())
  app.on('before-quit', event => {
    if (!stopped) { event.preventDefault(); void quit() }
  })
}

export { pathContext, coreStatus }
