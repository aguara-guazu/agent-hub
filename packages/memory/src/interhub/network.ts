import { randomBytes, randomUUID } from "node:crypto"
import { z } from "zod"
import type { InterHubEnvelope } from "@agenthub/shared"
import { check, parse } from "../contracts.js"
import { Vault } from "../config.js"
import type { MemoryStore } from "../store.js"
import { canonical, digest, signature, validSignature, type PublicIdentity } from "../sharing/crypto.js"

const code = () => randomBytes(32).toString("base64url")
const codeHash = (channelId: string, value: string) => digest({ channel_id: channelId, code: value })
const envelopeSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), channel_id: z.string().uuid(), origin_hub_id: z.string().regex(/^[a-f0-9]{64}$/),
  origin_peer_public_key: z.string().min(1).max(200), origin_agent_id: z.string().max(200).nullable(), kind: z.enum(["membership", "message", "thread", "code"]),
  occurred_at: z.string().datetime(), payload: z.unknown(), signature: z.string().min(1).max(200),
}).strict()

/** P2P-owned durable state. Chat owns local message materialization and roster presentation. */
export class InterhubNetwork {
  private readonly vault: Vault
  constructor(readonly store: MemoryStore) { this.vault = new Vault(store.directory) }

  private secretKey(channelId: string) { return `interhub-channel-code:${channelId}` }
  private async localIdentity() {
    const { SharedProjects } = await import("../sharing/projects.js")
    return new SharedProjects(this.store).identity()
  }
  private async assertCreator(channelId: string, sessionId: string) {
    const row = (await this.store.db.query("SELECT creator_hub_id,creator_session_id FROM interhub_channels WHERE channel_id=$1", [channelId]))[0]
    check(row?.creator_session_id === sessionId, "Sólo el líder del hub creador puede gestionar el código", 403)
    return row
  }

  async createChannel(caller: { id: string }, input: { name: string; projectId?: string | null }) {
    const channelId = randomUUID(), value = code(), identity = await this.localIdentity()
    await this.store.db.transaction(async sql => {
      await sql.query("INSERT INTO chat_channels(id,project_id,scope_key,path,name,kind,leader_id,activated_at) VALUES($1,$2,$3,'',$4,'inter-hub',$5,now())", [channelId, input.projectId ?? null, `interhub:${channelId}`, input.name, caller.id])
      await sql.query("INSERT INTO interhub_channels(channel_id,creator_hub_id,creator_session_id,code_hash,code_generation) VALUES($1,$2,$3,$4,1)", [channelId, identity.id, caller.id, codeHash(channelId, value)])
      await sql.query("INSERT INTO interhub_members(channel_id,hub_id,peer_identity,leader_session_id,leader_label) SELECT $1,$2,$3,$4,COALESCE(nickname,label) FROM chat_sessions WHERE id=$4", [channelId, identity.id, JSON.stringify({ id: identity.id, signing: identity.signing, encryption: identity.encryption, name: identity.name }), caller.id])
    })
    this.vault.save(this.secretKey(channelId), { code: value })
    return { channel_id: channelId, code: value }
  }

  async joinChannel(caller: { id: string }, value: string, verifiedPeer?: PublicIdentity) {
    check(value.length >= 32 && value.length <= 200, "Código inválido o revocado", 404)
    const rows = await this.store.db.query("SELECT * FROM interhub_channels WHERE code_revoked_at IS NULL")
    const channel = rows.find(row => codeHash(String(row.channel_id), value) === row.code_hash)
    check(channel, "Código inválido o revocado", 404)
    const identity = await this.localIdentity(), peer = verifiedPeer ?? identity
    check(peer.id === identity.id, "La identidad de unión debe provenir del peer P2P autenticado", 403)
    await this.store.db.query("INSERT INTO interhub_members(channel_id,hub_id,peer_identity,leader_session_id,leader_label) SELECT $1,$2,$3,$4,COALESCE(nickname,label) FROM chat_sessions WHERE id=$4 ON CONFLICT(channel_id,hub_id) DO UPDATE SET peer_identity=excluded.peer_identity,leader_session_id=excluded.leader_session_id,leader_label=excluded.leader_label,removed_at=NULL,last_seen_at=now()", [channel.channel_id, identity.id, JSON.stringify(peer), caller.id])
    return { channel_id: String(channel.channel_id), hub_id: identity.id }
  }

  async rotateCode(caller: { id: string }, channelId: string, action: "regenerate" | "revoke") {
    await this.assertCreator(channelId, caller.id)
    if (action === "revoke") {
      await this.store.db.query("UPDATE interhub_channels SET code_revoked_at=now() WHERE channel_id=$1", [channelId])
      this.vault.delete(this.secretKey(channelId))
      return { revoked: true }
    }
    const value = code()
    await this.store.db.query("UPDATE interhub_channels SET code_hash=$2,code_generation=code_generation+1,code_revoked_at=NULL WHERE channel_id=$1", [channelId, codeHash(channelId, value)])
    this.vault.save(this.secretKey(channelId), { code: value })
    return { code: value }
  }

  async creatorCode(channelId: string) {
    const row = (await this.store.db.query("SELECT code_revoked_at FROM interhub_channels WHERE channel_id=$1", [channelId]))[0]
    if (!row || row.code_revoked_at) return null
    return this.vault.read<{ code: string }>(this.secretKey(channelId))?.code ?? null
  }

  async listHubs(channelId: string) {
    const local = (await this.localIdentity()).id
    return this.store.db.query("SELECT hub_id AS id,leader_label AS name,hub_id=$2 AS is_local,CASE WHEN last_seen_at>datetime('now','-30 seconds') THEN 'online' ELSE 'offline' END AS connection FROM interhub_members WHERE channel_id=$1 AND removed_at IS NULL ORDER BY hub_id=$2 DESC,joined_at", [channelId, local])
  }

  async signEnvelope(input: Omit<InterHubEnvelope, "id" | "origin_hub_id" | "origin_peer_public_key" | "signature">) {
    const identity = await this.localIdentity()
    const unsigned = { ...input, id: randomUUID(), origin_hub_id: identity.id, origin_peer_public_key: identity.signing }
    return { ...unsigned, signature: signature(unsigned, identity) } as InterHubEnvelope
  }

  async receiveEnvelope(raw: unknown, peer: PublicIdentity) {
    const event = parse(envelopeSchema, raw)
    check(event.origin_hub_id === peer.id && event.origin_peer_public_key === peer.signing, "La identidad del origen no coincide con el peer P2P", 403)
    check(Math.abs(Date.now() - Date.parse(event.occurred_at)) <= 300_000, "Fecha de evento inválida", 403)
    const { signature: proof, ...unsigned } = event
    check(validSignature(unsigned, proof, peer), "Firma de evento inter-hub inválida", 403)
    const member = (await this.store.db.query("SELECT 1 FROM interhub_members WHERE channel_id=$1 AND hub_id=$2 AND removed_at IS NULL", [event.channel_id, peer.id]))[0]
    check(member, "El peer no pertenece al canal", 403)
    const inserted = await this.store.db.query("INSERT INTO interhub_events(id,channel_id,origin_hub_id,envelope,received_from) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id", [event.id, event.channel_id, peer.id, JSON.stringify(event), peer.id])
    return { duplicate: !inserted.length, envelope: event }
  }

  async catchup(channelId: string, after = 0) {
    check(Number.isSafeInteger(after) && after >= 0, "Cursor inválido", 400)
    return this.store.db.query("SELECT seq,envelope FROM interhub_events WHERE channel_id=$1 AND seq>$2 ORDER BY seq LIMIT 50", [channelId, after])
  }
}
