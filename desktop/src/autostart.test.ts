import { describe, expect, it, vi } from 'vitest'
import {
  AutostartManager,
  linuxAutostartPath,
  linuxDesktopEntry,
  type LinuxAutostartFs,
  type LoginItemBackend,
} from './autostart.js'

function memLinuxFs(configHome = '/home/u/.config'): LinuxAutostartFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    configHome,
    exists: (p) => files.has(p),
    write: (p, contents) => void files.set(p, contents),
    remove: (p) => void files.delete(p),
  }
}

describe('AutostartManager en darwin/win32', () => {
  it('lee y escribe openAtLogin vía login item', () => {
    let openAtLogin = false
    const loginItem: LoginItemBackend = {
      get: () => ({ openAtLogin }),
      set: vi.fn((s) => {
        openAtLogin = s.openAtLogin
      }),
    }
    const mgr = new AutostartManager({ platform: 'darwin', execPath: '/Applications/AH.app', appName: 'Agent Hub', loginItem })
    expect(mgr.isEnabled()).toBe(false)
    mgr.setEnabled(true)
    expect(loginItem.set).toHaveBeenCalledWith({ openAtLogin: true })
    expect(mgr.isEnabled()).toBe(true)
  })

  it('exige backend de login item fuera de linux', () => {
    const mgr = new AutostartManager({ platform: 'win32', execPath: 'C:/AH.exe', appName: 'Agent Hub' })
    expect(() => mgr.isEnabled()).toThrow(/loginItem/)
  })
})

describe('AutostartManager en linux', () => {
  it('crea y borra el .desktop en ~/.config/autostart', () => {
    const fs = memLinuxFs()
    const mgr = new AutostartManager({ platform: 'linux', execPath: '/usr/bin/agent-hub', appName: 'Agent Hub', linuxFs: fs })
    const path = linuxAutostartPath(fs.configHome)

    expect(mgr.isEnabled()).toBe(false)
    mgr.setEnabled(true)
    expect(fs.files.has(path)).toBe(true)
    expect(fs.files.get(path)).toContain('Exec=/usr/bin/agent-hub --hidden')
    expect(mgr.isEnabled()).toBe(true)

    mgr.setEnabled(false)
    expect(fs.files.has(path)).toBe(false)
  })

  it('la entrada .desktop tiene los campos mínimos', () => {
    const entry = linuxDesktopEntry('Agent Hub', '/usr/bin/agent-hub')
    expect(entry).toContain('[Desktop Entry]')
    expect(entry).toContain('Type=Application')
    expect(entry).toContain('Name=Agent Hub')
    expect(entry).toContain('X-GNOME-Autostart-enabled=true')
  })
})
