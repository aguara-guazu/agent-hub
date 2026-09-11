/**
 * Backend `env://`: variables de entorno del propio proceso del daemon.
 *
 *     env://GITHUB_TOKEN
 *
 * La CLAVE de `secret_refs` es el nombre de la variable que va a ver el PROCESO
 * HIJO; la ruta de la referencia es el nombre de la variable que lee el DAEMON. No
 * tienen por qué coincidir:
 *
 *     secret_refs = { GITHUB_TOKEN: "env://HUB_GITHUB_TOKEN" }
 */

import { SecretBackendError, SecretNotFoundError, SecretRefError, type SecretBackend, type SecretRef } from './base.js'

/** Nombre de variable de entorno POSIX portable. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export class EnvBackend implements SecretBackend {
  readonly scheme = 'env'

  private readonly environ: Record<string, string | undefined>

  constructor(environ?: Record<string, string | undefined>) {
    // Por defecto se referencia `process.env` (no una copia) para que un cambio en
    // caliente del entorno del daemon se vea en la resolución siguiente.
    this.environ = environ ?? process.env
  }

  get(ref: SecretRef): string {
    const name = ref.path.trim()
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new SecretRefError(ref.key, ref.toString(), `'${name}' no es un nombre válido de variable de entorno`)
    }
    const value = this.environ[name]
    if (value === undefined) {
      throw new SecretNotFoundError(
        ref.key,
        ref.toString(),
        `la variable ${name} no está definida en el proceso del daemon`,
      )
    }
    if (value === '') {
      throw new SecretNotFoundError(ref.key, ref.toString(), `la variable ${name} está definida pero vacía`)
    }
    if (value.includes('\x00')) {
      throw new SecretBackendError(ref.key, ref.toString(), `el valor de ${name} tiene un byte nulo y no se puede usar`)
    }
    return value
  }
}
