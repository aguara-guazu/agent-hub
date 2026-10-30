import type { InterhubAgentRole, InterhubMessageOrigin } from "./interhub.js"

export const INTERHUB_CHAT_VERSION = 1 as const
/** A leader's unanswered question waits this long before another hub is asked, and again between rounds. */
export const INTERHUB_ESCALATION_TIMEOUT_MS = 5 * 60 * 1000
/** Largest accepted lead of a remote timestamp over the receiving hub's clock. */
export const INTERHUB_CLOCK_SKEW_MS = 5 * 60 * 1000
/**
 * Deadline of a join with a code: P2P discovery of the creator hub, the connection redials and the proof exchange.
 * Only a test process (NODE_ENV=test) may use another value.
 */
export const INTERHUB_JOIN_TIMEOUT_MS = 90 * 1000
/** Name of the hub memory operation that joins with a code; clients that proxy it must allow INTERHUB_JOIN_TIMEOUT_MS. */
export const INTERHUB_JOIN_OPERATION = "chat_interhub_join"

export type InterhubRemoteRole = "leader" | "member"

/**
 * Agent identity that is carried as untrusted display data. Its hub and peer identity come from the verified
 * transport envelope, never from this payload. `id` must equal the envelope's `origin_agent_id`; `role` is
 * informative only: the receiver derives it from the origin hub's signed membership (its leader session).
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
  author: InterhubRemoteSessionPayload
  created_at: string
}

export interface InterhubMessagePayload {
  id: string
  thread_id: string
  author: InterhubRemoteSessionPayload
  text: string
  /** Global session ids; only sessions of the receiving hub associated with the channel get a delivery. */
  mentions: string[]
  reply_to: string | null
  kind: "proposal" | "objection" | "fact" | "agreement" | "question" | null
  created_at: string
}

/** Announces an agent of the origin hub; an author must be announced (or be the hub's leader) before it writes. */
export interface InterhubPresencePayload {
  session: InterhubRemoteSessionPayload
  state: "online" | "offline" | "unknown"
  occurred_at: string
}

/** One round: from_hub_id is the asking hub (must equal the verified origin), to_hub_id the hub whose leader asks its person. */
export interface InterhubEscalationPayload {
  id: string
  thread_id: string
  question_message_id: string
  from_hub_id: string
  to_hub_id: string
  created_at: string
}

export interface InterhubEscalationResolutionPayload {
  escalation_id: string
  /** Hub whose leader settled the escalation; must equal the verified origin. */
  hub_id: string
  resolved_at: string
}

export type InterhubChatPayload =
  | { type: "thread"; thread: InterhubThreadPayload }
  | { type: "message"; message: InterhubMessagePayload }
  | { type: "presence"; presence: InterhubPresencePayload }
  | { type: "escalation"; escalation: InterhubEscalationPayload }
  | { type: "escalation_resolved"; resolution: InterhubEscalationResolutionPayload }

/**
 * P2P hands this to the chat model only after signature, membership and peer identity verification.
 * origin_hub_id, origin_hub_name and origin_peer_id come from the verified peer identity; origin_agent_id
 * from the signed transport envelope. The chat model re-validates the shape and never trusts payload identity.
 */
export interface VerifiedInterhubChatEnvelope {
  id: string
  version: typeof INTERHUB_CHAT_VERSION
  channel_id: string
  origin_hub_id: string
  origin_hub_name: string
  origin_peer_id: string
  origin_agent_id: string | null
  occurred_at: string
  payload: InterhubChatPayload
}

export interface InterhubLocalDeliveryEnvelope {
  message_id: string
  recipient_session_ids: string[]
}

export interface InterhubEscalationState {
  id: string
  channel_id: string
  thread_id: string
  question_message_id: string
  last_hub_id: string | null
  next_hub_id: string | null
  /** Receiving hub's clock: start of the current round. */
  escalated_at: string
  answered_at: string | null
}

/** Extra fields of each `chat_read` item, only in inter-hub channels. Local messages carry the local hub. */
export interface InterhubMessageReadFields {
  origin_hub: InterhubMessageOrigin
  /** Null for Hub system messages. */
  author_role: InterhubAgentRole | null
}

/** Extra field of `chat_channels` items of kind inter-hub: member hubs not removed. */
export interface InterhubChannelReadFields {
  hub_count: number
}

/** Extra field of `chat_threads` items of inter-hub channels: distinct hubs whose agents wrote in the thread. */
export interface InterhubThreadReadFields {
  hub_count: number
}
