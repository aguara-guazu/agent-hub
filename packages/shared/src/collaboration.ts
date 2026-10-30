/**
 * Contract between the collaboration backend (packages/memory local-chat*) and the UI (project Collaboration tab, Home).
 * Reads keep using `/api/memory/call` (`chat_channels`, `chat_threads`, `chat_read`); person actions use the dedicated
 * authenticated routes below and are never MCP operations.
 */

/** Optional type of a thread message. Agents set it with `memory_chat_send(kind)`; the person may set it too. */
export const CHAT_MESSAGE_KINDS = ["proposal", "objection", "fact", "agreement", "question"] as const
export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number]

/** Who wrote a message: an agent session, the Hub itself (system notices) or the authenticated person. */
export type ChatAuthorSource = "agent" | "hub" | "person"

export const CHAT_PERSON_MESSAGE_MAX = 8000
export const CHAT_RESOLUTION_TEXT_MAX = 2000
export const CHAT_CHANNEL_NAME_MAX = 80
export const CHAT_CHANNEL_DESCRIPTION_MAX = 300
export const CHAT_DECISION_NOTE_MAX = 1000

export type ChatResolutionState = "pending" | "approved" | "rerun" | "superseded"

/** A thread's proposed resolution. At most one `pending` per thread; a new proposal supersedes the previous one. */
export interface ChatResolution {
  id: string
  thread_id: string
  channel_id: string
  project_id: string | null
  text: string
  state: ChatResolutionState
  proposed_by: string
  proposed_by_label: string
  /** Sessions the proposer declared in agreement (validated as thread participants or channel members). */
  agreed_session_ids: string[]
  agreed_labels: string[]
  agreed_count: number
  /** Distinct agent authors of the thread when proposed: the «de N» of «M de N agentes de acuerdo». */
  participant_count: number
  created_at: string
  decided_at: string | null
  decision_note: string | null
  /** `kind: "fact"`, `data.category: "decision"` entity created on approval (Project › Decisions). */
  decision_entity_id: string | null
}

/** Derived thread status for the UI chip: «En debate», «Espera tu decisión», resolved. */
export type ChatDebateState = "open" | "awaiting_decision" | "resolved"

/** Extra fields that `chat_threads` items now carry (existing fields stay unchanged). */
export interface ChatThreadDebateFields {
  /** Distinct agent authors (excludes the Hub and the person). */
  agent_count: number
  debate_state: ChatDebateState
  pending_resolution: Pick<ChatResolution, "id" | "text" | "agreed_count" | "participant_count" | "created_at"> | null
}

/** Extra fields of each `chat_read` item. Older messages have `kind: null`. */
export interface ChatMessageTypedFields {
  kind: ChatMessageKind | null
  author_source: ChatAuthorSource
}

/** `chat_read` now also returns the latest resolution of the thread (pending or decided), or null. */
export interface ChatReadResolutionField {
  resolution: ChatResolution | null
}

/** `chat_channels` items now carry an optional description. */
export interface ChatChannelDescriptionField {
  description: string | null
}

/** Row of `GET /api/memory/chat/pending-decisions`. Newest first. */
export interface ChatPendingDebate {
  resolution_id: string
  thread_id: string
  thread_title: string
  channel_id: string
  channel_name: string
  project_id: string | null
  project_title: string | null
  text: string
  agreed_count: number
  participant_count: number
  proposed_by_label: string
  created_at: string
}

/** `POST /api/memory/chat/threads/:threadId/messages` */
export interface ChatPersonMessageInput {
  text: string
  kind?: ChatMessageKind
  /** Stable per attempt so a retried click does not duplicate the message. */
  request_id: string
}
export interface ChatPersonMessageResult {
  message: { id: string; thread_id: string; text: string; kind: ChatMessageKind | null; author_source: "person"; created_at: string }
  /** Agent sessions notified through the Hub. */
  notified: number
}

/** `POST /api/memory/chat/threads/:threadId/resolution/approve` */
export interface ChatApproveResolutionInput {
  resolution_id: string
  note?: string
}
export interface ChatApproveResolutionResult {
  resolution: ChatResolution
  decision: { id: string; title: string; project_id: string }
  thread: { id: string; state: "resolved" }
  notified: number
}

/** `POST /api/memory/chat/threads/:threadId/resolution/rerun` */
export interface ChatRerunResolutionInput {
  resolution_id: string
  /** What the person wants the next round to address; sent to the agents as a person message. */
  note?: string
}
export interface ChatRerunResolutionResult {
  resolution: ChatResolution
  thread: { id: string; state: "open" }
  notified: number
}

/** `POST /api/memory/chat/channels` */
export interface ChatCreateChannelInput {
  project_id: string
  name: string
  description?: string
  /** Optional: an online agent session of the same project that will lead the channel (it keeps its other channels). */
  leader_session_id?: string
}
export interface ChatCreateChannelResult {
  channel: { id: string; project_id: string; name: string; description: string | null; leader_id: string | null; created_at: string }
}

/** Closed error codes of the person routes (HTTP 4xx `code`). */
export type ChatPersonErrorCode =
  | "thread_not_found" | "thread_resolved" | "channel_unavailable" | "resolution_not_pending" | "resolution_changed"
  | "no_project" | "leader_unavailable" | "request_conflict"
