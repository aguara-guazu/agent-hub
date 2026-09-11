import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Options, OfficialArch, OfficialPlatform } from '@electron/packager'

/**
 * Configuración de empaquetado con `@electron/packager` para las tres
 * plataformas de escritorio.
 *
 * El builder de opciones es puro (verificable en prueba). El bloque de
 * ejecución al final sólo corre cuando se invoca este archivo como script:
 * `node dist/packager.js [darwin|win32|linux|all]`.
 */

export const SUPPORTED_PLATFORMS = ['darwin', 'win32', 'linux'] as const
export type BuildPlatform = (typeof SUPPORTED_PLATFORMS)[number]

export const APP_NAME = 'Agent Hub'
/** Identificador del bundle macOS; distinto del `com.electron.*` genérico de Electron. */
export const APP_BUNDLE_ID = 'io.craftech.agenthub'

/** Arch por defecto para cada plataforma. */
const DEFAULT_ARCHS: Record<BuildPlatform, OfficialArch> = {
  darwin: 'arm64',
  win32: 'x64',
  linux: 'x64',
}

export interface PackagerConfigInput {
  /** Plataforma objetivo. */
  platform: BuildPlatform
  /** Raíz del proyecto que se empaqueta (contiene el package.json de la app). */
  projectRoot: string
  /** Directorio de salida. */
  out: string
  /** Versión de la app. */
  appVersion: string
  /** Arch opcional (por defecto según plataforma). */
  arch?: OfficialArch
  /** Icono base sin extensión; packager elige por plataforma. */
  iconBase?: string
}

export function packagerOptions(input: PackagerConfigInput): Options {
  const arch = input.arch ?? DEFAULT_ARCHS[input.platform]
  const options: Options = {
    dir: input.projectRoot,
    out: input.out,
    platform: input.platform as OfficialPlatform,
    arch,
    name: APP_NAME,
    appBundleId: APP_BUNDLE_ID,
    appVersion: input.appVersion,
    overwrite: true,
    asar: false,
    prune: true,
    // Firma y notarización usan credenciales del distribuidor y se configuran
    // fuera de este builder reproducible.
    ignore: [
      /^\/(docs|scripts|testdata|tests)($|\/)/,
      /^\/(desktop|frontend|packages\/[^/]+)\/(?:src|test|scripts)($|\/)/,
      /^\/frontend\/node_modules($|\/)/,
      /^\/desktop\/out($|\/)/,
      /^\/(?:README\.md|Makefile|eslint\.config\.js|tsconfig(?:\.base)?\.json|\.gitignore)$/,
      /^\/(?:desktop|frontend|packages\/[^/]+)\/(?:README\.md|tsconfig\.json|vitest\.config\.ts|vite\.config\.ts|index\.html)$/,
      /(^|\/)[^/]+\.test\.(?:js|d\.ts)(?:\.map)?$/,
      /(^|\/)[^/]+\.js\.map$/,
      /(^|\/)[^/]+\.d\.ts(?:\.map)?$/,
      /(^|\/)[^/]+\.(?:db|db-wal|db-shm|sqlite|sqlite3)$/,
      /(^|\/)(?:\.git|\.kiro)($|\/)/,
      /(^|\/)coverage($|\/)/,
      /(^|\/).*\.tsbuildinfo$/,
    ],
  }
  if (input.iconBase !== undefined) {
    options.icon = input.iconBase
  }
  if (input.platform === 'darwin') {
    // App de barra de menú: sin ícono en el Dock ni en Cmd+Tab. Aplica a todo proceso
    // del bundle, incluido un gateway headless lanzado con una configuración vieja.
    options.extendInfo = { LSUIElement: true }
  }
  return options
}

export function targetsFromArgv(
  argv: readonly string[],
  host: NodeJS.Platform = process.platform,
): BuildPlatform[] {
  const arg = argv[0]
  if (!arg) {
    if ((SUPPORTED_PLATFORMS as readonly string[]).includes(host)) return [host as BuildPlatform]
    throw new Error(`plataforma host no soportada: ${host}`)
  }
  if (arg === 'all') return [...SUPPORTED_PLATFORMS]
  if ((SUPPORTED_PLATFORMS as readonly string[]).includes(arg)) return [arg as BuildPlatform]
  throw new Error(`plataforma no soportada: ${arg} (usar ${SUPPORTED_PLATFORMS.join('|')} o all)`)
}

async function run(): Promise<void> {
  const { packager } = await import('@electron/packager')
  const here = dirname(fileURLToPath(import.meta.url))
  // dist/ está dentro de desktop/; el package.json de la app vive en la raíz
  // del monorepo (dos niveles arriba de desktop/dist).
  const projectRoot = join(here, '..', '..')
  const out = join(here, '..', 'out')
  const appVersion = process.env.npm_package_version ?? '0.2.0'
  const iconBase = join(here, '..', 'assets', 'icon')
  const hasIcon = ['.icns', '.ico', '.png'].some((extension) => existsSync(iconBase + extension))

  const targets = targetsFromArgv(process.argv.slice(2))
  for (const platform of targets) {
    const opts = packagerOptions({
      platform,
      projectRoot,
      out,
      appVersion,
      ...(hasIcon ? { iconBase } : {}),
    })
    const paths = await packager(opts)
    console.log(`[${platform}] empaquetado en:\n${paths.join('\n')}`)
  }
}

// Ejecuta sólo si es el módulo de entrada, nunca al importarlo desde una prueba.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
}
