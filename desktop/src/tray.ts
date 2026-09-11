import type { SupervisorState } from './supervisor.js'

/**
 * Plantilla del menú de tray, como datos puros.
 *
 * El main la traduce a `Menu.buildFromTemplate`. Separarla permite verificar
 * en pruebas qué acciones existen y qué estado muestran, sin Electron.
 */

export type TrayAction = 'show' | 'hide' | 'toggle-autostart' | 'restart-core' | 'quit'

export interface TrayItem {
  id?: TrayAction
  label?: string
  type?: 'normal' | 'separator' | 'checkbox'
  enabled?: boolean
  checked?: boolean
}

export interface TrayViewModel {
  coreState: SupervisorState
  windowVisible: boolean
  autostartEnabled: boolean
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
    { type: 'separator' },
    { id: 'quit', label: 'Salir de Agent Hub', type: 'normal' },
  ]
}

export const TRAY_TOOLTIP = 'Agent Hub'
