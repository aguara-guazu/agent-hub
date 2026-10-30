export const INTERHUB_TRANSPORT_VERSION = 1 as const

export type InterHubEventKind = "membership" | "message" | "thread" | "code"

export interface InterHubEnvelope<T = unknown> {
  version: typeof INTERHUB_TRANSPORT_VERSION
  id: string
  channel_id: string
  origin_hub_id: string
  origin_peer_public_key: string
  origin_agent_id: string | null
  kind: InterHubEventKind
  occurred_at: string
  payload: T
  signature: string
}

export interface InterHubMembershipPayload {
  action: "joined" | "removed"
  hub_id: string
  leader_id: string
  leader_label: string
  peer_public_key: string
}

export interface InterHubCodePayload {
  action: "revoked" | "regenerated"
  generation: number
}

export interface InterHubCatchupCursor {
  channel_id: string
  cursor: number
}

export interface InterHubTransport {
  publish(envelope: InterHubEnvelope): Promise<void>
  subscribe(channelId: string, afterCursor?: number): AsyncIterable<InterHubEnvelope>
  requestCatchup(channelId: string, cursor?: number): Promise<InterHubCatchupCursor>
}
