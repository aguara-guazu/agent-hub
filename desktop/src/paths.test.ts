import { describe, expect, it } from 'vitest'
import { coreEntrypoint, iconFor, rendererIndex, resolvePaths, type PathContext } from './paths.js'

const devCtx: PathContext = {
  isPackaged: false,
  resourcesPath: '/app/Contents/Resources',
  repoRoot: '/repo',
  appDir: '/repo/desktop/dist',
  rendererDevServerUrl: 'http://127.0.0.1:5173',
}

const prodCtx: PathContext = {
  isPackaged: true,
  resourcesPath: '/app/Contents/Resources',
  repoRoot: '/app/Contents/Resources',
  appDir: '/app/Contents/Resources/app/desktop/dist',
  rendererDevServerUrl: undefined,
}

describe('paths dev/prod', () => {
  it('en dev el core corre desde el repo con el Node del sistema', () => {
    expect(coreEntrypoint(devCtx)).toBe('/repo/packages/core/dist/server.js')
    const resolved = resolvePaths(devCtx, 'darwin')
    expect(resolved.coreCommand).toBe(process.execPath)
    expect(resolved.coreArgs).toEqual(['/repo/packages/core/dist/server.js'])
  })

  it('empaquetado el core cuelga de resourcesPath', () => {
    expect(coreEntrypoint(prodCtx)).toBe('/app/Contents/Resources/app/packages/core/dist/server.js')
    expect(rendererIndex(prodCtx)).toBe('/app/Contents/Resources/app/frontend/dist/index.html')
  })

  it('en dev con dev server el renderer se carga por URL', () => {
    const resolved = resolvePaths(devCtx, 'linux')
    expect(resolved.renderer).toEqual({ kind: 'url', url: 'http://127.0.0.1:5173' })
  })

  it('empaquetado el renderer se carga por archivo', () => {
    const resolved = resolvePaths(prodCtx, 'win32')
    expect(resolved.renderer).toEqual({
      kind: 'file',
      path: '/app/Contents/Resources/app/frontend/dist/index.html',
    })
  })

  it('el preload apunta al bridge compilado junto al main', () => {
    expect(resolvePaths(devCtx).preloadPath).toBe('/repo/desktop/dist/preload.cjs')
  })

  it('elige el icono por plataforma', () => {
    expect(iconFor(devCtx, 'win32')).toMatch(/icon\.ico$/)
    expect(iconFor(devCtx, 'darwin')).toMatch(/icon\.icns$/)
    expect(iconFor(devCtx, 'linux')).toMatch(/icon\.png$/)
  })
})
