import { useEffect, useRef, useState } from "react"
import { Chip, ErrorState, Loading } from "../../components/ui"
import type { ChipTone } from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import { api } from "../../lib/api"
import { redactText } from "../../lib/activity"

type Kind = "user" | "assistant" | "tool" | "system"
type ProcessState = "starting" | "busy" | "idle" | "waiting_input" | "stopped" | "failed" | "unknown"
interface Item { seq: number; at: string; kind: Kind; text: string }
interface Activity { supported: boolean; reason?: string; generation?: string; state?: string; items: Item[]; next_cursor: number; truncated?: boolean }

const KINDS: readonly Kind[] = ["user", "assistant", "tool", "system"]
const STATES: readonly ProcessState[] = ["starting", "busy", "idle", "waiting_input", "stopped", "failed", "unknown"]
const STATE_TONE: Record<ProcessState, ChipTone> = { starting: "info", busy: "info", idle: "ok", waiting_input: "warn", stopped: "off", failed: "danger", unknown: "off" }
const POLL_MS = 2000
/** Lo que se conserva en memoria de la vista: los últimos 500 eventos o 128 KiB de texto. */
const MAX_ITEMS = 500
const MAX_CHARS = 131072

/** Salida en vivo de un agente de chat, de solo lectura: no envía mensajes ni consume tokens.
 *  La salida queda en el estado de este componente, fuera de las cachés compartidas de consultas. */
export function AgentOutput({ agentId }: { agentId: string }) {
  const { t } = useT("activity")
  const format = useFormat()
  const [activity, setActivity] = useState<Activity | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)
  const output = useRef<HTMLDivElement>(null)
  const follow = useRef(true)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let cursor = 0
    let generation: string | undefined
    const controller = new AbortController()
    const path = (after: number) => `/memory/chat/agents/${encodeURIComponent(agentId)}/activity?after=${after}`
    async function refresh() {
      if (document.hidden) { timer = setTimeout(() => void refresh(), POLL_MS); return }
      try {
        let result = await api.get<Activity>(path(cursor), controller.signal)
        if (disposed) return
        // Un proceso reiniciado empieza otra secuencia: se pide también su prefijo retenido.
        if (generation !== undefined && result.generation !== generation && cursor > 0) {
          result = await api.get<Activity>(path(0), controller.signal)
          if (disposed) return
        }
        generation = result.generation
        cursor = result.next_cursor
        setActivity(previous => {
          const same = previous && previous.generation === result.generation
          const merged = same ? [...previous.items, ...result.items.filter(item => item.seq > previous.next_cursor)] : result.items
          let size = 0
          let start = merged.length
          while (start > 0 && merged.length - start < MAX_ITEMS && size + merged[start - 1]!.text.length <= MAX_CHARS) size += merged[--start]!.text.length
          return { ...result, items: merged.slice(start), truncated: Boolean(result.truncated || start || (same && previous.truncated)) }
        })
        setError(null)
        if (!result.supported) return
      } catch (cause) {
        if (disposed) return
        setError(cause)
      }
      if (!disposed) timer = setTimeout(() => void refresh(), POLL_MS)
    }
    void refresh()
    return () => { disposed = true; controller.abort(); clearTimeout(timer) }
  }, [agentId, attempt])

  useEffect(() => {
    if (follow.current && output.current) output.current.scrollTop = output.current.scrollHeight
  }, [activity])

  if (error && !activity) return <ErrorState error={error} title={t("agentOutput.errorTitle")} onRetry={() => { setError(null); setAttempt(value => value + 1) }} />
  if (!activity) return <Loading label={t("agentOutput.loading")} />
  if (!activity.supported) return <span className="xs t3">{t("agentOutput.unsupported")}</span>

  const state: ProcessState = STATES.includes(activity.state as ProcessState) ? activity.state as ProcessState : "unknown"
  return (
    <div className="field">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap" }}>
        <span className="label">{t("agentOutput.state")}</span>
        <Chip tone={STATE_TONE[state]}>{t(`agentOutput.process.${state}`)}</Chip>
        {activity.truncated && <span className="xs t3">{t("agentOutput.truncated")}</span>}
      </div>
      <div
        ref={output}
        className="card card-pad"
        role="log"
        aria-label={t("agentOutput.label")}
        tabIndex={0}
        style={{ maxHeight: 480, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}
        onScroll={() => {
          const node = output.current
          if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
        }}
      >
        {activity.items.length === 0 && <span className="xs t3">{t("agentOutput.empty")}</span>}
        {activity.items.map(item => (
          <section key={item.seq} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)", minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--sp-2)" }}>
              <span className="xs" style={{ fontWeight: 500 }}>{KINDS.includes(item.kind) ? t(`agentOutput.kind.${item.kind}`) : t("agentOutput.kind.system")}</span>
              <time className="xs t3 num" dateTime={item.at} title={format.date(item.at, "datetime")}>{format.date(item.at, "time")}</time>
            </div>
            <pre className="mono xs t2" style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{redactText(item.text)}</pre>
          </section>
        ))}
      </div>
    </div>
  )
}

export default AgentOutput
