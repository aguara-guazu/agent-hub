import { useState } from "react"
import type { ReactNode } from "react"
import { BarChart, Chip, Empty, EmptyFiltered, ErrorState, List, Row, RowHead, Seg, Select, SkeletonRows, TabPanel, Tag } from "../../components/ui"
import type { BarChartPoint } from "../../components/ui"
import { useT } from "../../i18n"
import { useAllProjects } from "../../lib/projects"
import {
  CONSUMPTION_RANGES, CONTEXT_WARN_PCT, DEFAULT_RANGE, useConsumptionSeries, useConsumptionSummary,
  type ConsumptionGroup, type ConsumptionRange, type SeriesItem, type SummaryRow,
} from "../../lib/consumption"
import { ConsumptionPanel } from "./ConsumptionPanel"
import { useConsumptionLabels } from "./labels"
import { Bar, Col } from "./shared"

type View = "agent" | "cli" | "total"

const GROUP_OF: Record<View, ConsumptionGroup> = { agent: "agent", cli: "cli", total: "origin" }
const ALL = "all"
const ROW_MIN = 640

function Layout({ header, bar, content, panel }: { header: ReactNode; bar: ReactNode; content: ReactNode; panel: ReactNode }) {
  return (
    <div className="split">
      <div className="page">
        {header}
        <TabPanel idPrefix="activity" value="consumo">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
            <Bar>{bar}</Bar>
            {content}
          </div>
        </TabPanel>
      </div>
      {panel}
    </div>
  )
}

const rowKey = (row: SummaryRow) => `${row.key}:${row.unit ?? "none"}`

/** Consumo · gráficos por CLI y lista por agente, por CLI o por origen. Cada CLI se muestra en su unidad. */
export default function ConsumptionTab({ header }: { header: ReactNode }) {
  const { t } = useT("activity")
  const labels = useConsumptionLabels()
  const [view, setView] = useState<View>("agent")
  const [range, setRange] = useState<ConsumptionRange>(DEFAULT_RANGE)
  const [project, setProject] = useState<string>(ALL)
  const [selected, setSelected] = useState<string | null>(null)
  const projectId = project === ALL ? null : project

  const summary = useConsumptionSummary(range, GROUP_OF[view], projectId)
  const series = useConsumptionSeries(range, projectId)
  const projects = useAllProjects()

  const rows = summary.data?.items ?? []
  const current = view === "agent" ? rows.find(row => row.key === selected) ?? null : null
  const filtered = project !== ALL

  function clearFilters() { setProject(ALL); setSelected(null) }

  const charts = buildCharts(series.data?.items ?? [], range, labels, t)

  let content: ReactNode
  if (summary.isPending) content = <SkeletonRows avatar={false} label={t("consumption.loading")} />
  else if (summary.error) content = <List><ErrorState error={summary.error} title={t("consumption.empty.errorTitle")} onRetry={() => void summary.refetch()} /></List>
  else if (rows.length === 0 && filtered) content = <List><EmptyFiltered text={t("consumption.empty.filtered")} onClear={clearFilters} /></List>
  else if (rows.length === 0) content = <List><Empty icon="activity" title={t("consumption.empty.title")} detail={t("consumption.empty.detail")} /></List>
  else content = (
    <List className="scroll-x">
      <RowHead style={{ minWidth: ROW_MIN }}>
        <span style={{ flex: 1 }}>{view === "total" ? t("consumption.columns.origin") : view === "cli" ? t("consumption.columns.cli") : t("consumption.columns.agent")}</span>
        {view === "agent" && <Col width={120}>{t("consumption.columns.cli")}</Col>}
        <Col width={130} right>{t("consumption.columns.usage")}</Col>
        <Col width={110} right>{t("consumption.columns.cost")}</Col>
        {view !== "total" && <Col width={120}>{t("consumption.columns.context")}</Col>}
      </RowHead>
      {rows.map(row => {
        const origins = row.top_origins.map(item => labels.origin(item.origin)).join(", ")
        const title = view === "total" ? labels.origin(row.key as Parameters<typeof labels.origin>[0]) : view === "cli" ? labels.cli(row.key) : row.label
        const sub = view === "total"
          ? <Tag>{t("consumption.estimated")}</Tag>
          : view === "agent" && origins ? t("consumption.topOrigins", { origins }) : undefined
        return (
          <Row
            key={rowKey(row)}
            style={{ minWidth: ROW_MIN }}
            selected={view === "agent" && row.key === selected}
            {...(view === "agent" ? { onOpen: () => setSelected(row.key === selected ? null : row.key) } : {})}
            title={title}
            sub={sub}
            meta={<>
              {view === "agent" && <Col width={120} className="xs t2 trunc">{labels.cli(row.cli_kind)}</Col>}
              <Col width={130} right className="xs t2 num" title={row.unit === "tokens" ? labels.exact(row.total) : undefined}>{labels.usage(row)}</Col>
              <Col width={110} right className="xs t2 num">{row.unit === null ? "—" : labels.cost(row)}</Col>
              {view !== "total" && <Col width={120}>{context(row, t, labels.percent)}</Col>}
            </>}
          />
        )
      })}
    </List>
  )

  return (
    <Layout
      header={header}
      bar={<>
        <Seg<View>
          label={t("consumption.group.label")}
          value={view}
          onChange={value => { setView(value); setSelected(null) }}
          options={[
            { value: "agent", label: t("consumption.group.agent") },
            { value: "cli", label: t("consumption.group.cli") },
            { value: "total", label: t("consumption.group.total") },
          ]}
        />
        <Select<ConsumptionRange>
          label={t("consumption.range.label")}
          value={range}
          onChange={value => { setRange(value); setSelected(null) }}
          options={CONSUMPTION_RANGES.map(value => ({ value, label: labels.range(value) }))}
        />
        <Select<string>
          label={t("consumption.project.label")}
          value={project}
          onChange={value => { setProject(value); setSelected(null) }}
          options={[{ value: ALL, label: t("consumption.project.all") }, ...(projects.data?.items ?? []).map(item => ({ value: item.id, label: item.title }))]}
        />
      </>}
      content={<>
        {charts.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "var(--sp-3)" }}>
            {charts.map(chart => <BarChart key={chart.key} title={chart.title} value={chart.value} subtitle={chart.subtitle} points={chart.points} ariaLabel={chart.ariaLabel} />)}
          </div>
        )}
        {content}
      </>}
      panel={current && <ConsumptionPanel key={current.key} id={current.key} fallback={current} range={range} onClose={() => setSelected(null)} />}
    />
  )
}

function context(row: SummaryRow, t: ReturnType<typeof useT<"activity">>["t"], percent: (value: number) => string): ReactNode {
  if (row.context_peak_pct === null) return <Chip tone="off">{t("consumption.noData")}</Chip>
  return <Chip tone={row.context_peak_pct >= CONTEXT_WARN_PCT ? "warn" : "ok"}>{percent(row.context_peak_pct)}</Chip>
}

interface ChartSpec { key: string; title: string; value: string; subtitle: string; points: BarChartPoint[]; ariaLabel: string }

/** Un gráfico por CLI con datos, en su unidad, y uno del costo equivalente. */
function buildCharts(
  items: readonly SeriesItem[],
  range: ConsumptionRange,
  labels: ReturnType<typeof useConsumptionLabels>,
  t: ReturnType<typeof useT<"activity">>["t"],
): ChartSpec[] {
  const subtitle = t("consumption.charts.subtitle", { range: labels.range(range), granularity: labels.granularity(range) })
  const specs: ChartSpec[] = []
  const build = (key: string, title: string, entries: { bucket: string; total: number }[], format: (value: number) => string, extra?: string): ChartSpec => {
    const points = entries.map(entry => {
      const when = labels.bucket(entry.bucket, range, true)
      return { label: labels.bucket(entry.bucket, range), value: entry.total, tooltip: t("consumption.charts.tooltip", { when, value: format(entry.total) }) }
    })
    const total = entries.reduce((sum, entry) => sum + entry.total, 0)
    const peak = entries.reduce<{ bucket: string; total: number } | null>((best, entry) => (best === null || entry.total > best.total ? entry : best), null)
    const value = format(total)
    const ariaLabel = peak && total > 0
      ? t("consumption.charts.aria", { title, value, range: labels.range(range), peak: format(peak.total), when: labels.bucket(peak.bucket, range, true) })
      : t("consumption.charts.ariaEmpty", { title, range: labels.range(range) })
    return { key, title, value, subtitle: extra ?? subtitle, points, ariaLabel }
  }

  for (const item of items) {
    if (item.cli_kind === "cost") continue
    const unit = item.unit === "credits" ? "credits" : "tokens"
    const cli = labels.cli(item.cli_kind)
    const title = t(unit === "credits" ? "consumption.charts.creditsTitle" : "consumption.charts.tokensTitle", { cli })
    const entries = item.points.map(point => ({ bucket: point.bucket, total: point.total ?? 0 }))
    specs.push(build(`${item.cli_kind}:${unit}`, title, entries, value => labels.amount(unit, value)))
  }

  const cost = items.find(item => item.cli_kind === "cost")
  if (cost && cost.points.some(point => point.total !== null)) {
    const hasKiro = items.some(item => item.cli_kind === "kiro")
    const entries = cost.points.map(point => ({ bucket: point.bucket, total: point.total ?? 0 }))
    specs.push(build("cost", t("consumption.charts.costTitle"), entries, labels.money, t(hasKiro ? "consumption.charts.costSubtitleKiro" : "consumption.charts.costSubtitle")))
  }
  return specs
}
