/**
 * Read-only collaboration fields the UI gets from `/api/memory/call` (`chat_channels`, `chat_agents`, `chat_threads`, `chat_read`).
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

// Wrap-up and archive delays. Production always uses these values; the Hub reads the AGENTHUB_CHAT_AGENT_INACTIVITY_MS,
// AGENTHUB_CHAT_ARCHIVE_IDLE_MS, AGENTHUB_CHAT_ARCHIVE_PROPOSED_MS and AGENTHUB_CHAT_ARCHIVE_SWEEP_MS overrides only in a
// test process (NODE_ENV=test).

/** Agents without Hub-observed activity for this long may be cleaned by the channel leader without declaring them finished. */
export const CHAT_AGENT_INACTIVITY_MS = 6 * 60 * 60 * 1000
/** A local channel with no connected agent or leader is archived this long after its last activity. */
export const CHAT_CHANNEL_ARCHIVE_IDLE_MS = 48 * 60 * 60 * 1000
/** Delay after a leader's `memory_chat_propose_archive`, while no later use of the channel cancels the proposal. */
export const CHAT_CHANNEL_ARCHIVE_PROPOSED_MS = 24 * 60 * 60 * 1000
/** Interval between archive evaluations of the server sweep; revivals and proposal cancellations are checked on every tick. */
export const CHAT_CHANNEL_ARCHIVE_SWEEP_MS = 60 * 1000

/** `inactive`: 48 h rule; `proposed`: the leader's proposal shortened it to 24 h. */
export const CHAT_CHANNEL_ARCHIVE_CAUSES = ["inactive", "proposed"] as const
export type ChatChannelArchiveCause = (typeof CHAT_CHANNEL_ARCHIVE_CAUSES)[number]

/**
 * `chat_channels` input. Default: archived channels excluded. `archived: true`: only archived ones, newest archive first
 * (the «Archivados» section). `include_archived: true`: both. `channel_id` and `deleted: true` ignore the archive filter.
 */
export interface ChatChannelsArchiveFilter {
  archived?: boolean
  include_archived?: boolean
}

/** Extra fields of `chat_channels` items. Inter-hub, automation and team worker channels are never archived. */
export interface ChatChannelArchiveFields {
  archived_at: string | null
  archive_cause: ChatChannelArchiveCause | null
  /** Pending proposal; cleared by any later use of the channel or by a revival. */
  archive_proposed_at: string | null
  /** Session id of the leader that proposed it. */
  archive_proposed_by: string | null
  archive_proposal_reason: string | null
  /** Last revival; the 48 h count restarts from it. */
  unarchived_at: string | null
  /** Last Hub-observed use: channel lifecycle, threads, messages, work reports, activity of its agents and team members. */
  last_activity_at: string
}

/** Extra field of `chat_threads` items: archive date of the thread's channel. */
export interface ChatThreadChannelArchiveField {
  channel_archived_at: string | null
}

/**
 * Extra fields of session objects (`chat_agents` items, registrations). Default `chat_agents` excludes a session the
 * leader cleaned while `last_activity_at <= dismissed_at`; `include_dismissed: true` returns it (audit).
 */
export interface ChatSessionActivityFields {
  /** Server clock of the last Hub-observed activity: hook events other than heartbeats, collaboration calls, fleet protocol events. */
  last_activity_at: string
  dismissed_at: string | null
  /** `agent:<session id>` of the leader that cleaned it. */
  dismissed_by: string | null
  dismissal_reason: string | null
}

/** `inactive`: no activity for CHAT_AGENT_INACTIVITY_MS; `declared_finished`: listed by the leader in `finished_ids`. */
export type ChatCleanupBasis = "inactive" | "declared_finished"
/** `recent_activity`: active within the threshold and not declared finished; `reclaim_right`: the displaced leader of the channel. */
export type ChatCleanupBlock = "recent_activity" | "reclaim_right"
/** `not_listed`: the id is not in the channel's agent list (already cleaned, kicked, closed outside a team, other channel). */
export type ChatCleanupSkip = ChatCleanupBlock | "not_listed"

export interface ChatCleanupCandidate {
  id: string
  label: string
  cli_kind: string
  role: "member" | "team_member"
  team_id: string | null
  member_state: string | null
  state: string
  connection_state: string
  closed_at: string | null
  last_activity_at: string
  inactive_ms: number
  eligible: boolean
  basis: ChatCleanupBasis | null
  blocked: ChatCleanupBlock | null
}

/** Result of `memory_chat_clean_agents`. Without `apply` it only evaluates: `cleaned` is empty. */
export interface ChatCleanAgentsResult {
  channel_id: string
  evaluated_at: string
  inactivity_threshold_ms: number
  applied: boolean
  candidates: ChatCleanupCandidate[]
  cleaned: Array<{ id: string; label: string; basis: ChatCleanupBasis; dismissed_at: string }>
  skipped: Array<{ id: string; code: ChatCleanupSkip }>
  event_id: string | null
}

/** Result of `memory_chat_propose_archive`. `waiting_for`: connected agents of the channel, other than the proposer, that hold the archive. */
export interface ChatProposeArchiveResult {
  channel_id: string
  archive_proposed_at: string
  archive_proposed_by: string
  archive_due_at: string
  unchanged: boolean
  waiting_for: Array<{ id: string; label: string }>
  event_id: string | null
}

/** `chat_authority_events` kinds written by agent cleanup and channel archiving. */
export const CHAT_WRAP_UP_EVENT_KINDS = ["agents_cleaned", "channel_archive_proposed", "channel_archive_proposal_cancelled", "channel_archived", "channel_unarchived"] as const
export type ChatWrapUpEventKind = (typeof CHAT_WRAP_UP_EVENT_KINDS)[number]
