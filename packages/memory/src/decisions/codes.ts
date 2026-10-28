import { createHmac, timingSafeEqual } from 'node:crypto'

/** Base32 legible: sin 0/O, 1/I/L ni U, para transcribir desde el móvil sin ambigüedad. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CODE_LENGTH = 8
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`)

/**
 * Código de aprobación derivado del secreto del verificador. Es determinista por
 * (dueño, solicitud, revisión, salt): un reenvío previo al dispatch reconstruye el mismo código sin guardarlo
 * en claro. El salt solo cambia si el código colisiona con otra solicitud activa del dueño.
 * Muestreo por rechazo sobre un flujo HMAC en modo contador: sin sesgo de módulo.
 */
export function deriveCode(key: Buffer | Uint8Array, ownerId: string, requestId: string, revision: number, salt: number): string {
  const limit = 256 - (256 % CODE_ALPHABET.length)
  let code = ''
  for (let counter = 0; code.length < CODE_LENGTH; counter++) {
    const block = createHmac('sha256', key).update(`decision-code-derive\u0000${ownerId}\u0000${requestId}\u0000${revision}\u0000${salt}\u0000${counter}`).digest()
    for (const byte of block) {
      if (byte < limit && code.length < CODE_LENGTH) code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
    }
  }
  return code
}

/** Presentación XXXX-XXXX. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** Normaliza lo que escribe la persona (mayúsculas, sin guion ni espacios). Devuelve null si no es un código válido. */
export function normalizeCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[\s-]/g, '')
  return CODE_PATTERN.test(code) ? code : null
}

/** HMAC del código con la clave privada del verificador, acotado al dueño: permite exigir unicidad entre solicitudes activas. Es lo único que se persiste del código. */
export function codeHmac(key: Buffer | Uint8Array, ownerId: string, code: string): string {
  return createHmac('sha256', key).update(`decision-code\u0000${ownerId}\u0000${code}`).digest('hex')
}

export function sameHmac(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex'), right = Buffer.from(b, 'hex')
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}
