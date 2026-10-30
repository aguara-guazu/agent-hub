import type { LanguagePreference } from "./i18n.js"
import type { SupervisorState } from "./supervisor.js"

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
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export interface CoreStatus {
  state: SupervisorState
  apiBaseUrl: string
  pid: number | undefined
  daemonState?: SupervisorState
}

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
]

export const RECEIVE_CHANNELS: readonly IpcChannel[] = [IPC.coreStateChanged, IPC.navigate]
