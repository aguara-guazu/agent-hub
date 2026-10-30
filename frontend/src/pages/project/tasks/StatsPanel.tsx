import type { ReactNode } from "react"
import { Button, Dl, ErrorState, List, Loading, Panel, PanelBody, PanelHeader, Row } from "../../../components/ui"
import { useFormat, useT } from "../../../i18n"
import { useMemory, type MemoryEntity } from "../../../lib/memory"
import { SidePanel } from "../work"
import { useTaskLabels } from "./labels"
import type { TaskStats } from "./types"

type Translate = ReturnType<typeof useT<"project">>["t"]
type Format = ReturnType<typeof useFormat>

/** Estadísticas de tareas, calculadas por la API a partir del historial de cada tarea. Solo lectura. */
export function StatsPanel({ project, onClose }: { project: MemoryEntity; onClose: () => void }) {
  const { t } = useT("project")
  const format = useFormat()
  const labels = useTaskLabels()
  const stats = useMemory<TaskStats>("task_stats", { project_id: project.id, weeks: 12 })
  const s = stats.data
  const kindLabel = (kind: string) => t(kind === "jira" ? "tasks.kind.jira" : "tasks.stats.pendingKind")
  const number = (value: number | null | undefined) => value === null || value === undefined ? "—" : format.number(Number(value))
  return (
    <SidePanel>
      <Panel label={t("tasks.stats.title")} onClose={onClose} wide>
        <PanelHeader
          title={t("tasks.stats.title")}
          status={s ? <span className="xs t3" title={format.date(s.generated_at)}>{t("tasks.stats.generated", { when: format.date(s.generated_at) })}</span> : undefined}
          actions={s ? <Button small icon="document" onClick={() => downloadReport(project, s, t, format, labels.statusLabel, labels.originLabel)}>{t("tasks.stats.export")}</Button> : undefined}
        />
        <PanelBody>
          {stats.isPending ? <Loading />
            : stats.error || !s ? <ErrorState error={stats.error} title={t("tasks.stats.errorTitle")} onRetry={() => void stats.refetch()} />
            : <>
                <Dl items={summaryItems(s, t).map(([label, value]) => ({ label, value: number(value) }))} />
                <StatsSection title={t("tasks.stats.weekly")} rows={s.weekly.map(week => ({
                  key: week.week, title: t("tasks.stats.weekOf", { date: format.date(week.week, "date") }), meta: t("tasks.stats.createdClosed", { created: number(week.created), closed: number(week.closed) }),
                }))} />
                <StatsSection title={t("tasks.stats.byStatus")} rows={s.by_status.map(row => ({ key: `${row.kind}-${row.status}`, title: labels.statusLabel(row.status), sub: kindLabel(row.kind), meta: number(row.count) }))} />
                <StatsSection title={t("tasks.stats.leadTime")} rows={s.lead_time.map(row => ({
                  key: row.kind, title: kindLabel(row.kind), sub: t("tasks.stats.closedCount", { value: number(row.closed) }), meta: row.avg_days === null ? "—" : t("tasks.stats.days", { days: format.number(Number(row.avg_days), { maximumFractionDigits: 1 }) }),
                }))} />
                <StatsSection title={t("tasks.stats.assignees")} rows={s.assignees.map(row => ({ key: row.assignee, title: row.assignee, meta: t("tasks.stats.openDone", { open: number(row.open), done: number(row.done) }) }))} />
                <StatsSection title={t("tasks.stats.origins")} rows={s.origins.map(row => ({ key: row.origin, title: labels.originLabel(row.origin), meta: t("tasks.stats.openDone", { open: number(row.open), done: number(row.done) }) }))} />
                <StatsSection title={t("tasks.stats.agents")} rows={s.agents.map(row => ({ key: row.agent_label, title: row.agent_label, sub: t("tasks.stats.notes", { value: number(row.notes) }), meta: format.date(row.last_note) }))} />
                <StatsSection title={t("tasks.stats.stale")} rows={s.stale.map((row, index) => ({
                  key: `${row.external_key ?? row.title}-${index}`, title: row.external_key ? `${row.external_key} · ${row.title}` : row.title, sub: labels.statusLabel(row.status), meta: format.date(row.updated_at),
                }))} />
              </>}
        </PanelBody>
      </Panel>
    </SidePanel>
  )
}

function StatsSection({ title, rows }: { title: string; rows: { key: string; title: string; sub?: string; meta?: ReactNode }[] }) {
  const { t } = useT("project")
  return (
    <section className="section">
      <h3 className="h3">{title}</h3>
      {rows.length === 0 ? <span className="t3">{t("tasks.stats.noData")}</span> : (
        <List>{rows.map(row => <Row key={row.key} title={row.title} sub={row.sub} meta={row.meta !== undefined ? <span className="xs t3">{row.meta}</span> : undefined} />)}</List>
      )}
    </section>
  )
}

function summaryItems(s: TaskStats, t: Translate): [string, number][] {
  return [
    [t("tasks.stats.summary.open"), s.summary.open], [t("tasks.stats.summary.inProgress"), s.summary.in_progress], [t("tasks.stats.summary.blocked"), s.summary.blocked],
    [t("tasks.stats.summary.stale"), s.summary.stale_open], [t("tasks.stats.summary.created"), s.summary.created_last_2_weeks], [t("tasks.stats.summary.closed"), s.summary.closed_last_2_weeks],
    [t("tasks.stats.summary.done"), s.summary.done], [t("tasks.stats.summary.dropped"), s.summary.dropped],
  ]
}

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!)

/** Barra apoyada en la base con solo el extremo de datos redondeado. */
function bar(x: number, baseline: number, width: number, value: number) {
  if (value <= 0) return `M${x},${baseline}h${width}v-1h-${width}z`
  const r = Math.min(4, width / 2, value), top = baseline - value
  return `M${x},${baseline}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${baseline}Z`
}

/**
 * Informe autocontenido (sin scripts ni recursos externos) para adjuntar tal cual. Es un archivo exportado, no interfaz de la app:
 * por eso lleva su propia paleta en lugar de los tokens de ah.css, con variante clara y oscura por `prefers-color-scheme`.
 */
export function reportHtml(project: MemoryEntity, s: TaskStats, t: Translate, format: Format, status: (value: unknown) => string, origin: (value: unknown) => string): string {
  const kind = (value: string) => t(value === "jira" ? "tasks.kind.jira" : "tasks.stats.pendingKind")
  const week = (value: string) => format.date(value, "date")
  const rowsTable = (head: string[], rows: unknown[][]) => rows.length
    ? `<table><thead><tr>${head.map(h => `<th>${escape(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${escape(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
    : `<p class="muted">${escape(t("tasks.stats.noData"))}</p>`
  const table = (title: string, head: string[], rows: unknown[][]) => `<section><h2>${escape(title)}</h2>${rowsTable(head, rows)}</section>`
  const max = Math.max(1, ...s.weekly.flatMap(w => [w.created, w.closed])), h = 140, step = 40
  const created = t("tasks.stats.report.created"), closed = t("tasks.stats.report.closed")
  const bars = s.weekly.map((w, i) => `<g><title>${escape(t("tasks.stats.weekOf", { date: week(w.week) }))}: ${w.created} ${escape(created)}, ${w.closed} ${escape(closed)}</title><path class="s1" d="${bar(i * step + 8, h, 10, w.created / max * h)}"/><path class="s2" d="${bar(i * step + 20, h, 10, w.closed / max * h)}"/>${i % 2 === s.weekly.length % 2 ? `<text x="${i * step + 19}" y="${h + 16}" text-anchor="middle">${escape(week(w.week))}</text>` : ""}</g>`).join("")
  const tiles = summaryItems(s, t)
  const kindHead = t("tasks.stats.report.kind"), statusHead = t("tasks.stats.report.status"), countHead = t("tasks.stats.report.count")
  return `<!doctype html><html lang="${format.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(t("tasks.stats.report.title", { project: project.title }))}</title><style>
:root{color-scheme:light;--bg:#f8f9fb;--surface:#fff;--border:#dfe3ea;--text:#101828;--muted:#667085;--s1:#2a78d6;--s2:#eb6834}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#090c11;--surface:#11161f;--border:#262f3d;--text:#f2f5f9;--muted:#8b95a7;--s1:#3987e5;--s2:#d95926}}
body{margin:0;padding:32px 16px;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1080px;margin:0 auto;display:grid;gap:20px}
h1{margin:0;font-size:26px}h2{font-size:15px;margin:0 0 10px}.muted{color:var(--muted)}.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.tile,section{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px}.tile strong{display:block;font-size:26px}.tile span{color:var(--muted);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-top:1px solid var(--border);font-size:12px}th{color:var(--muted);font-weight:500}
.chart{overflow-x:auto}svg text{fill:var(--muted);font-size:10px}.s1{fill:var(--s1)}.s2{fill:var(--s2)}.axis{stroke:var(--border)}.legend{display:flex;gap:14px;font-size:12px;color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
</style></head><body><main><header><h1>${escape(project.title)}</h1><p class="muted">${escape(t("tasks.stats.generated", { when: format.date(s.generated_at) }))}${project.data.jira_project_key ? ` · Jira ${escape(project.data.jira_project_key)}` : ""}</p></header>
<div class="tiles">${tiles.map(([label, value]) => `<div class="tile"><strong>${escape(format.number(Number(value)))}</strong><span>${escape(label)}</span></div>`).join("")}</div>
<section><h2>${escape(t("tasks.stats.weekly"))}</h2><div class="legend"><span><i style="background:var(--s1)"></i>${escape(created)}</span><span><i style="background:var(--s2)"></i>${escape(closed)}</span></div><div class="chart"><svg role="img" aria-label="${escape(t("tasks.stats.weekly"))}" width="${s.weekly.length * step}" height="${h + 24}"><line class="axis" x1="0" x2="${s.weekly.length * step}" y1="${h}" y2="${h}"/>${bars}</svg></div>
${rowsTable([t("tasks.stats.report.week"), created, closed], s.weekly.map(w => [week(w.week), w.created, w.closed]))}</section>
<div class="grid">${table(t("tasks.stats.byStatus"), [kindHead, statusHead, countHead], s.by_status.map(r => [kind(r.kind), status(r.status), r.count]))}
${table(t("tasks.stats.leadTime"), [kindHead, t("tasks.stats.report.avgDays"), t("tasks.stats.report.closedHead")], s.lead_time.map(r => [kind(r.kind), r.avg_days ?? "—", r.closed]))}
${table(t("tasks.stats.assignees"), [t("tasks.stats.report.assignee"), t("tasks.stats.report.open"), t("tasks.stats.report.done")], s.assignees.map(r => [r.assignee, r.open, r.done]))}
${table(t("tasks.stats.origins"), [t("tasks.stats.report.origin"), t("tasks.stats.report.open"), t("tasks.stats.report.done")], s.origins.map(r => [origin(r.origin), r.open, r.done]))}
${table(t("tasks.stats.stale"), [t("tasks.stats.report.task"), statusHead, t("tasks.stats.report.updated")], s.stale.map(r => [r.external_key ? `${r.external_key} · ${r.title}` : r.title, status(r.status), format.date(r.updated_at)]))}
${table(t("tasks.stats.report.recent"), [t("tasks.stats.report.date"), t("tasks.stats.report.task"), t("tasks.stats.report.change"), t("tasks.stats.report.actor")], s.recent.map(r => [format.date(r.created_at), r.external_key ?? r.title, r.action === "status" ? `${status(r.status_before)} → ${status(r.status_after)}` : r.action === "created" ? t("tasks.panel.event.created", { status: status(r.status_after) }) : r.action === "note" ? t("tasks.panel.event.note") : r.action === "jira_comment" ? t("tasks.panel.event.jiraComment") : t("tasks.panel.event.updated"), r.actor]))}</div>
</main></body></html>`
}

function downloadReport(project: MemoryEntity, s: TaskStats, t: Translate, format: Format, status: (value: unknown) => string, origin: (value: unknown) => string) {
  const url = URL.createObjectURL(new Blob([reportHtml(project, s, t, format, status, origin)], { type: "text/html;charset=utf-8" }))
  const link = document.createElement("a")
  const slug = project.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").toLowerCase() || "project"
  link.href = url
  link.download = `${slug}-${t("tasks.stats.report.fileSuffix")}-${new Date().toISOString().slice(0, 10)}.html`
  link.click()
  URL.revokeObjectURL(url)
}
