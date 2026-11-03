/**
 * Read-only inter-hub channel fields the UI gets from `/api/memory/interhub/*` and `chat_read`.
 * The UI does not request the secret join code; it is never included in the roster.
 */

/** Value of `chat_channels.kind` for a channel shared between several hubs. */
export const INTERHUB_CHANNEL_KIND = "inter-hub"

export type InterhubAgentRole = "leader" | "member"

export interface InterhubRosterAgent {
  id: string
  label: string
  cli_kind: string
  role: InterhubAgentRole
  state: string
}

export interface InterhubRosterHub {
  id: string
  name: string
  /** True for the hub that serves this response; listed first. */
  is_local: boolean
  agent_count: number
  /** One leader per hub inside the channel. */
  leader_id: string | null
  /** Leader first. */
  agents: InterhubRosterAgent[]
}

/** `GET /api/memory/interhub/channels/:id/roster` and the result of `memory_chat_interhub_hubs`. */
export interface InterhubRoster {
  hub_count: number
  agent_count: number
  hubs: InterhubRosterHub[]
}

/** Added by the Hub to each `chat_read` item of an inter-hub channel; derived from the verified peer identity, never from the message. */
export interface InterhubMessageOrigin {
  id: string
  name: string
  is_local: boolean
}
