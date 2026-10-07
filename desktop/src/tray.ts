import type { SupervisorState } from './supervisor.js'

/**
 * Plantilla del menú de tray, como datos puros.
 *
 * El main la traduce a `Menu.buildFromTemplate`. Separarla permite verificar
 * en pruebas qué acciones existen y qué estado muestran, sin Electron.
 */

export type TrayAction = 'show' | 'hide' | 'toggle-autostart' | 'restart-core' | 'restart-client' | 'check-updates' | 'apply-update' | 'open-release' | 'quit'

export interface TrayItem {
  id?: TrayAction
  label?: string
  type?: 'normal' | 'separator' | 'checkbox'
  enabled?: boolean
  checked?: boolean
}

export interface TrayUpdateState {
  version: string
  /** `ready`: descargada, falta reiniciar. `available`: esta instalación sólo puede avisar. */
  state: 'ready' | 'available'
}

export interface TrayViewModel {
  coreState: SupervisorState
  windowVisible: boolean
  autostartEnabled: boolean
  update?: TrayUpdateState | null
  checkingUpdates?: boolean
  downloadingUpdate?: { version: string; receivedBytes: number; totalBytes: number | null } | null
  installingUpdate?: string | null
  updateError?: string | null
  /** Cliente de escritorio que sigue con una lista de herramientas vieja. */
  clientRestart?: { label: string } | null
}

function coreLabel(state: SupervisorState): string {
  switch (state) {
    case 'running':
      return 'Core: en ejecución'
    case 'starting':
      return 'Core: iniciando…'
    case 'restarting':
      return 'Core: reiniciando…'
    case 'stopping':
      return 'Core: deteniendo…'
    case 'failed':
      return 'Core: con fallo'
    case 'stopped':
    default:
      return 'Core: detenido'
  }
}

export function buildTrayTemplate(vm: TrayViewModel): TrayItem[] {
  return [
    { label: coreLabel(vm.coreState), enabled: false },
    { type: 'separator' },
    vm.windowVisible
      ? { id: 'hide', label: 'Ocultar ventana', type: 'normal' }
      : { id: 'show', label: 'Abrir Agent Hub', type: 'normal' },
    {
      id: 'toggle-autostart',
      label: 'Iniciar al ingresar',
      type: 'checkbox',
      checked: vm.autostartEnabled,
    },
    {
      id: 'restart-core',
      label: 'Reiniciar core',
      type: 'normal',
      enabled: vm.coreState !== 'starting' && vm.coreState !== 'restarting',
    },
    ...(vm.clientRestart ? [{ id: 'restart-client' as const, label: vm.clientRestart.label, type: 'normal' as const }] : []),
    { type: 'separator' },
    ...updateItems(vm),
    { type: 'separator' },
    { id: 'quit', label: 'Salir de Agent Hub', type: 'normal' },
  ]
}

function updateItems(vm: TrayViewModel): TrayItem[] {
  const items: TrayItem[] = []
  if (vm.installingUpdate) {
    items.push({ label: `Instalando v${vm.installingUpdate}…`, enabled: false })
  } else if (vm.downloadingUpdate) {
    const { version, receivedBytes, totalBytes } = vm.downloadingUpdate
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
    const progress = totalBytes ? `${Math.min(100, Math.floor(receivedBytes / totalBytes * 100))}% · ${mb(receivedBytes)} / ${mb(totalBytes)} MB` : `${mb(receivedBytes)} MB`
    items.push({ label: `Descargando v${version}… ${progress}`, enabled: false })
    items.push({ id: 'open-release', label: 'Ver la nueva versión…', type: 'normal' })
  } else if (vm.update?.state === 'ready') {
    items.push({ id: 'apply-update', label: `Reiniciar para actualizar a v${vm.update.version}`, type: 'normal' })
  } else if (vm.update?.state === 'available') {
    items.push({ id: 'open-release', label: `Nueva versión v${vm.update.version} disponible…`, type: 'normal' })
  }
  if (vm.updateError) items.push({ label: vm.updateError, enabled: false })
  const busy = Boolean(vm.checkingUpdates || vm.downloadingUpdate || vm.installingUpdate)
  items.push({
    id: 'check-updates',
    label: vm.installingUpdate ? 'Actualización en curso…' : vm.downloadingUpdate ? 'Descarga en curso…'
      : vm.checkingUpdates ? 'Buscando actualizaciones…' : vm.updateError ? 'Reintentar actualización' : 'Buscar actualizaciones',
    type: 'normal',
    enabled: !busy,
  })
  return items
}

export const TRAY_TOOLTIP = 'Agent Hub'
