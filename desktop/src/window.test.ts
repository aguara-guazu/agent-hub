import { describe, expect, it } from 'vitest'
import { isAllowedNavigation, secureWebPreferences, windowOptions } from './window.js'

describe('opciones seguras de ventana', () => {
  it('fuerza aislamiento, sandbox y sin nodeIntegration', () => {
    const prefs = secureWebPreferences('/preload.js')
    expect(prefs.contextIsolation).toBe(true)
    expect(prefs.sandbox).toBe(true)
    expect(prefs.nodeIntegration).toBe(false)
    expect(prefs.nodeIntegrationInWorker).toBe(false)
    expect(prefs.webSecurity).toBe(true)
    expect(prefs.allowRunningInsecureContent).toBe(false)
    expect(prefs.preload).toBe('/preload.js')
  })

  it('la ventana arranca oculta y con el preload correcto', () => {
    const opts = windowOptions('/p.js', '/icon.png')
    expect(opts.show).toBe(false)
    expect(opts.webPreferences.preload).toBe('/p.js')
    expect(opts.icon).toBe('/icon.png')
  })

  it('sólo permite navegar dentro del mismo origen', () => {
    expect(isAllowedNavigation('http://127.0.0.1:8765/', 'http://127.0.0.1:8765/matrix')).toBe(true)
    expect(isAllowedNavigation('http://127.0.0.1:8765/', 'http://evil.example/')).toBe(false)
    expect(isAllowedNavigation('http://127.0.0.1:8765/', 'no-es-una-url')).toBe(false)
  })
})
