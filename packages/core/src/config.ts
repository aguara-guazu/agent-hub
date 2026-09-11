/**
 * Configuración del control plane local TypeScript.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface Settings {
  /** Ruta del archivo SQLite (agenthub.db). */
  databasePath: string
  jwtSecret: string
  jwtAlgorithm: string
  accessTokenTtlSeconds: number
  corsOrigins: string[]
  syncLongPollSeconds: number
  /**
   * Modo local: el control plane corre dentro del daemon en la máquina de una sola
   * persona. No se anuncia el ingreso por contraseña porque no hay ninguna que sirva.
   */
  localMode: boolean
  /** Carpeta con la consola ya compilada; vacío deja que la sirva Vite en desarrollo. */
  consoleDist: string
  /** Secreto efímero heredado por Electron para obtener la sesión del dueño local. */
  desktopBootstrapToken: string
  /**
   * Cada cuántos segundos se vuelve a sondear un MCP server habilitado y configurado
   * cuyo último sondeo falló. `0` desactiva el reintento automático.
   */
  probeRetrySeconds: number
  /** Carpeta con las credenciales OAuth de los MCP servers: un JSON 0600 por server. */
  oauthDir: string
  /** URL de retorno del flujo OAuth, tal como la verá el navegador (loopback del core). */
  oauthRedirectUrl: string
  /** Sembrar el catálogo inicial (servers OAuth públicos) al preparar al dueño local. */
  starterCatalog: boolean
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  return !['0', 'false', 'no', ''].includes(raw.trim().toLowerCase())
}

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

const DEFAULT_DB = process.env.AGENTHUB_DATABASE_PATH?.trim()
  || join(process.cwd(), 'agenthub.db')

function defaultRedirectUrl(): string {
  const host = process.env.AGENTHUB_HUB_HOST?.trim() || '127.0.0.1'
  const port = process.env.AGENTHUB_HUB_PORT?.trim() || '8765'
  return `http://${host}:${port}/api/oauth/callback`
}

export function loadSettings(overrides: Partial<Settings> = {}): Settings {
  const databasePath = overrides.databasePath ?? DEFAULT_DB
  return {
    databasePath,
    jwtSecret: process.env.AGENTHUB_JWT_SECRET?.trim() || 'dev-only-not-a-secret-change-in-deploy',
    jwtAlgorithm: 'HS256',
    accessTokenTtlSeconds: envInt('AGENTHUB_ACCESS_TOKEN_TTL_SECONDS', 60 * 60 * 12),
    corsOrigins: envList('AGENTHUB_CORS_ORIGINS', [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]),
    syncLongPollSeconds: envInt('AGENTHUB_SYNC_LONG_POLL_SECONDS', 25),
    localMode: envBool('AGENTHUB_LOCAL_MODE', false),
    consoleDist: process.env.AGENTHUB_CONSOLE_DIST?.trim() || '',
    desktopBootstrapToken: process.env.AGENTHUB_DESKTOP_BOOTSTRAP_TOKEN?.trim() || '',
    probeRetrySeconds: envInt('AGENTHUB_PROBE_RETRY_SECONDS', 30),
    oauthDir: process.env.AGENTHUB_OAUTH_DIR?.trim() || join(dirname(databasePath), 'oauth'),
    oauthRedirectUrl: process.env.AGENTHUB_OAUTH_REDIRECT_URL?.trim() || defaultRedirectUrl(),
    starterCatalog: envBool('AGENTHUB_STARTER_CATALOG', true),
    ...overrides,
  }
}

export const DEFAULT_STATE_DIR = join(homedir(), '.agenthub')
