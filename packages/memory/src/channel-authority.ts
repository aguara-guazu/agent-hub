import type { Sql } from "./database.js"
import { channelMembership, type ChannelMembership } from "./chat-access.js"

/** A leader silent for longer than this, as measured by the Hub, may be replaced by a same-project agent. */
export const LEADER_LIVENESS_TIMEOUT_MS = 20 * 60_000
/** A session that lost a channel's leadership cannot take it over again before this elapses. */
export const LEADERSHIP_COOLDOWN_MS = 10 * 60_000
/** Lease granted by every hook, PID check or fleet probe; lease_until minus this is the last verified signal. */
export const SESSION_LEASE_MS = 90_000
export const LEADERSHIP_ATTEMPT_WINDOW_MS = 10 * 60_000
export const LEADERSHIP_ATTEMPTS_PER_SESSION = 3
export const LEADERSHIP_ATTEMPTS_PER_CHANNEL = 10
export const LEADERSHIP_EVENT_KINDS = ["leadership_takeover", "leadership_reclaim", "leadership_rejected"] as const

/**
 * Write authority in a channel: the shared membership minus a leader displaced from it, whose rights stay frozen until it
 * reclaims. "team" never grants general writes; team threads keep their own thread-bound check.
 */
export async function writeAssociation(sql: Sql, sessionId: string, channelId: string): Promise<Exclude<ChannelMembership, "team"> | null> {
  const membership = await channelMembership(sql, sessionId, channelId)
  if (membership === "leader") return membership
  if (membership !== "member") return null
  const displaced = (await sql.query("SELECT 1 FROM chat_channels WHERE id=$1 AND displaced_leader_id=$2", [channelId, sessionId])).length
  return displaced ? null : membership
}

export type LivenessEvidence = { last_liveness_at: string; source: "lease" | "last_seen" | "created" | "closed"; silent_ms: number }

/** Last signal the Hub itself recorded for a session (hooks, PID birth check, fleet probe, authenticated inbox). */
export function lastLiveness(session: Record<string, any>, now = Date.now()): LivenessEvidence {
  const lease = Date.parse(session.lease_until) - SESSION_LEASE_MS
  const seen = Date.parse(session.last_seen_at)
  let at: number, source: LivenessEvidence["source"]
  if (Number.isFinite(lease) && !(seen > lease)) { at = lease; source = "lease" }
  else if (Number.isFinite(seen)) { at = seen; source = "last_seen" }
  else { at = Date.parse(session.created_at); source = "created" }
  const closed = Date.parse(session.closed_at)
  if (Number.isFinite(closed) && closed < at) { at = closed; source = "closed" }
  if (!Number.isFinite(at)) at = 0
  return { last_liveness_at: new Date(at).toISOString(), source, silent_ms: Math.max(0, now - at) }
}

export function leaseActive(session: Record<string, any>, now = Date.now()) {
  return !session.closed_at && !session.removed_at && Date.parse(session.lease_until) > now
}
