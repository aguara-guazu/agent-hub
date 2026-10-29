import { useCallback } from "react"
import type { CSSProperties, ReactNode } from "react"
import { useFormat, useT } from "../../i18n"

/** Barra de filtros de plantilla A: se envuelve en ventanas angostas. */
export function Bar({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }}>{children}</div>
}

const CODE_BOX: CSSProperties = {
  margin: 0,
  padding: "var(--sp-3)",
  borderRadius: "var(--r-sm)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
}

/** Caja monoespaciada del panel (respuesta, detalle). `danger` marca una falla; `locked`, un bloqueo de política. */
export function CodeBox({ children, tone }: { children: ReactNode; tone?: "danger" | "locked" }) {
  const style: CSSProperties = tone
    ? { ...CODE_BOX, borderColor: `var(--${tone}-border)`, color: `var(--${tone})` }
    : CODE_BOX
  return <pre className={tone ? "mono xs" : "mono xs t2"} style={style}>{children}</pre>
}

/** Hora en listas: la hora si es de hoy; si no, relativa («ayer», «hace 3 d»). El tooltip lleva la fecha completa. */
export function useListTime() {
  const format = useFormat()
  return useCallback((value: string) => {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return { text: "—", title: undefined }
    const today = new Date()
    const sameDay = date.toDateString() === today.toDateString()
    return { text: sameDay ? format.date(date, "time") : format.relative(date), title: format.date(date, "datetime") }
  }, [format])
}

/** Duraciones: «142 ms», «2,1 s», «1 min 05 s». */
export function useDuration() {
  const { t } = useT("activity")
  const format = useFormat()
  return useCallback((ms: number | null | undefined) => {
    if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return "—"
    if (ms < 1000) return t("duration.ms", { value: Math.round(ms) })
    const seconds = ms / 1000
    if (seconds < 60) return t("duration.s", { value: format.number(seconds, { maximumFractionDigits: 1 }) })
    const whole = Math.floor(seconds)
    return t("duration.min", { min: Math.floor(whole / 60), s: String(whole % 60).padStart(2, "0") })
  }, [t, format])
}

/** Celda de columna con ancho fijo, alineada a la derecha para números. */
export function Col({ width, right = false, className, title, children }: { width: number; right?: boolean; className?: string; title?: string; children: ReactNode }) {
  return <span className={`col ${className ?? ""}`.trim()} title={title} style={{ width, textAlign: right ? "right" : undefined, display: "flex", justifyContent: right ? "flex-end" : "flex-start" }}>{children}</span>
}
