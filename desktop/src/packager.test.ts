import { describe, expect, it } from 'vitest'
import { APP_BUNDLE_ID, APP_NAME, SUPPORTED_PLATFORMS, packagerOptions, targetsFromArgv } from './packager.js'

describe('configuración de @electron/packager', () => {
  it('cubre las tres plataformas de escritorio', () => {
    expect([...SUPPORTED_PLATFORMS]).toEqual(['darwin', 'win32', 'linux'])
  })

  it('darwin empaqueta arm64 sin asar para ejecutar core y daemon como procesos Node', () => {
    const opts = packagerOptions({ platform: 'darwin', projectRoot: '/repo', out: '/repo/desktop/out', appVersion: '0.2.0' })
    expect(opts.platform).toBe('darwin')
    expect(opts.arch).toBe('arm64')
    expect(opts.asar).toBe(false)
    expect(opts.prune).toBe(true)
    expect(opts.overwrite).toBe(true)
    expect(opts.name).toBe(APP_NAME)
    expect(opts.appVersion).toBe('0.2.0')
  })

  it('darwin es una app de barra de menú: LSUIElement y bundle id propio', () => {
    const darwin = packagerOptions({ platform: 'darwin', projectRoot: '/r', out: '/o', appVersion: '1' })
    expect(darwin.appBundleId).toBe(APP_BUNDLE_ID)
    expect(darwin.extendInfo).toEqual({ LSUIElement: true })
    for (const platform of ['win32', 'linux'] as const) {
      expect(packagerOptions({ platform, projectRoot: '/r', out: '/o', appVersion: '1' }).extendInfo).toBeUndefined()
    }
  })

  it('win32 y linux usan x64 por defecto', () => {
    expect(packagerOptions({ platform: 'win32', projectRoot: '/r', out: '/o', appVersion: '1' }).arch).toBe('x64')
    expect(packagerOptions({ platform: 'linux', projectRoot: '/r', out: '/o', appVersion: '1' }).arch).toBe('x64')
  })

  it('respeta un arch explícito', () => {
    const opts = packagerOptions({ platform: 'linux', projectRoot: '/r', out: '/o', appVersion: '1', arch: 'arm64' })
    expect(opts.arch).toBe('arm64')
  })

  it('ignora documentación, tests y metadatos que no se distribuyen', () => {
    const opts = packagerOptions({ platform: 'linux', projectRoot: '/r', out: '/o', appVersion: '1' })
    const ignore = opts.ignore as RegExp[]
    expect(ignore.some((re) => re.test('/docs/architecture.md'))).toBe(true)
    expect(ignore.some((re) => re.test('/tests/e2e/local.test.ts'))).toBe(true)
    expect(ignore.some((re) => re.test('/.git/HEAD'))).toBe(true)
    expect(ignore.some((re) => re.test('/.kiro/settings/lsp.json'))).toBe(true)
    expect(ignore.some((re) => re.test('/agenthub.db'))).toBe(true)
    expect(ignore.some((re) => re.test('/packages/core/src/app.ts'))).toBe(true)
    expect(ignore.some((re) => re.test('/packages/core/test/http.test.ts'))).toBe(true)
    expect(ignore.some((re) => re.test('/frontend/scripts/screenshots.mjs'))).toBe(true)
    expect(ignore.some((re) => re.test('/frontend/node_modules/playwright/index.js'))).toBe(true)
    expect(ignore.some((re) => re.test('/desktop/dist/window.test.js'))).toBe(true)
    expect(ignore.some((re) => re.test('/packages/core/dist/app.js.map'))).toBe(true)
    expect(ignore.some((re) => re.test('/packages/core/dist/app.d.ts'))).toBe(true)
    expect(ignore.some((re) => re.test('/frontend/tsconfig.tsbuildinfo'))).toBe(true)
    expect(ignore.some((re) => re.test('/desktop/dist/main.js'))).toBe(false)
    expect(ignore.some((re) => re.test('/packages/core/dist/server.js'))).toBe(false)
    expect(ignore.some((re) => re.test('/packages/daemon/dist/cli.js'))).toBe(false)
    expect(ignore.some((re) => re.test('/packages/gateway/dist/headless.js'))).toBe(false)
    expect(ignore.some((re) => re.test('/frontend/dist/index.html'))).toBe(false)
  })

  it('incluye icono cuando se provee iconBase', () => {
    const withIcon = packagerOptions({ platform: 'darwin', projectRoot: '/r', out: '/o', appVersion: '1', iconBase: '/r/desktop/assets/icon' })
    expect(withIcon.icon).toBe('/r/desktop/assets/icon')
    const without = packagerOptions({ platform: 'darwin', projectRoot: '/r', out: '/o', appVersion: '1' })
    expect(without.icon).toBeUndefined()
  })

  it('parsea los targets de argv', () => {
    expect(targetsFromArgv([], 'darwin')).toEqual(['darwin'])
    expect(targetsFromArgv([], 'win32')).toEqual(['win32'])
    expect(targetsFromArgv(['all'])).toEqual(['darwin', 'win32', 'linux'])
    expect(targetsFromArgv(['win32'])).toEqual(['win32'])
    expect(() => targetsFromArgv(['solaris'])).toThrow(/no soportada/)
  })
})
