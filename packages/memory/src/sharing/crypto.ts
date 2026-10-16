import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, verify } from 'node:crypto'
import { generateMnemonic, mnemonicToEntropy } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { AeadId, CipherSuite, KdfId, KemId } from 'hpke-js'
import { z } from 'zod'
import { check } from '../contracts.js'

// Wire canonicalization is independent of locale, unlike the legacy local import hash.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const bytes = (s: string) => Buffer.from(s, 'base64url')
const encoded = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString('base64url')
const suite = new CipherSuite({ kem: KemId.DhkemX25519HkdfSha256, kdf: KdfId.HkdfSha256, aead: AeadId.Aes256Gcm })
const info = (purpose: string) => Buffer.from(`agenthub-sharing-v1:${purpose}`)
const derived = (seed: string, purpose: string) => Buffer.from(hkdfSync('sha256', bytes(seed), info('keys'), info(purpose), 32))
export const publicIdentitySchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), signing: z.string().max(200), encryption: z.string().max(200), name: z.string().min(1).max(120) }).strict()
export type PublicIdentity = z.infer<typeof publicIdentitySchema>
export interface Identity extends PublicIdentity { seed: string }
function signingKey(seed: string) {
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), derived(seed, 'signing')]), format: 'der', type: 'pkcs8' })
}
export async function identity(seed = encoded(randomBytes(32)), name = 'Participante'): Promise<Identity> {
  check(bytes(seed).length === 32, 'Identidad inválida')
  const signing = encoded(createPublicKey(signingKey(seed)).export({ format: 'der', type: 'spki' }))
  const pair = await suite.kem.deriveKeyPair(derived(seed, 'encryption'))
  const encryption = encoded(await suite.kem.serializePublicKey(pair.publicKey))
  return { id: digest({ signing, encryption }), signing, encryption, name, seed }
}
export function publicIdentity(who: PublicIdentity): PublicIdentity {
  return { id: who.id, signing: who.signing, encryption: who.encryption, name: who.name }
}
export function validateIdentity(who: PublicIdentity) {
  publicIdentitySchema.parse(publicIdentity(who))
  check(who.id === digest({ signing: who.signing, encryption: who.encryption }), 'Identidad alterada')
}
export async function recovery(phrase?: string) {
  const words = phrase?.trim().toLowerCase().split(/\s+/).join(' ') ?? generateMnemonic(wordlist, 256)
  let entropy: Uint8Array
  try { entropy = mnemonicToEntropy(words, wordlist) } catch { throw new Error('Frase de recuperación inválida') }
  check(entropy.length === 32, 'La recuperación requiere 24 palabras')
  return { phrase: words, identity: await identity(encoded(entropy), 'Recuperación') }
}
export const signature = (value: unknown, who: Identity) => encoded(sign(null, Buffer.from(canonical(value)), signingKey(who.seed)))
export function validSignature(value: unknown, proof: string, who: PublicIdentity): boolean {
  try { validateIdentity(who); return verify(null, Buffer.from(canonical(value)), { key: bytes(who.signing), format: 'der', type: 'spki' }, bytes(proof)) } catch { return false }
}
export const boxSchema = z.object({ nonce: z.string().max(30), ciphertext: z.string().max(180_000_000), tag: z.string().max(30) }).strict()
export type Box = z.infer<typeof boxSchema>
export function encrypt(value: unknown, key: string, purpose: string): Box {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', bytes(key), nonce)
  cipher.setAAD(info(purpose))
  const ciphertext = Buffer.concat([cipher.update(canonical(value)), cipher.final()])
  return { nonce: encoded(nonce), ciphertext: encoded(ciphertext), tag: encoded(cipher.getAuthTag()) }
}
export function decrypt(box: Box, key: string, purpose: string): unknown {
  const decipher = createDecipheriv('aes-256-gcm', bytes(key), bytes(box.nonce))
  decipher.setAAD(info(purpose)); decipher.setAuthTag(bytes(box.tag))
  return JSON.parse(Buffer.concat([decipher.update(bytes(box.ciphertext)), decipher.final()]).toString('utf8'))
}
export const envelopeSchema = z.object({ enc: z.string().max(200), ciphertext: z.string().max(200_000) }).strict()
export type Envelope = z.infer<typeof envelopeSchema>
export async function seal(value: unknown, who: PublicIdentity, purpose: string): Promise<Envelope> {
  validateIdentity(who)
  const sender = await suite.createSenderContext({ recipientPublicKey: await suite.kem.deserializePublicKey(bytes(who.encryption)), info: info(purpose) })
  return { enc: encoded(sender.enc), ciphertext: encoded(await sender.seal(Buffer.from(canonical(value)))) }
}
export async function unseal(box: Envelope, who: Identity, purpose: string): Promise<any> {
  const pair = await suite.kem.deriveKeyPair(derived(who.seed, 'encryption'))
  const receiver = await suite.createRecipientContext({ recipientKey: pair.privateKey, enc: bytes(box.enc), info: info(purpose) })
  return JSON.parse(Buffer.from(await receiver.open(bytes(box.ciphertext))).toString('utf8'))
}
export const randomKey = () => encoded(randomBytes(32))
