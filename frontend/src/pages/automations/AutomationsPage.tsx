import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import {
  Avatar, Banner, Button, Chip, Empty, EmptyFiltered, ErrorState, List, Row, RowHead, Seg, Select, SkeletonRows, Switch, useToast,
} from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import { relativeTime } from "../../components/ui"
import { useAutomationSettings, useAutomationSettingsMutation, useRuns, useScheduleActions, useSchedules } from "../../lib/automations"
import type { RunListItem, ScheduleView } from "../../lib/automations"
import { DeliveryPanel } from "./DeliveryPanel"
import { SchedulePanel } from "./SchedulePanel"
import { cancel, commit, commitAll, isPending, schedule as deferAction } from "./pending"
import { ARTIFACTS, RUN_TONES, runWhen, useActionError, useDecisionSummary, useProjects, useScheduleText, type Artifact } from "./shared"

type View = "active" | "paused" | "history"
const VIEWS: readonly View[] = ["active", "paused", "history"]
const ALL = "all"
const NONE = "none"
const ROW_MIN = 560

function isView(value: string | null): value is View {
  return value !== null && (VIEWS as readonly string[]).includes(value)
}

/** Automatizaciones · plantilla A con panel. El segmentado separa activas, pausadas e historial de entregas;
 *  `/automations/deliveries/:runId` abre el historial con el detalle de esa entrega en el panel. */
export default function AutomationsPage() {
  const { t, plural } = useT("automations")
  const ts = useT("status").t
  const tc = useT("common").t
  const format = useFormat()
  const toast = useToast()
  const actionError = useActionError()
  const text = useScheduleText()
  const summary = useDecisionSummary()
  const navigate = useNavigate()
  const { runId = "" } = useParams()
  const [params, setParams] = useSearchParams()

  const schedules = useSchedules()
  const settings = useAutomationSettings()
  const saveSettings = useAutomationSettingsMutation()
  const actions = useScheduleActions()
  const projects = useProjects()

  const view: View = runId ? "history" : isView(params.get("view")) ? params.get("view") as View : "active"
  const [project, setProject] = useState<string>(ALL)
  const [kind, setKind] = useState<Artifact | typeof ALL>(ALL)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())

  const runs = useRuns({ project_id: project !== ALL && project !== NONE ? project : undefined, kind: kind !== ALL ? kind : undefined }, view === "history")

  const setView = (next: View) => {
    setSelectedId(null)
    if (runId) { navigate(next === "active" ? "/automations" : `/automations?view=${next}`); return }
    setParams(current => {
      const updated = new URLSearchParams(current)
      if (next === "active") updated.delete("view")
      else updated.set("view", next)
      updated.delete("focus")
      return updated
    }, { replace: true })
  }

  const all = useMemo(
    () => (schedules.data?.items ?? []).filter(item => (item.state === "active" || item.state === "paused") && !hidden.has(item.id)),
    [schedules.data, hidden],
  )
  const byProject = (item: { project_id: string | null }) => project === ALL || (project === NONE ? item.project_id === null : item.project_id === project)
  const active = all.filter(item => item.state === "active")
  const paused = all.filter(item => item.state === "paused")
  const visible = (view === "paused" ? paused : active).filter(byProject)
  const selected = all.find(item => item.id === selectedId) ?? null
  const projectName = useCallback((id: string | null) => (id ? projects.names.get(id) ?? null : null), [projects.names])

  // ?focus=<id> (Inicio, notificaciones del escritorio): elige la vista de esa automatización, la abre y la resalta una vez cargada.
  const focus = params.get("focus")
  useEffect(() => {
    if (!focus || !schedules.data) return
    const target = schedules.data.items.find(item => item.id === focus)
    setParams(current => {
      const updated = new URLSearchParams(current)
      updated.delete("focus")
      if (target?.state === "paused") updated.set("view", "paused")
      else if (target) updated.delete("view")
      return updated
    }, { replace: true })
    if (!target) return
    setProject(ALL)
    setSelectedId(target.id)
    requestAnimationFrame(() => document.getElementById(`schedule-${target.id}`)?.scrollIntoView?.({ block: "center" }))
  }, [focus, schedules.data, setParams])

  // Las acciones diferidas se envían al salir de la vista: Deshacer solo vale mientras el aviso está visible.
  useEffect(() => () => { void commitAll() }, [])

  function fail(message: string, error: unknown) {
    toast.error(message, actionError(error))
  }

  function togglePause(item: ScheduleView, resume: boolean) {
    const forward = resume ? actions.resume : actions.pause
    const back = resume ? actions.pause : actions.resume
    forward.mutate({ id: item.id, revision: item.revision }, {
      onSuccess: updated => toast.show({
        message: t(resume ? "toast.resumed" : "toast.paused", { name: item.title }),
        undo: () => back.mutate({ id: item.id, revision: updated.revision }, { onError: error => fail(tc("toast.actionFailed"), error) }),
      }),
      onError: error => fail(tc("toast.actionFailed"), error),
    })
  }

  function runNow(item: ScheduleView) {
    const key = `run-${item.id}`
    if (isPending(key)) return
    deferAction(key, `/memory/schedules/${encodeURIComponent(item.id)}/run_now`, {},
      error => fail(t("toast.runFailed", { name: item.title }), error),
      () => { void schedules.refetch(); toast.info(t("toast.runStarted", { name: item.title })) })
    toast.show({ kind: "info", message: t("toast.runQueued", { name: item.title }), undo: () => { cancel(key) }, onCommit: () => { void commit(key) } })
  }

  function remove(item: ScheduleView) {
    const key = `cancel-${item.id}`
    const unhide = () => setHidden(current => { const next = new Set(current); next.delete(item.id); return next })
    setHidden(current => new Set(current).add(item.id))
    setSelectedId(current => (current === item.id ? null : current))
    deferAction(key, `/memory/schedules/${encodeURIComponent(item.id)}/cancel`, { expected_revision: item.revision },
      error => { unhide(); fail(t("toast.deleteFailed", { name: item.title }), error) },
      () => { void schedules.refetch() })
    toast.show({ message: t("toast.deleted", { name: item.title }), undo: () => { cancel(key); unhide() }, onCommit: () => { void commit(key) } })
  }

  function enableAutomations() {
    saveSettings.mutate({ automations_enabled: true }, {
      onSuccess: () => toast.show({
        message: t("toast.enabled"),
        undo: () => saveSettings.mutate({ automations_enabled: false }, { onError: error => fail(tc("toast.saveFailed"), error) }),
      }),
      onError: error => fail(tc("toast.saveFailed"), error),
    })
  }

  const undeliverable = all.filter(item => item.delivery_unavailable.includes("gmail_self")).length
  const banner = settings.data && !settings.data.automations_enabled
    ? <Banner action={<Button small disabled={saveSettings.isPending} onClick={enableAutomations}>{t("banner.enable")}</Button>}>{t("banner.disabled")}</Banner>
    : undeliverable > 0
      ? <Banner action={<Button small onClick={() => navigate("/settings?section=fuentes")}>{t("banner.gmailAction")}</Button>}>{plural("banner.gmail", undeliverable)}</Banner>
      : null

  const projectOptions = [
    { value: ALL, label: t("filter.allProjects") },
    { value: NONE, label: t("filter.noProject") },
    ...projects.list.map(item => ({ value: item.id, label: item.title, avatar: item.title })),
  ]
  const kindOptions: { value: Artifact | typeof ALL; label: string }[] = [{ value: ALL, label: t("filter.allKinds") }, ...ARTIFACTS.map(value => ({ value, label: t(`artifact.${value}`) }))]
  const filtered = project !== ALL || (view === "history" && kind !== ALL)
  const clearFilters = () => { setProject(ALL); setKind(ALL) }

  function scheduleList() {
    if (schedules.isPending) return <SkeletonRows label={t("loading")} />
    if (schedules.error) return <List><ErrorState error={schedules.error} title={t("empty.errorTitle")} onRetry={() => void schedules.refetch()} /></List>
    const source = view === "paused" ? paused : active
    if (all.length === 0) return <List><Empty icon="automations" title={t("empty.title")} detail={t("empty.detail")} action={<Button small onClick={() => navigate("/projects")}>{t("empty.action")}</Button>} /></List>
    if (source.length === 0) {
      return view === "paused"
        ? <List><Empty icon="automations" title={t("empty.pausedTitle")} detail={t("empty.pausedDetail")} action={<Button small onClick={() => setView("active")}>{t("view.active")}</Button>} /></List>
        : <List><Empty icon="automations" title={t("empty.title")} detail={t("empty.detail")} action={<Button small onClick={() => navigate("/projects")}>{t("empty.action")}</Button>} /></List>
    }
    if (visible.length === 0) return <List><EmptyFiltered text={t("empty.filtered")} onClear={clearFilters} /></List>
    return (
      <List className="scroll-x">
        <RowHead style={{ minWidth: ROW_MIN }}>
          <span style={{ flex: 1 }}>{t("columns.automation")}</span>
          <span className="col" style={{ width: 110 }}>{t("columns.next")}</span>
          <span className="col" style={{ width: 40 }} />
        </RowHead>
        {visible.map(item => {
          const name = projectName(item.project_id)
          return (
            <Row
              key={item.id}
              id={`schedule-${item.id}`}
              style={{ minWidth: ROW_MIN }}
              selected={item.id === selectedId}
              onOpen={() => setSelectedId(item.id)}
              lead={<Avatar name={name ?? tc("app.name")} small />}
              title={item.title}
              sub={`${name ?? t("scope.owner")} · ${text.recurrence(item.recurrence)}`}
              meta={<span className="col xs t2 num" style={{ width: 110, whiteSpace: "nowrap" }} title={item.next_run_at && item.state === "active" ? format.date(item.next_run_at, "datetime") : undefined}>{text.nextOf(item)}</span>}
              action={<span className="col" style={{ width: 40, display: "flex", justifyContent: "flex-end" }}>
                <Switch
                  checked={item.state === "active"}
                  disabled={actions.pause.isPending || actions.resume.isPending}
                  label={t("row.switch", { name: item.title })}
                  onChange={on => togglePause(item, on)}
                />
              </span>}
            />
          )
        })}
      </List>
    )
  }

  function historyList() {
    if (runs.isPending) return <SkeletonRows label={t("loading")} />
    if (runs.error) return <List><ErrorState error={runs.error} title={t("empty.historyErrorTitle")} onRetry={() => void runs.refetch()} /></List>
    const items = (runs.data?.items ?? []).filter(byProject)
    if (items.length === 0) {
      return filtered
        ? <List><EmptyFiltered text={t("empty.historyFiltered")} onClear={clearFilters} /></List>
        : <List><Empty icon="automations" title={t("empty.historyTitle")} detail={t("empty.historyDetail")} action={<Button small onClick={() => setView("active")}>{t("view.active")}</Button>} /></List>
    }
    return (
      <List className="scroll-x">
        <RowHead style={{ minWidth: ROW_MIN }}>
          <span style={{ flex: 1 }}>{t("columns.delivery")}</span>
          <span className="col" style={{ width: 160 }}>{t("columns.status")}</span>
        </RowHead>
        {items.map((run: RunListItem) => {
          const name = projectName(run.project_id)
          const decision = run.decision?.state === "pending"
          const detail = [name, relativeTime(runWhen(run)), run.decision && run.decision.state !== "none" ? summary(run.decision) : null].filter(Boolean).join(" · ")
          return (
            <Row
              key={run.run_id}
              style={{ minWidth: ROW_MIN }}
              selected={run.run_id === runId}
              onOpen={() => navigate(`/automations/deliveries/${encodeURIComponent(run.run_id)}`)}
              lead={<Avatar name={name ?? tc("app.name")} small />}
              title={<>{run.read_at ? null : <span className="dot" role="img" aria-label={t("row.unread")} style={{ display: "inline-block", marginRight: "var(--sp-2)", background: "var(--info)" }} />}{run.title}</>}
              titleText={run.title}
              sub={detail}
              meta={<span className="col" style={{ width: 160, display: "flex" }}>
                {decision ? <Chip tone="warn">{ts("chip.awaitingDecision")}</Chip> : <Chip tone={RUN_TONES[run.state]}>{ts(`delivery.${run.state}`)}</Chip>}
              </span>}
            />
          )
        })}
      </List>
    )
  }

  const showBar = view === "history" || !schedules.isPending
  return (
    <div className="split">
      <div className="page">
        <div className="ph"><div className="ph-text"><h1 className="h1">{t("title")}</h1></div></div>
        {banner}
        {showBar && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }}>
            <Seg<View>
              label={t("view.label")}
              value={view}
              onChange={setView}
              options={[
                { value: "active", label: t("view.active"), count: active.length },
                { value: "paused", label: t("view.paused"), count: paused.length },
                { value: "history", label: t("view.history") },
              ]}
            />
            <Select label={t("filter.project")} value={project} options={projectOptions} onChange={setProject} />
            {view === "history" && <Select<Artifact | typeof ALL> label={t("filter.kind")} value={kind} options={kindOptions} onChange={setKind} />}
          </div>
        )}
        {view === "history" ? historyList() : scheduleList()}
      </div>

      {view !== "history" && selected && (
        <SchedulePanel
          key={selected.id}
          schedule={selected}
          projectName={projectName(selected.project_id)}
          availability={schedules.data?.delivery_available}
          onClose={() => setSelectedId(null)}
          onRunNow={runNow}
          onDelete={remove}
        />
      )}
      {runId && <DeliveryPanel key={runId} runId={runId} projectName={projectName} onClose={() => navigate("/automations?view=history")} />}
    </div>
  )
}
