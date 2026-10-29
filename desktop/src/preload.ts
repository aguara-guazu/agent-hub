import { contextBridge, ipcRenderer } from 'electron'
import type { LanguagePreference } from "./i18n.js"
import { IPC, type AgentHubBridge, type ClientRestartResult, type CoreStatus, type OpenFileResult } from './ipc.js'

/**
 * Preload seguro. Con `contextIsolation` y `sandbox` activos, el renderer sólo
 * ve `window.agentHub` con la superficie declarada en el contrato IPC. No se
 * expone `ipcRenderer`, ni Node, ni acceso al filesystem.
 */

const bridge: AgentHubBridge = {
  getCoreStatus: () => ipcRenderer.invoke(IPC.getCoreStatus) as Promise<CoreStatus>,
  restartCore: () => ipcRenderer.invoke(IPC.restartCore) as Promise<void>,
  getAutostart: () => ipcRenderer.invoke(IPC.getAutostart) as Promise<boolean>,
  setAutostart: (enabled: boolean) => ipcRenderer.invoke(IPC.setAutostart, enabled) as Promise<boolean>,
  onCoreStateChanged: (listener: (status: CoreStatus) => void) => {
    const handler = (_event: unknown, status: CoreStatus): void => listener(status)
    ipcRenderer.on(IPC.coreStateChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.coreStateChanged, handler)
    }
  },
  platform: process.platform,
  getSession: () => ipcRenderer.invoke(IPC.getSession) as Promise<string>,
  syncNow: () => ipcRenderer.invoke(IPC.syncNow) as Promise<void>,
  restartClient: (cliKind: string) => ipcRenderer.invoke(IPC.restartClient, cliKind) as Promise<ClientRestartResult>,
  openStoredPdf: (versionId: string) => ipcRenderer.invoke(IPC.openStoredPdf, versionId) as Promise<OpenFileResult>,
  onNavigate: (listener: (route: string) => void) => {
    navigationListeners.add(listener)
    const handler = (_event: unknown, route: unknown): void => { if (typeof route === 'string') listener(route) }
    ipcRenderer.on(IPC.navigate, handler)
    attachNavigation()
    deliverPendingRoute()
    return () => {
      navigationListeners.delete(listener)
      ipcRenderer.removeListener(IPC.navigate, handler)
    }
  },
  getLanguage: () => ipcRenderer.invoke(IPC.getLanguage) as Promise<LanguagePreference>,
  setLanguage: (preference: LanguagePreference) => ipcRenderer.invoke(IPC.setLanguage, preference) as Promise<LanguagePreference>,
}

/**
 * La ruta pendiente se pide una sola vez por carga de página y se entrega al primer
 * listener vivo: React puede montar, desmontar y volver a montar el efecto que se suscribe.
 */
const navigationListeners = new Set<(route: string) => void>()
let navigationAttached = false
let undeliveredRoute: string | null = null

function attachNavigation(): void {
  if (navigationAttached) return
  navigationAttached = true
  void (ipcRenderer.invoke(IPC.attachNavigation) as Promise<string | null>).then(route => {
    undeliveredRoute = route
    deliverPendingRoute()
  })
}

function deliverPendingRoute(): void {
  const listener = [...navigationListeners][0]
  if (!listener || !undeliveredRoute) return
  const route = undeliveredRoute
  undeliveredRoute = null
  listener(route)
}

contextBridge.exposeInMainWorld('agentHub', bridge)
