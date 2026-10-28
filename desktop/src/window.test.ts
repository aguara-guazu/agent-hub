import { describe, expect, it } from 'vitest'
import { externalUrl, isAllowedNavigation, secureWebPreferences, windowOptions } from './window.js'

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

describe('externalUrl', () => {
  it('permite http, https y mailto', () => {
    expect(externalUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(externalUrl('http://example.com')).toBe('http://example.com/')
    expect(externalUrl('mailto:ana@example.com')).toBe('mailto:ana@example.com')
  })

  it('rechaza javascript, file, data, ssh, rutas relativas, credenciales y basura', () => {
    for (const target of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'ssh://host/repo', 'vscode://file/x', '/relativa', '#ancla', 'https://user:pass@example.com', 'no-es-una-url', '']) {
      expect(externalUrl(target)).toBeNull()
    }
  })
})
