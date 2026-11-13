import { useEffect, useState } from "react"
import type { RecordingStatusView } from "../electron"

/** Grabación en curso y reuniones que el escritorio ofrece grabar; `null` fuera de la app de escritorio o en versiones que no graban. */
export function useRecordingStatus(): RecordingStatusView | null {
  const [status, setStatus] = useState<RecordingStatusView | null>(null)
  useEffect(() => {
    const bridge = window.agentHub
    if (!bridge?.getRecordingStatus) return
    let live = true
    void bridge.getRecordingStatus().then(value => { if (live) setStatus(value) }).catch(() => undefined)
    const unsubscribe = bridge.onRecordingChanged?.(setStatus)
    return () => { live = false; unsubscribe?.() }
  }, [])
  return status?.supported ? status : null
}
