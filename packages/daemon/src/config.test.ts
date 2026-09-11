import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { packagedAppRoot, resolveGatewayLaunch } from './config.js'

const base = {
  execPath: '/Applications/Agent Hub.app/Contents/MacOS/Agent Hub',
  devEntry: '/repo/desktop/dist/entry.js',
  cliEntry: '/repo/packages/daemon/dist/cli.js',
  pkg: false,
}

describe('cómo lanza un CLI el puente stdio', () => {
  it('dentro de Electron empaquetado corre entry.js como Node puro', () => {
    const launch = resolveGatewayLaunch({ ...base, electron: true, packagedAppRoot: '/Applications/Agent Hub.app/Contents/Resources/app' })
    expect(launch.command).toBe(base.execPath)
    expect(launch.args).toEqual(['/Applications/Agent Hub.app/Contents/Resources/app/desktop/dist/entry.js', '--agenthub-headless'])
    // Sin esto el puente sería una app gráfica: ícono en el Dock y macOS lo tomaría
    // por "Agent Hub ya abierto", impidiendo lanzar la app real.
    expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('dentro de Electron en desarrollo usa el entry.js del repositorio', () => {
    const launch = resolveGatewayLaunch({ ...base, electron: true, packagedAppRoot: null, execPath: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' })
    expect(launch.args).toEqual(['/repo/desktop/dist/entry.js', '--agenthub-headless'])
    expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('con Node del sistema lanza dist/cli.js sin entorno extra', () => {
    const launch = resolveGatewayLaunch({ ...base, electron: false, packagedAppRoot: null, execPath: '/usr/local/bin/node' })
    expect(launch).toEqual({ command: '/usr/local/bin/node', args: ['/repo/packages/daemon/dist/cli.js'], env: {} })
  })

  it('un binario pkg se relanza a sí mismo', () => {
    const launch = resolveGatewayLaunch({ ...base, electron: false, pkg: true, packagedAppRoot: null, execPath: '/usr/local/bin/agenthub' })
    expect(launch).toEqual({ command: '/usr/local/bin/agenthub', args: [], env: {} })
  })
})

describe('raíz app/ del bundle empaquetado', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  it('reconoce el layout de macOS y el de Windows/Linux, y null en desarrollo', () => {
    const mac = mkdtempSync(join(tmpdir(), 'agenthub-mac-'))
    roots.push(mac)
    mkdirSync(join(mac, 'Contents', 'MacOS'), { recursive: true })
    mkdirSync(join(mac, 'Contents', 'Resources', 'app'), { recursive: true })
    writeFileSync(join(mac, 'Contents', 'Resources', 'app', 'package.json'), '{}')
    expect(packagedAppRoot(join(mac, 'Contents', 'MacOS', 'Agent Hub'))).toBe(join(mac, 'Contents', 'Resources', 'app'))

    const win = mkdtempSync(join(tmpdir(), 'agenthub-win-'))
    roots.push(win)
    mkdirSync(join(win, 'resources', 'app'), { recursive: true })
    writeFileSync(join(win, 'resources', 'app', 'package.json'), '{}')
    expect(packagedAppRoot(join(win, 'Agent Hub.exe'))).toBe(join(win, 'resources', 'app'))

    const dev = mkdtempSync(join(tmpdir(), 'agenthub-dev-'))
    roots.push(dev)
    expect(packagedAppRoot(join(dev, 'Electron'))).toBeNull()
  })
})
