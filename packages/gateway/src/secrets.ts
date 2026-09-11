/**
 * Broker de secretos del gateway: referencias, backends locales y resolutor con cache.
 *
 * El catalogo guarda `secret_refs` como `nombre de destino -> referencia`, donde la
 * referencia es el NOMBRE del secreto en el almacen de la maquina, nunca su valor. El
 * valor no viaja por el control plane, no entra en el snapshot y no se guarda: el
 * gateway lo resuelve LOCALMENTE al levantar el proceso hijo o abrir la conexion HTTP.
 *
 * FORMATO
 *
 *     <backend>://<ruta>
 *     keychain://agenthub/github-token   Keychain de macOS / Secret Service (via `security`/`secret-tool`)
 *     env://GITHUB_TOKEN                 entorno del propio proceso del gateway
 *     file:///ruta/absoluta/al/secreto   archivo 0600 en disco
 *
 * REGLA DE ORO DE LOS ERRORES: un fallo dice QUE referencia fallo y POR QUE, y NUNCA
 * incluye el valor. Un valor sin esquema se rechaza a proposito: si alguien pego el
 * token en el formulario, la referencia ES el valor, asi que el error lo identifica
 * por su clave y no repite el texto.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { platform } from 'node:os'

export const NO_SCHEME_REASON =
  "la referencia no declara esquema. Se espera '<backend>://<ruta>', por ejemplo " +
  'keychain://agenthub/github-token, env://GITHUB_TOKEN o file:///ruta/absoluta/al/secreto. ' +
  'Un valor literal se rechaza a proposito: el catalogo lleva el NOMBRE del secreto, nunca el secreto'

export const DEFAULT_TTL_MS = 60_000
export const DEFAULT_KEYCHAIN_SERVICE = 'agenthub'
export const REQUIRED_FILE_MODE = 0o600
/** Cualquier bit de grupo u otros deja el secreto al alcance de otro proceso. */
export const FORBIDDEN_MODE_BITS = 0o077
export const MAX_SECRET_BYTES = 64 * 1024

const REF_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([\s\S]*)$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Token de encabezado HTTP (RFC 9110). */
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const HEADER_FORBIDDEN = /[\r\n\0]/

export type SecretErrorKind = 'ref' | 'not_found' | 'backend'

/** Fallo al resolver un secreto, ya atribuido a una entrada de `secret_refs`. */
export class SecretError extends Error {
  readonly key: string
  readonly reference: string
  readonly reason: string
  readonly kind: SecretErrorKind

  constructor(kind: SecretErrorKind, key: string, reference: string, reason: string) {
    const origen = key ? `secret_refs["${key}"]` : 'la referencia'
    const destino = reference ? ` -> ${reference}` : ''
    super(`${origen}${destino}: ${reason}`)
    this.name = 'SecretError'
    this.kind = kind
    this.key = key
    this.reference = reference
    this.reason = reason
  }
}

export interface SecretRef {
  readonly scheme: string
  readonly path: string
  readonly key: string
}

/** Identificacion segura cuando la ruta puede ser el secreto mismo. */
function redacted(ref: SecretRef): string {
  return `${ref.scheme}://...`
}

function refString(ref: SecretRef): string {
  return `${ref.scheme}://${ref.path}`
}

export function parseRef(reference: string, key = ''): SecretRef {
  const raw = reference.trim()
  if (!raw) throw new SecretError('ref', key, '', 'la referencia esta vacia')
  const match = REF_PATTERN.exec(raw)
  if (match === null) throw new SecretError('ref', key, '', NO_SCHEME_REASON)
  const scheme = match[1]!.toLowerCase()
  const path = match[2]!
  if (!path.trim()) {
    throw new SecretError('ref', key, `${scheme}://`, 'la referencia no indica ninguna ruta tras el esquema')
  }
  return { scheme, path, key }
}

/** Un almacen local de secretos, identificado por su esquema. */
export interface SecretBackend {
  readonly scheme: string
  /** Devuelve el valor de `ref`, o lanza un `SecretError`. Es sincronico y puede bloquear. */
  get(ref: SecretRef): string
}

/** Backend `env://`: variables de entorno del propio proceso del gateway. */
export class EnvBackend implements SecretBackend {
  readonly scheme = 'env'
  private readonly environ: Record<string, string | undefined>

  constructor(environ: Record<string, string | undefined> = process.env) {
    this.environ = environ
  }

  get(ref: SecretRef): string {
    const name = ref.path.trim()
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new SecretError('ref', ref.key, refString(ref), `'${name}' no es un nombre valido de variable de entorno`)
    }
    const value = this.environ[name]
    if (value === undefined) {
      throw new SecretError('not_found', ref.key, refString(ref), `la variable ${name} no esta definida en el proceso del gateway`)
    }
    if (value === '') {
      throw new SecretError('not_found', ref.key, refString(ref), `la variable ${name} esta definida pero vacia`)
    }
    if (value.includes('\0')) {
      throw new SecretError('backend', ref.key, refString(ref), `el valor de ${name} tiene un byte nulo y no se puede usar`)
    }
    return value
  }
}

/** Backend `file://`: un archivo por secreto, con permisos 0600 obligatorios. */
export class FileSecretBackend implements SecretBackend {
  readonly scheme = 'file'

  get(ref: SecretRef): string {
    const path = this.resolvePath(ref)
    let info: ReturnType<typeof statSync>
    try {
      info = statSync(path)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new SecretError('not_found', ref.key, refString(ref), `el archivo del secreto no existe: ${path}`)
      }
      throw new SecretError('backend', ref.key, refString(ref), `no se pudo consultar ${path}: ${code ?? 'error'}`)
    }
    if (!info.isFile()) {
      throw new SecretError('backend', ref.key, refString(ref), `${path} no es un archivo regular`)
    }
    const mode = info.mode & 0o777
    if (mode & FORBIDDEN_MODE_BITS) {
      throw new SecretError(
        'backend',
        ref.key,
        refString(ref),
        `${path} tiene permisos ${mode.toString(8).padStart(4, '0')} y se exige 0600: tal como esta, ` +
          `otro usuario o cualquier proceso del grupo puede leer el secreto. Se corrige con: chmod 600 ${path}`,
      )
    }
    if (info.size > MAX_SECRET_BYTES) {
      throw new SecretError('backend', ref.key, refString(ref), `${path} pesa ${info.size} bytes; un secreto no puede superar ${MAX_SECRET_BYTES}`)
    }
    let value: string
    try {
      value = readFileSync(path, 'utf-8').trim()
    } catch {
      throw new SecretError('backend', ref.key, refString(ref), `no se pudo leer ${path}`)
    }
    if (!value) {
      throw new SecretError('not_found', ref.key, refString(ref), `${path} existe pero esta vacio`)
    }
    return value
  }

  private resolvePath(ref: SecretRef): string {
    const raw = decodeURIComponent(ref.path).trim()
    if (raw.includes('\0')) {
      throw new SecretError('ref', ref.key, refString(ref), 'la ruta del secreto tiene un byte nulo')
    }
    if (!raw.startsWith('/')) {
      throw new SecretError(
        'ref',
        ref.key,
        refString(ref),
        'se espera una ruta absoluta con la forma file:///ruta/al/secreto (tres barras: el host va vacio)',
      )
    }
    return raw
  }
}

/**
 * Backend `keychain://`: el llavero del sistema, via las herramientas nativas.
 *
 *     keychain://agenthub/github-token   ->  servicio "agenthub", cuenta "github-token"
 *     keychain://github-token            ->  servicio "agenthub" (por defecto)
 *
 * En macOS usa `security find-generic-password`; en Linux `secret-tool lookup`. Se
 * inyecta un `lookup` en las pruebas para no tocar el llavero real, que abre un
 * dialogo de autorizacion sin interaccion.
 */
export type KeychainLookup = (service: string, account: string) => string | null

function nativeLookup(service: string, account: string): string | null {
  if (platform() === 'darwin') {
    const res = spawnSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf-8',
    })
    if (res.status === 0) return res.stdout.replace(/\n$/, '')
    return null
  }
  const res = spawnSync('secret-tool', ['lookup', 'service', service, 'account', account], { encoding: 'utf-8' })
  if (res.status === 0 && res.stdout) return res.stdout.replace(/\n$/, '')
  return null
}

export class KeychainBackend implements SecretBackend {
  readonly scheme = 'keychain'
  private readonly defaultService: string
  private readonly lookup: KeychainLookup

  constructor(options: { defaultService?: string; lookup?: KeychainLookup } = {}) {
    this.defaultService = options.defaultService ?? DEFAULT_KEYCHAIN_SERVICE
    this.lookup = options.lookup ?? nativeLookup
  }

  get(ref: SecretRef): string {
    const [service, account] = this.split(ref.path)
    let value: string | null
    try {
      value = this.lookup(service, account)
    } catch (err) {
      throw new SecretError('backend', ref.key, refString(ref), `el llavero fallo de forma inesperada (${(err as Error).name})`)
    }
    if (value === null) {
      throw new SecretError('not_found', ref.key, refString(ref), `el llavero no tiene una entrada para el servicio '${service}' y la cuenta '${account}'`)
    }
    if (value === '') {
      throw new SecretError('not_found', ref.key, refString(ref), `la entrada '${service}/${account}' existe en el llavero pero esta vacia`)
    }
    return value
  }

  private split(path: string): [string, string] {
    const clean = path.trim().replace(/^\/+|\/+$/g, '')
    const slash = clean.indexOf('/')
    if (slash >= 0) {
      const service = clean.slice(0, slash) || this.defaultService
      return [service, clean.slice(slash + 1)]
    }
    return [this.defaultService, clean]
  }
}

export function defaultBackends(): Record<string, SecretBackend> {
  const backends: SecretBackend[] = [new KeychainBackend(), new EnvBackend(), new FileSecretBackend()]
  return Object.fromEntries(backends.map((backend) => [backend.scheme, backend]))
}

interface Cached {
  value: string
  expiresAt: number
}

/** Traduce referencias de `secret_refs` a valores contra el almacen local, con cache TTL. */
export class SecretResolver {
  private readonly backends: Record<string, SecretBackend>
  private readonly ttlMs: number
  private readonly clock: () => number
  private readonly cache = new Map<string, Cached>()

  constructor(
    backends: Record<string, SecretBackend> = defaultBackends(),
    options: { ttlMs?: number; clock?: () => number } = {},
  ) {
    this.backends = { ...backends }
    this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS)
    this.clock = options.clock ?? (() => Date.now())
  }

  get schemes(): string[] {
    return Object.keys(this.backends).sort()
  }

  resolve(reference: string, key = ''): string {
    const ref = parseRef(reference, key)
    const backend = this.backends[ref.scheme]
    if (backend === undefined) {
      throw new SecretError(
        'ref',
        key,
        redacted(ref),
        `no hay backend para el esquema '${ref.scheme}'. Este gateway resuelve: ${this.schemes.join(', ')}`,
      )
    }
    const cacheKey = `${ref.scheme}://${ref.path}`
    const now = this.clock()
    const hit = this.cache.get(cacheKey)
    if (hit !== undefined && hit.expiresAt > now) return hit.value

    const value = backend.get(ref)
    if (!value) {
      throw new SecretError('backend', ref.key, refString(ref), `el backend '${ref.scheme}' devolvio un valor vacio`)
    }
    this.cache.set(cacheKey, { value, expiresAt: this.clock() + this.ttlMs })
    return value
  }

  invalidate(reference?: string): void {
    if (reference === undefined) {
      this.cache.clear()
      return
    }
    try {
      const ref = parseRef(reference)
      this.cache.delete(`${ref.scheme}://${ref.path}`)
    } catch {
      // Una referencia invalida no esta cacheada: nada que borrar.
    }
  }

  /** `{VARIABLE: referencia}` -> `{VARIABLE: valor}` para el entorno de un hijo. */
  resolveEnv(mapping: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [name, reference] of Object.entries(mapping)) {
      if (!ENV_NAME_PATTERN.test(name)) {
        throw new SecretError('ref', name, '', `'${name}' no es un nombre valido de variable de entorno de destino`)
      }
      out[name] = this.resolve(reference, name)
    }
    return out
  }

  /** `{Encabezado: referencia}` -> `{Encabezado: valor}` para el upstream HTTP. */
  resolveHeaders(mapping: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [name, reference] of Object.entries(mapping)) {
      if (!HEADER_NAME_PATTERN.test(name)) {
        throw new SecretError('ref', name, '', `'${name}' no es un nombre valido de encabezado HTTP de destino`)
      }
      const value = this.resolve(reference, name)
      if (HEADER_FORBIDDEN.test(value)) {
        throw new SecretError(
          'backend',
          name,
          '',
          `el valor resuelto para el encabezado ${name} tiene saltos de linea o bytes nulos y no puede viajar en un pedido HTTP`,
        )
      }
      out[name] = value
    }
    return out
  }
}

let sharedResolver: SecretResolver | null = null

/** Resolutor compartido por el proceso, para que la cache sirva de verdad. */
export function defaultResolver(): SecretResolver {
  if (sharedResolver === null) sharedResolver = new SecretResolver()
  return sharedResolver
}
