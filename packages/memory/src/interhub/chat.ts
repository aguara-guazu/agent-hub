import { randomUUID } from "node:crypto"
import type { InterhubChatPayload, InterhubEscalationState, VerifiedInterhubChatEnvelope } from "@agenthub/shared"
import { check } from "../contracts.js"
import type { Sql } from "../database.js"
import type { MemoryStore } from "../store.js"

export const interhubEscalationTimeout = () => process.env.NODE_ENV === "test" && process.env.AGENTHUB_INTERHUB_ESCALATION_MS
  ? Number(process.env.AGENTHUB_INTERHUB_ESCALATION_MS)
  : 5 * 60 * 1000

export interface InterhubHub {
  id: string
  name: string
  is_local: boolean
  connection: "online" | "offline" | "unknown"
}

export interface InterhubChatDependencies {
  hubs(channelId: string): Promise<InterhubHub[]>
  localHubId(): Promise<string>
  publish(channelId: string, payload: InterhubChatPayload): Promise<void>
}

/** Materializes only envelopes whose peer, membership and signature P2P has verified. */
export class InterhubChat {
  constructor(readonly store: MemoryStore, readonly transport: InterhubChatDependencies) {}

  private async channel(sql: Sql, channelId: string) {
    const channel = (await sql.query("SELECT * FROM chat_channels WHERE id=$1 AND kind='inter-hub' AND closed_at IS NULL AND deleted_at IS NULL", [channelId]))[0]
    check(channel, "Canal entre hubs inexistente.", 404)
    return channel
  }

  async receive(envelope: VerifiedInterhubChatEnvelope) {
    check(envelope.version === 1 && /^[0-9a-f-]{36}$/i.test(envelope.id), "Sobre inter-hub inválido", 400)
    return this.store.db.transaction(async sql => {
      await this.channel(sql, envelope.channel_id)
      const inserted = await sql.query("INSERT OR IGNORE INTO interhub_received_envelopes(envelope_id,channel_id,origin_hub_id,origin_peer_id,occurred_at) VALUES($1,$2,$3,$4,$5) RETURNING envelope_id", [envelope.id, envelope.channel_id, envelope.origin_hub_id, envelope.origin_peer_id, envelope.occurred_at])
      if (!inserted.length) return { duplicate: true }
      const payload = envelope.payload
      if (payload.type === "presence") {
        const session = payload.presence.session
        await sql.query(`INSERT INTO interhub_remote_sessions(channel_id,hub_id,session_id,label,cli_kind,role,state,peer_id,occurred_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT(channel_id,hub_id,session_id) DO UPDATE SET label=excluded.label,cli_kind=excluded.cli_kind,role=excluded.role,state=excluded.state,peer_id=excluded.peer_id,occurred_at=excluded.occurred_at,updated_at=now()
          WHERE excluded.occurred_at>=interhub_remote_sessions.occurred_at`, [envelope.channel_id, envelope.origin_hub_id, session.id, session.label, session.cli_kind, session.role, payload.presence.state, envelope.origin_peer_id, payload.presence.occurred_at])
        return { duplicate: false, kind: payload.type }
      }
      if (payload.type === "thread") {
        const thread = payload.thread
        await sql.query("INSERT OR IGNORE INTO chat_threads(id,channel_id,title,created_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)", [thread.id, envelope.channel_id, thread.title, `interhub:${envelope.origin_hub_id}`, thread.created_at])
        return { duplicate: false, kind: payload.type }
      }
      if (payload.type === "message") return this.receiveMessage(sql, envelope)
      if (payload.type === "escalation") {
        const escalation = payload.escalation
        await sql.query(`INSERT OR IGNORE INTO interhub_escalations(id,channel_id,thread_id,question_message_id,last_hub_id,next_hub_id,escalated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [escalation.id, envelope.channel_id, escalation.thread_id, escalation.question_message_id, escalation.from_hub_id, escalation.to_hub_id, escalation.created_at])
        return { duplicate: false, kind: payload.type }
      }
      return { duplicate: false }
    })
  }

  private async receiveMessage(sql: Sql, envelope: VerifiedInterhubChatEnvelope) {
    const message = (envelope.payload as Extract<InterhubChatPayload, { type: "message" }>).message
    const thread = (await sql.query("SELECT id FROM chat_threads WHERE id=$1 AND channel_id=$2", [message.thread_id, envelope.channel_id]))[0]
    check(thread, "El mensaje inter-hub refiere a un hilo inexistente", 409)
    const authorId = `interhub:${envelope.origin_hub_id}:${message.author.id}`
    await sql.query(`INSERT OR IGNORE INTO chat_sessions(id,agent_id,key_hash,label,cli_kind,channel_id,state,event_at,closed_at)
      VALUES($1,$2,$3,$4,'interhub-remote',$5,'offline',$6,$6)`, [authorId, authorId, envelope.id, message.author.label, envelope.channel_id, message.created_at])
    await sql.query("INSERT OR IGNORE INTO chat_messages(id,thread_id,author_id,text,reply_to,request_id,request_hash,kind,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [message.id, message.thread_id, authorId, message.text, message.reply_to, envelope.id, envelope.id, message.kind, message.created_at])
    await sql.query("INSERT OR IGNORE INTO interhub_message_origins(message_id,envelope_id,hub_id,hub_name,peer_id,author_role) VALUES($1,$2,$3,$4,$5,$6)", [message.id, envelope.id, envelope.origin_hub_id, envelope.origin_hub_name, envelope.origin_peer_id, message.author.role])
    // Remote IDs are never recipients. Only matching local sessions receive durable local delivery and wakes.
    for (const id of message.mentions) await sql.query(`INSERT OR IGNORE INTO chat_deliveries(message_id,recipient_id)
      SELECT $1,s.id FROM chat_sessions s WHERE s.id=$2 AND s.channel_id=$3 AND s.cli_kind<>'interhub-remote' AND s.closed_at IS NULL AND s.removed_at IS NULL`, [message.id, id, envelope.channel_id])
    await sql.query("UPDATE chat_threads SET updated_at=MAX(updated_at,$2),archived_notice=0 WHERE id=$1", [message.thread_id, message.created_at])
    return { duplicate: false, kind: "message" as const }
  }

  async escalate(caller: { id: string; channel_id: string }, channelId: string, threadId: string, messageId: string) {
    return this.store.db.transaction(async sql => {
      const channel = await this.channel(sql, channelId)
      check(channel.leader_id === caller.id, "Sólo el líder local del canal puede escalar.", 403)
      const message = (await sql.query("SELECT id,created_at FROM chat_messages WHERE id=$1 AND thread_id=$2", [messageId, threadId]))[0]
      check(message, "La pregunta no pertenece al hilo.", 404)
      check(Date.now() - Date.parse(message.created_at) >= interhubEscalationTimeout(), "La pregunta todavía no cumplió el plazo de escalada.", 409)
      const hubs = (await this.transport.hubs(channelId)).filter(hub => !hub.is_local && hub.connection === "online")
      if (!hubs.length) return { no_other_hub: true as const }
      const current = (await sql.query("SELECT * FROM interhub_escalations WHERE channel_id=$1 AND thread_id=$2 AND question_message_id=$3", [channelId, threadId, messageId]))[0] as InterhubEscalationState | undefined
      const start = current?.last_hub_id ? Math.max(0, hubs.findIndex(hub => hub.id === current.last_hub_id) + 1) : 0
      const target = hubs[start % hubs.length]!
      const id = current?.id ?? randomUUID(), now = new Date().toISOString()
      await sql.query(`INSERT INTO interhub_escalations(id,channel_id,thread_id,question_message_id,last_hub_id,next_hub_id,escalated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(channel_id,thread_id,question_message_id) DO UPDATE SET last_hub_id=excluded.last_hub_id,next_hub_id=excluded.next_hub_id,escalated_at=excluded.escalated_at,updated_at=now()`, [id, channelId, threadId, messageId, target.id, target.id, now])
      await this.transport.publish(channelId, { type: "escalation", escalation: { id, thread_id: threadId, question_message_id: messageId, from_hub_id: await this.transport.localHubId(), to_hub_id: target.id, created_at: now } })
      return { delegated_to_hub_id: target.id }
    })
  }
}
