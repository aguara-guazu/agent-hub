#!/usr/bin/env node
/**
 * Writes the update manifest for a tagged release, next to the artifacts it lists:
 *   AgentHub-update.json      canonical JSON {schema:1, version, assets:[{name, sha256, size}], next_trust?}
 *   AgentHub-update.json.sig  {key_id, sig_b64}: Ed25519 over the exact manifest bytes, only when a signing key is set
 * Usage: node scripts/update-manifest.mjs <artifacts dir> <tag vX.Y.Z> <out dir>
 * Environment (CI secrets/variables, never files in the repo):
 *   AGENTHUB_UPDATE_SIGNING_KEY      PKCS#8 PEM of the Ed25519 private key; absent ⇒ unsigned manifest
 *   AGENTHUB_UPDATE_SIGNING_KEY_ID   id of that key in the embedded trust store (required with the key)
 *   AGENTHUB_UPDATE_NEXT_TRUST       optional rotation {keys:[{id, ed25519_spki_b64}], revoked:[id]}; only with a key
 * The canonical form must match desktop/src/update-trust.ts canonicalJson and parseManifest byte for byte.
 */
import { Buffer } from "node:buffer"
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto"
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/
const MANIFEST = "AgentHub-update.json"

function fail(message) { console.error(`update-manifest: ${message}`); process.exit(1) }

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return files(path)
    if (entry.isSymbolicLink()) fail(`symlink no permitido: ${path}`)
    return entry.isFile() ? [path] : []
  })
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    createReadStream(path).on("data", chunk => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")))
  })
}

/** Same acceptance as parseTrustSet({requireActive: true}); revocations deduplicated in order as the updater does. */
function nextTrust(raw) {
  const trust = JSON.parse(raw)
  if (!trust || typeof trust !== "object" || !Array.isArray(trust.keys) || !Array.isArray(trust.revoked) || Object.keys(trust).some(k => k !== "keys" && k !== "revoked")) fail("AGENTHUB_UPDATE_NEXT_TRUST: se espera {keys, revoked}")
  const ids = new Set()
  const keys = trust.keys.map(entry => {
    if (!entry || Object.keys(entry).some(k => k !== "id" && k !== "ed25519_spki_b64") || typeof entry.id !== "string" || !KEY_ID.test(entry.id) || ids.has(entry.id)) fail("AGENTHUB_UPDATE_NEXT_TRUST: clave inválida o repetida")
    let key
    try { key = createPublicKey({ key: Buffer.from(entry.ed25519_spki_b64, "base64"), format: "der", type: "spki" }) } catch { key = null }
    if (key?.asymmetricKeyType !== "ed25519") fail(`AGENTHUB_UPDATE_NEXT_TRUST: ${entry.id} no es Ed25519 DER SPKI`)
    ids.add(entry.id)
    return { id: entry.id, ed25519_spki_b64: entry.ed25519_spki_b64 }
  })
  if (!trust.revoked.every(id => typeof id === "string" && KEY_ID.test(id))) fail("AGENTHUB_UPDATE_NEXT_TRUST: revocación inválida")
  if (!keys.some(key => !trust.revoked.includes(key.id))) fail("AGENTHUB_UPDATE_NEXT_TRUST: ninguna clave vigente")
  return { keys, revoked: [...new Set(trust.revoked)] }
}

const [artifactsDir, tag, outDir] = process.argv.slice(2)
if (!artifactsDir || !tag || !outDir) fail("uso: update-manifest.mjs <artifacts> <tag> <out>")
const version = tag.replace(/^v/, "")
if (!/^v/.test(tag) || !SEMVER.test(version)) fail(`tag no canónico: ${tag}`)
const packaged = JSON.parse(readFileSync("desktop/package.json", "utf8")).version
if (packaged !== version) fail(`la versión del tag (${version}) no coincide con desktop/package.json (${packaged})`)

const paths = files(artifactsDir).filter(path => basename(path) !== MANIFEST && basename(path) !== `${MANIFEST}.sig`)
const names = new Set()
const assets = []
for (const path of paths) {
  const name = basename(path)
  // softprops/action-gh-release uploads by basename: two artifacts with one name would make the manifest ambiguous.
  if (names.has(name)) fail(`artefacto repetido: ${name}`)
  names.add(name)
  const size = statSync(path).size
  if (!Number.isSafeInteger(size) || size <= 0) fail(`tamaño inválido: ${name}`)
  assets.push({ name, sha256: await sha256(path), size })
}
if (!assets.length) fail("no hay artefactos")
assets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

const privatePem = process.env.AGENTHUB_UPDATE_SIGNING_KEY
const rotation = process.env.AGENTHUB_UPDATE_NEXT_TRUST
if (rotation && !privatePem) fail("AGENTHUB_UPDATE_NEXT_TRUST requiere firma: una rotación sin firma se descarta en el cliente")
const manifest = { schema: 1, version, assets, ...(rotation ? { next_trust: nextTrust(rotation) } : {}) }
const bytes = Buffer.from(canonicalJson(manifest), "utf8")
writeFileSync(join(outDir, MANIFEST), bytes)
console.log(`update-manifest: ${assets.length} artefacto(s) para ${version}`)

if (privatePem) {
  const keyId = process.env.AGENTHUB_UPDATE_SIGNING_KEY_ID
  if (!keyId || !KEY_ID.test(keyId)) fail("AGENTHUB_UPDATE_SIGNING_KEY_ID ausente o inválido")
  const key = createPrivateKey(privatePem)
  if (key.asymmetricKeyType !== "ed25519") fail("la clave de firma no es Ed25519")
  const signature = sign(null, bytes, key)
  writeFileSync(join(outDir, `${MANIFEST}.sig`), canonicalJson({ key_id: keyId, sig_b64: signature.toString("base64") }))
  console.log(`update-manifest: firmado con ${keyId}`)
} else {
  console.log("update-manifest: sin AGENTHUB_UPDATE_SIGNING_KEY, manifiesto sin firma (integridad sin autenticación del publicador)")
}
