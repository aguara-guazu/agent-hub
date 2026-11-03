import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib"
import { check } from "../contracts.js"

export const INVITATION_PREFIX = "ahinv1."
/** Upper bound for the decompressed JSON; protects against decompression bombs in pasted codes. */
export const MAX_INVITATION_BYTES = 32 * 1024 * 1024
/** Longest pasted text still decoded: base64url of the maximum payload plus slack for whitespace and wrapping. */
const MAX_CODE_CHARS = Math.ceil(MAX_INVITATION_BYTES * 4 / 3) + 1024 * 1024

const INVALID = "El código de invitación no es válido o está incompleto; cópialo completo de nuevo"
const OVERSIZED = "La invitación supera el tamaño máximo admitido"
const MULTIPLE = "El texto contiene más de un código de invitación; pega solo uno"
const INVISIBLE = /[\s\u200b-\u200d\u2060\ufeff]/g
const LEADING_NOISE = /^[\s\u200b-\u200d\u2060\ufeff"'`\u201c\u201d\u2018\u2019]+/
const CODE = new RegExp(`${INVITATION_PREFIX.replace(".", "\\.")}([A-Za-z0-9_-]+)`)

/**
 * Single-line invitation code: versioned prefix plus base64url of the Brotli-compressed compact JSON.
 * The JSON is not altered, so signatures verify against the decoded content exactly as for v1 JSON.
 */
export function encodeInvitation(packet: unknown): string {
  const json = Buffer.from(JSON.stringify(packet))
  check(json.length <= MAX_INVITATION_BYTES, OVERSIZED)
  const compressed = brotliCompressSync(json, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_SIZE_HINT]: json.length,
    },
  })
  return `${INVITATION_PREFIX}${compressed.toString("base64url")}`
}

/**
 * Normalizes pasted invitation input to the v1 invitation object, without schema validation.
 * Non-strings pass through. Strings are either a legacy JSON document (inner whitespace preserved,
 * titles contain spaces) or a code, from which every whitespace and zero-width character is removed
 * because chat clients wrap long lines.
 */
export function decodeInvitation(input: unknown): unknown {
  if (typeof input !== "string") return input
  const text = input.replace(LEADING_NOISE, "")
  if (text.startsWith("{")) {
    const end = text.lastIndexOf("}")
    return parseJson(end < 0 ? text : text.slice(0, end + 1))
  }
  check(text.length <= MAX_CODE_CHARS, OVERSIZED)
  const compact = text.replace(INVISIBLE, "")
  check(compact.split(INVITATION_PREFIX).length <= 2, MULTIPLE)
  const match = CODE.exec(compact)
  check(match, INVALID)
  const bytes = Buffer.from(match[1]!, "base64url")
  check(bytes.length > 0, INVALID)
  let json: string
  try { json = brotliDecompressSync(bytes, { maxOutputLength: MAX_INVITATION_BYTES }).toString("utf8") }
  catch { check(false, INVALID) }
  return parseJson(json)
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { check(false, INVALID) }
}
