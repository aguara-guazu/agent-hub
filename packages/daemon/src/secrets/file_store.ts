/**
 * Backend `file://`: un archivo por secreto, con permisos 0600 obligatorios.
 *
 *     file:///Users/x/.config/agenthub/secrets/github.txt
 *
 * El contenido entero del archivo es el secreto; se le saca el espacio en blanco de
 * los bordes porque un `echo` deja un salto de línea final que rompe cualquier token.
 *
 * POR QUÉ SE EXIGE 0600 Y NO SE AVISA NOMÁS: un archivo 0644 en el HOME lo lee
 * cualquier proceso de la máquina. Negarse convierte el problema en algo que se
 * arregla una vez con `chmod 600`.
 *
 * Se consulta el modo del ARCHIVO DESTINO (`statSync` sigue el symlink): lo que
 * importa es quién puede leer el contenido, no los permisos del enlace.
 *
 * Windows no tiene bits POSIX: `stat` informa 0666 (0444 si es de sólo lectura) sin
 * importar las ACL, que son las que protegen el archivo. Ahí no se exige el modo.
 */

import { readFileSync, statSync } from 'node:fs'
import { platform } from 'node:os'
import { secretFilePath } from '@agenthub/gateway/platform'

import { SecretBackendError, SecretNotFoundError, SecretRefError, type SecretBackend, type SecretRef } from './base.js'

export const REQUIRED_MODE = 0o600
/** Cualquier bit para grupo u otros deja el secreto al alcance de otro proceso. */
export const FORBIDDEN_MODE_BITS = 0o077

/** Tope de lectura. Un token no pesa más que esto. */
const MAX_SECRET_BYTES = 64 * 1024

export class FileSecretBackend implements SecretBackend {
  readonly scheme = 'file'

  get(ref: SecretRef): string {
    const path = this.pathOf(ref)
    let info
    try {
      info = statSync(path)
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SecretNotFoundError(ref.key, ref.toString(), `el archivo del secreto no existe: ${path}`)
      }
      throw new SecretBackendError(
        ref.key,
        ref.toString(),
        `no se pudo consultar ${path}: ${(exc as Error).name}`,
      )
    }

    if (!info.isFile()) {
      throw new SecretBackendError(ref.key, ref.toString(), `${path} no es un archivo regular`)
    }

    const mode = info.mode & 0o777
    if (platform() !== 'win32' && (mode & FORBIDDEN_MODE_BITS) !== 0) {
      throw new SecretBackendError(
        ref.key,
        ref.toString(),
        `${path} tiene permisos ${mode.toString(8).padStart(4, '0')} y se exige ` +
          `${REQUIRED_MODE.toString(8).padStart(4, '0')}: tal como está, otro usuario o cualquier ` +
          `proceso del grupo puede leer el secreto. Se corrige con: chmod 600 ${path}`,
      )
    }
    if (info.size > MAX_SECRET_BYTES) {
      throw new SecretBackendError(
        ref.key,
        ref.toString(),
        `${path} pesa ${info.size} bytes; un secreto no puede superar ${MAX_SECRET_BYTES}`,
      )
    }

    let raw: Buffer
    try {
      raw = readFileSync(path)
    } catch (exc) {
      throw new SecretBackendError(ref.key, ref.toString(), `no se pudo leer ${path}: ${(exc as Error).name}`)
    }

    let value: string
    try {
      // Rechaza UTF-8 inválido para no filtrar el fragmento crudo en el error.
      value = new TextDecoder('utf-8', { fatal: true }).decode(raw).trim()
    } catch {
      throw new SecretBackendError(ref.key, ref.toString(), `${path} no es texto UTF-8 válido`)
    }
    if (!value) {
      throw new SecretNotFoundError(ref.key, ref.toString(), `${path} existe pero está vacío`)
    }
    return value
  }

  /**
   * `file:///ruta/absoluta` a ruta nativa con `fileURLToPath`: en Windows `file:///C:/x` es
   * `C:\x`, no `/C:/x`. Los `%XX` se decodifican una sola vez; `?` y `#` se escapan antes
   * para que no corten la ruta como query o fragmento. Se rechaza la forma con host
   * (`file://servidor/ruta`, una ruta UNC en Windows) y la ruta relativa: el broker resuelve
   * contra ESTA máquina, y una ruta relativa dependería del directorio de trabajo del daemon.
   */
  private pathOf(ref: SecretRef): string {
    const raw = ref.path.trim()
    if (raw.includes('\x00') || /%00/i.test(raw)) {
      throw new SecretRefError(ref.key, ref.toString(), 'la ruta del secreto tiene un byte nulo')
    }
    const absolute = () => new SecretRefError(
      ref.key,
      ref.toString(),
      'se espera una ruta absoluta con la forma file:///ruta/al/secreto (tres barras: el host va vacío)',
    )
    if (!raw.startsWith('/')) throw absolute()
    try {
      return secretFilePath(raw)
    } catch {
      throw absolute()
    }
  }
}
