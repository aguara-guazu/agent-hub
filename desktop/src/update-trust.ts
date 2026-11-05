/**
 * Confianza del actualizador: conjunto de claves Ed25519, manifiesto firmado sobre sus bytes exactos y
 * estados de autenticidad. Sin Electron ni red; la lectura de archivos recibe rutas.
 *
 * - Sin claves y sin `requireSignature`: `integrity_only` (SHA-256 y tamaño fijados por el manifiesto o por
 *   GitHub; no se autentica al publicador).
 * - Con claves, o con `requireSignature` ya fijado: la firma es obligatoria, sin alternativa.
 * - Rotación (`next_trust`) y revocación sólo llegan dentro de un manifiesto firmado por una clave ya
 *   confiable, y se adoptan recién cuando la versión que las trae queda sana.
 *
 * Formatos (contrato con el empaquetado): `desktop/dist/update-trust.json` = `{schema:1, keys:[{id,
 * ed25519_spki_b64}], revoked:[id]}` con claves DER SPKI en base64; manifiesto `AgentHub-update.json` en JSON
 * canónico; firma `AgentHub-update.json.sig` = `{key_id, sig_b64}` sobre los bytes exactos del manifiesto.
 */
import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto"
import { readFileSync } from "node:fs"
import { t } from "./i18n.js"

export interface TrustKey { id: string; ed25519_spki_b64: string }
export interface TrustSet { keys: TrustKey[]; revoked: string[] }
export type TrustState = "integrity_only" | "publisher_authenticated"

export interface ManifestAsset { name: string; size: number; sha256: string }
export interface SignedManifest {
  schema: 1
  version: string
  assets: ManifestAsset[]
  next_trust?: TrustSet
}

export interface VerifiedManifest {
  manifest: SignedManifest
  trust: TrustState
  /** Id de la clave que firmó, sólo con `publisher_authenticated`. */
  keyId?: string
}

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** SemVer canónico MAJOR.MINOR.PATCH: sin ceros a la izquierda, prerelease ni metadatos de build. */
export function isStrictSemver(value: string): boolean {
  return SEMVER.test(value) && value.split(".").every((part) => Number.isSafeInteger(Number(part)))
}

/** JSON con claves ordenadas recursivamente y sin espacios; los arreglos conservan su orden. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function ed25519Key(spkiBase64: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" })
    return key.asymmetricKeyType === "ed25519" ? key : null
  } catch {
    return null
  }
}

/**
 * Valida un conjunto de claves. Rechaza ids repetidos, claves que no sean Ed25519 DER SPKI y campos
 * desconocidos. Con `requireActive`, además exige al menos una clave no revocada: un conjunto siguiente sin
 * ninguna dejaría el canal bloqueado.
 */
export function parseTrustSet(value: unknown, options: { requireActive?: boolean; schema?: boolean } = {}): TrustSet | null {
  const raw = value as Record<string, unknown> | null
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.keys) || !Array.isArray(raw.revoked)) return null
  const allowed = options.schema ? ["schema", "keys", "revoked"] : ["keys", "revoked"]
  if (Object.keys(raw).some((name) => !allowed.includes(name))) return null
  if (options.schema && raw.schema !== 1) return null
  const ids = new Set<string>()
  const keys: TrustKey[] = []
  for (const entry of raw.keys) {
    const key = entry as { id?: unknown; ed25519_spki_b64?: unknown } | null
    if (!key || typeof key.id !== "string" || !KEY_ID.test(key.id) || ids.has(key.id) || typeof key.ed25519_spki_b64 !== "string" || !ed25519Key(key.ed25519_spki_b64)) return null
    if (Object.keys(key).some((name) => name !== "id" && name !== "ed25519_spki_b64")) return null
    ids.add(key.id)
    keys.push({ id: key.id, ed25519_spki_b64: key.ed25519_spki_b64 })
  }
  const revoked = raw.revoked as unknown[]
  if (!revoked.every((id): id is string => typeof id === "string" && KEY_ID.test(id))) return null
  if (options.requireActive && !keys.some((key) => !revoked.includes(key.id))) return null
  return { keys, revoked: [...new Set(revoked)] }
}

export type BundledTrust = { kind: "absent" } | { kind: "ok"; trust: TrustSet } | { kind: "invalid" }

/**
 * Trust store embebido en el build (`desktop/dist/update-trust.json`). Un archivo que existe pero no es
 * válido NO equivale a «sin claves»: degradaría la verificación, así que se distingue de `absent`.
 */
export function loadBundledTrust(path: string): BundledTrust {
  let source: string
  try {
    source = readFileSync(path, "utf8")
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "invalid" }
  }
  try {
    const trust = parseTrustSet(JSON.parse(source), { schema: true })
    return trust ? { kind: "ok", trust } : { kind: "invalid" }
  } catch {
    return { kind: "invalid" }
  }
}

/** Claves vigentes: el conjunto adoptado tras una rotación (si hay) reemplaza al embebido; las revocaciones se acumulan. */
export function effectiveTrust(bundled: TrustSet | null, adopted: TrustSet | null): TrustSet {
  const base = adopted ?? bundled ?? { keys: [], revoked: [] }
  const revoked = [...new Set([...(bundled?.revoked ?? []), ...(adopted?.revoked ?? []), ...base.revoked])]
  // Las claves revocadas siguen en la lista: su presencia mantiene exigida la firma y `verifyManifest` las descarta al verificar.
  return { keys: base.keys, revoked }
}

function parseManifest(raw: Buffer): SignedManifest {
  const invalid = () => new Error(t("updater.manifestInvalid"))
  let parsed: unknown
  try { parsed = JSON.parse(raw.toString("utf8")) } catch { throw invalid() }
  const manifest = parsed as Record<string, unknown> | null
  if (!manifest || typeof manifest !== "object" || manifest.schema !== 1 || typeof manifest.version !== "string" || !isStrictSemver(manifest.version) || !Array.isArray(manifest.assets)) throw invalid()
  if (Object.keys(manifest).some((name) => !["schema", "version", "assets", "next_trust"].includes(name))) throw invalid()
  const names = new Set<string>()
  const assets = manifest.assets.map((entry): ManifestAsset => {
    const item = entry as Record<string, unknown> | null
    if (!item || typeof item.name !== "string" || !item.name || names.has(item.name) || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)
      || typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size <= 0 || Object.keys(item).some((name) => !["name", "size", "sha256"].includes(name))) throw invalid()
    names.add(item.name)
    return { name: item.name, size: item.size, sha256: item.sha256 }
  })
  const nextTrust = manifest.next_trust === undefined ? undefined : parseTrustSet(manifest.next_trust, { requireActive: true })
  if (nextTrust === null) throw invalid()
  const result: SignedManifest = { schema: 1, version: manifest.version, assets, ...(nextTrust ? { next_trust: nextTrust } : {}) }
  // La firma cubre los bytes exactos: el manifiesto tiene que estar en su forma canónica, sin variantes equivalentes.
  if (Buffer.compare(raw, Buffer.from(canonicalJson({ ...result, assets: [...assets].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) }), "utf8")) !== 0) throw invalid()
  return result
}

/**
 * Valida el manifiesto. Con claves vigentes o `requireSignature`, la firma (ed25519 sobre los bytes exactos)
 * es obligatoria y debe venir de una clave vigente no revocada; sin ellas, el manifiesto sólo aporta SHA-256 y
 * tamaño (`integrity_only`) y su `next_trust` se descarta: una rotación sin firma no puede plantar claves.
 */
export function verifyManifest(raw: Buffer, signatureRaw: Buffer | null, trust: TrustSet, requireSignature: boolean): VerifiedManifest {
  const manifest = parseManifest(raw)
  if (!requireSignature && trust.keys.length === 0) {
    const { next_trust: _discarded, ...unsigned } = manifest
    return { manifest: unsigned, trust: "integrity_only" }
  }
  let keyId = ""
  let signature = Buffer.alloc(0)
  try {
    const parsed = JSON.parse(signatureRaw?.toString("utf8") ?? "") as Record<string, unknown>
    if (typeof parsed.key_id === "string" && typeof parsed.sig_b64 === "string" && Object.keys(parsed).length === 2) { keyId = parsed.key_id; signature = Buffer.from(parsed.sig_b64, "base64") }
  } catch { /* firma ausente o malformada */ }
  const entry = trust.keys.find((candidate) => candidate.id === keyId && !trust.revoked.includes(candidate.id))
  const key = entry ? ed25519Key(entry.ed25519_spki_b64) : null
  let valid = false
  try { valid = Boolean(key && signature.length === 64 && verifySignature(null, raw, key, signature)) } catch { valid = false }
  if (!valid) throw new Error(t("updater.signatureInvalid"))
  return { manifest, trust: "publisher_authenticated", keyId }
}
