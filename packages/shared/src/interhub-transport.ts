export const INTERHUB_TRANSPORT_VERSION = 1 as const

/** thread/message carry chat, presence the agent list of a hub, escalation both escalation payloads. */
export type InterHubEventKind = "membership" | "message" | "thread" | "presence" | "escalation" | "code"

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

/** Public P2P identity of a hub; `id` is the digest of both keys. */
export interface InterHubPeerIdentity {
  id: string
  signing: string
  encryption: string
  name: string
}

/**
 * `joined` is accepted from the creator hub (admission) or from the hub itself (leader change of an existing member).
 * `removed` is accepted from the creator hub or from the hub itself.
 */
export interface InterHubMembershipPayload {
  action: "joined" | "removed"
  hub_id: string
  leader_id: string
  leader_label: string
  peer_public_key: string
  peer_identity: InterHubPeerIdentity
}

/** Informative only: the code itself never leaves the creator hub. */
export interface InterHubCodePayload {
  action: "revoked" | "regenerated"
  generation: number
}

export interface InterHubRosterMember {
  hub_id: string
  peer_identity: InterHubPeerIdentity
  leader_session_id: string | null
  leader_label: string
  joined_at: string
}

/** Channel state the creator hub returns to a hub that proved the code, signed with the creator's identity. */
export interface InterHubSignedRoster {
  version: typeof INTERHUB_TRANSPORT_VERSION
  channel: { id: string; name: string; description: string | null; creator_hub_id: string; created_at: string }
  members: InterHubRosterMember[]
  issued_at: string
  signature: string
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
