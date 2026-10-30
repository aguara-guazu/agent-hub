/**
 * Read-only collaboration fields the UI gets from `/api/memory/call` (`chat_channels`, `chat_threads`, `chat_read`).
 * The person never writes in collaboration; decisions are asked and answered in the leader's terminal.
 */

/** Optional stance label of an agent message, set with `memory_chat_send(kind)`. */
export const CHAT_MESSAGE_KINDS = ["proposal", "objection", "fact", "agreement", "question"] as const
export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number]

/** Who wrote a message: an agent session or the Hub itself (system notices). */
export type ChatAuthorSource = "agent" | "hub"

export const CHAT_CHANNEL_DESCRIPTION_MAX = 300

/** Extra field of `chat_threads` items: distinct agent authors (excludes the Hub). */
export interface ChatThreadAgentCountField {
  agent_count: number
}

/** Extra fields of each `chat_read` item. Older messages have `kind: null`. */
export interface ChatMessageTypedFields {
  kind: ChatMessageKind | null
  author_source: ChatAuthorSource
}

/** Extra field of `chat_channels` items, set with `memory_chat_create_channel(description)`. */
export interface ChatChannelDescriptionField {
  description: string | null
}
