/**
 * Tipos del puente Electron expuesto por el preload de `@agenthub/desktop`.
 *
 * El renderer sólo debe usar `window.agentHub` cuando corre dentro de Electron;
 * en el navegador (dev server puro) es `undefined`. Este archivo es un ambiente
 * de tipos: no emite código.
 */

export type CoreState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'stopping'
  | 'failed'

export interface CoreStatus {
  state: CoreState
  apiBaseUrl: string
  pid: number | undefined
  daemonState?: CoreState
}

export interface ClientRestartResult {
  ok: boolean
  detail: string
}

export interface AgentHubBridge {
  getCoreStatus(): Promise<CoreStatus>
  restartCore(): Promise<void>
  getAutostart(): Promise<boolean>
  setAutostart(enabled: boolean): Promise<boolean>
  onCoreStateChanged(listener: (status: CoreStatus) => void): () => void
  readonly platform: NodeJS.Platform
  getSession(): Promise<string>
  syncNow(): Promise<void>
  /** Cierra y vuelve a abrir un cliente de escritorio (hoy sólo `claude_desktop`). */
  restartClient(cliKind: string): Promise<ClientRestartResult>
}

declare global {
  interface Window {
    /** Presente sólo cuando la consola corre dentro de la app Electron. */
    agentHub?: AgentHubBridge
  }
}

export {}
