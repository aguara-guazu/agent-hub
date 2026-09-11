/**
 * Opciones seguras para el BrowserWindow del renderer.
 *
 * Reglas no negociables (revisables por prueba):
 *  - contextIsolation activado
 *  - sandbox activado
 *  - nodeIntegration desactivado
 *  - webSecurity activado
 *  - preload apuntando al bridge compilado
 *
 * El módulo es puro (no importa Electron) para poder verificarlo en pruebas.
 */

export interface SecureWebPreferences {
  contextIsolation: true
  sandbox: true
  nodeIntegration: false
  nodeIntegrationInWorker: false
  webSecurity: true
  allowRunningInsecureContent: false
  preload: string
}

export interface WindowOptions {
  width: number
  height: number
  minWidth: number
  minHeight: number
  show: boolean
  icon: string
  webPreferences: SecureWebPreferences
}

export function secureWebPreferences(preloadPath: string): SecureWebPreferences {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    preload: preloadPath,
  }
}

export function windowOptions(preloadPath: string, iconPath: string): WindowOptions {
  return {
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    show: false,
    icon: iconPath,
    webPreferences: secureWebPreferences(preloadPath),
  }
}

/**
 * Política de navegación: sólo se permite el origen propio (loopback del core
 * o el dev server). Cualquier otra URL se abre fuera o se bloquea.
 */
export function isAllowedNavigation(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl)
    const target = new URL(targetUrl)
    return current.origin === target.origin
  } catch {
    return false
  }
}
