import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AutoUpdater,
  assetNameFor,
  bundlePathFrom,
  compareVersions,
  detectStrategy,
  downloadAsset,
  fetchLatestRelease,
  installAppImage,
  installDmg,
  installNsis,
  type RunFn,
} from './updater.js'

const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function fakeResponse(body: string | Buffer, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: init.status ?? 200, headers: init.headers ?? {} })
}

const release = (version: string, assets: string[]) => JSON.stringify({
  tag_name: `v${version}`,
  body: 'notas',
  html_url: `https://github.com/aguara-guazu/agent-hub/releases/tag/v${version}`,
  assets: assets.map((name) => ({ name, browser_download_url: `https://downloads.example/${name}` })),
})

describe('versiones y artefactos', () => {
  it('compara versiones semánticas con o sin la v', () => {
    expect(compareVersions('0.3.0', '0.2.0')).toBe(1)
    expect(compareVersions('v0.2.0', '0.2.0')).toBe(0)
    expect(compareVersions('0.2.1', '0.10.0')).toBe(-1)
    expect(compareVersions('1.0', '0.9.9')).toBe(1)
  })

  it('elige el artefacto que publica electron-builder para cada plataforma', () => {
    expect(assetNameFor('dmg', 'arm64')).toBe('AgentHub-arm64.dmg')
    expect(assetNameFor('dmg', 'x64')).toBe('AgentHub-x64.dmg')
    expect(assetNameFor('nsis', 'x64')).toBe('AgentHub-Setup-x64.exe')
    expect(assetNameFor('nsis', 'arm64')).toBe('AgentHub-Setup-arm64.exe')
    expect(assetNameFor('appimage', 'x64')).toBe('AgentHub-x86_64.AppImage')
    expect(assetNameFor('appimage', 'arm64')).toBe('AgentHub-arm64.AppImage')
    expect(assetNameFor('notify', 'x64')).toBeNull()
  })

  it('detecta cómo puede actualizarse cada instalación', () => {
    expect(bundlePathFrom('/Applications/Agent Hub.app/Contents/MacOS/Agent Hub')).toBe('/Applications/Agent Hub.app')
    expect(bundlePathFrom('/opt/agent-hub/agent-hub')).toBeNull()
    expect(detectStrategy({ platform: 'darwin', execPath: '/Applications/Agent Hub.app/Contents/MacOS/Agent Hub', env: {} })).toBe('dmg')
    expect(detectStrategy({ platform: 'win32', execPath: 'C:\\\\Users\\\\ana\\\\AppData\\\\Local\\\\Programs\\\\Agent Hub\\\\Agent Hub.exe', env: {}, exists: () => true })).toBe('nsis')
    expect(detectStrategy({ platform: 'win32', execPath: 'D:\\\\portable\\\\Agent Hub.exe', env: {}, exists: () => false })).toBe('notify')
    expect(detectStrategy({ platform: 'linux', execPath: '/tmp/.mount_x/agent-hub', env: { APPIMAGE: '/home/ana/AgentHub-x86_64.AppImage' } })).toBe('appimage')
    expect(detectStrategy({ platform: 'linux', execPath: '/opt/Agent Hub/agent-hub', env: {} })).toBe('notify')
  })
})

describe('consulta de la última release', () => {
  it('parsea la release y sus artefactos', async () => {
    const seen: string[] = []
    const info = await fetchLatestRelease({ repo: 'o/r', apiBase: 'https://api.example/', fetchFn: async (url) => { seen.push(url); return fakeResponse(release('0.3.0', ['AgentHub-arm64.dmg'])) } })
    expect(seen).toEqual(['https://api.example/repos/o/r/releases/latest'])
    expect(info).toEqual({ version: '0.3.0', notes: 'notas', page: 'https://github.com/aguara-guazu/agent-hub/releases/tag/v0.3.0', assets: [{ name: 'AgentHub-arm64.dmg', url: 'https://downloads.example/AgentHub-arm64.dmg' }] })
  })

  it('sin release, con error HTTP o con un tag raro devuelve null en vez de lanzar', async () => {
    expect(await fetchLatestRelease({ fetchFn: async () => fakeResponse('{}', { status: 404 }) })).toBeNull()
    expect(await fetchLatestRelease({ fetchFn: async () => fakeResponse(JSON.stringify({ tag_name: 'nightly' })) })).toBeNull()
    expect(await fetchLatestRelease({ fetchFn: async () => { throw new Error('sin red') } })).toBeNull()
  })
})

describe('descarga', () => {
  async function serve(body: Buffer, status = 200): Promise<string> {
    const server = createServer((_request, response) => { response.writeHead(status, { 'Content-Length': String(body.length) }).end(body) }).listen(0, '127.0.0.1')
    servers.push(server)
    await once(server, 'listening')
    const address = server.address() as { port: number }
    return `http://127.0.0.1:${address.port}/asset`
  }

  it('baja el artefacto, informa el progreso y exige un tamaño mínimo', async () => {
    const dir = tmp('agenthub-dl-')
    const url = await serve(Buffer.alloc(4096, 1))
    const progress: number[] = []
    await downloadAsset(url, join(dir, 'a.bin'), { minBytes: 1024, onProgress: (f) => progress.push(f) })
    expect(statSync(join(dir, 'a.bin')).size).toBe(4096)
    expect(progress.at(-1)).toBe(1)

    const small = await serve(Buffer.from('<!doctype html>'))
    await expect(downloadAsset(small, join(dir, 'b.bin'), { minBytes: 1024 })).rejects.toThrow(/no parece un instalador/)
    expect(existsSync(join(dir, 'b.bin'))).toBe(false)

    const missing = await serve(Buffer.from('nada'), 404)
    await expect(downloadAsset(missing, join(dir, 'c.bin'), { minBytes: 1 })).rejects.toThrow(/HTTP 404/)
  })
})

describe('instalación', () => {
  it('macOS: monta, verifica el bundle id, prepara al lado e intercambia con respaldo', async () => {
    const root = tmp('agenthub-dmg-')
    const bundle = join(root, 'Applications', 'Agent Hub.app')
    mkdirSync(join(bundle, 'Contents'), { recursive: true })
    writeFileSync(join(bundle, 'Contents', 'Info.plist'), '<plist>io.craftech.agenthub 0.2.0</plist>')
    const dmgDir = join(root, 'download')
    mkdirSync(dmgDir)
    writeFileSync(join(dmgDir, 'AgentHub-arm64.dmg'), 'no importa')
    const commands: string[] = []
    const run: RunFn = async (command, args) => {
      commands.push([command, ...args].join(' '))
      if (command === 'hdiutil' && args[0] === 'attach') {
        const mount = args[args.indexOf('-mountpoint') + 1]!
        mkdirSync(join(mount, 'Agent Hub.app', 'Contents'), { recursive: true })
        writeFileSync(join(mount, 'Agent Hub.app', 'Contents', 'Info.plist'), '<plist>io.craftech.agenthub 0.3.0</plist>')
        return { stdout: '' }
      }
      if (command === '/bin/ls') return { stdout: 'Agent Hub.app\n.background\n' }
      if (command === 'ditto') { cpSync(args[0]!, args[1]!, { recursive: true }); return { stdout: '' } }
      if (command === '/bin/mv') { await rename(args[0]!, args[1]!); return { stdout: '' } }
      if (command === '/bin/rm') { await rm(args[1]!, { recursive: true, force: true }); return { stdout: '' } }
      return { stdout: '' }
    }
    await installDmg(join(dmgDir, 'AgentHub-arm64.dmg'), bundle, 'io.craftech.agenthub', run)
    expect(readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8')).toContain('0.3.0')
    expect(existsSync(`${bundle}.incoming`)).toBe(false)
    expect(existsSync(`${bundle}.previous`)).toBe(false)
    expect(existsSync(dmgDir)).toBe(false)
    expect(commands.some((c) => c.startsWith('hdiutil detach'))).toBe(true)
    expect(commands.some((c) => c.startsWith('xattr -dr com.apple.quarantine'))).toBe(true)
  })

  it('macOS: si el dmg trae otra app, no toca nada', async () => {
    const root = tmp('agenthub-dmg-bad-')
    const bundle = join(root, 'Agent Hub.app')
    mkdirSync(join(bundle, 'Contents'), { recursive: true })
    writeFileSync(join(bundle, 'Contents', 'Info.plist'), 'io.craftech.agenthub')
    const dmgDir = join(root, 'download'); mkdirSync(dmgDir); writeFileSync(join(dmgDir, 'x.dmg'), '')
    const run: RunFn = async (command, args) => {
      if (command === 'hdiutil' && args[0] === 'attach') {
        const mount = args[args.indexOf('-mountpoint') + 1]!
        mkdirSync(join(mount, 'Otra.app', 'Contents'), { recursive: true })
        writeFileSync(join(mount, 'Otra.app', 'Contents', 'Info.plist'), 'com.otra.app')
      }
      if (command === '/bin/ls') return { stdout: 'Otra.app\n' }
      if (command === '/bin/mv') throw new Error('no debería mover nada')
      return { stdout: '' }
    }
    await expect(installDmg(join(dmgDir, 'x.dmg'), bundle, 'io.craftech.agenthub', run)).rejects.toThrow(/no contiene esta aplicación/)
    expect(readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8')).toBe('io.craftech.agenthub')
  })

  it('Windows: lanza el instalador NSIS en silencio con reapertura, como electron-updater', () => {
    const calls: Array<[string, readonly string[]]> = []
    installNsis('C:\\\\tmp\\\\AgentHub-Setup-x64.exe', (command, args) => { calls.push([command, args]) })
    expect(calls).toEqual([['C:\\\\tmp\\\\AgentHub-Setup-x64.exe', ['--updated', '/S', '--force-run']]])
  })

  it('Linux: reemplaza el .AppImage en su lugar, lo deja ejecutable y lo vuelve a abrir', async () => {
    const root = tmp('agenthub-appimage-')
    const appImage = join(root, 'AgentHub-x86_64.AppImage')
    writeFileSync(appImage, 'viejo')
    const downloaded = join(root, 'dl', 'AgentHub-x86_64.AppImage')
    mkdirSync(join(root, 'dl')); writeFileSync(downloaded, 'nuevo')
    const spawned: string[] = []
    await installAppImage(downloaded, appImage, (command) => { spawned.push(command) })
    expect(readFileSync(appImage, 'utf8')).toBe('nuevo')
    expect(statSync(appImage).mode & 0o111).toBeTruthy()
    expect(existsSync(`${appImage}.incoming`)).toBe(false)
    expect(spawned).toEqual([appImage])
  })
})

describe('orquestación', () => {
  const base = { currentVersion: '0.2.0', arch: 'arm64', bundleId: 'io.craftech.agenthub', enabled: true }

  it('en desarrollo o con AGENTHUB_NO_AUTO_UPDATE no hace nada', async () => {
    const dev = new AutoUpdater({ ...base, platform: 'darwin', execPath: '/x/Agent Hub.app/Contents/MacOS/Agent Hub', env: {}, enabled: false, fetchFn: async () => { throw new Error('no debería llamar') } })
    expect(await dev.check()).toEqual({ state: 'disabled' })
    const off = new AutoUpdater({ ...base, platform: 'darwin', execPath: '/x/Agent Hub.app/Contents/MacOS/Agent Hub', env: { AGENTHUB_NO_AUTO_UPDATE: '1' }, fetchFn: async () => { throw new Error('no debería llamar') } })
    expect(await off.check()).toEqual({ state: 'disabled' })
  })

  it('al día cuando la release no es más nueva o no hay release', async () => {
    const same = new AutoUpdater({ ...base, platform: 'darwin', execPath: '/x/Agent Hub.app/Contents/MacOS/Agent Hub', env: {}, fetchFn: async () => fakeResponse(release('0.2.0', ['AgentHub-arm64.dmg'])) })
    expect(await same.check()).toEqual({ state: 'up-to-date', version: '0.2.0' })
    const none = new AutoUpdater({ ...base, platform: 'darwin', execPath: '/x/Agent Hub.app/Contents/MacOS/Agent Hub', env: {}, fetchFn: async () => fakeResponse('{}', { status: 404 }) })
    expect(await none.check()).toEqual({ state: 'up-to-date', version: '0.2.0' })
  })

  it('sólo avisa cuando la instalación no puede autoinstalar (deb, zip) o falta el artefacto', async () => {
    const deb = new AutoUpdater({ ...base, platform: 'linux', execPath: '/opt/Agent Hub/agent-hub', env: {}, fetchFn: async () => fakeResponse(release('0.3.0', ['AgentHub-x86_64.AppImage'])) })
    expect(await deb.check()).toMatchObject({ state: 'available', version: '0.3.0' })
    const root = tmp('agenthub-orq-')
    const bundle = join(root, 'Agent Hub.app'); mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    const noAsset = new AutoUpdater({ ...base, platform: 'darwin', execPath: join(bundle, 'Contents', 'MacOS', 'Agent Hub'), env: {}, fetchFn: async () => fakeResponse(release('0.3.0', ['AgentHub-x64.dmg'])) })
    expect(await noAsset.check()).toMatchObject({ state: 'available', version: '0.3.0' })
  })

  it('baja el artefacto correcto y lo deja listo para aplicar; una descarga rota se informa como fallo', async () => {
    const root = tmp('agenthub-orq2-')
    const bundle = join(root, 'Agent Hub.app'); mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    const requested: string[] = []
    const fetchFn = async (url: string): Promise<Response> => {
      requested.push(url)
      if (url.includes('/releases/latest')) return fakeResponse(release('0.3.0', ['AgentHub-x64.dmg', 'AgentHub-arm64.dmg']))
      return fakeResponse(Buffer.alloc(2048, 7), { headers: { 'Content-Length': '2048' } })
    }
    const updater = new AutoUpdater({ ...base, platform: 'darwin', execPath: join(bundle, 'Contents', 'MacOS', 'Agent Hub'), env: {}, fetchFn, tmpDir: root, minAssetBytes: 1024 })
    const status = await updater.check()
    expect(status.state).toBe('downloaded')
    if (status.state !== 'downloaded') return
    expect(status.version).toBe('0.3.0')
    expect(status.strategy).toBe('dmg')
    expect(requested[1]).toBe('https://downloads.example/AgentHub-arm64.dmg')
    expect(statSync(status.path).size).toBe(2048)

    const broken = new AutoUpdater({ ...base, platform: 'darwin', execPath: join(bundle, 'Contents', 'MacOS', 'Agent Hub'), env: {}, tmpDir: root, minAssetBytes: 1024,
      fetchFn: async (url) => url.includes('/releases/latest') ? fakeResponse(release('0.3.0', ['AgentHub-arm64.dmg'])) : fakeResponse(Buffer.from('html')) })
    expect(await broken.check()).toMatchObject({ state: 'failed', version: '0.3.0' })
  })

  it('aplicar en Windows lanza el instalador y en Linux reemplaza el AppImage', async () => {
    const root = tmp('agenthub-orq3-')
    const spawned: Array<[string, readonly string[]]> = []
    const win = new AutoUpdater({ ...base, platform: 'win32', arch: 'x64', execPath: 'C:\\\\Programs\\\\Agent Hub\\\\Agent Hub.exe', env: {}, exists: () => true, spawnFn: (c, a) => { spawned.push([c, a]) } })
    expect(await win.apply({ state: 'downloaded', version: '0.3.0', path: 'C:\\\\tmp\\\\AgentHub-Setup-x64.exe', strategy: 'nsis' })).toBe('external')
    expect(spawned[0]).toEqual(['C:\\\\tmp\\\\AgentHub-Setup-x64.exe', ['--updated', '/S', '--force-run']])

    const appImage = join(root, 'AgentHub-x86_64.AppImage'); writeFileSync(appImage, 'viejo')
    const downloaded = join(root, 'nuevo.AppImage'); writeFileSync(downloaded, 'nuevo')
    const linux = new AutoUpdater({ ...base, platform: 'linux', arch: 'x64', execPath: '/tmp/.mount_x/agent-hub', env: { APPIMAGE: appImage }, spawnFn: (c, a) => { spawned.push([c, a]) } })
    expect(await linux.apply({ state: 'downloaded', version: '0.3.0', path: downloaded, strategy: 'appimage' })).toBe('external')
    expect(readFileSync(appImage, 'utf8')).toBe('nuevo')
    expect(spawned[1]).toEqual([appImage, []])
  })
})
