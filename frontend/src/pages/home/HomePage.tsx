import { useEffect, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { Avatar, Button, Chip, type ChipTone } from "../../components/ui/basics"
import { Banner, Empty, EmptyFiltered, ErrorState, List, RowLink, Seg, SkeletonRows, type SegOption } from "../../components/ui/display"
import { relativeTime } from "../../components/ui/time"
import { useShellStatus } from "../../components/useShellStatus"
import { useFormat, useT } from "../../i18n"
import type { RunState } from "../../lib/automations"
import { useAuth } from "../../lib/auth"
import { usePendingInbox, useRecentProjects, useToday, type PendingInbox } from "../../lib/home"
import { useMemoryStatus } from "../../lib/memory"
import { PendingSection, usePendingRows, type PendingGroup } from "./pending"
import { Panel, PanelBody, PanelHeader } from "../../components/ui/Panel"
import { ReadGrantConfirm, readRequestAgent } from "../../components/ReadGrantConfirm"
import type { ReadRequest } from "../../lib/read-grants"

type Filter = "all" | PendingGroup

const GROUPS: readonly PendingGroup[] = ["connections", "agents", "memory"]
const GROUP_LABELS = { connections: "pending.groupConnections", agents: "pending.groupAgents", memory: "pending.groupMemory" } as const
const RUN_TONES: Record<RunState, ChipTone> = {
  pending: "info", running: "info", deferred: "info", succeeded: "ok", partial: "warn", failed: "danger",
  uncertain: "warn", skipped: "off", cancelled: "off", interrupted: "danger",
}
const MINUTE = 60_000

/** Reloj por minuto para el saludo y los «En 2 h» de Hoy. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), MINUTE)
    return () => clearInterval(timer)
  }, [])
  return now
}

function Greeting({ now, count }: { now: Date; count: number }) {
  const { t, plural } = useT("home")
  const { user } = useAuth()
  const first = user?.full_name?.trim().split(/\s+/)[0]
  const hour = now.getHours()
  const part = hour < 12 ? "morning" : hour < 20 ? "afternoon" : "evening"
  return (
    <div className="ph">
      <div className="ph-text">
        <h1 className="h1">{first ? t(`greeting.${part}Named`, { name: first }) : t(`greeting.${part}`)}</h1>
        <p className="t2">{count > 0 ? plural("summary", count) : t("summaryNone")}</p>
      </div>
    </div>
  )
}

/** Un único aviso de página: el servicio detenido tiene prioridad sobre la memoria. */
function PageBanner() {
  const { t } = useT("home")
  const { t: tc } = useT("common")
  const status = useShellStatus()
  const memory = useMemoryStatus()
  const restart = useMutation({ mutationFn: () => window.agentHub!.restartCore() })
  if (status.failing) {
    return <Banner tone="danger" action={window.agentHub && <Button small disabled={restart.isPending} onClick={() => restart.mutate()}>{t("banner.restartService")}</Button>}>{t("banner.serviceStopped")}</Banner>
  }
  const state = memory.data?.state
  if (state === "migrating" || state === "migration_pending") {
    return <Banner tone="neutral" action={<Link className="btn btn-sm" to="/activity?tab=procesamiento">{t("banner.viewProcessing")}</Link>}>{t("banner.memoryMigrating")}</Banner>
  }
  if (memory.isError || (memory.data && !memory.data.ready)) {
    return <Banner tone="danger" action={<Button small disabled={memory.isFetching} onClick={() => void memory.refetch()}>{tc("actions.retry")}</Button>}>{t("banner.memoryUnavailable")}</Banner>
  }
  return null
}

function Pending({ inbox, projectNames, reviewing, onReviewRead }: { inbox: PendingInbox; projectNames: Map<string, string>; reviewing: string | null; onReviewRead: (request: ReadRequest) => void }) {
  const { t } = useT("home")
  const { rows, dialog } = usePendingRows(inbox, projectNames, onReviewRead, reviewing)
  const [filter, setFilter] = useState<Filter>("all")
  const groups = GROUPS.filter(group => rows.some(row => row.group === group))
  const options: SegOption<Filter>[] = [
    { value: "all", label: t("pending.all"), count: rows.length },
    ...groups.map(group => ({ value: group, label: t(GROUP_LABELS[group]), count: rows.filter(row => row.group === group).length })),
  ]
  const shown = filter === "all" ? groups : groups.filter(group => group === filter)
  let body
  if (inbox.loading) body = <SkeletonRows count={3} />
  else if (inbox.error) body = <List><ErrorState error={inbox.error} title={t("pending.loadError")} onRetry={inbox.refetch} /></List>
  else if (rows.length === 0) body = <List><Empty icon="done" title={t("pending.empty")} /></List>
  else if (shown.length === 0) body = <List><EmptyFiltered text={t("pending.emptyFiltered")} onClear={() => setFilter("all")} /></List>
  else body = (
    <List>
      {shown.map((group, index) => (
        <PendingSection key={group} label={t(GROUP_LABELS[group])} rows={rows.filter(row => row.group === group)} first={index === 0} />
      ))}
    </List>
  )
  return (
    <section className="section" style={{ flex: "999 1 520px", minWidth: 0 }} aria-labelledby="home-pending">
      <div className="section-h">
        <h2 className="h2" id="home-pending">{t("pending.title")}</h2>
        {groups.length > 1 && <Seg label={t("pending.filterLabel")} options={options} value={filter} onChange={setFilter} />}
      </div>
      {body}
      {dialog}
    </section>
  )
}

function Today({ now, projectNames }: { now: Date; projectNames: Map<string, string> }) {
  const { t } = useT("home")
  const { t: ts } = useT("status")
  const format = useFormat()
  const today = useToday(now)
  const until = (at: string) => {
    const minutes = Math.max(1, Math.round((new Date(at).getTime() - now.getTime()) / MINUTE))
    return minutes < 60 ? ts("chip.inMinutes", { count: minutes }) : ts("chip.inHours", { count: Math.round(minutes / 60) })
  }
  let body
  if (today.isPending) body = <SkeletonRows count={2} avatar={false} />
  else if (today.error) body = <List><ErrorState error={today.error} onRetry={today.refetch} /></List>
  else if (today.rows.length === 0) body = <List><Empty icon="automations" title={t("today.empty")} /></List>
  else body = (
    <List>
      {today.rows.map(row => {
        const project = row.projectId ? projectNames.get(row.projectId) : undefined
        const chip = row.run
          ? <Chip tone={RUN_TONES[row.run.state]}>{ts(`delivery.${row.run.state}`)}</Chip>
          : <Chip tone="info">{until(row.at)}</Chip>
        const lead = <span className="mono t3 num xs" style={{ width: "var(--sp-7)", flex: "none" }}>{format.date(row.at, "time")}</span>
        return row.run
          ? <RowLink key={row.key} to={`/automations/deliveries/${encodeURIComponent(row.run.run_id)}`} lead={lead} title={row.title} sub={project} meta={chip} />
          : <RowLink key={row.key} to={`/automations?focus=${encodeURIComponent(row.schedule!.id)}`} lead={lead} title={row.title} sub={project} meta={chip} />
      })}
    </List>
  )
  return (
    <section className="section" aria-labelledby="home-today">
      <div className="section-h"><h2 className="h2" id="home-today">{t("today.title")}</h2><Link className="xs" to="/automations">{t("today.viewAll")}</Link></div>
      {body}
    </section>
  )
}

function Recent({ recent }: { recent: ReturnType<typeof useRecentProjects> }) {
  const { t } = useT("home")
  let body
  if (recent.isPending) body = <SkeletonRows count={3} />
  else if (recent.error) body = <List><ErrorState error={recent.error} onRetry={() => void recent.refetch()} /></List>
  else if (recent.items.length === 0) body = <List><Empty icon="projects" title={t("recent.empty")} action={<Link className="btn btn-sm" to="/projects">{t("recent.emptyAction")}</Link>} /></List>
  else body = (
    <List>
      {recent.items.map(project => (
        <RowLink key={project.id} to={`/projects/${project.id}`} lead={<Avatar name={project.title} small />} title={project.title} meta={<span className="xs t3" title={project.updated_at}>{relativeTime(project.updated_at)}</span>} />
      ))}
    </List>
  )
  return (
    <section className="section" aria-labelledby="home-recent">
      <div className="section-h"><h2 className="h2" id="home-recent">{t("recent.title")}</h2><Link className="xs" to="/projects">{t("recent.viewAll")}</Link></div>
      {body}
    </section>
  )
}

/** Inicio · plantilla D (bandeja): lo que necesita una decisión, lo que corre hoy y los proyectos recientes. Sin acciones de creación. */
export default function HomePage() {
  const now = useNow()
  const inbox = usePendingInbox()
  const recent = useRecentProjects()
  const [reviewingId, setReviewingId] = useState<string | null>(null)
  // El pedido sale de la bandeja al resolverse (o al vencer en el servidor): el panel se cierra con él.
  const reviewing = inbox.agents.readRequests.find(request => request.id === reviewingId) ?? null
  return (
    <div className="split">
      <div className="page">
        <Greeting now={now} count={inbox.count} />
        <PageBanner />
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-5)", alignItems: "flex-start" }}>
          <Pending inbox={inbox} projectNames={recent.names} reviewing={reviewing?.id ?? null} onReviewRead={request => setReviewingId(request.id)} />
          {!reviewing && (
            <aside style={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
              <Today now={now} projectNames={recent.names} />
              <Recent recent={recent} />
            </aside>
          )}
        </div>
      </div>
      {reviewing && <ReadRequestPanel key={reviewing.id} request={reviewing} onClose={() => setReviewingId(null)} />}
    </div>
  )
}

function ReadRequestPanel({ request, onClose }: { request: ReadRequest; onClose: () => void }) {
  const { t } = useT("access")
  const ts = useT("status").t
  return (
    <Panel label={t("panelTitle")} onClose={onClose}>
      <PanelHeader lead={<Avatar name={readRequestAgent(request)} />} title={t("panelTitle")} status={<Chip tone="warn">{ts("chip.awaitingDecision")}</Chip>} />
      <PanelBody>
        <ReadGrantConfirm request={request} onDone={onClose} />
      </PanelBody>
    </Panel>
  )
}
