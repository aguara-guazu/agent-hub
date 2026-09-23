import type { SupervisorState } from './supervisor.js'

/**
 * Contrato IPC mínimo entre el proceso principal y el renderer.
 *
 * El preload expone SÓLO estos canales por `contextBridge`. No hay acceso a
 * `ipcRenderer` crudo, ni a Node, ni al filesystem desde el renderer.
 */

export const IPC = {
  /** invoke: renderer -> main, devuelve el estado del core y la URL del API. */
  getCoreStatus: 'agenthub:core-status',
  /** invoke: renderer -> main, pide reiniciar el core. */
  restartCore: 'agenthub:restart-core',
  /** invoke: renderer -> main, lee autostart. */
  getAutostart: 'agenthub:autostart-get',
  /** invoke: renderer -> main, cambia autostart. */
  setAutostart: 'agenthub:autostart-set',
  /** send: main -> renderer, notifica cambios de estado del core. */
  coreStateChanged: 'agenthub:core-state-changed',
  getSession: 'agenthub:session',
  syncNow: 'agenthub:sync-now',
  /** invoke: renderer -> main, cierra y vuelve a abrir un cliente (hoy sólo Claude Desktop). */
  restartClient: 'agenthub:restart-client',
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
]

export const RECEIVE_CHANNELS: readonly IpcChannel[] = [IPC.coreStateChanged]
