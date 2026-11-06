import { BarList, Chip, Dl, ErrorState, Loading, LineChart, Panel, PanelBody, PanelHeader, Tag } from "../../components/ui"
import type { DlItem } from "../../components/ui"
import { useT } from "../../i18n"
import { CONTEXT_WARN_PCT, useConsumptionAgent, type ConsumptionRange, type SummaryRow } from "../../lib/consumption"
import { useConsumptionLabels } from "./labels"

interface Props {
  id: string
  fallback: SummaryRow | null
  range: ConsumptionRange
  onClose: () => void
}

/** Detalle de un agente: datos del período, desglose estimado por origen y tamaño del contexto en el tiempo. */
export function ConsumptionPanel({ id, fallback, range, onClose }: Props) {
  const { t } = useT("activity")
  const labels = useConsumptionLabels()
  const query = useConsumptionAgent(id, range)
  const detail = query.data
  const row = detail?.row ?? fallback

  const context = (() => {
    const points = detail?.context ?? []
    const usePct = points.some(point => point.pct !== null)
    const series = points.map(point => ({
      at: point.at,
      x: labels.instant(point.at, range, true),
      y: usePct ? point.pct : point.tokens,
      compaction: point.compaction,
    }))
    return { usePct, series, peak: series.reduce<number | null>((max, point) => (point.y !== null && (max === null || point.y > max) ? point.y : max), null) }
  })()

  const items: DlItem[] = row ? [
    { label: t("consumption.panel.cliModel"), value: detail?.model ? <>{labels.cli(row.cli_kind)} · <span className="mono xs">{detail.model}</span></> : labels.cli(row.cli_kind) },
    { label: t("consumption.panel.usage"), value: row.unit === null ? t("consumption.noData") : labels.usage(row) },
  ] : []
  if (row && row.unit !== null) {
    if (row.turns !== null) items.push({ label: t("consumption.panel.turns"), value: labels.exact(row.turns) })
    if (detail) items.push({ label: t("consumption.panel.modelCalls"), value: labels.exact(detail.model_calls) })
  }
  if (row && row.unit === "tokens") {
    items.push(
      { label: t("consumption.panel.input"), value: labels.exact(row.input) },
      { label: t("consumption.panel.output"), value: labels.exact(row.output) },
      { label: t("consumption.panel.cacheWrite"), value: labels.exact(row.cache_write) },
      { label: t("consumption.panel.cacheRead"), value: labels.exact(row.cache_read) },
    )
  }
  if (row && row.unit !== null) {
    items.push(
      { label: t("consumption.panel.cost"), value: <span title={labels.costHint(row)}>{labels.cost(row)}</span> },
      { label: t("consumption.panel.compactions"), value: labels.exact(row.compactions) },
    )
  }
  if (row && detail?.context_last_pct != null) items.push({ label: t("consumption.panel.contextNow"), value: labels.percent(detail.context_last_pct) })
  if (row) items.push({ label: t("consumption.panel.contextPeak"), value: row.context_peak_pct === null ? t("consumption.noData") : labels.percent(row.context_peak_pct) })
  if (row && row.unit !== null && detail?.source) {
    items.push({ label: t("consumption.panel.source"), value: detail.source === "acp" ? t("consumption.panel.sourceAcp") : t("consumption.panel.sourceFile") })
  }

  const breakdown = detail?.breakdown ?? []
  const breakdownTotal = breakdown.reduce((sum, item) => sum + item.amount, 0)
  const breakdownMax = breakdown.reduce((max, item) => Math.max(max, item.amount), 0)
  const hasPct = context.usePct

  let body
  if (query.isPending) body = <Loading label={t("consumption.panel.loading")} />
  else if (query.error) body = <ErrorState error={query.error} title={t("consumption.panel.error")} onRetry={() => void query.refetch()} />
  else body = <>
    <Dl items={items} />
    <div className="field">
      <span className="label">{t("consumption.panel.breakdown")} <Tag>{t("consumption.estimated")}</Tag></span>
      {breakdown.length === 0
        ? <span className="xs t3">{t("consumption.panel.breakdownEmpty")}</span>
        : <BarList items={breakdown.map(item => ({
          label: labels.origin(item.origin),
          value: [
            labels.amount(item.unit, item.amount),
            labels.percent(breakdownTotal > 0 ? (item.amount / breakdownTotal) * 100 : 0),
            ...(item.unit === "tokens" ? [labels.originCost(item.cost_usd)] : []),
          ].join(" · "),
          ratio: breakdownMax > 0 ? item.amount / breakdownMax : 0,
        }))} />}
    </div>
    <div className="field">
      <span className="label">{t("consumption.panel.context")}{!hasPct && context.peak !== null ? ` · ${t("consumption.panel.contextTokens")}` : ""}</span>
      {context.peak === null
        ? <span className="xs t3">{t("consumption.panel.contextEmpty")}</span>
        : <LineChart
          points={context.series.map(point => ({ x: point.x, y: point.y }))}
          marks={context.series.filter(point => point.compaction).map(point => ({ x: point.x, label: t("consumption.panel.compaction") }))}
          {...(hasPct ? { threshold: { y: CONTEXT_WARN_PCT, label: labels.percent(CONTEXT_WARN_PCT) } } : {})}
          ariaLabel={t("consumption.panel.contextAria", { peak: hasPct ? labels.percent(context.peak) : labels.exact(context.peak) })}
        />}
    </div>
  </>

  const peak = row?.context_peak_pct ?? null
  return (
    <Panel label={t("consumption.panel.label")} onClose={onClose}>
      <PanelHeader
        title={row?.label ?? "—"}
        status={peak === null
          ? <Chip tone="off">{t("consumption.noData")}</Chip>
          : <Chip tone={peak >= CONTEXT_WARN_PCT ? "warn" : "ok"}>{labels.percent(peak)}</Chip>}
      />
      <PanelBody>{body}</PanelBody>
    </Panel>
  )
}
