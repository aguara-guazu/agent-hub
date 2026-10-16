import { z } from 'zod'
import { boxSchema, envelopeSchema, publicIdentitySchema } from './crypto.js'
import { fieldsSchema } from '../contracts.js'

export const roleSchema = z.enum(['owner', 'maintainer', 'reader'])
export const memberSchema = z.object({ identity: publicIdentitySchema, role: roleSchema, invite: z.boolean(), expires_at: z.string().datetime().nullable(), revoked: z.boolean() }).strict()
export type Member = z.infer<typeof memberSchema>
export const genesisSchema = z.object({ id: z.string().uuid(), title: z.string().min(1).max(300), description: z.string().max(8000), recovery: publicIdentitySchema,
  owner: publicIdentitySchema, created_at: z.string().datetime(), signature: z.string().max(200) }).strict()
export type Genesis = z.infer<typeof genesisSchema>
export const policySchema = z.object({ project: z.string().uuid(), revision: z.number().int().nonnegative(), parent: z.string().nullable(),
  issuer: z.string(), epoch: z.string().uuid(), created_at: z.string().datetime(), members: z.array(memberSchema).min(1).max(100),
  // Every epoch key is wrapped for each current member and recovery, allowing a new member to read project history.
  keys: z.record(z.string(), envelopeSchema),
  // Every policy includes recovery envelopes exclusively for its active owners.
  recovery_keys: z.record(z.string(), envelopeSchema),
  history: z.array(z.string()).max(100_000), supersedes: z.array(z.string()).max(1000), signature: z.string().max(200) }).strict()
export type Policy = z.infer<typeof policySchema>
export const invitationSchema = z.object({ format: z.literal('agenthub-invitation-v1'), genesis: genesisSchema, policies: z.array(policySchema).min(1).max(10_000),
  proofs: z.array(policySchema).max(10_000).default([]) }).strict()
export const eventSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), project: z.string().uuid(), policy: z.string(), author: z.string(),
  created_at: z.string().datetime(), nonce: z.string().uuid(), body: boxSchema, signature: z.string().max(200) }).strict()
export type SharedEvent = z.infer<typeof eventSchema>
export const messageSchema = z.object({ kind: z.literal('message'), text: z.string().min(1).max(8000), agent: z.string().max(200).nullable(),
  agent_label: z.string().max(200), to_member: z.string().nullable(), to_agent: z.string().max(200).nullable(),
  expires_at: z.string().datetime(), reply_to: z.string().nullable(), private_body: envelopeSchema.nullable(), sender_body: envelopeSchema.nullable() }).strict()
export const publicationSchema = z.object({ kind: z.literal('publication'), key: z.string().min(1).max(1000), previous: z.array(z.string()).max(100),
  title: z.string().min(1).max(300), source_kind: z.enum(['meeting','document','message','note','issue','event']),
  fragments: z.array(z.object({ text: z.string().min(1).max(100_000), speaker: z.string().max(200).optional(), offset_ms: z.number().int().nonnegative().optional() }).strict()).max(20_000),
  url: z.string().max(2000).nullable(), occurred_at: z.string().nullable(),
  attachment: z.object({ format: z.literal('agenthub-file-v1'), filename: z.string().max(300), mime_type: z.string().max(200), size: z.number().int().nonnegative().max(25_000_000), sha256: z.string().regex(/^[a-f0-9]{64}$/), data_base64: z.string().max(34_000_000) }).strict().nullable(),
  facts: z.array(z.object({ text: z.string().max(20_000), category: z.string().max(100), evidence: z.array(z.number().int().nonnegative()).max(100),
    model: z.string().max(200).optional() }).strict()).max(5000),
  agent: z.string().max(200).nullable(), processing_key: z.string().max(200).nullable() }).strict()
export const objectSchema = z.object({ kind: z.literal('object'), key: z.string().min(1).max(1000), previous: z.array(z.string()).max(100), agent: z.string().max(200).nullable(),
  value: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('collection'), title: z.string().min(1).max(500), description: z.string().max(8000), fields: fieldsSchema,
      rows: z.array(z.object({ key: z.string().max(200), values: z.record(z.string(), z.json()) }).strict()).max(10_000) }).strict(),
    z.object({ kind: z.literal('task'), title: z.string().min(1).max(500), description: z.string().max(8000), status: z.enum(['todo','in_progress','blocked','done','dropped']),
      external_url: z.string().max(2000).nullable() }).strict(),
  ]) }).strict()
export const payloadSchema = z.discriminatedUnion('kind', [messageSchema, publicationSchema,
  objectSchema,
  z.object({ kind: z.literal('observation'), publication: z.string().length(64), agent: z.string().max(200).nullable() }).strict(),
  z.object({ kind: z.literal('receipt'), message: z.string(), agent: z.string().nullable(), state: z.enum(['read','handled']) }).strict(),
  z.object({ kind: z.literal('claim'), key: z.string().max(200), expires_at: z.string().datetime(), agent: z.string().nullable() }).strict()])
export type Payload = z.infer<typeof payloadSchema>
export type Publication = z.infer<typeof publicationSchema>
export type SharedObject = z.infer<typeof objectSchema>
export const withoutSignature = <T extends { signature: string }>(value: T) => { const { signature: _signature, ...unsigned } = value; return unsigned }
export const active = (member: Member | undefined, now = Date.now()) => !!member && !member.revoked && (member.role === 'owner' || !!member.expires_at && Date.parse(member.expires_at) > now)
