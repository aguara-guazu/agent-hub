/**
 * Backend `keychain://`: el llavero del sistema.
 *
 *     keychain://agenthub/github-token   ->  servicio "agenthub", cuenta "github-token"
 *     keychain://github-token            ->  servicio "agenthub" (por defecto)
 *
 * En Python esto lo abstrae la librería `keyring`. En Node no hay un equivalente
 * empaquetado, así que se delega en el llavero del sistema operativo a través de un
 * lector inyectable (`KeychainReader`): por defecto habla con `security` en macOS y
 * `secret-tool` en Linux. En las pruebas se inyecta un almacén en memoria, igual que
 * `test_secrets.py` sustituye el backend de `keyring`.
 *
 * COMO SE CARGA UN SECRETO (no lo hace el daemon: escribir en el llavero es una
 * acción de la persona, no del hub):
 *
 *     security add-generic-password -s agenthub -a github-token -w      # macOS
 *     secret-tool store --label=agenthub service agenthub account X     # Linux
 */

import { spawnSync } from 'node:child_process'

import { SecretBackendError, SecretNotFoundError, type SecretBackend, type SecretRef } from './base.js'

/** Servicio que se asume cuando la referencia trae un solo segmento. */
export const DEFAULT_KEYCHAIN_SERVICE = 'agenthub'

/** Tope del texto de un error del llavero que se copia al mensaje. */
const MAX_BACKEND_DETAIL = 160

/**
 * Lee el llavero del sistema. Devuelve el valor, `null` si no existe, o lanza para
 * un fallo del almacén (bloqueado, sin permiso, sin backend disponible).
 */
export interface KeychainReader {
  read(service: string, account: string): string | null
}

/** Lector por defecto: `security` en macOS, `secret-tool` en Linux. */
export class OsKeychainReader implements KeychainReader {
  read(service: string, account: string): string | null {
    if (process.platform === 'darwin') return this.readMac(service, account)
    if (process.platform === 'linux') return this.readLinux(service, account)
    throw new Error(`no hay llavero soportado en la plataforma ${process.platform}`)
  }

  private readMac(service: string, account: string): string | null {
    const result = spawnSync(
      'security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { encoding: 'utf-8' },
    )
    if (result.error) throw result.error
    // 44 = item no encontrado; cualquier otro código distinto de 0 es un fallo real.
    if (result.status === 44) return null
    if (result.status !== 0) {
      if ((result.stderr || '').includes('could not be found')) return null
      throw new Error((result.stderr || '').trim() || `security salió con código ${result.status}`)
    }
    // `-w` imprime el valor con un salto de línea final.
    return result.stdout.replace(/\n$/, '')
  }

  private readLinux(service: string, account: string): string | null {
    const result = spawnSync(
      'secret-tool',
      ['lookup', 'service', service, 'account', account],
      { encoding: 'utf-8' },
    )
    if (result.error) throw result.error
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim()
      // secret-tool sale con 1 y sin stderr cuando no encuentra la entrada.
      if (!stderr) return null
      throw new Error(stderr)
    }
    return result.stdout.length > 0 ? result.stdout : null
  }
}

export class KeychainBackend implements SecretBackend {
  readonly scheme = 'keychain'

  private readonly defaultService: string
  private readonly reader: KeychainReader

  constructor(options: { defaultService?: string; reader?: KeychainReader } = {}) {
    this.defaultService = options.defaultService ?? DEFAULT_KEYCHAIN_SERVICE
    this.reader = options.reader ?? new OsKeychainReader()
  }

  get(ref: SecretRef): string {
    const [service, account] = this.split(ref.path)
    let value: string | null
    try {
      value = this.reader.read(service, account)
    } catch (exc) {
      // Un llavero roto no puede tumbar al daemon: se normaliza.
      throw new SecretBackendError(ref.key, ref.toString(), `el llavero falló (${short(exc)})`)
    }
    if (value === null) {
      throw new SecretNotFoundError(
        ref.key,
        ref.toString(),
        `el llavero no tiene una entrada para el servicio '${service}' y la cuenta '${account}'`,
      )
    }
    if (!value) {
      throw new SecretNotFoundError(
        ref.key,
        ref.toString(),
        `la entrada '${service}/${account}' existe en el llavero pero está vacía`,
      )
    }
    return value
  }

  /** `servicio/cuenta`, o `cuenta` sola con el servicio por defecto. */
  private split(path: string): [string, string] {
    const cleaned = path.trim().replace(/^\/+|\/+$/g, '')
    const slash = cleaned.indexOf('/')
    if (slash >= 0) {
      const service = cleaned.slice(0, slash)
      const account = cleaned.slice(slash + 1)
      return [service || this.defaultService, account]
    }
    return [this.defaultService, cleaned]
  }
}

function short(exc: unknown): string {
  const err = exc as Error
  const head = (err.message ?? '').trim().split('\n')[0]?.slice(0, MAX_BACKEND_DETAIL) ?? ''
  const name = err.name ?? 'Error'
  return head ? `${name}: ${head}` : name
}
