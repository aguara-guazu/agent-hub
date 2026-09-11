import { join } from 'node:path'

/**
 * Autostart (inicio al ingresar) multiplataforma.
 *
 * - darwin / win32: se delega en `app.setLoginItemSettings` de Electron.
 * - linux: no hay API nativa; se escribe/borra un `.desktop` en
 *   `~/.config/autostart`.
 *
 * La lógica de plataforma es pura para poder probarla; los efectos (Electron y
 * disco) se inyectan.
 */

export interface LoginItemBackend {
  get(): { openAtLogin: boolean }
  set(settings: { openAtLogin: boolean }): void
}

export interface LinuxAutostartFs {
  configHome: string
  exists(path: string): boolean
  write(path: string, contents: string): void
  remove(path: string): void
}

export interface AutostartDeps {
  platform: NodeJS.Platform
  execPath: string
  appName: string
  loginItem?: LoginItemBackend
  linuxFs?: LinuxAutostartFs
}

const LINUX_DESKTOP_FILENAME = 'agent-hub.desktop'

export function linuxAutostartPath(configHome: string): string {
  return join(configHome, 'autostart', LINUX_DESKTOP_FILENAME)
}

export function linuxDesktopEntry(appName: string, execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${appName}`,
    `Exec=${execPath} --hidden`,
    'X-GNOME-Autostart-enabled=true',
    'Terminal=false',
    '',
  ].join('\n')
}

export class AutostartManager {
  constructor(private readonly deps: AutostartDeps) {}

  isEnabled(): boolean {
    if (this.deps.platform === 'linux') {
      const fs = this.requireLinuxFs()
      return fs.exists(linuxAutostartPath(fs.configHome))
    }
    return this.requireLoginItem().get().openAtLogin
  }

  setEnabled(enabled: boolean): void {
    if (this.deps.platform === 'linux') {
      const fs = this.requireLinuxFs()
      const path = linuxAutostartPath(fs.configHome)
      if (enabled) {
        fs.write(path, linuxDesktopEntry(this.deps.appName, this.deps.execPath))
      } else if (fs.exists(path)) {
        fs.remove(path)
      }
      return
    }
    this.requireLoginItem().set({ openAtLogin: enabled })
  }

  private requireLoginItem(): LoginItemBackend {
    if (!this.deps.loginItem) throw new Error('loginItem backend requerido para esta plataforma')
    return this.deps.loginItem
  }

  private requireLinuxFs(): LinuxAutostartFs {
    if (!this.deps.linuxFs) throw new Error('linuxFs requerido en linux')
    return this.deps.linuxFs
  }
}
