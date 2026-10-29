import { useEffect, useRef, useState } from "react"
import { Button, Chip, ErrorState, Loading, Panel, PanelBody, PanelHeader, absoluteTime, type ChipTone } from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"

interface ActivityItem { seq: number; at: string; kind: "user" | "assistant" | "tool" | "system"; text: string }
interface Activity { supported: boolean; reason?: string; generation?: string; state?: string; items: ActivityItem[]; next_cursor: number; truncated?: boolean }

type ProcessState = "starting" | "busy" | "idle" | "waiting_input" | "stopped" | "failed" | "unknown"
const PROCESS_TONE: Record<ProcessState, ChipTone> = { starting: "info", busy: "info", idle: "ok", waiting_input: "warn", stopped: "off", failed: "danger", unknown: "off" }
const PROCESSES = ["starting", "busy", "idle", "waiting_input", "stopped", "failed"] as const

// Mismos topes que la vista previa: 500 eventos o 128 KiB de texto retenidos en memoria del componente.
const MAX_ITEMS = 500
const MAX_CHARS = 131072
const POLL_MS = 2000

/** Salida que el proceso comparte con el Hub. Solo para la persona: vive en este componente, fuera de la caché de consultas. */
export function AgentPanel({ agent, onClose, onThreads }: { agent: { id: string; label: string }; onClose: () => void; onThreads: () => void }) {
  const { t } = useT("collaboration")
  const [activity, setActivity] = useState<Activity | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [attempt, setAttempt] = useState(0)
  const output = useRef<HTMLDivElement>(null)
  const follow = useRef(true)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let cursor = 0
    let generation: string | undefined
    const controller = new AbortController()
    const url = (after: number) => `/memory/chat/agents/${encodeURIComponent(agent.id)}/activity?after=${after}`
    async function refresh() {
      if (document.hidden) { timer = setTimeout(() => void refresh(), POLL_MS); return }
      try {
        let result = await api.get<Activity>(url(cursor), controller.signal)
        if (disposed) return
        // Un proceso reiniciado empieza otra secuencia: se pide también su prefijo retenido.
        if (generation !== undefined && result.generation !== generation && cursor > 0) {
          result = await api.get<Activity>(url(0), controller.signal)
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
        setError(cause instanceof Error ? cause : new Error(String(cause)))
      }
      if (!disposed) timer = setTimeout(() => void refresh(), POLL_MS)
    }
    void refresh()
    return () => { disposed = true; controller.abort(); clearTimeout(timer) }
  }, [agent.id, attempt])

  useEffect(() => {
    if (follow.current && output.current) output.current.scrollTop = output.current.scrollHeight
  }, [activity])

  const state: ProcessState = PROCESSES.find(value => value === activity?.state) ?? "unknown"

  return (
    <Panel label={t("agent.activityOf", { name: agent.label })} onClose={onClose} wide>
      <PanelHeader title={agent.label} status={activity?.supported && <Chip tone={PROCESS_TONE[state]}>{t(`process.${state}`)}</Chip>} />
      <PanelBody>
        {!activity && !error && <Loading label={t("agent.loading")} />}
        {error && <ErrorState error={error} title={t("agent.error")} onRetry={() => setAttempt(value => value + 1)} />}
        {activity?.supported === false && <span className="t2">{t("agent.unsupported")}</span>}
        {activity?.supported && <>
          {activity.truncated && <span className="xs t3">{t("agent.truncated")}</span>}
          <div
            ref={output}
            className="card"
            aria-label={t("agent.output")}
            tabIndex={0}
            onScroll={() => {
              const node = output.current
              if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
            }}
            style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)", padding: "var(--sp-3)", maxHeight: "60vh", overflowY: "auto", background: "var(--surface-2)" }}
          >
            {activity.items.length === 0 && <span className="t3">{t("agent.empty")}</span>}
            {activity.items.map(item => (
              <section key={item.seq} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)", minWidth: 0 }}>
                <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "baseline" }}>
                  <span className="xs" style={{ fontWeight: 600 }}>{t(`activityKind.${item.kind}`)}</span>
                  <time className="xs t3" dateTime={item.at}>{absoluteTime(item.at)}</time>
                </div>
                <pre className="mono xs t2" style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.text}</pre>
              </section>
            ))}
          </div>
        </>}
      </PanelBody>
      <div className="panel-f"><Button small onClick={onThreads}>{t("actions.agentThreads")}</Button></div>
    </Panel>
  )
}
