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

export interface UpdateReason { code: string; count?: number }

/** Estado visible de la actualización automática. */
export interface UpdateStatusView {
  enabled: boolean
  phase: "idle" | "checking" | "available" | "downloading" | "ready" | "postponed" | "applying" | "failed" | "disabled"
  version?: string
  trust?: "integrity_only" | "publisher_authenticated"
  reasons?: UpdateReason[]
  error?: string
  /** Avance de la parada coordinada del Hub previa a aplicar la actualización. */
  stop?: {
    state: string
    deadlineAt?: string
    forceAt?: string
    graceStartedAt?: string
    waiting?: { coordinators: number; leadersInTurn: number; members: number }
    errorCode?: string
    actions?: string[]
  }
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
  /** Versión en ejecución y última release publicada; sólo lectura, con la consulta en caché. Ausente en versiones anteriores del escritorio. */
  getVersionInfo?(): Promise<VersionInfo>
  /** Versión de la app en ejecución, sin consultar la red. Ausente en versiones anteriores del escritorio. */
  getAppVersion?(): Promise<string>
  /** Interruptor de actualizaciones automáticas (activado por defecto). Ausente en versiones anteriores del escritorio. */
  getUpdateStatus?(): Promise<UpdateStatusView>
  getAutoUpdate?(): Promise<boolean>
  /** Enciende o apaga las actualizaciones automáticas; devuelve el valor vigente. Ausente en versiones anteriores del escritorio. */
  setAutoUpdate?(enabled: boolean): Promise<boolean>
}

declare global {
  interface Window {
    /** Presente sólo cuando la consola corre dentro de la app Electron. */
    agentHub?: AgentHubBridge
  }
}

export {}
