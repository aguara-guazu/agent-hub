import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { CHAT_CHANNEL_DESCRIPTION_MAX, type InterHubEnvelope, type InterHubEventKind, type InterHubSignedRoster, type InterhubChatPayload } from "@agenthub/shared"
import { check, parse } from "../contracts.js"
import { Vault } from "../config.js"
import type { MemoryStore } from "../store.js"
import { SharedProjects } from "../sharing/projects.js"
import { canonical, digest, publicIdentity, publicIdentitySchema, signature, validSignature, validateIdentity, type Identity, type PublicIdentity } from "../sharing/crypto.js"
import { INTERHUB_REMOTE_CLI_KIND, interhubChatPayloadSchema, interhubRemoteSessionId } from "./chat.js"

/** Upper bound of one envelope on the wire; the largest legitimate payload is a 16 000 character message. */
export const MAX_ENVELOPE_BYTES = 96_000
const FUTURE_SKEW_MS = 300_000
const code = () => randomBytes(32).toString("base64url")
const codeHash = (channelId: string, value: string) => digest({ channel_id: channelId, code: value })
/** DHT rendezvous of a code. Announced on the DHT, so it is derived in its own domain and reveals nothing about the proof key. */
export const rendezvousTopic = (value: string) => digest({ protocol: "agenthub-interhub-join-v1", code: value })
const proofKey = (value: string) => digest({ protocol: "agenthub-interhub-proof-v1", code: value })
export const channelTopic = (channelId: string) => digest({ protocol: "agenthub-interhub-v1", channel: channelId })

/** Binds a join proof to both authenticated hello identities and both Noise keys of one connection, so it cannot be relayed. */
export interface JoinTranscript { request: string; nonce: string; joiner: string; creator: string; joiner_noise: string; creator_noise: string }
export function joinProof(key: string, purpose: "join" | "accept", transcript: JoinTranscript, roster?: InterHubSignedRoster) {
  return createHmac("sha256", Buffer.from(key, "hex")).update(canonical({ purpose, transcript, roster: roster ? digest(roster) : null })).digest("hex")
}
export const sameProof = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
export const codeKey = (value: string) => proofKey(value)

const uuid = z.string().uuid()
const hubId = z.string().regex(/^[a-f0-9]{64}$/)
const iso = z.string().datetime()
const membershipSchema = z.object({ action: z.enum(["joined", "removed"]), hub_id: hubId, leader_id: z.string().max(200), leader_label: z.string().max(200),
  peer_public_key: z.string().max(200), peer_identity: publicIdentitySchema }).strict()
const codeSchema = z.object({ action: z.enum(["revoked", "regenerated"]), generation: z.number().int().nonnegative() }).strict()
const envelopeSchema = z.object({
  version: z.literal(1), id: uuid, channel_id: uuid, origin_hub_id: hubId, origin_peer_public_key: z.string().min(1).max(200),
  origin_agent_id: z.string().max(200).nullable(), kind: z.enum(["membership", "message", "thread", "presence", "escalation", "code"]),
  occurred_at: iso, payload: z.unknown(), signature: z.string().min(1).max(200),
}).strict()
export const rosterSchema = z.object({
  version: z.literal(1),
  channel: z.object({ id: uuid, name: z.string().min(1).max(200), description: z.string().max(CHAT_CHANNEL_DESCRIPTION_MAX).nullable(), creator_hub_id: hubId, created_at: iso }).strict(),
  members: z.array(z.object({ hub_id: hubId, peer_identity: publicIdentitySchema, leader_session_id: z.string().max(200).nullable(), leader_label: z.string().max(200), joined_at: iso }).strict()).min(1).max(64),
  issued_at: iso, signature: z.string().min(1).max(200),
}).strict()

export const chatKind = (payload: InterhubChatPayload): InterHubEventKind =>
  payload.type === "thread" ? "thread" : payload.type === "message" ? "message" : payload.type === "presence" ? "presence" : "escalation"
const identityOf = (value: unknown): PublicIdentity => typeof value === "string" ? JSON.parse(value) : value as PublicIdentity
const label = (value: string) => value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 200) || "Líder"

export type VerifiedEnvelope =
  | { kind: "chat"; envelope: InterHubEnvelope<InterhubChatPayload>; originName: string }
  | { kind: "membership"; envelope: InterHubEnvelope<z.infer<typeof membershipSchema>> }
  | { kind: "code"; envelope: InterHubEnvelope<z.infer<typeof codeSchema>> }

/** P2P-owned durable state of inter-hub channels: codes, membership, the signed event log and its verification. */
export class InterhubNetwork {
  private readonly vault: Vault
  constructor(readonly store: MemoryStore) { this.vault = new Vault(store.directory) }

  private secretKey(channelId: string) { return `interhub-channel-code-${channelId}` }
  async localIdentity(): Promise<Identity> { return new SharedProjects(this.store).identity() }
  private async assertCreator(channelId: string, sessionId: string) {
    const row = (await this.store.db.query(`SELECT i.creator_hub_id FROM interhub_channels i
      JOIN chat_channels c ON c.id=i.channel_id JOIN chat_sessions s ON s.id=$2
      WHERE i.channel_id=$1 AND c.kind='inter-hub' AND c.leader_id=s.id AND s.closed_at IS NULL AND s.removed_at IS NULL`, [channelId, sessionId]))[0]
    const local = await this.localIdentity()
    check(row?.creator_hub_id === local.id, "Sólo el líder vigente del hub creador puede gestionar el código", 403)
    return row
  }

  async createChannel(caller: { id: string }, input: { name: string; projectId?: string | null }) {
    const channelId = randomUUID(), value = code(), identity = await this.localIdentity()
    await this.store.db.transaction(async sql => {
      await sql.query("INSERT INTO chat_channels(id,project_id,scope_key,path,name,kind,leader_id,activated_at) VALUES($1,$2,$3,'',$4,'inter-hub',$5,now())", [channelId, input.projectId ?? null, `interhub:${channelId}`, input.name, caller.id])
      await sql.query("INSERT INTO interhub_channels(channel_id,creator_hub_id,creator_session_id,code_hash,code_generation) VALUES($1,$2,$3,$4,1)", [channelId, identity.id, caller.id, codeHash(channelId, value)])
      await sql.query("INSERT INTO interhub_members(channel_id,hub_id,peer_identity,leader_session_id,leader_label) SELECT $1,$2,$3,$4,COALESCE(nickname,label) FROM chat_sessions WHERE id=$4", [channelId, identity.id, JSON.stringify(publicIdentity(identity)), caller.id])
    })
    this.vault.save(this.secretKey(channelId), { code: value })
    return { channel_id: channelId, code: value }
  }

  /** A code of a channel this hub created: joining it from here would only swap the local leader, so it is refused before any network lookup. */
  async assertNotOwnCode(value: string) {
    for (const channel of await this.activeCodes()) if (channel.code === value) check(false, "Tu hub ya es parte de este canal entre hubs", 409)
  }

  /** Channels created here whose code is active and whose vault copy still matches the stored hash. */
  async activeCodes() {
    const local = await this.localIdentity()
    const rows = await this.store.db.query(`SELECT i.channel_id,i.code_hash FROM interhub_channels i JOIN chat_channels c ON c.id=i.channel_id
      WHERE i.creator_hub_id=$1 AND i.code_revoked_at IS NULL AND c.kind='inter-hub' AND c.closed_at IS NULL AND c.deleted_at IS NULL`, [local.id])
    const result: { channel_id: string; code: string }[] = []
    for (const row of rows) {
      const value = this.vault.read<{ code: string }>(this.secretKey(String(row.channel_id)))?.code
      if (value && codeHash(String(row.channel_id), value) === row.code_hash) result.push({ channel_id: String(row.channel_id), code: value })
    }
    return result
  }

  async rotateCode(caller: { id: string }, channelId: string, action: "regenerate" | "revoke") {
    await this.assertCreator(channelId, caller.id)
    if (action === "revoke") {
      await this.store.db.query("UPDATE interhub_channels SET code_revoked_at=now(),updated_at=now() WHERE channel_id=$1", [channelId])
      this.vault.delete(this.secretKey(channelId))
      return { revoked: true, generation: await this.generation(channelId) }
    }
    const value = code()
    // The vault is written first: a crash in between leaves a code that does not match the hash, which activeCodes ignores.
    this.vault.save(this.secretKey(channelId), { code: value })
    await this.store.db.query("UPDATE interhub_channels SET code_hash=$2,code_generation=code_generation+1,code_revoked_at=NULL,updated_at=now() WHERE channel_id=$1", [channelId, codeHash(channelId, value)])
    return { code: value, generation: await this.generation(channelId) }
  }
  private async generation(channelId: string) {
    return Number((await this.store.db.query("SELECT code_generation FROM interhub_channels WHERE channel_id=$1", [channelId]))[0]?.code_generation ?? 0)
  }

  async creatorCode(channelId: string) {
    const row = (await this.store.db.query("SELECT code_revoked_at FROM interhub_channels WHERE channel_id=$1", [channelId]))[0]
    if (!row || row.code_revoked_at) return null
    return this.vault.read<{ code: string }>(this.secretKey(channelId))?.code ?? null
  }

  async listHubs(channelId: string) {
    const local = (await this.localIdentity()).id, since = new Date(Date.now() - 30_000).toISOString()
    return this.store.db.query(`SELECT hub_id AS id,leader_label AS name,hub_id=$2 AS is_local,
      CASE WHEN hub_id=$2 OR last_seen_at>$3 THEN 'online' ELSE 'offline' END AS connection
      FROM interhub_members WHERE channel_id=$1 AND removed_at IS NULL ORDER BY hub_id=$2 DESC,joined_at`, [channelId, local, since])
  }

  /** Inter-hub channels where this hub is an active member and the local copy is usable. */
  async memberChannels() {
    const local = (await this.localIdentity()).id
    return (await this.store.db.query(`SELECT i.channel_id,i.creator_hub_id FROM interhub_channels i JOIN chat_channels c ON c.id=i.channel_id
      JOIN interhub_members m ON m.channel_id=i.channel_id AND m.hub_id=$1 AND m.removed_at IS NULL
      WHERE c.kind='inter-hub' AND c.deleted_at IS NULL`, [local])).map(row => ({ channel_id: String(row.channel_id), creator_hub_id: String(row.creator_hub_id) }))
  }
  async activeMembers(channelId: string) {
    return (await this.store.db.query("SELECT hub_id FROM interhub_members WHERE channel_id=$1 AND removed_at IS NULL", [channelId])).map(row => String(row.hub_id))
  }
  async isMember(channelId: string, hub: string) {
    return Boolean((await this.store.db.query(`SELECT 1 FROM interhub_members m JOIN chat_channels c ON c.id=m.channel_id
      WHERE m.channel_id=$1 AND m.hub_id=$2 AND m.removed_at IS NULL AND c.kind='inter-hub' AND c.deleted_at IS NULL`, [channelId, hub]))[0])
  }
  async touch(hub: string) {
    await this.store.db.query("UPDATE interhub_members SET last_seen_at=now() WHERE hub_id=$1 AND removed_at IS NULL", [hub])
  }
  async lastSeq(channelId: string) {
    return Number((await this.store.db.query("SELECT COALESCE(max(seq),0) AS seq FROM interhub_events WHERE channel_id=$1", [channelId]))[0]?.seq ?? 0)
  }

  async signEnvelope(input: Omit<InterHubEnvelope, "id" | "origin_hub_id" | "origin_peer_public_key" | "signature">) {
    const identity = await this.localIdentity()
    const unsigned = { ...input, id: randomUUID(), origin_hub_id: identity.id, origin_peer_public_key: identity.signing }
    return { ...unsigned, signature: signature(unsigned, identity) } as InterHubEnvelope
  }

  /** Signs and appends a local event to the log every member pulls from. The caller has already applied it locally. */
  async append(channelId: string, kind: InterHubEventKind, payload: unknown, originAgentId: string | null = null) {
    const envelope = await this.signEnvelope({ version: 1, channel_id: channelId, origin_agent_id: originAgentId, kind, occurred_at: new Date().toISOString(), payload })
    check(Buffer.byteLength(canonical(envelope)) <= MAX_ENVELOPE_BYTES, "Evento inter-hub demasiado grande", 413)
    await this.store.db.query("INSERT INTO interhub_events(id,channel_id,origin_hub_id,envelope,received_from,applied_at) VALUES($1,$2,$3,$4,'local',now())",
      [envelope.id, channelId, envelope.origin_hub_id, JSON.stringify(envelope)])
    return envelope
  }

  /** Signed channel state; only the creator hub issues it, to a hub that just proved the code. */
  async signedRoster(channelId: string): Promise<InterHubSignedRoster> {
    const identity = await this.localIdentity()
    const channel = (await this.store.db.query(`SELECT c.id,c.name,c.description,i.creator_hub_id,i.created_at FROM chat_channels c JOIN interhub_channels i ON i.channel_id=c.id WHERE c.id=$1`, [channelId]))[0]
    check(channel && channel.creator_hub_id === identity.id, "Sólo el hub creador emite el estado del canal", 403)
    const members = await this.store.db.query("SELECT hub_id,peer_identity,leader_session_id,leader_label,joined_at FROM interhub_members WHERE channel_id=$1 AND removed_at IS NULL ORDER BY joined_at,hub_id", [channelId])
    const unsigned = { version: 1 as const, channel: { id: String(channel.id), name: String(channel.name), description: channel.description ?? null, creator_hub_id: identity.id, created_at: new Date(String(channel.created_at)).toISOString() },
      members: members.map(m => ({ hub_id: String(m.hub_id), peer_identity: publicIdentity(identityOf(m.peer_identity)), leader_session_id: m.leader_session_id ?? null, leader_label: String(m.leader_label), joined_at: new Date(String(m.joined_at)).toISOString() })),
      issued_at: new Date().toISOString() }
    return { ...unsigned, signature: signature(unsigned, identity) }
  }

  /**
   * Creator side of a join. `proves` checks the joiner's proof against one candidate key; the joiner identity is the
   * authenticated P2P peer. Returns null for any failure so a wrong, revoked or unknown code is indistinguishable.
   */
  async admit(joiner: PublicIdentity, leader: { id: string; label: string }, proves: (key: string) => boolean) {
    const local = await this.localIdentity()
    if (joiner.id === local.id) return null
    const match = (await this.activeCodes()).find(candidate => proves(codeKey(candidate.code)))
    if (!match) return null
    const key = codeKey(match.code)
    return this.store.db.transaction(async sql => {
      // Re-read inside the transaction: a revoke or regenerate committed meanwhile wins.
      const current = (await sql.query("SELECT code_hash,code_revoked_at FROM interhub_channels WHERE channel_id=$1", [match.channel_id]))[0]
      if (!current || current.code_revoked_at || current.code_hash !== codeHash(match.channel_id, match.code)) return null
      const existing = (await sql.query("SELECT leader_session_id,leader_label,removed_at FROM interhub_members WHERE channel_id=$1 AND hub_id=$2", [match.channel_id, joiner.id]))[0]
      // An active member keeps its leader: holding the code again must not swap it.
      const keep = existing && !existing.removed_at
      const leaderId = keep ? String(existing.leader_session_id ?? leader.id) : leader.id, leaderLabel = keep ? String(existing.leader_label) : label(leader.label)
      if (!keep) await sql.query(`INSERT INTO interhub_members(channel_id,hub_id,peer_identity,leader_session_id,leader_label) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(channel_id,hub_id) DO UPDATE SET peer_identity=excluded.peer_identity,leader_session_id=excluded.leader_session_id,leader_label=excluded.leader_label,removed_at=NULL,joined_at=now(),last_seen_at=now()`,
      [match.channel_id, joiner.id, JSON.stringify(publicIdentity(joiner)), leaderId, leaderLabel])
      else await sql.query("UPDATE interhub_members SET peer_identity=$3,last_seen_at=now() WHERE channel_id=$1 AND hub_id=$2", [match.channel_id, joiner.id, JSON.stringify(publicIdentity(joiner))])
      if (!keep) await this.append(match.channel_id, "membership", { action: "joined", hub_id: joiner.id, leader_id: leaderId, leader_label: leaderLabel,
        peer_public_key: joiner.signing, peer_identity: publicIdentity(joiner) })
      return { channel_id: match.channel_id, key, roster: await this.signedRoster(match.channel_id) }
    })
  }

  /**
   * Joiner side: verifies the creator-signed roster and creates the local copy of the channel with the caller as this
   * hub's leader. `projectId` was already validated against this hub's projects; a rejoin keeps the current project
   * when none is given.
   */
  async completeJoin(caller: { id: string; label: string }, creator: PublicIdentity, raw: unknown, projectId: string | null = null) {
    const roster = parse(rosterSchema, raw), local = await this.localIdentity()
    const { signature: proof, ...unsigned } = roster
    check(roster.channel.creator_hub_id === creator.id && validSignature(unsigned, proof, creator), "Respuesta del hub creador inválida", 403)
    check(Date.parse(roster.issued_at) <= Date.now() + FUTURE_SKEW_MS, "Respuesta del hub creador inválida", 403)
    for (const member of roster.members) {
      validateIdentity(member.peer_identity)
      check(member.hub_id === member.peer_identity.id, "Respuesta del hub creador inválida", 403)
    }
    check(roster.members.some(m => m.hub_id === local.id) && roster.members.some(m => m.hub_id === creator.id), "Respuesta del hub creador inválida", 403)
    const channelId = roster.channel.id, creatorEntry = roster.members.find(m => m.hub_id === creator.id)!
    const existing = (await this.store.db.query("SELECT kind,deleted_at FROM chat_channels WHERE id=$1", [channelId]))[0]
    if (existing) {
      check(existing.kind === "inter-hub", "El identificador del canal ya existe en este hub", 409)
      check(!await this.isMember(channelId, local.id), "Tu hub ya es parte de este canal entre hubs", 409)
    }
    // Same placeholder the chat model derives for this author, so the creator's leader has a single local stand-in.
    const placeholder = interhubRemoteSessionId(channelId, creator.id, creatorEntry.leader_session_id ?? "creator")
    await this.store.db.transaction(async sql => {
      if (!existing) await sql.query("INSERT INTO chat_channels(id,project_id,scope_key,path,name,kind,leader_id,activated_at,description) VALUES($1,$6,$2,'',$3,'inter-hub',$4,now(),$5)",
        [channelId, `interhub:${channelId}`, roster.channel.name, caller.id, roster.channel.description, projectId])
      else await sql.query("UPDATE chat_channels SET leader_id=$2,project_id=COALESCE($3,project_id),deleted_at=NULL,closed_at=NULL,updated_at=now() WHERE id=$1", [channelId, caller.id, projectId])
      // interhub_channels references a local session: the creator's leader is represented by a closed remote placeholder.
      await sql.query(`INSERT OR IGNORE INTO chat_sessions(id,agent_id,key_hash,label,cli_kind,channel_id,state,event_at,closed_at)
        VALUES($1,$1,$1,$2,$3,$4,'offline',now(),now())`, [placeholder, creatorEntry.leader_label || "Líder", INTERHUB_REMOTE_CLI_KIND, channelId])
      await sql.query(`INSERT INTO interhub_channels(channel_id,creator_hub_id,creator_session_id,code_hash,code_generation) VALUES($1,$2,$3,'',0)
        ON CONFLICT(channel_id) DO UPDATE SET creator_hub_id=excluded.creator_hub_id,updated_at=now()`, [channelId, creator.id, placeholder])
      for (const member of roster.members) {
        const own = member.hub_id === local.id
        await sql.query(`INSERT INTO interhub_members(channel_id,hub_id,peer_identity,leader_session_id,leader_label,joined_at) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(channel_id,hub_id) DO UPDATE SET peer_identity=excluded.peer_identity,leader_session_id=excluded.leader_session_id,leader_label=excluded.leader_label,removed_at=NULL`,
        [channelId, member.hub_id, JSON.stringify(own ? publicIdentity(local) : member.peer_identity), own ? caller.id : member.leader_session_id, own ? label(caller.label) : member.leader_label, member.joined_at])
      }
    })
    const recorded = roster.members.find(m => m.hub_id === local.id)!
    const project = (await this.store.db.query("SELECT project_id FROM chat_channels WHERE id=$1", [channelId]))[0]?.project_id ?? null
    return { channel_id: channelId, hub_id: local.id, project_id: project === null ? null : String(project), leader_changed: recorded.leader_session_id !== caller.id }
  }

  /**
   * Verifies a replicated envelope and appends it to the local log. `via` is the authenticated peer that delivered it;
   * the origin's identity comes from this hub's membership table, never from the envelope.
   */
  async receiveEnvelope(raw: unknown, via: PublicIdentity): Promise<{ stored: boolean; seq?: number; verified?: VerifiedEnvelope }> {
    const known = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : null
    if (known && (await this.store.db.query("SELECT 1 FROM interhub_events WHERE id=$1", [known]))[0]) return { stored: false }
    const verified = await this.verify(raw, via), event = verified.envelope, local = await this.localIdentity()
    const inserted = await this.store.db.query("INSERT INTO interhub_events(id,channel_id,origin_hub_id,envelope,received_from,applied_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING seq",
      [event.id, event.channel_id, event.origin_hub_id, JSON.stringify(event), via.id, event.origin_hub_id === local.id ? new Date().toISOString() : null])
    if (!inserted.length) return { stored: false }
    return { stored: true, seq: Number(inserted[0]!.seq), ...(event.origin_hub_id === local.id ? {} : { verified }) }
  }

  /** Signature, origin membership, clock and per-kind authority of an envelope; `via`, when given, must be a member too. */
  async verify(raw: unknown, via?: PublicIdentity): Promise<VerifiedEnvelope> {
    check(Buffer.byteLength(canonical(raw)) <= MAX_ENVELOPE_BYTES, "Evento inter-hub demasiado grande", 413)
    const event = parse(envelopeSchema, raw)
    const local = await this.localIdentity()
    check(await this.isMember(event.channel_id, local.id), "Este hub no participa del canal", 403)
    if (via) check(await this.isMember(event.channel_id, via.id), "El peer no pertenece al canal", 403)
    const origin = (await this.store.db.query("SELECT peer_identity,removed_at FROM interhub_members WHERE channel_id=$1 AND hub_id=$2", [event.channel_id, event.origin_hub_id]))[0]
    check(origin, "El origen del evento no pertenece al canal", 403)
    const identity = identityOf(origin.peer_identity)
    check(Date.parse(event.occurred_at) <= Date.now() + FUTURE_SKEW_MS, "Fecha de evento inválida", 403)
    check(!origin.removed_at || Date.parse(event.occurred_at) <= Date.parse(String(origin.removed_at)), "El origen ya no pertenece al canal", 403)
    const { signature: proof, ...unsigned } = event
    check(event.origin_peer_public_key === identity.signing && validSignature(unsigned, proof, identity), "Firma de evento inter-hub inválida", 403)
    return this.authorize(event)
  }

  /** Per-kind authority of an already authenticated origin. */
  private async authorize(event: z.infer<typeof envelopeSchema>): Promise<VerifiedEnvelope> {
    const channel = (await this.store.db.query("SELECT creator_hub_id FROM interhub_channels WHERE channel_id=$1", [event.channel_id]))[0]!
    const fromCreator = event.origin_hub_id === channel.creator_hub_id
    if (event.kind === "membership") {
      const payload = parse(membershipSchema, event.payload)
      validateIdentity(payload.peer_identity)
      check(payload.peer_identity.id === payload.hub_id && payload.peer_identity.signing === payload.peer_public_key, "Membresía inter-hub inválida", 403)
      const self = payload.hub_id === event.origin_hub_id && await this.isMember(event.channel_id, payload.hub_id)
      check(fromCreator || self, "Sólo el hub creador admite miembros", 403)
      return { kind: "membership", envelope: { ...event, payload } as InterHubEnvelope<typeof payload> }
    }
    if (event.kind === "code") {
      check(fromCreator, "Sólo el hub creador gestiona el código", 403)
      const payload = parse(codeSchema, event.payload)
      return { kind: "code", envelope: { ...event, payload } as InterHubEnvelope<typeof payload> }
    }
    const payload = parse(interhubChatPayloadSchema, event.payload) as InterhubChatPayload
    check(chatKind(payload) === event.kind, "Tipo de evento inter-hub inválido", 403)
    if (payload.type === "escalation") {
      check(payload.escalation.from_hub_id === event.origin_hub_id, "La escalada debe provenir del hub que escala", 403)
      check(await this.isMember(event.channel_id, payload.escalation.to_hub_id), "La escalada apunta a un hub ajeno al canal", 403)
    }
    const origin = (await this.store.db.query("SELECT peer_identity FROM interhub_members WHERE channel_id=$1 AND hub_id=$2", [event.channel_id, event.origin_hub_id]))[0]!
    return { kind: "chat", envelope: { ...event, payload } as InterHubEnvelope<InterhubChatPayload>, originName: identityOf(origin.peer_identity).name }
  }

  /** Applies membership and code events; chat events are materialized by InterhubChat. */
  async applyControl(verified: Exclude<VerifiedEnvelope, { kind: "chat" }>) {
    const local = (await this.localIdentity()).id, event = verified.envelope
    if (verified.kind === "code") {
      // The creator keeps its own row authoritative; members only mirror the generation for display.
      await this.store.db.query(`UPDATE interhub_channels SET code_generation=MAX(code_generation,$2),code_revoked_at=$3,updated_at=now()
        WHERE channel_id=$1 AND creator_hub_id<>$4`, [event.channel_id, verified.envelope.payload.generation, verified.envelope.payload.action === "revoked" ? event.occurred_at : null, local])
      return
    }
    const payload = verified.envelope.payload
    // A removal of this hub stops its replica; this hub's own leader is never taken from a remote event.
    if (payload.action === "removed") {
      await this.store.db.query("UPDATE interhub_members SET removed_at=COALESCE(removed_at,$3) WHERE channel_id=$1 AND hub_id=$2", [event.channel_id, payload.hub_id, event.occurred_at])
      return
    }
    if (payload.hub_id === local) return
    await this.store.db.query(`INSERT INTO interhub_members(channel_id,hub_id,peer_identity,leader_session_id,leader_label) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(channel_id,hub_id) DO UPDATE SET peer_identity=excluded.peer_identity,leader_session_id=excluded.leader_session_id,leader_label=excluded.leader_label,removed_at=NULL`,
    [event.channel_id, payload.hub_id, JSON.stringify(payload.peer_identity), payload.leader_id || null, label(payload.leader_label)])
  }
}
