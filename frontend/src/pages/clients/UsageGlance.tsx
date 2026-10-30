import type { UsageQuotaWindow } from "@agenthub/shared"
import { useFormat, useT } from "../../i18n"
import type { LocalClient } from "../../lib/local"
import { isWeekly, percentOf, usageOf } from "./UsageSection"
import type { UsageStatus } from "./UsageSection"

const FIVE_HOURS_MINUTES = 300
const METER_WIDTH = 56
const LABEL_WIDTH = 52
const RESET_WIDTH = 92

const isFiveHours = (window: UsageQuotaWindow) => window.duration_minutes === FIVE_HOURS_MINUTES || window.id === "five_hour"
const isMonthly = (window: UsageQuotaWindow) => window.id === "monthly-credits" || window.id === "monthly"

/** Barra de uso con tono según el estado del pool; el valor se acota a 0–100. */
function Meter({ percent, tone, label }: { percent: number; tone: string; label: string }) {
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}
      style={{ width: METER_WIDTH, height: "var(--sp-1)", borderRadius: "var(--r-full)", background: "var(--surface-3)", overflow: "hidden", flex: "none" }}>
      <div style={{ width: `${percent}%`, height: "100%", background: tone, borderRadius: "var(--r-full)" }} />
    </div>
  )
}

/**
 * Cuota del cliente en la lista: la ventana principal (semanal o mensual según el tipo de cuenta) y, si el
 * cliente la reporta, la de 5 horas con su renovación. Sin lectura o con un cliente sin soporte no muestra nada:
 * el detalle completo vive en el panel del cliente.
 */
export function UsageGlance({ client, data }: { client: LocalClient; data: UsageStatus | undefined }) {
  const { t } = useT("clients")
  const format = useFormat()
  const usage = usageOf(data, client)
  const windows = usage.pools.flatMap(pool => pool.observation.windows.filter(window => percentOf(window) !== null))
  const primary = windows.find(isWeekly) ?? windows.find(isMonthly)
  const hours = windows.find(isFiveHours)
  if (!primary && !hours) return null
  const tone = usage.status === "exhausted" ? "var(--danger)" : usage.status === "low" ? "var(--warn)" : "var(--accent)"
  const name = (window: UsageQuotaWindow) => isFiveHours(window) ? t("usage.glance.fiveHours") : isWeekly(window) ? t("usage.glance.weekly") : t("usage.glance.monthly")
  const line = (window: UsageQuotaWindow, withReset: boolean) => {
    const percent = Math.max(0, Math.min(100, percentOf(window) ?? 0))
    const value = format.number(percent, { maximumFractionDigits: 0 })
    return (
      <div key={window.id} title={window.resets_at ? t("usage.glance.resets", { when: format.relative(window.resets_at) }) : undefined}
        style={{ display: "grid", gridTemplateColumns: `${LABEL_WIDTH}px ${METER_WIDTH}px 34px ${RESET_WIDTH}px`, alignItems: "center", columnGap: "var(--sp-2)" }}>
        <span className="xs t3" style={{ textAlign: "right" }}>{name(window)}</span>
        <Meter percent={percent} tone={tone} label={t("usage.glance.label", { client: client.cli_kind, window: name(window), value })} />
        <span className="xs t2 num" style={{ textAlign: "right" }}>{t("usage.glance.used", { value })}</span>
        <span className="xs t3" style={{ whiteSpace: "nowrap" }}>{withReset && window.resets_at ? format.relative(window.resets_at) : ""}</span>
      </div>
    )
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
      {primary && line(primary, false)}
      {hours && line(hours, true)}
    </div>
  )
}
