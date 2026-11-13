import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { RecordingStatusView } from "../electron"
import { api } from "./api"

/** Voz de una reunión grabada que todavía no tiene nombre, con la propuesta del modelo si la hay. */
export interface PendingVoice {
  recording_id: string
  entity_id: string
  title: string
  started_at: string
  voice: number
  seconds: number
  sample: string
  proposal: { email: string; name: string; confidence: "high" | "medium" | "low"; reason: string } | null
  candidates: { email: string; name: string }[]
}

/** La clave empieza con `memory`: las decisiones de memoria la refrescan junto con el resto de Pendientes. */
export function usePendingVoices(enabled: boolean) {
  return useQuery({ queryKey: ["memory", "recording-voices"], queryFn: () => api.get<{ items: PendingVoice[] }>("/memory/recordings/voices"), enabled })
}

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
