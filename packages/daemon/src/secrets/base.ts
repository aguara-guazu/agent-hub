/**
 * Interfaz del broker de secretos: referencias, errores y contrato de backend.
 *
 * El catálogo del control plane guarda `secret_refs`: un mapa de
 * `nombre del destino -> referencia`, donde la referencia es el NOMBRE del secreto
 * en el almacén de la máquina, nunca su valor. El valor no viaja por el control
 * plane, no entra en el snapshot y no se guarda en la base: el daemon lo resuelve
 * LOCALMENTE al levantar el proceso hijo o abrir la conexión con el upstream.
 *
 * FORMATO DE REFERENCIA
 *
 *     <backend>://<ruta>
 *
 *     keychain://agenthub/github-token
 *     env://GITHUB_TOKEN
 *     file:///Users/x/.config/agenthub/secrets/github.txt
 *
 * Un valor SIN esquema es un error explícito, no un valor literal.
 *
 * REGLA DE ORO DE LOS MENSAJES DE ERROR: un fallo dice QUÉ referencia falló y POR
 * QUÉ, y NUNCA incluye el valor ni una parte de él.
 */

/** `<esquema>://<ruta>`; esquema en minúsculas, la ruta tal cual (incluidos `/`). */
const REF_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([\s\S]*)$/

export const NO_SCHEME_REASON =
  "la referencia no declara esquema. Se espera '<backend>://<ruta>', por ejemplo " +
  'keychain://agenthub/github-token, env://GITHUB_TOKEN o ' +
  'file:///ruta/absoluta/al/secreto. Un valor literal se rechaza a propósito: el ' +
  'catálogo lleva el NOMBRE del secreto, nunca el secreto'

/**
 * Referencia ya parseada. Nunca contiene el valor del secreto.
 *
 * `key` es la clave de `secret_refs` (variable de entorno o encabezado de destino)
 * y viaja con la referencia solo para que los mensajes de error puedan nombrarla.
 */
export class SecretRef {
  constructor(
    readonly scheme: string,
    readonly path: string,
    readonly key: string = '',
  ) {}

  toString(): string {
    return `${this.scheme}://${this.path}`
  }

  /** Identificación segura cuando la ruta puede ser el secreto mismo. */
  redacted(): string {
    return `${this.scheme}://...`
  }

  withKey(key: string): SecretRef {
    return new SecretRef(this.scheme, this.path, key)
  }
}

function compose(key: string, reference: string, reason: string): string {
  const origen = key ? `secret_refs["${key}"]` : 'la referencia'
  const destino = reference ? ` -> ${reference}` : ''
  return `${origen}${destino}: ${reason}`
}

/** Fallo al resolver un secreto, ya atribuido a una entrada de `secret_refs`. */
export class SecretError extends Error {
  readonly key: string
  readonly reference: string
  readonly reason: string

  constructor(key: string, reference: string, reason: string) {
    super(compose(key, reference, reason))
    this.name = 'SecretError'
    this.key = key
    this.reference = reference
    this.reason = reason
  }
}

/** La referencia (o el nombre de destino) es inválida: no hay nada que buscar. */
export class SecretRefError extends SecretError {
  constructor(key: string, reference: string, reason: string) {
    super(key, reference, reason)
    this.name = 'SecretRefError'
  }
}

/** El almacén contestó, pero no tiene ese secreto o lo tiene vacío. */
export class SecretNotFoundError extends SecretError {
  constructor(key: string, reference: string, reason: string) {
    super(key, reference, reason)
    this.name = 'SecretNotFoundError'
  }
}

/** El almacén no pudo contestar: llavero bloqueado, permisos, E/S. */
export class SecretBackendError extends SecretError {
  constructor(key: string, reference: string, reason: string) {
    super(key, reference, reason)
    this.name = 'SecretBackendError'
  }
}

/** Un almacén local de secretos, identificado por su esquema. */
export interface SecretBackend {
  readonly scheme: string
  /** Devuelve el valor de `ref`, o lanza un `SecretError`. Sincrónico o async. */
  get(ref: SecretRef): string | Promise<string>
}

/**
 * Parsea `<backend>://<ruta>`. Lanza `SecretRefError` si falta el esquema o la ruta.
 * El mensaje no repite nunca `reference`: cuando falta el esquema, ese texto es
 * justamente el valor que alguien pegó por error.
 */
export function parseRef(reference: string, key = ''): SecretRef {
  const raw = reference.trim()
  if (!raw) throw new SecretRefError(key, '', 'la referencia está vacía')
  const match = REF_PATTERN.exec(raw)
  if (match === null) throw new SecretRefError(key, '', NO_SCHEME_REASON)
  const scheme = match[1]!.toLowerCase()
  const path = match[2]!
  if (!path.trim()) {
    throw new SecretRefError(key, `${scheme}://`, 'la referencia no indica ninguna ruta tras el esquema')
  }
  return new SecretRef(scheme, path, key)
}
