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
  /** Abre un PDF guardado con la aplicación asociada del sistema; `ok: false` cuando no hay ninguna. Ausente en versiones anteriores del escritorio. */
  openStoredPdf?(versionId: string): Promise<{ ok: boolean; detail: string }>
  /** Pedidos de navegación del proceso principal (clic en una notificación). Ausente en versiones anteriores del escritorio. */
  onNavigate?(listener: (route: string) => void): () => void
  /** Preferencia de idioma guardada por el escritorio (`auto` si no hay ninguna). Ausente en versiones anteriores del escritorio. */
  getLanguage?(): Promise<"es" | "en" | "auto">
  /** Guarda la preferencia para la bandeja, las notificaciones y los diálogos; devuelve la vigente. Ausente en versiones anteriores del escritorio. */
  setLanguage?(preference: "es" | "en" | "auto"): Promise<"es" | "en" | "auto">
}

declare global {
  interface Window {
    /** Presente sólo cuando la consola corre dentro de la app Electron. */
    agentHub?: AgentHubBridge
  }
}

export {}
