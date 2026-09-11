import { join } from 'node:path'

export interface PathContext {
  isPackaged: boolean
  resourcesPath: string
  repoRoot: string
  appDir: string
  rendererDevServerUrl?: string | undefined
}

export interface ResolvedPaths {
  coreCommand: string
  coreArgs: string[]
  daemonCommand: string
  daemonArgs: string[]
  preloadPath: string
  renderer: { kind: 'url'; url: string } | { kind: 'file'; path: string }
  rendererIndex: string
  iconPath: string
}

function appRoot(ctx: PathContext): string {
  return ctx.isPackaged ? join(ctx.resourcesPath, 'app') : ctx.repoRoot
}
export function coreEntrypoint(ctx: PathContext): string {
  return join(appRoot(ctx), 'packages', 'core', 'dist', 'server.js')
}
export function daemonEntrypoint(ctx: PathContext): string {
  return join(appRoot(ctx), 'packages', 'daemon', 'dist', 'cli.js')
}
export function rendererIndex(ctx: PathContext): string {
  return join(appRoot(ctx), 'frontend', 'dist', 'index.html')
}
export function iconFor(ctx: PathContext, platform: NodeJS.Platform): string {
  const base = ctx.isPackaged ? join(appRoot(ctx), 'desktop', 'assets') : join(ctx.appDir, '..', 'assets')
  const file = platform === 'win32' ? 'icon.ico' : platform === 'darwin' ? 'icon.icns' : 'icon.png'
  return join(base, file)
}
export function resolvePaths(ctx: PathContext, platform: NodeJS.Platform = process.platform): ResolvedPaths {
  const index = rendererIndex(ctx)
  return {
    // En producción process.execPath es Electron; ELECTRON_RUN_AS_NODE hace que
    // ejecute estos módulos como Node en macOS, Windows y Linux.
    coreCommand: process.execPath,
    coreArgs: [coreEntrypoint(ctx)],
    daemonCommand: process.execPath,
    daemonArgs: [daemonEntrypoint(ctx)],
    preloadPath: join(ctx.appDir, 'preload.cjs'),
    renderer: !ctx.isPackaged && ctx.rendererDevServerUrl
      ? { kind: 'url', url: ctx.rendererDevServerUrl }
      : { kind: 'file', path: index },
    rendererIndex: index,
    iconPath: iconFor(ctx, platform),
  }
}
