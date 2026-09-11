import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AgentHubBridge, type CoreStatus } from './ipc.js'

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
}

contextBridge.exposeInMainWorld('agentHub', bridge)
