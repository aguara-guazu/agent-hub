import { describe, expect, it } from 'vitest'
import { buildTrayTemplate, type TrayAction } from './tray.js'

function actions(items: ReturnType<typeof buildTrayTemplate>): TrayAction[] {
  return items.map((i) => i.id).filter((id): id is TrayAction => Boolean(id))
}

describe('plantilla de tray', () => {
  it('ofrece siempre la acción de salir', () => {
    const items = buildTrayTemplate({ coreState: 'running', windowVisible: true, autostartEnabled: false })
    expect(actions(items)).toContain('quit')
  })

  it('muestra "Ocultar" cuando la ventana está visible y "Abrir" cuando no', () => {
    const visible = buildTrayTemplate({ coreState: 'running', windowVisible: true, autostartEnabled: false })
    expect(actions(visible)).toContain('hide')
    expect(actions(visible)).not.toContain('show')

    const hidden = buildTrayTemplate({ coreState: 'running', windowVisible: false, autostartEnabled: false })
    expect(actions(hidden)).toContain('show')
    expect(actions(hidden)).not.toContain('hide')
  })

  it('refleja el estado del autostart en el checkbox', () => {
    const on = buildTrayTemplate({ coreState: 'running', windowVisible: true, autostartEnabled: true })
    const item = on.find((i) => i.id === 'toggle-autostart')
    expect(item?.type).toBe('checkbox')
    expect(item?.checked).toBe(true)
  })

  it('deshabilita reiniciar core mientras está arrancando o reiniciando', () => {
    for (const state of ['starting', 'restarting'] as const) {
      const items = buildTrayTemplate({ coreState: state, windowVisible: true, autostartEnabled: false })
      const restart = items.find((i) => i.id === 'restart-core')
      expect(restart?.enabled).toBe(false)
    }
    const running = buildTrayTemplate({ coreState: 'running', windowVisible: true, autostartEnabled: false })
    expect(running.find((i) => i.id === 'restart-core')?.enabled).toBe(true)
  })

  it('ofrece buscar actualizaciones y refleja una actualización lista o sólo anunciable', () => {
    const idle = buildTrayTemplate({ coreState: 'running', windowVisible: false, autostartEnabled: false })
    expect(actions(idle)).toContain('check-updates')
    expect(actions(idle)).not.toContain('apply-update')
    expect(actions(idle)).not.toContain('open-release')

    const ready = buildTrayTemplate({ coreState: 'running', windowVisible: false, autostartEnabled: false, update: { version: '0.3.0', state: 'ready' } })
    expect(ready.find((i) => i.id === 'apply-update')?.label).toContain('0.3.0')
    expect(actions(ready)).not.toContain('open-release')

    const available = buildTrayTemplate({ coreState: 'running', windowVisible: false, autostartEnabled: false, update: { version: '0.3.0', state: 'available' } })
    expect(available.find((i) => i.id === 'open-release')?.label).toContain('0.3.0')
    expect(actions(available)).not.toContain('apply-update')

    const checking = buildTrayTemplate({ coreState: 'running', windowVisible: false, autostartEnabled: false, checkingUpdates: true })
    expect(checking.find((i) => i.id === 'check-updates')?.enabled).toBe(false)
  })

  it('muestra una etiqueta legible del estado del core', () => {
    const items = buildTrayTemplate({ coreState: 'failed', windowVisible: true, autostartEnabled: false })
    expect(items[0]?.label).toMatch(/fallo/i)
    expect(items[0]?.enabled).toBe(false)
  })
})
