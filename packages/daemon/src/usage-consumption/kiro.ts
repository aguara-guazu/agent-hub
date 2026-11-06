import { parseKiroSessionInfo, type ConsumptionEvent } from "@agenthub/shared"

export interface KiroConsumptionObserverOptions {
  hub_session_id: string
  native_session_id: string
  model?: string | null
  ingest: (events: ConsumptionEvent[]) => Promise<void>
  /** Called at most once per observer, with a short technical reason. */
  warn: (reason: string) => void
}

/**
 * Side observer for the `session/update` packets of a Kiro ACP session. It never throws and never blocks the
 * protocol: a format mismatch or a rejected batch is reported once and the session stays without data.
 */
export function createKiroConsumptionObserver(options: KiroConsumptionObserverOptions): (update: unknown) => void {
  let seq = 0
  let lastContextPct: number | null = null
  let warned = false
  const warn = (reason: string) => {
    if (warned) return
    warned = true
    try { options.warn(reason) } catch { /* telemetry is optional */ }
  }
  return update => {
    try {
      const parsed = parseKiroSessionInfo(update, {
        hub_session_id: options.hub_session_id,
        native_session_id: options.native_session_id,
        seq: ++seq,
        at: new Date().toISOString(),
        lastContextPct,
      })
      if (!parsed) return warn("format_mismatch")
      if (parsed.contextPct !== undefined) lastContextPct = parsed.contextPct
      if (parsed.event) void options.ingest([{ ...parsed.event, model: options.model ?? null }]).catch(() => warn("ingest_failed"))
    } catch {
      warn("observer_failed")
    }
  }
}
