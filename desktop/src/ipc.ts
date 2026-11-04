import type { LanguagePreference } from "./i18n.js"
import type { SupervisorState } from "./supervisor.js"
import type { UpdateReport } from "./update-report.js"

/**
 * Contrato IPC mínimo entre el proceso principal y el renderer.
 *
 * El preload expone SÓLO estos canales por `contextBridge`. No hay acceso a
 * `ipcRenderer` crudo, ni a Node, ni al filesystem desde el renderer.
 */

export const IPC = {
  /** invoke: renderer -> main, devuelve el estado del core y la URL del API. */
  getCoreStatus: "agenthub:core-status",
  /** invoke: renderer -> main, pide reiniciar el core. */
  restartCore: "agenthub:restart-core",
  /** invoke: renderer -> main, lee autostart. */
  getAutostart: "agenthub:autostart-get",
  /** invoke: renderer -> main, cambia autostart. */
  setAutostart: "agenthub:autostart-set",
  /** send: main -> renderer, notifica cambios de estado del core. */
  coreStateChanged: "agenthub:core-state-changed",
  getSession: "agenthub:session",
  syncNow: "agenthub:sync-now",
  /** invoke: renderer -> main, cierra y vuelve a abrir un cliente (hoy sólo Claude Desktop). */
  restartClient: "agenthub:restart-client",
  /** invoke: renderer -> main, abre un PDF guardado en la memoria con la aplicación del sistema. */
  openStoredPdf: "agenthub:open-stored-pdf",
  /** send: main -> renderer, pide navegar a una ruta de la lista blanca de `navigation.ts`. */
  navigate: "agenthub:navigate",
  /** invoke: renderer -> main, declara que escucha `navigate` y recibe la ruta que quedó pendiente (o `null`). */
  attachNavigation: "agenthub:navigation-attach",
  /** invoke: renderer -> main, preferencia de idioma guardada en `userData` (`auto` si no hay ninguna). */
  getLanguage: "agenthub:language-get",
  /** invoke: renderer -> main, guarda la preferencia de idioma y devuelve la que quedó vigente. */
  setLanguage: "agenthub:language-set",
  /** invoke: renderer -> main, versión en ejecución y última release publicada. Sólo lectura: no descarga ni instala. */
  getVersionInfo: "agenthub:version-info",
  /** invoke: renderer -> main, versión de la app en ejecución. Sólo lectura y sin red. */
  getAppVersion: "agenthub:app-version",
  /** invoke: renderer -> main, interruptor de actualizaciones automáticas (activado por defecto). */
  /** invoke: renderer -> main, estado visible de la actualización (fase, versión, razones de espera). */
  getUpdateStatus: "agenthub:update-status",
  getAutoUpdate: "agenthub:auto-update-get",
  /** invoke: renderer -> main, enciende o apaga las actualizaciones automáticas y devuelve el valor vigente. */
  setAutoUpdate: "agenthub:auto-update-set",
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export interface CoreStatus {
  state: SupervisorState
  apiBaseUrl: string
  pid: number | undefined
  daemonState?: SupervisorState
}

export type VersionState = "up-to-date" | "outdated" | "unknown"

export interface VersionInfo {
  /** Versión de la app en ejecución. */
  current: string
  /** Última release publicada, o `null` si no se pudo consultar. */
  latest: string | null
  /** Página de la última release, o `null` si no se pudo consultar. */
  page: string | null
  state: VersionState
  /** Momento de la consulta, en ISO 8601. */
  checkedAt: string
}
/** Estado de la actualización tal como lo ve la consola. */
export type UpdateStatusView = { enabled: boolean } & UpdateReport

export interface ClientRestartResult {
  ok: boolean
  detail: string
}

export interface OpenFileResult {
  ok: boolean
  detail: string
}

/** Superficie que el preload publica en `window.agentHub`. */
export interface AgentHubBridge {
  getCoreStatus(): Promise<CoreStatus>
  restartCore(): Promise<void>
  getAutostart(): Promise<boolean>
  setAutostart(enabled: boolean): Promise<boolean>
  onCoreStateChanged(listener: (status: CoreStatus) => void): () => void
  readonly platform: NodeJS.Platform
  getSession(): Promise<string>
  syncNow(): Promise<void>
  restartClient(cliKind: string): Promise<ClientRestartResult>
  openStoredPdf(versionId: string): Promise<OpenFileResult>
  /** Escucha pedidos de navegación del proceso principal; entrega primero la ruta pendiente, si la hay. */
  onNavigate(listener: (route: string) => void): () => void
  getLanguage(): Promise<LanguagePreference>
  setLanguage(preference: LanguagePreference): Promise<LanguagePreference>
  getVersionInfo(): Promise<VersionInfo>
  getAppVersion(): Promise<string>
  getUpdateStatus(): Promise<UpdateStatusView>
  getAutoUpdate(): Promise<boolean>
  setAutoUpdate(enabled: boolean): Promise<boolean>
}

/** Lista blanca de canales que el preload puede usar en cada dirección. */
export const INVOKE_CHANNELS: readonly IpcChannel[] = [
  IPC.getCoreStatus,
  IPC.restartCore,
  IPC.getAutostart,
  IPC.setAutostart,
  IPC.getSession,
  IPC.syncNow,
  IPC.restartClient,
  IPC.openStoredPdf,
  IPC.attachNavigation,
  IPC.getLanguage,
  IPC.setLanguage,
  IPC.getVersionInfo,
  IPC.getAppVersion,
  IPC.getUpdateStatus,
  IPC.getAutoUpdate,
  IPC.setAutoUpdate,
]

export const RECEIVE_CHANNELS: readonly IpcChannel[] = [IPC.coreStateChanged, IPC.navigate]
