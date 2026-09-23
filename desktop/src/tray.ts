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
  if (vm.update?.state === 'ready') {
    items.push({ id: 'apply-update', label: `Reiniciar para actualizar a v${vm.update.version}`, type: 'normal' })
  } else if (vm.update?.state === 'available') {
    items.push({ id: 'open-release', label: `Nueva versión v${vm.update.version} disponible…`, type: 'normal' })
  }
  items.push({
    id: 'check-updates',
    label: vm.checkingUpdates ? 'Buscando actualizaciones…' : 'Buscar actualizaciones',
    type: 'normal',
    enabled: !vm.checkingUpdates,
  })
  return items
}

export const TRAY_TOOLTIP = 'Agent Hub'
