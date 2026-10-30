/**
 * Contract between the collaboration backend (packages/memory local-chat*) and the UI (project Collaboration tab, Home).
 * The UI only reads collaboration: `/api/memory/call` (`chat_channels`, `chat_threads`, `chat_read`) and
 * `GET /api/memory/chat/pending-decisions`. The person approves in the leader's terminal; the leader records it over MCP.
 */

/** Optional stance of a thread message. Agents set it with `memory_chat_send(kind)`. */
export const CHAT_MESSAGE_KINDS = ["proposal", "objection", "fact", "agreement", "question"] as const
export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number]

/** Who wrote a message: an agent session or the Hub itself (system notices). */
export type ChatAuthorSource = "agent" | "hub"

export const CHAT_RESOLUTION_TEXT_MAX = 2000
export const CHAT_CHANNEL_DESCRIPTION_MAX = 300

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
  /** Sessions the proposer declared in agreement (always thread participants; the proposer counts). */
  agreed_session_ids: string[]
  agreed_labels: string[]
  agreed_count: number
  /** Distinct agent authors of the thread when proposed: the «de N» of «M de N agentes de acuerdo». */
  participant_count: number
  created_at: string
  decided_at: string | null
  /** Session (leader or team master) that recorded the person's answer given in its terminal. */
  decided_by: string | null
  /** Always `coordinator_declaration`: the Hub records the leader's audited declaration, not an authenticated UI approval. */
  decision_source: "coordinator_declaration" | null
  decision_note: string | null
  /** `kind: "fact"`, `data.category: "decision"` entity created on approval (Project › Decisions). */
  decision_entity_id: string | null
}

/** Derived thread status for the UI chip: «En debate», «Espera tu decisión», resolved. */
export type ChatDebateState = "open" | "awaiting_decision" | "resolved"

/** Extra fields of `chat_threads` items (existing fields unchanged). */
export interface ChatThreadDebateFields {
  /** Distinct agent authors (excludes the Hub). */
  agent_count: number
  debate_state: ChatDebateState
  pending_resolution: Pick<ChatResolution, "id" | "text" | "agreed_count" | "participant_count" | "created_at"> | null
}

/** Extra fields of each `chat_read` item. Older messages have `kind: null`. */
export interface ChatMessageTypedFields {
  kind: ChatMessageKind | null
  author_source: ChatAuthorSource
}

/** `chat_read` also returns the latest resolution of the thread (pending or decided), or null. */
export interface ChatReadResolutionField {
  resolution: ChatResolution | null
}

/** Extra fields of `chat_channels` items. */
export interface ChatChannelDebateFields {
  description: string | null
  /** Threads of the channel (and its team threads) with a pending resolution: the channel badge. */
  awaiting_decision: number
}

/** Row of `GET /api/memory/chat/pending-decisions?project_id=&limit=&offset=`. Newest first. */
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
