import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { CHAT_MESSAGE_KINDS, INTERHUB_CHANNEL_KIND, INTERHUB_CHAT_VERSION, INTERHUB_CLOCK_SKEW_MS, INTERHUB_ESCALATION_TIMEOUT_MS } from "@agenthub/shared"
import type { InterhubAgentRole, InterhubChatPayload, InterhubEscalationState, InterhubMessageOrigin, VerifiedInterhubChatEnvelope } from "@agenthub/shared"
import { ACTIVE_TEAM_STATES, channelMembership } from "../chat-access.js"
import { check, id, parse } from "../contracts.js"
import type { Sql } from "../database.js"
import type { MemoryStore } from "../store.js"

/** cli_kind of the closed placeholder session that stands for a remote author in local FKs (messages, threads). */
export const INTERHUB_REMOTE_CLI_KIND = "interhub-remote"
const ESCALATION_SENDER = "interhub-escalation:"

/** Production value is the shared constant; only a test process (NODE_ENV=test) may shorten it. */
export const interhubEscalationTimeout = () => {
  const override = process.env.NODE_ENV === "test" ? Number(process.env.AGENTHUB_INTERHUB_ESCALATION_MS) : NaN
  return Number.isSafeInteger(override) && override > 0 ? override : INTERHUB_ESCALATION_TIMEOUT_MS
}

const at = z.iso.datetime()
const hubId = z.string().regex(/^[a-f0-9]{64}$/)
const sessionId = z.string().min(1).max(200).regex(/^[A-Za-z0-9:._-]+$/)
const visible = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value), "Texto vacío o con caracteres de control")
const remoteSession = z.object({ id: sessionId, label: visible(200), cli_kind: z.string().regex(/^[a-z0-9_-]{1,40}$/), role: z.enum(["leader", "member"]) }).strict()

/** Strict runtime contract of every chat payload; the P2P adapter and receive() both apply it. */
export const interhubChatPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thread"), thread: z.object({ id, title: visible(200), author: remoteSession, created_at: at }).strict() }).strict(),
  z.object({ type: z.literal("message"), message: z.object({
    id, thread_id: id, author: remoteSession, text: z.string().min(1).max(16000).refine(value => value.trim().length > 0, "Texto vacío"),
    mentions: z.array(sessionId).max(20), reply_to: id.nullable(), kind: z.enum(CHAT_MESSAGE_KINDS).nullable(), created_at: at,
  }).strict() }).strict(),
  z.object({ type: z.literal("presence"), presence: z.object({ session: remoteSession, state: z.enum(["online", "offline", "unknown"]), occurred_at: at }).strict() }).strict(),
  z.object({ type: z.literal("escalation"), escalation: z.object({ id, thread_id: id, question_message_id: id, from_hub_id: hubId, to_hub_id: hubId, created_at: at }).strict() }).strict(),
  z.object({ type: z.literal("escalation_resolved"), resolution: z.object({ escalation_id: id, hub_id: hubId, resolved_at: at }).strict() }).strict(),
])

export const verifiedInterhubChatEnvelopeSchema = z.object({
  id, version: z.literal(INTERHUB_CHAT_VERSION), channel_id: id, origin_hub_id: hubId, origin_hub_name: visible(200),
  origin_peer_id: z.string().min(1).max(200), origin_agent_id: sessionId.nullable(), occurred_at: at, payload: interhubChatPayloadSchema,
}).strict()

const payloadTimes = (payload: InterhubChatPayload) => {
  switch (payload.type) {
    case "thread": return [payload.thread.created_at]
    case "message": return [payload.message.created_at]
    case "presence": return [payload.presence.occurred_at]
    case "escalation": return [payload.escalation.created_at]
    case "escalation_resolved": return [payload.resolution.resolved_at]
  }
}

/** Placeholder id of a remote author: one per (channel, hub, remote session), never a routable session key. */
export const interhubRemoteSessionId = (channelId: string, hubId: string, remoteId: string) =>
  `interhub:${createHash("sha256").update(`${channelId}\n${hubId}\n${remoteId}`).digest("hex").slice(0, 40)}`

const hubName = (member: Record<string, any> | undefined, fallback: string) => {
  const identity = typeof member?.peer_identity === "string" ? safeJson(member.peer_identity) : member?.peer_identity
  return typeof identity?.name === "string" && identity.name.trim() ? identity.name as string : fallback
}
const safeJson = (value: string) => { try { return JSON.parse(value) as Record<string, unknown> } catch { return null } }

export interface InterhubHub {
  id: string
  name: string
  is_local: boolean
  connection: "online" | "offline" | "unknown"
}

export interface InterhubChatDependencies {
  hubs(channelId: string): Promise<InterhubHub[]>
  localHubId(): Promise<string>
  /** Signs and records the payload for the channel's peers. Always called after the state change committed. */
  publish(channelId: string, payload: InterhubChatPayload): Promise<void>
  /** Wakes local listeners (UI refresh, delivery runtime) after a committed change. */
  changed?(): void
}

interface EscalationRound {
  id: string
  channel_id: string
  thread_id: string
  question_message_id: string
  from: string
  target: string
  at: string
  previous: { last_hub_id: string | null; next_hub_id: string | null; escalated_at: string } | null
}

/**
 * Materializes only envelopes whose peer, membership and signature P2P has verified, and owns the inter-hub
 * escalation state. Identity is never taken from a payload: the hub comes from the verified envelope and the
 * author must be the signed `origin_agent_id` and belong to that hub's signed roster in the channel.
 */
export class InterhubChat {
  constructor(readonly store: MemoryStore, readonly transport: InterhubChatDependencies) {}

  private async channel(sql: Sql, channelId: string) {
    const channel = (await sql.query("SELECT * FROM chat_channels WHERE id=$1 AND kind=$2 AND closed_at IS NULL AND deleted_at IS NULL", [channelId, INTERHUB_CHANNEL_KIND]))[0]
    check(channel, "Canal entre hubs inexistente.", 404)
    return channel
  }

  private async member(sql: Sql, channelId: string, hub: string) {
    return (await sql.query("SELECT hub_id,peer_identity,leader_session_id,leader_label FROM interhub_members WHERE channel_id=$1 AND hub_id=$2 AND removed_at IS NULL", [channelId, hub]))[0]
  }

  async receive(raw: VerifiedInterhubChatEnvelope, now = Date.now()) {
    const envelope = parse(verifiedInterhubChatEnvelopeSchema, raw) as VerifiedInterhubChatEnvelope
    for (const value of [envelope.occurred_at, ...payloadTimes(envelope.payload)])
      check(Date.parse(value) <= now + INTERHUB_CLOCK_SKEW_MS, "Sobre inter-hub con fecha futura", 400)
    const localHub = await this.transport.localHubId()
    check(envelope.origin_hub_id !== localHub, "Un hub no materializa sus propios sobres", 400)
    const result = await this.store.db.transaction(async sql => {
      const channel = await this.channel(sql, envelope.channel_id)
      const member = await this.member(sql, envelope.channel_id, envelope.origin_hub_id)
      check(member, "El hub de origen no es miembro vigente del canal", 403)
      const inserted = await sql.query("INSERT OR IGNORE INTO interhub_received_envelopes(envelope_id,channel_id,origin_hub_id,origin_peer_id,occurred_at) VALUES($1,$2,$3,$4,$5) RETURNING envelope_id",
        [envelope.id, envelope.channel_id, envelope.origin_hub_id, envelope.origin_peer_id, envelope.occurred_at])
      if (!inserted.length) return { duplicate: true as const }
      const payload = envelope.payload
      switch (payload.type) {
        case "presence": return this.receivePresence(sql, envelope, member, payload.presence)
        case "thread": return this.receiveThread(sql, envelope, member, payload.thread)
        case "message": return this.receiveMessage(sql, envelope, channel, member, payload.message)
        case "escalation": return this.receiveEscalation(sql, envelope, channel, member, payload.escalation, localHub, now)
        case "escalation_resolved": return this.receiveResolution(sql, envelope, channel, member, payload.resolution, now)
      }
    })
    if (!result.duplicate) this.transport.changed?.()
    return result
  }

  private async receivePresence(sql: Sql, envelope: VerifiedInterhubChatEnvelope, member: Record<string, any>, presence: Extract<InterhubChatPayload, { type: "presence" }>["presence"]) {
    const session = presence.session
    check(envelope.origin_agent_id === session.id, "La presencia no corresponde al agente firmado por el hub de origen", 403)
    // At most one leader per (channel, hub): the role always follows the hub's signed membership, never the payload.
    const role = session.id === member.leader_session_id ? "leader" : "member"
    await sql.query(`INSERT INTO interhub_remote_sessions(channel_id,hub_id,session_id,label,cli_kind,role,state,peer_id,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(channel_id,hub_id,session_id) DO UPDATE SET label=excluded.label,cli_kind=excluded.cli_kind,role=excluded.role,state=excluded.state,peer_id=excluded.peer_id,occurred_at=excluded.occurred_at,updated_at=now()
      WHERE excluded.occurred_at>=interhub_remote_sessions.occurred_at`, [envelope.channel_id, envelope.origin_hub_id, session.id, session.label, session.cli_kind, role, presence.state, envelope.origin_peer_id, presence.occurred_at])
    await sql.query("UPDATE chat_sessions SET label=$2 WHERE id=$1 AND cli_kind=$3", [interhubRemoteSessionId(envelope.channel_id, envelope.origin_hub_id, session.id), session.label, INTERHUB_REMOTE_CLI_KIND])
    return { duplicate: false as const, kind: "presence" as const }
  }

  /** Verified author: the signed origin_agent_id, listed in the origin hub's signed roster. Returns its local placeholder. */
  private async remoteAuthor(sql: Sql, envelope: VerifiedInterhubChatEnvelope, member: Record<string, any>, author: { id: string; label: string }) {
    check(envelope.origin_agent_id === author.id, "El autor no coincide con el agente firmado por el hub de origen", 403)
    const announced = (await sql.query("SELECT label FROM interhub_remote_sessions WHERE channel_id=$1 AND hub_id=$2 AND session_id=$3", [envelope.channel_id, envelope.origin_hub_id, author.id]))[0]
    const leader = author.id === member.leader_session_id
    check(leader || announced, "El autor no figura en el roster firmado de su hub en este canal", 409)
    const label = String(announced?.label ?? (leader ? member.leader_label : author.label))
    const placeholder = interhubRemoteSessionId(envelope.channel_id, envelope.origin_hub_id, author.id)
    await sql.query(`INSERT INTO chat_sessions(id,agent_id,key_hash,label,cli_kind,channel_id,state,event_at,closed_at)
      VALUES($1,$1,$1,$2,$3,$4,'offline',now(),now())
      ON CONFLICT(id) DO UPDATE SET label=excluded.label WHERE chat_sessions.cli_kind=excluded.cli_kind`, [placeholder, label, INTERHUB_REMOTE_CLI_KIND, envelope.channel_id])
    const row = (await sql.query("SELECT cli_kind,channel_id FROM chat_sessions WHERE id=$1", [placeholder]))[0]
    check(row?.cli_kind === INTERHUB_REMOTE_CLI_KIND && row.channel_id === envelope.channel_id, "Identidad remota en conflicto con una sesión local", 409)
    return { id: placeholder, role: (leader ? "leader" : "member") as InterhubAgentRole }
  }

  private async receiveThread(sql: Sql, envelope: VerifiedInterhubChatEnvelope, member: Record<string, any>, thread: Extract<InterhubChatPayload, { type: "thread" }>["thread"]) {
    const author = await this.remoteAuthor(sql, envelope, member, thread.author)
    const existing = (await sql.query("SELECT channel_id FROM chat_threads WHERE id=$1", [thread.id]))[0]
    check(!existing || existing.channel_id === envelope.channel_id, "El hilo inter-hub ya pertenece a otro canal", 409)
    if (!existing) await sql.query("INSERT INTO chat_threads(id,channel_id,title,created_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)", [thread.id, envelope.channel_id, thread.title, author.id, thread.created_at])
    return { duplicate: false as const, kind: "thread" as const }
  }

  private async receiveMessage(sql: Sql, envelope: VerifiedInterhubChatEnvelope, channel: Record<string, any>, member: Record<string, any>, message: Extract<InterhubChatPayload, { type: "message" }>["message"]) {
    const thread = (await sql.query("SELECT id FROM chat_threads WHERE id=$1 AND channel_id=$2", [message.thread_id, envelope.channel_id]))[0]
    check(thread, "El mensaje inter-hub refiere a un hilo inexistente", 409)
    const author = await this.remoteAuthor(sql, envelope, member, message.author)
    // A colliding id never gains a remote origin: only the same remote message re-sent in another envelope is a no-op.
    if ((await sql.query("SELECT 1 FROM chat_messages WHERE id=$1", [message.id])).length) {
      const same = (await sql.query(`SELECT 1 FROM chat_messages m JOIN interhub_message_origins o ON o.message_id=m.id
        WHERE m.id=$1 AND m.thread_id=$2 AND m.author_id=$3 AND o.hub_id=$4`, [message.id, message.thread_id, author.id, envelope.origin_hub_id])).length
      check(same, "El id del mensaje inter-hub ya pertenece a otro mensaje", 409)
      return { duplicate: false as const, kind: "message" as const, already_materialized: true }
    }
    const replied = message.reply_to ? (await sql.query(`SELECT m.id,m.author_id,o.message_id AS remote FROM chat_messages m LEFT JOIN interhub_message_origins o ON o.message_id=m.id
      WHERE m.id=$1 AND m.thread_id=$2`, [message.reply_to, message.thread_id]))[0] : undefined
    await sql.query("INSERT INTO chat_messages(id,thread_id,author_id,text,reply_to,request_id,request_hash,kind,created_at) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8)",
      [message.id, message.thread_id, author.id, message.text, replied ? replied.id : null, envelope.id, message.kind, message.created_at])
    await sql.query("INSERT INTO interhub_message_origins(message_id,envelope_id,hub_id,hub_name,peer_id,author_role) VALUES($1,$2,$3,$4,$5,$6)",
      [message.id, envelope.id, envelope.origin_hub_id, envelope.origin_hub_name, envelope.origin_peer_id, author.role])
    const recipients = new Set<string>()
    for (const mention of message.mentions) if (await this.localRecipient(sql, mention, channel.id)) recipients.add(mention)
    if (replied && !replied.remote && await this.localRecipient(sql, String(replied.author_id), channel.id)) recipients.add(String(replied.author_id))
    // Remote ids are never recipients; a local request addressed to this remote author counts as answered.
    for (const recipient of recipients) await sql.query("INSERT OR IGNORE INTO chat_deliveries(message_id,recipient_id) VALUES($1,$2)", [message.id, recipient])
    if (replied) await sql.query(`UPDATE chat_deliveries SET response_message_id=COALESCE(response_message_id,$3),read_at=COALESCE(read_at,now()),handled_at=COALESCE(handled_at,now())
      WHERE message_id=$1 AND recipient_id=$2 AND cancelled_at IS NULL`, [replied.id, author.id, message.id])
    await sql.query("UPDATE chat_threads SET updated_at=MAX(updated_at,$2),archived_notice=0 WHERE id=$1", [message.thread_id, message.created_at])
    return { duplicate: false as const, kind: "message" as const, delivered_to: [...recipients] }
  }

  /** A local agent session associated with the channel: its leader (who lives in its own workspace channel), members and team. */
  private async localRecipient(sql: Sql, sessionId: string, channelId: string) {
    const session = (await sql.query("SELECT cli_kind FROM chat_sessions WHERE id=$1", [sessionId]))[0]
    if (!session || session.cli_kind === INTERHUB_REMOTE_CLI_KIND || session.cli_kind === "hub") return false
    return Boolean(await channelMembership(sql, sessionId, channelId))
  }

  private async receiveEscalation(sql: Sql, envelope: VerifiedInterhubChatEnvelope, channel: Record<string, any>, member: Record<string, any>,
    escalation: Extract<InterhubChatPayload, { type: "escalation" }>["escalation"], localHub: string, now: number) {
    check(escalation.from_hub_id === envelope.origin_hub_id, "La escalada no proviene del hub que la firma", 403)
    check(escalation.to_hub_id !== escalation.from_hub_id && await this.member(sql, envelope.channel_id, escalation.to_hub_id), "La escalada apunta a un hub que no es miembro del canal", 409)
    const question = (await sql.query(`SELECT m.id FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id JOIN interhub_message_origins o ON o.message_id=m.id
      WHERE m.id=$1 AND m.thread_id=$2 AND t.channel_id=$3 AND o.hub_id=$4`, [escalation.question_message_id, escalation.thread_id, envelope.channel_id, envelope.origin_hub_id]))[0]
    check(question, "La pregunta escalada no es un mensaje del hub de origen en ese hilo", 409)
    const existing = (await sql.query("SELECT * FROM interhub_escalations WHERE id=$1 OR (channel_id=$2 AND thread_id=$3 AND question_message_id=$4)",
      [escalation.id, envelope.channel_id, escalation.thread_id, escalation.question_message_id])) as unknown as InterhubEscalationState[]
    check(existing.every(row => row.id === escalation.id && row.channel_id === envelope.channel_id && row.thread_id === escalation.thread_id
      && row.question_message_id === escalation.question_message_id), "La escalada choca con otra registrada", 409)
    if (existing[0]?.answered_at) return { duplicate: false as const, kind: "escalation" as const, ignored: "resolved" as const }
    // Rounds are dated with this hub's clock: a remote timestamp never shortens a local wait.
    const receivedAt = new Date(now).toISOString()
    await sql.query(`INSERT INTO interhub_escalations(id,channel_id,thread_id,question_message_id,last_hub_id,next_hub_id,escalated_at) VALUES($1,$2,$3,$4,$5,$5,$6)
      ON CONFLICT(id) DO UPDATE SET last_hub_id=excluded.last_hub_id,next_hub_id=excluded.next_hub_id,escalated_at=excluded.escalated_at,updated_at=now()`,
      [escalation.id, envelope.channel_id, escalation.thread_id, escalation.question_message_id, escalation.to_hub_id, receivedAt])
    await this.cancelEscalationNotices(sql, escalation.id, "La escalada pasó a otro hub")
    if (escalation.to_hub_id === localHub && channel.leader_id) {
      const from = hubName(member, envelope.origin_hub_name)
      await this.escalationNotice(sql, channel.id, escalation.id, String(channel.leader_id), escalation.thread_id, "interhub_escalation",
        `Agent Hub: in inter-hub channel "${channel.name}" (${channel.id}) the leader of hub "${from}" asked its person a question and nobody on that hub answered in ${Math.round(interhubEscalationTimeout() / 60000)} minutes. Put that question (thread ${escalation.thread_id}, message ${escalation.question_message_id}; read it with memory_chat_read) to your own person in your terminal. With the answer, post it in the thread with memory_chat_send(reply_to=${escalation.question_message_id}) and call memory_chat_interhub_resolve_escalation(channel_id=${channel.id}, thread_id=${escalation.thread_id}, escalation_id=${escalation.id}). Without an answer do nothing: the Hub asks the next hub.`)
    }
    return { duplicate: false as const, kind: "escalation" as const }
  }

  private async receiveResolution(sql: Sql, envelope: VerifiedInterhubChatEnvelope, channel: Record<string, any>, member: Record<string, any>,
    resolution: Extract<InterhubChatPayload, { type: "escalation_resolved" }>["resolution"], now: number) {
    check(resolution.hub_id === envelope.origin_hub_id, "La resolución no proviene del hub que la firma", 403)
    const row = (await sql.query("SELECT * FROM interhub_escalations WHERE id=$1 AND channel_id=$2", [resolution.escalation_id, envelope.channel_id]))[0]
    if (!row || row.answered_at) return { duplicate: false as const, kind: "escalation_resolved" as const, ignored: row ? "resolved" as const : "unknown" as const }
    await sql.query("UPDATE interhub_escalations SET answered_at=$2,updated_at=now() WHERE id=$1 AND answered_at IS NULL", [row.id, new Date(now).toISOString()])
    await this.cancelEscalationNotices(sql, String(row.id), "Escalada resuelta por otro hub")
    const asker = (await sql.query(`SELECT m.author_id FROM chat_messages m JOIN chat_sessions s ON s.id=m.author_id
      WHERE m.id=$1 AND s.removed_at IS NULL AND s.cli_kind NOT IN ($2,'hub') AND NOT EXISTS(SELECT 1 FROM interhub_message_origins o WHERE o.message_id=m.id)`, [row.question_message_id, INTERHUB_REMOTE_CLI_KIND]))[0]
    if (asker) await this.escalationNotice(sql, channel.id, String(row.id), String(asker.author_id), String(row.thread_id), "interhub_escalation_resolved",
      `Agent Hub: in inter-hub channel "${channel.name}" (${channel.id}) the leader of hub "${hubName(member, envelope.origin_hub_name)}" resolved escalation ${row.id} of your question (thread ${row.thread_id}, message ${row.question_message_id}): its person answered. Read the thread with memory_chat_read for the answer. No more hubs will be asked.`)
    return { duplicate: false as const, kind: "escalation_resolved" as const }
  }

  /** Private Hub notice (never a thread message: the UI shows no escalation notices). One pending per escalation and recipient. */
  private async escalationNotice(sql: Sql, channelId: string, escalationId: string, recipientId: string, threadId: string, cause: string, text: string) {
    const sender = `${ESCALATION_SENDER}${escalationId}`
    await sql.query(`INSERT OR IGNORE INTO chat_sessions(id,agent_id,key_hash,label,cli_kind,channel_id,state,event_at,closed_at)
      VALUES($1,'agenthub-system',$1,'Agent Hub','hub',$2,'offline',now(),now())`, [sender, channelId])
    await sql.query("UPDATE chat_status_notices SET cancelled_at=now(),error='Aviso de escalada superado' WHERE session_id=$1 AND recipient_id=$2 AND handled_at IS NULL AND cancelled_at IS NULL", [sender, recipientId])
    await sql.query("INSERT INTO chat_status_notices(id,session_id,turn_id,cause,channel_id,recipient_id,work_thread_id,text) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [randomUUID(), sender, `${cause}:${randomUUID()}`, cause, channelId, recipientId, threadId, text])
  }

  private async cancelEscalationNotices(sql: Sql, escalationId: string, reason: string) {
    await sql.query("UPDATE chat_status_notices SET cancelled_at=now(),error=$2 WHERE session_id=$1 AND handled_at IS NULL AND cancelled_at IS NULL", [`${ESCALATION_SENDER}${escalationId}`, reason])
  }

  /**
   * Starts an escalation, or runs its next round, for a question the caller (this hub's leader) wrote here.
   * The wait is measured with this hub's clock from the question (first round) or from the current round.
   */
  async escalate(caller: { id: string }, channelId: string, threadId: string, messageId: string, now = Date.now()) {
    const localHub = await this.transport.localHubId()
    const round = await this.store.db.transaction(async sql => {
      await this.channel(sql, channelId)
      const question = (await sql.query(`SELECT m.id,m.author_id,m.kind,m.created_at FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id
        WHERE m.id=$1 AND m.thread_id=$2 AND t.channel_id=$3 AND NOT EXISTS(SELECT 1 FROM interhub_message_origins o WHERE o.message_id=m.id)`, [messageId, threadId, channelId]))[0]
      check(question, "La pregunta no es un mensaje de este hub en ese hilo del canal.", 404)
      check(question.author_id === caller.id, "Sólo podés escalar una pregunta que escribiste vos.", 403)
      check(question.kind === "question", "Sólo se escala un mensaje enviado con kind question.", 409)
      const current = (await sql.query("SELECT * FROM interhub_escalations WHERE channel_id=$1 AND thread_id=$2 AND question_message_id=$3", [channelId, threadId, messageId]))[0] as InterhubEscalationState | undefined
      check(!current?.answered_at, "Esa escalada ya fue resuelta; no se repite.", 409)
      const since = Date.parse(String(current?.escalated_at ?? question.created_at))
      check(now - since >= interhubEscalationTimeout(), current ? "La ronda actual de esa escalada todavía está en plazo." : "La pregunta todavía no cumplió el plazo de escalada.", 409)
      return this.nextRound(sql, channelId, { thread_id: threadId, question_message_id: messageId }, current, localHub, now)
    })
    if (!round) return { no_other_hub: true as const }
    await this.publishRound(round)
    this.transport.changed?.()
    return { delegated_to_hub_id: round.target, escalation_id: round.id }
  }

  /** Next hub after the last one asked, in stable hub-id order, preferring a connected one. Null when no other hub exists. */
  private async nextRound(sql: Sql, channelId: string, question: { thread_id: string; question_message_id: string }, current: InterhubEscalationState | undefined, localHub: string, now: number): Promise<EscalationRound | null> {
    const hubs = (await this.transport.hubs(channelId)).filter(hub => !hub.is_local && hub.id !== localHub).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    if (!hubs.length) return null
    const last = current?.last_hub_id ?? null
    const start = last === null ? 0 : Math.max(0, hubs.findIndex(hub => hub.id > last))
    const ordered = [...hubs.slice(start), ...hubs.slice(0, start)]
    const target = ordered.find(hub => hub.connection === "online") ?? ordered[0]!
    const id = current?.id ?? randomUUID(), at = new Date(now).toISOString()
    if (current) {
      const updated = await sql.query("UPDATE interhub_escalations SET last_hub_id=$2,next_hub_id=$2,escalated_at=$3,updated_at=now() WHERE id=$1 AND answered_at IS NULL AND escalated_at=$4 RETURNING id",
        [id, target.id, at, current.escalated_at])
      check(updated.length, "La escalada cambió mientras se calculaba la ronda; volvé a intentar.", 409)
    } else {
      const inserted = await sql.query(`INSERT INTO interhub_escalations(id,channel_id,thread_id,question_message_id,last_hub_id,next_hub_id,escalated_at)
        VALUES($1,$2,$3,$4,$5,$5,$6) ON CONFLICT DO NOTHING RETURNING id`, [id, channelId, question.thread_id, question.question_message_id, target.id, at])
      check(inserted.length, "La escalada ya existe; volvé a intentar.", 409)
    }
    return { id, channel_id: channelId, thread_id: question.thread_id, question_message_id: question.question_message_id, from: localHub, target: target.id, at,
      previous: current ? { last_hub_id: current.last_hub_id, next_hub_id: current.next_hub_id, escalated_at: current.escalated_at } : null }
  }

  /** Publishes a committed round; if publishing fails the round is undone (compare-and-set) so a later call or sweep retries it. */
  private async publishRound(round: EscalationRound) {
    try {
      await this.transport.publish(round.channel_id, { type: "escalation", escalation: { id: round.id, thread_id: round.thread_id, question_message_id: round.question_message_id,
        from_hub_id: round.from, to_hub_id: round.target, created_at: round.at } })
    } catch (error) {
      if (round.previous) await this.store.db.query("UPDATE interhub_escalations SET last_hub_id=$2,next_hub_id=$3,escalated_at=$4,updated_at=now() WHERE id=$1 AND escalated_at=$5 AND answered_at IS NULL",
        [round.id, round.previous.last_hub_id, round.previous.next_hub_id, round.previous.escalated_at, round.at])
      else await this.store.db.query("DELETE FROM interhub_escalations WHERE id=$1 AND escalated_at=$2 AND answered_at IS NULL", [round.id, round.at])
      throw error
    }
  }

  /**
   * Runtime sweep: every unresolved escalation of a question asked here whose current round is older than the timeout
   * moves to the next hub. Resolved escalations never get another round; without another hub the wait just restarts.
   */
  async sweepEscalations(now = Date.now()) {
    const cutoff = new Date(now - interhubEscalationTimeout()).toISOString()
    const due = await this.store.db.query(`SELECT e.id FROM interhub_escalations e JOIN chat_channels c ON c.id=e.channel_id
      WHERE e.answered_at IS NULL AND e.escalated_at<=$1 AND c.kind=$2 AND c.closed_at IS NULL AND c.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM interhub_message_origins o WHERE o.message_id=e.question_message_id) ORDER BY e.escalated_at LIMIT 20`, [cutoff, INTERHUB_CHANNEL_KIND])
    if (!due.length) return { rounds: 0, failed: 0 }
    const localHub = await this.transport.localHubId()
    let rounds = 0, failed = 0
    for (const { id: escalationId } of due) {
      try {
        const round = await this.store.db.transaction(async sql => {
          const current = (await sql.query("SELECT * FROM interhub_escalations WHERE id=$1 AND answered_at IS NULL AND escalated_at<=$2", [escalationId, cutoff]))[0] as InterhubEscalationState | undefined
          if (!current || !await this.member(sql, current.channel_id, localHub)) return null
          const next = await this.nextRound(sql, current.channel_id, current, current, localHub, now)
          if (!next) await sql.query("UPDATE interhub_escalations SET escalated_at=$2,updated_at=now() WHERE id=$1 AND escalated_at=$3 AND answered_at IS NULL", [current.id, new Date(now).toISOString(), current.escalated_at])
          return next
        })
        if (!round) continue
        await this.publishRound(round)
        rounds++
      } catch { failed++ }
    }
    if (rounds) this.transport.changed?.()
    return { rounds, failed }
  }

  /** Marks an escalation answered for every hub. Idempotent: an answered escalation is neither republished nor reopened. */
  async resolve(channelId: string, threadId: string, escalationId: string, now = Date.now()) {
    const localHub = await this.transport.localHubId(), resolvedAt = new Date(now).toISOString()
    const changed = await this.store.db.transaction(async sql => {
      await this.channel(sql, channelId)
      const row = (await sql.query("SELECT answered_at FROM interhub_escalations WHERE id=$1 AND channel_id=$2 AND thread_id=$3", [escalationId, channelId, threadId]))[0]
      check(row, "Escalada inexistente.", 404)
      if (row.answered_at) return false
      await sql.query("UPDATE interhub_escalations SET answered_at=$2,updated_at=now() WHERE id=$1 AND answered_at IS NULL", [escalationId, resolvedAt])
      await this.cancelEscalationNotices(sql, escalationId, "Escalada resuelta")
      return true
    })
    if (!changed) return { resolved: true as const }
    try {
      await this.transport.publish(channelId, { type: "escalation_resolved", resolution: { escalation_id: escalationId, hub_id: localHub, resolved_at: resolvedAt } })
    } catch (error) {
      await this.store.db.query("UPDATE interhub_escalations SET answered_at=NULL,updated_at=now() WHERE id=$1 AND answered_at=$2", [escalationId, resolvedAt])
      throw error
    }
    this.transport.changed?.()
    return { resolved: true as const }
  }
}

/** Keeps an inter-hub escalation notice pending only while it still applies; called by the local notice revalidation. */
export async function interhubNoticeValid(sql: Sql, notice: Record<string, any>) {
  const recipient = (await sql.query("SELECT 1 FROM chat_sessions WHERE id=$1 AND removed_at IS NULL", [notice.recipient_id])).length > 0
  if (!recipient || notice.cause !== "interhub_escalation") return recipient
  const escalationId = String(notice.session_id).slice(ESCALATION_SENDER.length)
  return (await sql.query(`SELECT 1 FROM interhub_escalations e JOIN chat_channels c ON c.id=e.channel_id
    WHERE e.id=$1 AND e.answered_at IS NULL AND c.closed_at IS NULL AND c.deleted_at IS NULL AND c.leader_id=$2`, [escalationId, notice.recipient_id])).length > 0
}

const activeTeams = ACTIVE_TEAM_STATES.map(state => `'${state}'`).join(",")

/**
 * Open agent sessions this hub contributes to an inter-hub channel: its leader there, sessions of the channel, local
 * agents the leader associated with it and joined members of active teams mastered in it. Shared by the roster and the
 * transport's presence announcements, so remote hubs accept as authors exactly the agents the local roster lists.
 */
export async function localChannelAgents(sql: Sql, channelId: string, leaderId: string | null) {
  return sql.query(
    `SELECT s.* FROM chat_sessions s WHERE (s.id=$2 OR s.channel_id=$1 OR s.id IN (SELECT m.session_id FROM chat_team_members m JOIN chat_team_plans p ON p.id=m.team_id
       WHERE p.master_channel_id=$1 AND m.state='joined' AND p.state IN (${activeTeams}))
       OR s.id IN (SELECT a.session_id FROM interhub_local_agents a WHERE a.channel_id=$1 AND a.removed_at IS NULL))
     AND s.cli_kind NOT IN ($3,'hub') AND s.nickname IS NOT NULL AND s.removed_at IS NULL AND s.closed_at IS NULL ORDER BY s.created_at,s.id`, [channelId, leaderId, INTERHUB_REMOTE_CLI_KIND])
}

/**
 * Mentions of an inter-hub thread. An id that is not a local session but is a remote agent of the channel (its id in its
 * own hub, as memory_chat_interhub_hubs lists it) becomes that agent's local placeholder, created when it has not written
 * here yet. Any other id is returned unchanged for the caller's usual validation.
 */
export async function interhubMentions(sql: Sql, channelId: string, mentions: string[]) {
  const resolved: string[] = []
  for (const mention of mentions) {
    if ((await sql.query("SELECT 1 FROM chat_sessions WHERE id=$1", [mention])).length) { resolved.push(mention); continue }
    const remote = (await sql.query(`SELECT r.hub_id,r.label FROM interhub_remote_sessions r JOIN interhub_members m ON m.channel_id=r.channel_id AND m.hub_id=r.hub_id AND m.removed_at IS NULL
        WHERE r.channel_id=$1 AND r.session_id=$2
      UNION ALL SELECT hub_id,leader_label FROM interhub_members WHERE channel_id=$1 AND leader_session_id=$2 AND removed_at IS NULL LIMIT 1`, [channelId, mention]))[0]
    if (!remote) { resolved.push(mention); continue }
    const placeholder = interhubRemoteSessionId(channelId, String(remote.hub_id), mention)
    await sql.query(`INSERT OR IGNORE INTO chat_sessions(id,agent_id,key_hash,label,cli_kind,channel_id,state,event_at,closed_at)
      VALUES($1,$1,$1,$2,$3,$4,'offline',now(),now())`, [placeholder, String(remote.label), INTERHUB_REMOTE_CLI_KIND, channelId])
    const row = (await sql.query("SELECT cli_kind,channel_id FROM chat_sessions WHERE id=$1", [placeholder]))[0]
    resolved.push(row?.cli_kind === INTERHUB_REMOTE_CLI_KIND && row.channel_id === channelId ? placeholder : mention)
  }
  return resolved
}

/** Local placeholder id of every remote agent of the channel known here (announced or hub leader), mapped to its remote id. */
export async function remoteAgentIds(sql: Sql, channelId: string) {
  const rows = await sql.query(`SELECT hub_id,session_id FROM interhub_remote_sessions WHERE channel_id=$1
    UNION SELECT hub_id,leader_session_id FROM interhub_members WHERE channel_id=$1 AND leader_session_id IS NOT NULL`, [channelId])
  return new Map(rows.map(row => [interhubRemoteSessionId(channelId, String(row.hub_id), String(row.session_id)), String(row.session_id)]))
}

type LocalHub = () => Promise<{ id: string; name: string }>

/** `chat_channels` items: hub_count only on inter-hub channels; every other item is returned untouched. */
export async function interhubChannelFields<T extends Record<string, any>>(sql: Sql, items: T[]) {
  const ids = items.filter(item => item.kind === INTERHUB_CHANNEL_KIND).map(item => String(item.id))
  if (!ids.length) return items
  const counts = new Map((await sql.query("SELECT channel_id,count(*) AS n FROM interhub_members WHERE removed_at IS NULL AND channel_id IN (SELECT value FROM json_each($1)) GROUP BY channel_id",
    [JSON.stringify(ids)])).map(row => [String(row.channel_id), Number(row.n)]))
  return items.map(item => item.kind === INTERHUB_CHANNEL_KIND ? { ...item, hub_count: counts.get(String(item.id)) ?? 0 } : item)
}

/** `chat_threads` items: hub_count (distinct hubs whose agents wrote) only on threads of inter-hub channels. */
export async function interhubThreadFields<T extends Record<string, any>>(sql: Sql, items: T[]) {
  if (!items.length) return items
  const channels = new Set((await sql.query("SELECT id FROM chat_channels WHERE kind=$1 AND id IN (SELECT value FROM json_each($2))",
    [INTERHUB_CHANNEL_KIND, JSON.stringify([...new Set(items.map(item => String(item.channel_id)))])])).map(row => String(row.id)))
  const threads = items.filter(item => channels.has(String(item.channel_id))).map(item => String(item.id))
  if (!threads.length) return items
  // Remote hubs are counted by origin; every message without an origin was written here. Hub notices are not agents.
  const counts = new Map((await sql.query(`SELECT m.thread_id,count(DISTINCT o.hub_id)+max(CASE WHEN o.message_id IS NULL THEN 1 ELSE 0 END) AS n
    FROM chat_messages m JOIN chat_sessions s ON s.id=m.author_id LEFT JOIN interhub_message_origins o ON o.message_id=m.id
    WHERE m.thread_id IN (SELECT value FROM json_each($1)) AND s.cli_kind<>'hub' GROUP BY m.thread_id`, [JSON.stringify(threads)])).map(row => [String(row.thread_id), Number(row.n)]))
  return items.map(item => channels.has(String(item.channel_id)) ? { ...item, hub_count: counts.get(String(item.id)) ?? 0 } : item)
}

/**
 * `chat_read` items of an inter-hub channel: origin_hub and author_role. Remote messages take them from their verified
 * origin; local ones carry this hub, as leader when written by the channel's local leader. Other channels pass through.
 */
export async function interhubMessageFields<T extends Record<string, any>>(sql: Sql, channelId: string, items: T[], localHub: LocalHub) {
  const channel = (await sql.query("SELECT kind,leader_id FROM chat_channels WHERE id=$1", [channelId]))[0]
  if (channel?.kind !== INTERHUB_CHANNEL_KIND || !items.length) return items
  const origins = new Map((await sql.query(`SELECT o.message_id,o.hub_id,o.hub_name,o.author_role,m.peer_identity FROM interhub_message_origins o
    LEFT JOIN interhub_members m ON m.channel_id=$2 AND m.hub_id=o.hub_id WHERE o.message_id IN (SELECT value FROM json_each($1))`,
  [JSON.stringify(items.map(item => String(item.id))), channelId])).map(row => [String(row.message_id), row]))
  // Placeholders hide the remote session id; the announced cli_kind is recovered through the same derivation.
  const remoteKinds = new Map(origins.size ? (await sql.query("SELECT hub_id,session_id,cli_kind FROM interhub_remote_sessions WHERE channel_id=$1", [channelId]))
    .map(row => [interhubRemoteSessionId(channelId, String(row.hub_id), String(row.session_id)), String(row.cli_kind)]) : [])
  const local = items.some(item => !origins.has(String(item.id))) ? await localHub() : null
  return items.map(item => {
    const origin = origins.get(String(item.id))
    if (origin) {
      const hub: InterhubMessageOrigin = { id: String(origin.hub_id), name: hubName(origin, String(origin.hub_name)), is_local: false }
      const cliKind = remoteKinds.get(String(item.author_id))
      return { ...item, ...(cliKind ? { cli_kind: cliKind } : {}), origin_hub: hub, author_role: origin.author_role === "leader" ? "leader" : "member" }
    }
    const hub: InterhubMessageOrigin = { id: local!.id, name: local!.name, is_local: true }
    const role: InterhubAgentRole | null = item.author_source === "hub" ? null : item.author_id === channel.leader_id ? "leader" : "member"
    return { ...item, origin_hub: hub, author_role: role }
  })
}
