import type { RecordingState } from "./recording.js"

export type EndDecision = "stop" | "continue"
export interface EndNotice { close(): void; isClosed?(): boolean }

/** One decision per recording and scheduled end. A late tick after sleep uses the current wall clock. */
export class CalendarEndReminder {
  private key = ""
  private acknowledged = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private notice: EndNotice | undefined

  constructor(private state: () => RecordingState,
    private show: (title: string, decide: (choice: EndDecision) => void) => EndNotice,
    private stop: () => void, private onError?: (error: unknown) => void) {}

  get visible(): boolean { return !!this.notice && !this.notice.isClosed?.() }

  clear(): void {
    clearTimeout(this.timer); this.timer = undefined
    this.key = ""; this.acknowledged = false
    this.notice?.close(); this.notice = undefined
  }

  sync(): void {
    const state = this.state(), end = Date.parse(state.scheduledEnd ?? "")
    if (state.phase !== "recording" || !state.eventId || !state.id || !Number.isFinite(end)) { this.clear(); return }
    const key = `${state.id}/${end}`
    if (this.key !== key) { this.clear(); this.key = key }
    if (this.acknowledged) return
    const remaining = end - Date.now()
    if (remaining > 0) {
      this.timer ??= setTimeout(() => { this.timer = undefined; this.sync() }, Math.min(remaining, 2_147_483_647)).unref()
      return
    }
    clearTimeout(this.timer); this.timer = undefined
    if (this.visible) return
    const decide = (choice: EndDecision) => {
      const current = this.state()
      if (current.phase !== "recording" || current.id !== state.id || Date.parse(current.scheduledEnd ?? "") !== end || this.key !== key || this.acknowledged) return
      this.acknowledged = true
      this.notice?.close(); this.notice = undefined
      if (choice === "stop") this.stop()
    }
    try { this.notice = this.show(state.title ?? "", decide) }
    catch (error) { this.onError?.(error) } // The next tick retries without interrupting the audio.
  }
}
