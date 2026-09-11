/**
 * Resolutor: elige el backend por esquema, cachea con TTL corto y arma env/headers.
 *
 * DECISIONES
 *
 * - Cache con TTL corto (60 s). Sin cache, cada `tools/call` que reconecta pagaría
 *   una consulta al Keychain. Con TTL largo, una credencial rotada seguiría en uso.
 *   Un minuto es el punto donde una ráfaga cuesta una sola consulta y una rotación
 *   se toma como máximo un minuto en verse. La cache es por (esquema, ruta).
 * - La cache guarda valores en memoria del daemon. No se escriben a disco, no salen
 *   en `status` y no viajan al control plane.
 * - Los fallos no se cachean.
 */

import {
  SecretBackendError,
  SecretError,
  SecretRefError,
  parseRef,
  type SecretBackend,
  type SecretRef,
} from './base.js'
import { ENV_NAME_PATTERN, EnvBackend } from './env.js'
import { FileSecretBackend } from './file_store.js'
import { KeychainBackend } from './keychain.js'

export {
  NO_SCHEME_REASON,
  SecretError,
  SecretRef,
  SecretRefError,
  SecretNotFoundError,
  SecretBackendError,
  parseRef,
  type SecretBackend,
} from './base.js'
export { ENV_NAME_PATTERN, EnvBackend } from './env.js'
export { FORBIDDEN_MODE_BITS, REQUIRED_MODE, FileSecretBackend } from './file_store.js'
export {
  DEFAULT_KEYCHAIN_SERVICE,
  KeychainBackend,
  OsKeychainReader,
  type KeychainReader,
} from './keychain.js'

export const DEFAULT_TTL_SECONDS = 60

/** Token de encabezado HTTP (RFC 9110). */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
/** Caracteres que no pueden viajar en el valor de un encabezado HTTP. */
const HEADER_FORBIDDEN = /[\r\n\x00]/

/** Los backends que el daemon trae de fábrica, indexados por esquema. */
export function defaultBackends(): Record<string, SecretBackend> {
  const available: SecretBackend[] = [new KeychainBackend(), new EnvBackend(), new FileSecretBackend()]
  const out: Record<string, SecretBackend> = {}
  for (const backend of available) out[backend.scheme] = backend
  return out
}

interface Cached {
  value: string
  expiresAt: number
}

/** Traduce referencias de `secret_refs` a valores, contra el almacén local. */
export class SecretResolver {
  private readonly backends: Record<string, SecretBackend>
  private readonly ttlMs: number
  private readonly clock: () => number
  private readonly cache = new Map<string, Cached>()

  constructor(
    backends?: Record<string, SecretBackend>,
    options: { ttlSeconds?: number; clock?: () => number } = {},
  ) {
    this.backends = { ...(backends ?? defaultBackends()) }
    this.ttlMs = Math.max(0, options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000
    this.clock = options.clock ?? (() => Date.now())
  }

  get schemes(): string[] {
    return Object.keys(this.backends).sort()
  }

  /** Devuelve el valor de una referencia. Lanza `SecretError` si no se puede. */
  async resolve(reference: string, key = ''): Promise<string> {
    const ref = parseRef(reference, key)
    const backend = this.backends[ref.scheme]
    if (backend === undefined) {
      // La ruta se oculta: un secreto con forma de URL parsea como referencia de un
      // esquema desconocido, y repetirla sería filtrarlo.
      throw new SecretRefError(
        key,
        ref.redacted(),
        `no hay backend para el esquema '${ref.scheme}'. Este daemon resuelve: ${this.schemes.join(', ')}`,
      )
    }

    const cacheKey = `${ref.scheme}://${ref.path}`
    const now = this.clock()
    const hit = this.cache.get(cacheKey)
    if (hit !== undefined && hit.expiresAt > now) return hit.value

    const value = await this.fetch(backend, ref)
    this.cache.set(cacheKey, { value, expiresAt: this.clock() + this.ttlMs })
    return value
  }

  private async fetch(backend: SecretBackend, ref: SecretRef): Promise<string> {
    let value: string
    try {
      value = await backend.get(ref)
    } catch (exc) {
      if (exc instanceof SecretError) throw exc
      // Un backend de terceros no puede tumbar al daemon: se normaliza.
      throw new SecretBackendError(ref.key, ref.toString(), `el backend '${ref.scheme}' falló: ${(exc as Error).name}`)
    }
    if (typeof value !== 'string' || !value) {
      throw new SecretBackendError(ref.key, ref.toString(), `el backend '${ref.scheme}' devolvió un valor vacío`)
    }
    return value
  }

  /** Borra la cache entera, o solo la entrada de una referencia. */
  invalidate(reference?: string): void {
    if (reference === undefined) {
      this.cache.clear()
      return
    }
    try {
      const ref = parseRef(reference)
      this.cache.delete(`${ref.scheme}://${ref.path}`)
    } catch (exc) {
      if (!(exc instanceof SecretRefError)) throw exc
    }
  }

  /**
   * `{VARIABLE: referencia}` -> `{VARIABLE: valor}` para el entorno de un hijo.
   * Valida el nombre de la variable: una clave con `=` o byte nulo no se puede pasar.
   */
  async resolveEnv(mapping: Record<string, string>): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const [name, reference] of Object.entries(mapping)) {
      if (!ENV_NAME_PATTERN.test(name)) {
        throw new SecretRefError(name, '', `'${name}' no es un nombre válido de variable de entorno de destino`)
      }
      out[name] = await this.resolve(reference, name)
    }
    return out
  }

  /**
   * `{Encabezado: referencia}` -> `{Encabezado: valor}` para el upstream HTTP.
   * Valida el nombre y el VALOR: un salto de línea permitiría inyectar encabezados.
   */
  async resolveHeaders(mapping: Record<string, string>): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const [name, reference] of Object.entries(mapping)) {
      if (!HEADER_NAME_PATTERN.test(name)) {
        throw new SecretRefError(name, '', `'${name}' no es un nombre válido de encabezado HTTP de destino`)
      }
      const value = await this.resolve(reference, name)
      if (HEADER_FORBIDDEN.test(value)) {
        throw new SecretBackendError(
          name,
          '',
          `el valor resuelto para el encabezado ${name} tiene saltos de línea o bytes nulos y no puede ` +
            'viajar en un pedido HTTP',
        )
      }
      out[name] = value
    }
    return out
  }
}

let defaultInstance: SecretResolver | null = null

/** Resolutor compartido por todo el proceso, para que la cache sirva de verdad. */
export function defaultResolver(): SecretResolver {
  if (defaultInstance === null) defaultInstance = new SecretResolver()
  return defaultInstance
}

/** Lee `secret_refs` de una spec, tolerando que el campo no exista. */
export function secretRefsOf(spec: unknown): Record<string, string> {
  const raw = (spec as { secret_refs?: unknown })?.secret_refs
  if (raw === null || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[String(key)] = String(value)
  }
  return out
}
