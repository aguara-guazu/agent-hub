export const REDACTED = '[secreto omitido]'

/** Provider token formats with a fixed prefix; each match is replaced whole. */
const TOKENS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bya29\.[0-9A-Za-z_-]{20,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
]
/** `user:password@host` inside a URL or connection string. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,200}:)([^\s@/]{1,200})(@)/gi
/** Labelled values; the value must look like a credential (digit, symbol or mixed case) so prose such as «Clave: definir alcance» is kept. */
const LABELLED = /\b(password|passwd|pwd|contraseña|contrasena|clave|passphrase|secret|client[_ -]?secret|aws_secret_access_key|secret_access_key|api[_ -]?key|access[_ -]?token|token)(?![A-Za-z0-9_])(\s*[:=]\s*["']?)([^\s"']{6,200})/gi
const credentialLike = (value: string) => /\d/.test(value) || /[^A-Za-z0-9áéíóúñÁÉÍÓÚÑ]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value))

/** Replaces credentials in free text before it is stored or sent to a model. Returns the text and the number of replacements. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0
  let result = text
  for (const pattern of TOKENS) result = result.replace(pattern, () => { count++; return REDACTED })
  result = result.replace(URL_PASSWORD, (_match, head: string, _password: string, tail: string) => { count++; return `${head}${REDACTED}${tail}` })
  result = result.replace(LABELLED, (match, label: string, separator: string, value: string) => {
    if (REDACTED.startsWith(value) || !credentialLike(value)) return match
    count++
    return `${label}${separator}${REDACTED}`
  })
  return { text: result, count }
}

/** File extensions that carry keys, keystores or environment secrets; such attachments are never downloaded. */
export const SECRET_FILE = /\.(pem|key|p12|pfx|ppk|jks|keystore|kdbx|ovpn|gpg|asc|env|tfvars|tfstate)$|^\.env(\..+)?$|^id_(rsa|dsa|ecdsa|ed25519)$/i
