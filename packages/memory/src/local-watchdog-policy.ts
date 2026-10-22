export type WatchdogAction = "WAIT" | "UNKNOWN" | "ASK_STATUS" | "ALERT" | "RETRY_DELIVERY"
export const POLICY_VERSION = "2"

export interface WatchdogConfig {
  idleGraceMs: number
  observationMaxAgeMs: number
  statusCooldownMs: number
  maxStatusAttempts: number
  maxDeliveryAttempts: number
}

export const defaultWatchdogConfig: Readonly<WatchdogConfig> = Object.freeze({
  idleGraceMs: 120_000,
  observationMaxAgeMs: 120_000,
  statusCooldownMs: 120_000,
  maxStatusAttempts: 2,
  maxDeliveryAttempts: 5,
})

export interface WatchdogSnapshot {
  now: number
  work: {
    status: "active" | "waiting" | "completed"
    updatedAt: number
    lastProgressAt?: number | null
    waitingFor?: "human" | "permission" | "agent" | "tool" | "schedule" | null
    reportMessageId?: string | null
  } | null
  session?: {
    state: "idle" | "busy" | "blocked" | "offline" | "unknown" | "removed"
    observedAt: number | null
    stateSince: number | null
    leaseUntil: number | null
  } | null
  /** Persisted attempts for this work version; observation alone must not increment them. */
  recovery?: {
    statusAttempts: number
    lastStatusAttemptAt: number | null
    alertedAt: number | null
  }
  /** Receipt for the persisted report and its intended recipient, not another message. */
  delivery?: {
    notifiedAt: number | null
    readAt: number | null
    handledAt: number | null
    cancelledAt: number | null
    attempts: number
    nextAttemptAt: number | null
    error: string | null
  } | null
}

export interface WatchdogDecision {
  action: WatchdogAction
  reason: string
  evidence: string[]
  nextEvaluationAt: number | null
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/** Pure policy. All timestamps are epoch milliseconds; delivery attempts remain owned by transport. */
export function evaluateWatchdog(snapshot: WatchdogSnapshot, overrides: Partial<WatchdogConfig> = {}): WatchdogDecision {
  const config = { ...defaultWatchdogConfig, ...overrides }
  const decide = (action: WatchdogAction, reason: string, evidence: string[] = [], nextEvaluationAt: number | null = null): WatchdogDecision =>
    ({ action, reason, evidence, nextEvaluationAt })
  if (Object.values(config).some(value => !Number.isSafeInteger(value) || value <= 0) ||
      config.maxStatusAttempts > 10 || config.maxDeliveryAttempts > 10 ||
      Math.max(config.idleGraceMs, config.observationMaxAgeMs, config.statusCooldownMs) > 86_400_000) {
    return decide("UNKNOWN", "invalid_config")
  }
  const { now, work, session, delivery } = snapshot
  if (!timestamp(now)) return decide("UNKNOWN", "invalid_now")
  if (!work) return decide("WAIT", "no_tracked_work")
  const past = (value: unknown): value is number => timestamp(value) && value <= now
  if (!past(work.updatedAt) || (work.lastProgressAt != null && (!past(work.lastProgressAt) || work.lastProgressAt > work.updatedAt))) {
    return decide("UNKNOWN", "invalid_work_timestamps")
  }
  const recovery = snapshot.recovery ?? { statusAttempts: 0, lastStatusAttemptAt: null, alertedAt: null }
  if (!count(recovery.statusAttempts) ||
      (recovery.lastStatusAttemptAt != null && !past(recovery.lastStatusAttemptAt)) ||
      (recovery.alertedAt != null && !past(recovery.alertedAt)) ||
      (recovery.statusAttempts > 0 && recovery.lastStatusAttemptAt == null) ||
      (recovery.statusAttempts === 0 && recovery.lastStatusAttemptAt != null) ||
      (recovery.lastStatusAttemptAt != null && recovery.lastStatusAttemptAt < work.updatedAt) ||
      (recovery.alertedAt != null && recovery.alertedAt < work.updatedAt)) {
    return decide("UNKNOWN", "invalid_recovery_state")
  }
  const alert = (reason: string, evidence: string[]): WatchdogDecision => recovery.alertedAt != null
    ? decide("WAIT", "already_alerted", evidence)
    : decide("ALERT", reason, evidence)

  if (work.reportMessageId) {
    const evidence = ["report_persisted"]
    if (!delivery) return decide("UNKNOWN", "delivery_receipt_unknown", evidence)
    if ([delivery.notifiedAt, delivery.readAt, delivery.handledAt, delivery.cancelledAt].some(value => value != null && !past(value)) ||
        !count(delivery.attempts) || (delivery.nextAttemptAt != null && !timestamp(delivery.nextAttemptAt))) {
      return decide("UNKNOWN", "invalid_delivery_state", evidence)
    }
    if (delivery.cancelledAt != null) return decide("WAIT", "delivery_cancelled", evidence)
    if (delivery.handledAt != null) return decide("WAIT", "report_handled", [...evidence, "recipient_handled"])
    if (delivery.readAt != null) return decide("WAIT", "report_read_unhandled", [...evidence, "recipient_read"])
    if (delivery.notifiedAt != null && !delivery.error) {
      if (delivery.attempts >= config.maxDeliveryAttempts) {
        if (delivery.nextAttemptAt == null) return decide("UNKNOWN", "delivery_deadline_unknown", evidence)
        if (delivery.nextAttemptAt > now) return decide("WAIT", "delivery_cooldown", evidence, delivery.nextAttemptAt)
        // Queue acceptance is not a read receipt; this does not claim the transport failed.
        return alert("unread_notification_budget_exhausted", [...evidence, "transport_notified", "recipient_not_read"])
      }
      return decide("WAIT", "report_notified_unread", [...evidence, "transport_notified"])
    }
    if (delivery.attempts === 0) return decide("WAIT", "delivery_pending", evidence)
    if (delivery.nextAttemptAt == null) return decide("UNKNOWN", "delivery_deadline_unknown", evidence)
    if (delivery.nextAttemptAt > now) return decide("WAIT", "delivery_cooldown", evidence, delivery.nextAttemptAt)
    if (delivery.attempts >= config.maxDeliveryAttempts) return alert("delivery_attempts_exhausted", evidence)
    return decide("RETRY_DELIVERY", delivery.error ? "delivery_failed" : "delivery_unread_after_deadline", [...evidence, "transport_retry_due"])
  }
  if (work.status === "completed") return decide("UNKNOWN", "completed_without_report")
  if (work.status === "waiting") {
    if (!work.waitingFor) return decide("UNKNOWN", "waiting_reason_unknown")
    return decide("WAIT", "explicit_wait", [`waiting_for:${work.waitingFor}`])
  }
  if (work.status !== "active" || work.waitingFor) return decide("UNKNOWN", "inconsistent_work_state")
  if (!session) return decide("UNKNOWN", "session_observation_missing")
  if (!past(session.observedAt) || !past(session.stateSince) || session.stateSince > session.observedAt ||
      (session.leaseUntil != null && !timestamp(session.leaseUntil))) {
    return decide("UNKNOWN", "invalid_session_timestamps")
  }
  if (now - session.observedAt > config.observationMaxAgeMs) return decide("UNKNOWN", "session_observation_stale")
  if (session.state === "removed" || session.state === "offline") return decide("UNKNOWN", "session_unavailable", [`session:${session.state}`])
  if (session.leaseUntil == null || session.leaseUntil <= now) return decide("UNKNOWN", "session_lease_expired")
  if (session.state !== "idle") return decide("UNKNOWN", "session_not_confirmed_idle", [`session:${session.state}`])
  const evidence = ["tracked_incomplete_work", "fresh_idle_observation", "valid_session_lease"]
  const idleDeadline = Math.max(session.stateSince, work.updatedAt) + config.idleGraceMs
  if (!timestamp(idleDeadline)) return decide("UNKNOWN", "invalid_idle_deadline")
  if (now < idleDeadline) return decide("WAIT", "idle_grace", evidence, idleDeadline)
  if (recovery.alertedAt != null) return decide("WAIT", "already_alerted", evidence)
  if (recovery.lastStatusAttemptAt != null) {
    const cooldownDeadline = recovery.lastStatusAttemptAt + config.statusCooldownMs
    if (!timestamp(cooldownDeadline)) return decide("UNKNOWN", "invalid_cooldown_deadline")
    if (now < cooldownDeadline) return decide("WAIT", "status_cooldown", evidence, cooldownDeadline)
  }
  if (recovery.statusAttempts >= config.maxStatusAttempts) return alert("status_attempts_exhausted", evidence)
  return decide("ASK_STATUS", "incomplete_work_idle", evidence)
}
