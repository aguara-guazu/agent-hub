export const INTERHUB_CHAT_VERSION = 1 as const
export const INTERHUB_ESCALATION_TIMEOUT_MS = 5 * 60 * 1000

export type InterhubRemoteRole = "leader" | "member"

/**
 * Agent identity that is carried as untrusted display data. Its hub and peer
 * identity come from the verified transport envelope, never from this payload.
 */
export interface InterhubRemoteSessionPayload {
  id: string
  label: string
  cli_kind: string
  role: InterhubRemoteRole
}

export interface InterhubThreadPayload {
  id: string
  title: string
  created_at: string
}

export interface InterhubMessagePayload {
  id: string
  thread_id: string
  author: InterhubRemoteSessionPayload
  text: string
  mentions: string[]
  reply_to: string | null
  kind: "proposal" | "objection" | "fact" | "agreement" | "question" | null
  created_at: string
}

export interface InterhubPresencePayload {
  session: InterhubRemoteSessionPayload
  state: "online" | "offline" | "unknown"
  occurred_at: string
}

export interface InterhubEscalationPayload {
  id: string
  thread_id: string
  question_message_id: string
  from_hub_id: string
  to_hub_id: string
  created_at: string
}

export type InterhubChatPayload =
  | { type: "thread"; thread: InterhubThreadPayload }
  | { type: "message"; message: InterhubMessagePayload }
  | { type: "presence"; presence: InterhubPresencePayload }
  | { type: "escalation"; escalation: InterhubEscalationPayload }

/**
 * P2P hands this to the chat model only after signature, membership and peer
 * identity verification. origin_hub_id is authoritative transport context.
 */
export interface VerifiedInterhubChatEnvelope {
  id: string
  version: typeof INTERHUB_CHAT_VERSION
  channel_id: string
  origin_hub_id: string
  origin_hub_name: string
  origin_peer_id: string
  occurred_at: string
  payload: InterhubChatPayload
}

export interface InterhubLocalDeliveryEnvelope {
  message_id: string
  recipient_session_ids: string[]
}

export interface InterhubEscalationState {
  channel_id: string
  thread_id: string
  question_message_id: string
  last_hub_id: string | null
  next_hub_id: string | null
  escalated_at: string
  answered_at: string | null
}
