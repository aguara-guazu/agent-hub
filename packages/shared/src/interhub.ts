/**
 * Read-only inter-hub channel fields the UI gets from `/api/memory/interhub/*` and `chat_read`.
 * The join code is a secret: it only travels in `InterhubChannelCode`, never in the views below.
 */

/** Value of `chat_channels.kind` for a channel shared between several hubs. */
export const INTERHUB_CHANNEL_KIND = "inter-hub"

export type InterhubConnection = "online" | "offline" | "unknown"

export interface InterhubHubView {
  hub_id: string
  name: string
  /** True for the hub that serves this response. */
  is_local: boolean
  connection: InterhubConnection
  agent_count: number
  /** One leader per hub inside the channel. */
  leader: { session_id: string; nickname: string } | null
}

export interface InterhubAgentView {
  id: string
  nickname: string
  hub_id: string
  is_leader: boolean
  cli_kind: string
  state: string
}

export interface InterhubChannelView {
  id: string
  name: string
  project_id: string | null
  creator_hub_id: string
  /** True when the serving hub created the channel (the only one that can show the code). */
  is_creator_hub: boolean
  hubs: InterhubHubView[]
  created_at: string
}

export interface InterhubChannelAgents {
  hubs: InterhubHubView[]
  agents: InterhubAgentView[]
}

/** Added by the Hub to each `chat_read` item of an inter-hub channel; derived from the verified peer identity. */
export interface InterhubMessageOrigin {
  hub_id: string
  hub_name: string
  is_local: boolean
}

/** Only for the authenticated person of the creator hub, and in the `create`/`regenerate` tool results. */
export interface InterhubChannelCode {
  channel_id: string
  code: string
}
