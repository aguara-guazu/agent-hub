import { describe, expect, it } from "vitest"
import { defaultWatchdogConfig, evaluateWatchdog, type WatchdogSnapshot } from "../src/local-watchdog-policy.js"

const now = 1_000_000
const active = (): WatchdogSnapshot => ({
  now,
  work: { status: "active", updatedAt: now - 300_000, lastProgressAt: null },
  session: { state: "idle", observedAt: now, stateSince: now - 300_000, leaseUntil: now + 90_000 },
})
const completed = (): WatchdogSnapshot => ({
  ...active(),
  work: { status: "completed", updatedAt: now - 300_000, reportMessageId: "persisted-report" },
  delivery: { notifiedAt: null, readAt: null, handledAt: null, cancelledAt: null, attempts: 1, nextAttemptAt: now - 1, error: "transport unavailable" },
})

describe("deterministic watchdog evidence", () => {
  it("requires explicitly tracked incomplete work before asking for status", () => {
    expect(evaluateWatchdog(active())).toMatchObject({ action: "ASK_STATUS", reason: "incomplete_work_idle" })
    expect(evaluateWatchdog({ ...active(), work: null })).toMatchObject({ action: "WAIT", reason: "no_tracked_work" })
  })

  it.each(["human", "permission", "schedule", "agent", "tool"] as const)("protects an explicit %s wait regardless of silence or expired lease", waitingFor => {
    const snapshot = active()
    snapshot.work = { status: "waiting", waitingFor, updatedAt: 1 }
    snapshot.session!.leaseUntil = 2
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "WAIT", reason: "explicit_wait", evidence: [`waiting_for:${waitingFor}`] })
  })

  it.each(["busy", "blocked", "unknown", "offline", "removed"] as const)("does not infer a blockage from session state %s", state => {
    const snapshot = active()
    snapshot.session!.state = state
    expect(evaluateWatchdog(snapshot).action).toBe("UNKNOWN")
  })

  it("does not turn a fresh heartbeat into progress or proof that a busy process is stuck", () => {
    const snapshot = active()
    snapshot.session!.state = "busy"
    for (let tick = 0; tick < 20; tick++) {
      snapshot.now += 60_000
      snapshot.session!.observedAt = snapshot.now
      snapshot.session!.leaseUntil = snapshot.now + 90_000
      expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "UNKNOWN", reason: "session_not_confirmed_idle" })
    }
    expect(snapshot.work!.lastProgressAt).toBeNull()
  })

  it("requires both a fresh observation and an unexpired lease", () => {
    const snapshot = active()
    snapshot.session!.observedAt = now - defaultWatchdogConfig.observationMaxAgeMs - 1
    expect(evaluateWatchdog(snapshot).reason).toBe("session_observation_stale")
    snapshot.session!.observedAt = now
    snapshot.session!.leaseUntil = now
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "UNKNOWN", reason: "session_lease_expired" })
    snapshot.session!.leaseUntil = null
    expect(evaluateWatchdog(snapshot).reason).toBe("session_lease_expired")
    snapshot.session = null
    expect(evaluateWatchdog(snapshot).reason).toBe("session_observation_missing")
  })

  it("starts the idle grace at the latest state transition or explicit work update", () => {
    const snapshot = active()
    snapshot.session!.stateSince = now - 10_000
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "WAIT", reason: "idle_grace", nextEvaluationAt: now + 110_000 })
    snapshot.session!.stateSince = now - 300_000
    snapshot.work!.updatedAt = now - 5_000
    snapshot.work!.lastProgressAt = now - 5_000
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "WAIT", nextEvaluationAt: now + 115_000 })
    snapshot.work!.updatedAt = now - 120_000
    snapshot.work!.lastProgressAt = now - 120_000
    expect(evaluateWatchdog(snapshot).action).toBe("ASK_STATUS")
  })

  it("limits simulated recovery to two spaced inquiries and one alert across repeated evaluations", () => {
    const snapshot = active()
    snapshot.recovery = { statusAttempts: 0, lastStatusAttemptAt: null, alertedAt: null }
    const actions: string[] = []
    for (let tick = 0; tick < 60; tick++) {
      snapshot.now = now + tick * 10_000
      snapshot.session!.observedAt = snapshot.now
      snapshot.session!.leaseUntil = snapshot.now + 90_000
      const decision = evaluateWatchdog(snapshot)
      if (decision.action === "ASK_STATUS") {
        actions.push(decision.action)
        snapshot.recovery.statusAttempts++
        snapshot.recovery.lastStatusAttemptAt = snapshot.now
      } else if (decision.action === "ALERT") {
        actions.push(decision.action)
        snapshot.recovery.alertedAt = snapshot.now
      }
    }
    expect(actions).toEqual(["ASK_STATUS", "ASK_STATUS", "ALERT"])
    expect(evaluateWatchdog(snapshot).reason).toBe("already_alerted")
  })

  it("leaves observations and attempted interventions distinct", () => {
    const snapshot = active()
    const original = structuredClone(snapshot)
    const first = evaluateWatchdog(snapshot)
    expect(evaluateWatchdog(snapshot)).toEqual(first)
    expect(snapshot).toEqual(original)
    snapshot.recovery = { statusAttempts: 2, lastStatusAttemptAt: now - 1, alertedAt: null }
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "WAIT", reason: "status_cooldown", nextEvaluationAt: now + 119_999 })
  })

  it("does not carry an old recovery episode into new work progress", () => {
    const snapshot = active()
    snapshot.work!.updatedAt = now - 1
    snapshot.recovery = { statusAttempts: 2, lastStatusAttemptAt: now - 10_000, alertedAt: null }
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "UNKNOWN", reason: "invalid_recovery_state" })
    snapshot.recovery = { statusAttempts: 0, lastStatusAttemptAt: null, alertedAt: null }
    expect(evaluateWatchdog(snapshot).reason).toBe("idle_grace")
  })
})

describe("report delivery is separate from worker recovery", () => {
  it("retries only the failed delivery of an existing persisted report", () => {
    const snapshot = completed()
    snapshot.session = null
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "RETRY_DELIVERY", reason: "delivery_failed" })
    snapshot.delivery!.error = null
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "RETRY_DELIVERY", reason: "delivery_unread_after_deadline" })
  })

  it.each([
    ["readAt", "report_read_unhandled"],
    ["handledAt", "report_handled"],
    ["cancelledAt", "delivery_cancelled"],
  ] as const)("does not retry when %s is recorded", (field, reason) => {
    const snapshot = completed()
    snapshot.delivery![field] = now - 1
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "WAIT", reason })
  })

  it("a successful notification does not require a new notification just because it is unread", () => {
    const snapshot = completed()
    snapshot.delivery!.notifiedAt = now - 100_000
    snapshot.delivery!.error = null
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "WAIT", reason: "report_notified_unread" })
    snapshot.delivery!.error = "latest transport attempt failed"
    expect(evaluateWatchdog(snapshot).action).toBe("RETRY_DELIVERY")
  })

  it("requires delivery evidence; persistence alone never wakes the worker", () => {
    const snapshot = completed()
    snapshot.delivery = null
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "UNKNOWN", reason: "delivery_receipt_unknown" })
    snapshot.work!.reportMessageId = null
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "UNKNOWN", reason: "completed_without_report" })
  })

  it("defers the first delivery and respects the existing transport retry deadline", () => {
    const snapshot = completed()
    snapshot.delivery!.attempts = 0
    expect(evaluateWatchdog(snapshot).reason).toBe("delivery_pending")
    snapshot.delivery!.attempts = 1
    snapshot.delivery!.nextAttemptAt = now + 30_000
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "WAIT", reason: "delivery_cooldown", nextEvaluationAt: now + 30_000 })
    snapshot.delivery!.nextAttemptAt = null
    expect(evaluateWatchdog(snapshot).reason).toBe("delivery_deadline_unknown")
  })

  it("exhausted transport retries produce one alert when the caller persists its receipt", () => {
    const snapshot = completed()
    snapshot.delivery!.attempts = 5
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "ALERT", reason: "delivery_attempts_exhausted" })
    snapshot.recovery = { statusAttempts: 0, lastStatusAttemptAt: null, alertedAt: now }
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "WAIT", reason: "already_alerted" })
  })
})

describe("invalid or contradictory evidence", () => {
  it("surfaces exhausted successful notifications without treating them as read or rerunning the worker", () => {
    const snapshot=completed()
    snapshot.delivery!.notifiedAt=now-60_000
    snapshot.delivery!.error=null
    snapshot.delivery!.attempts=5
    expect(evaluateWatchdog(snapshot)).toMatchObject({action:"ALERT",reason:"unread_notification_budget_exhausted"})
    snapshot.delivery!.nextAttemptAt=now+1
    expect(evaluateWatchdog(snapshot).action).toBe("WAIT")
    snapshot.delivery!.nextAttemptAt=null
    expect(evaluateWatchdog(snapshot).action).toBe("UNKNOWN")
    snapshot.delivery!.nextAttemptAt=now-1
    snapshot.delivery!.readAt=now-1
    expect(evaluateWatchdog(snapshot).reason).toBe("report_read_unhandled")
  })
  it.each([NaN, Infinity, -1, now + 1])("abstains on invalid work timestamp %s", updatedAt => {
    const snapshot = active()
    snapshot.work!.updatedAt = updatedAt
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "UNKNOWN", reason: "invalid_work_timestamps" })
  })

  it.each(["observedAt", "stateSince"] as const)("abstains on a future or missing %s", field => {
    const snapshot = active()
    snapshot.session![field] = now + 1
    expect(evaluateWatchdog(snapshot).reason).toBe("invalid_session_timestamps")
    snapshot.session![field] = null
    expect(evaluateWatchdog(snapshot).reason).toBe("invalid_session_timestamps")
  })

  it("rejects contradictory progress, waits, and recovery counters", () => {
    const snapshot = active()
    snapshot.work!.lastProgressAt = now
    expect(evaluateWatchdog(snapshot).reason).toBe("invalid_work_timestamps")
    snapshot.work!.lastProgressAt = null
    snapshot.work!.waitingFor = "human"
    expect(evaluateWatchdog(snapshot).reason).toBe("inconsistent_work_state")
    snapshot.work!.status = "waiting"
    snapshot.work!.waitingFor = null
    expect(evaluateWatchdog(snapshot).reason).toBe("waiting_reason_unknown")
    snapshot.recovery = { statusAttempts: 1, lastStatusAttemptAt: null, alertedAt: null }
    expect(evaluateWatchdog(snapshot).reason).toBe("invalid_recovery_state")
  })

  it("rejects a future recipient receipt instead of treating it as delivered", () => {
    const snapshot = completed()
    snapshot.delivery!.readAt = now + 1
    expect(evaluateWatchdog(snapshot)).toMatchObject({ action: "UNKNOWN", reason: "invalid_delivery_state" })
  })

  it.each([0, -1, NaN, Infinity, 0.5, 86_400_001])("rejects invalid timing configuration %s", idleGraceMs => {
    expect(evaluateWatchdog(active(), { idleGraceMs })).toMatchObject({ action: "UNKNOWN", reason: "invalid_config" })
  })

  it("rejects unbounded attempts and invalid current time", () => {
    expect(evaluateWatchdog(active(), { maxStatusAttempts: 11 }).reason).toBe("invalid_config")
    expect(evaluateWatchdog(active(), { maxDeliveryAttempts: Infinity }).reason).toBe("invalid_config")
    expect(evaluateWatchdog({ ...active(), now: NaN }).reason).toBe("invalid_now")
  })
})
