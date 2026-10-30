import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import {
  Avatar, Banner, Button, Chip, Empty, EmptyFiltered, ErrorState, List, Row, RowHead, Seg, Select, SkeletonRows, Switch, useToast,
} from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import { useQueryClient } from "@tanstack/react-query"
import {
  markAllRunsRead, markRunUnread, restoreErrorCode, setRunsRead, useAutomationSettings, useAutomationSettingsMutation, useRuns, useScheduleActions, useSchedules, useUnreadRunCount,
} from "../../lib/automations"
import type { RunListItem, ScheduleView } from "../../lib/automations"
import { DeliveryPanel } from "./DeliveryPanel"
import { HistoryList } from "./HistoryList"
import { SchedulePanel } from "./SchedulePanel"
import { cancel, commit, commitAll, isPending, schedule as deferAction } from "./pending"
import { useActionError, useProjects, useScheduleText } from "./shared"

type View = "active" | "paused" | "history"
type Show = "unread" | "all"
const VIEWS: readonly View[] = ["active", "paused", "history"]
const ALL = "all"
const NONE = "none"
const ROW_MIN = 560
const PAGE = 50
/** Tope de `limit` del core para `GET …/schedules/runs`. */
const MAX_PAGE = 200

/** J/K no se roban de un campo de texto, de un diálogo modal ni de un menú abierto. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target.closest("textarea, select, [role='combobox'], [role='listbox'], [role='menu']")) return true
  return target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "reset"].includes(target.type)
}

function isView(value: string | null): value is View {
  return value !== null && (VIEWS as readonly string[]).includes(value)
}

/** Automatizaciones · plantilla A con panel. El segmentado separa activas, pausadas e historial de entregas;
 *  `/automations/deliveries/:runId` abre el historial con el detalle de esa entrega en el panel. */
export default function AutomationsPage() {
  const { t, plural } = useT("automations")
  const tc = useT("common").t
  const format = useFormat()
  const toast = useToast()
  const actionError = useActionError()
  const text = useScheduleText()
  const cache = useQueryClient()
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
  const [show, setShow] = useState<Show>("unread")
  const [limit, setLimit] = useState(PAGE)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [selection, setSelection] = useState<Set<string>>(new Set())
  /**
   * Estado de lectura cambiado en esta vista. Con «Sin ver», una entrega que se abre o se marca como vista sigue en la lista
   * (si no, desaparecería bajo el cursor y J/K perderían el lugar) hasta que cambie el filtro.
   */
  const [touched, setTouched] = useState<ReadonlyMap<string, RunListItem>>(new Map())
  const [marking, setMarking] = useState(false)

  const projectFilter = project !== ALL && project !== NONE ? project : undefined
  const runs = useRuns({ project_id: projectFilter, unread: show === "unread" ? "true" : undefined, limit: String(limit) }, view === "history")
  const unreadTotal = useUnreadRunCount()

  const setView = (next: View) => {
    setSelectedId(null)
    setSelection(new Set())
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

  /** Cancela en el acto; «Deshacer» la restaura con la revisión que devolvió el cancel (ventana de 10 min en el servidor). */
  function remove(item: ScheduleView) {
    const unhide = () => setHidden(current => { const next = new Set(current); next.delete(item.id); return next })
    setHidden(current => new Set(current).add(item.id))
    setSelectedId(current => (current === item.id ? null : current))
    actions.cancel.mutate({ id: item.id, revision: item.revision }, {
      onSuccess: cancelled => {
        unhide()
        toast.show({ message: t("toast.deleted", { name: item.title }), undo: () => restore(item, cancelled.revision) })
      },
      onError: error => { unhide(); fail(t("toast.deleteFailed", { name: item.title }), error) },
    })
  }

  function restore(item: ScheduleView, revision: number) {
    actions.restore.mutate({ id: item.id, revision }, {
      onSuccess: restored => {
        const aborted = restored.restore.aborted_runs.length
        if (aborted > 0) toast.show({ kind: "info", message: t("toast.restored", { name: item.title }), detail: plural("toast.abortedRuns", aborted), duration: 10000 })
      },
      onError: error => {
        const code = restoreErrorCode(error)
        toast.error(t("toast.restoreFailed", { name: item.title }), code ? t(`restoreErrors.${code}`) : actionError(error))
      },
    })
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
  const showOptions: { value: Show; label: string }[] = [{ value: "unread", label: t("filter.unread") }, { value: "all", label: t("filter.all") }]
  const clearFilters = () => { setProject(ALL); resetHistory() }
  const changeProject = (next: string) => { setProject(next); resetHistory() }
  const changeShow = (next: Show) => { setShow(next); resetHistory() }

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
    if (view === "paused") {
      return (
        <List className="scroll-x">
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
                sub={[name ?? t("scope.owner"), text.pausedBy(item)].filter(Boolean).join(" · ")}
                meta={<Chip tone="off">{t("next.paused")}</Chip>}
                action={<Switch
                  checked={false}
                  disabled={actions.pause.isPending || actions.resume.isPending}
                  label={t("row.switch", { name: item.title })}
                  onChange={on => togglePause(item, on)}
                />}
              />
            )
          })}
        </List>
      )
    }
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

  const projectRuns = useMemo(() => {
    const server = (runs.data?.items ?? []).filter(byProject)
    const ids = new Set(server.map(run => run.run_id))
    const list = server.map(run => {
      const local = touched.get(run.run_id)
      return local ? { ...run, read_at: local.read_at } : run
    })
    if (show === "unread") for (const run of touched.values()) if (!ids.has(run.run_id) && byProject(run)) list.push(run)
    return list.sort((a, b) => Date.parse(b.scheduled_for) - Date.parse(a.scheduled_for) || a.run_id.localeCompare(b.run_id))
    // `byProject` depende solo de `project`.
  }, [runs.data, touched, show, project])

  const touch = useCallback((items: readonly RunListItem[], read: boolean) => {
    const at = new Date().toISOString()
    setTouched(current => {
      const next = new Map(current)
      for (const run of items) next.set(run.run_id, { ...run, read_at: read ? run.read_at ?? at : null })
      return next
    })
  }, [])
  const resetHistory = () => { setTouched(new Map()); setSelection(new Set()); setLimit(PAGE) }

  const order = projectRuns.map(run => run.run_id)
  const current = order.indexOf(runId)
  const previousRun = current > 0 ? projectRuns[current - 1] : undefined
  const nextUnreadRun = projectRuns.slice(current + 1).find(run => run.read_at === null)

  const openRun = useCallback((run: RunListItem) => {
    if (run.read_at === null) touch([run], true)
    navigate(`/automations/deliveries/${encodeURIComponent(run.run_id)}`)
    requestAnimationFrame(() => document.getElementById(`delivery-${run.run_id}`)?.scrollIntoView?.({ block: "nearest" }))
  }, [navigate, touch])

  // Un enlace directo a una entrega sin ver la marca como vista al abrirse: se conserva en «Sin ver» igual que al abrirla desde la lista.
  const opened = useRef("")
  useEffect(() => {
    if (!runId || opened.current === runId) return
    const run = runs.data?.items.find(item => item.run_id === runId)
    if (!run) return
    opened.current = runId
    if (run.read_at === null) touch([run], true)
  }, [runId, runs.data, touch])

  const keys = useRef({ previous: previousRun, next: nextUnreadRun, open: openRun })
  keys.current = { previous: previousRun, next: nextUnreadRun, open: openRun }
  useEffect(() => {
    if (view !== "history") return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return
      const key = event.key.toLowerCase()
      if (key !== "j" && key !== "k") return
      if (typing(event.target) || document.querySelector("[aria-modal='true'], .pop")) return
      const target = key === "j" ? keys.current.next : keys.current.previous
      if (!target) return
      event.preventDefault()
      keys.current.open(target)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [view])

  const refreshRuns = () => cache.invalidateQueries({ queryKey: ["schedule-runs"] })

  function markRead(ids: readonly string[], read: boolean) {
    const items = projectRuns.filter(run => ids.includes(run.run_id))
    if (items.length === 0) return
    setMarking(true)
    touch(items, read)
    setRunsRead(items.map(run => run.run_id), read)
      .then(changed => {
        setSelection(new Set())
        if (changed.length === 0) return
        const undoItems = items.filter(run => changed.includes(run.run_id))
        toast.show({
          message: plural(read ? "toast.markedRead" : "toast.markedUnread", changed.length),
          undo: () => {
            touch(undoItems, !read)
            void setRunsRead(changed, !read).catch(error => fail(tc("toast.actionFailed"), error)).finally(() => void refreshRuns())
          },
        })
      })
      .catch(error => {
        touch(items.filter(run => (run.read_at === null) !== read), !read)
        fail(tc("toast.actionFailed"), error)
      })
      .finally(() => { setMarking(false); void refreshRuns() })
  }

  function markAll() {
    setMarking(true)
    const visibleUnread = projectRuns.filter(run => run.read_at === null)
    touch(visibleUnread, true)
    markAllRunsRead(projectFilter)
      .then(changed => {
        setSelection(new Set())
        if (changed.length === 0) return
        toast.show({
          message: plural("toast.markedRead", changed.length),
          undo: () => {
            touch(visibleUnread.filter(run => changed.includes(run.run_id)), false)
            void setRunsRead(changed, false).catch(error => fail(tc("toast.actionFailed"), error)).finally(() => void refreshRuns())
          },
        })
      })
      .catch(error => { touch(visibleUnread, false); fail(tc("toast.actionFailed"), error) })
      .finally(() => { setMarking(false); void refreshRuns() })
  }

  function markOneUnread(run: { run_id: string }) {
    const item = projectRuns.find(entry => entry.run_id === run.run_id)
    if (item) touch([item], false)
    navigate("/automations?view=history")
    markRunUnread(run.run_id)
      .then(() => toast.show({
        message: plural("toast.markedUnread", 1),
        undo: () => { if (item) touch([item], true); void setRunsRead([run.run_id], true).finally(() => void refreshRuns()) },
      }))
      .catch(error => { if (item) touch([item], true); fail(tc("toast.actionFailed"), error) })
      .finally(() => void refreshRuns())
  }

  function historyList() {
    if (runs.isPending) return <SkeletonRows label={t("loading")} />
    if (runs.error) return <List><ErrorState error={runs.error} title={t("empty.historyErrorTitle")} onRetry={() => void runs.refetch()} /></List>
    if (projectRuns.length === 0) {
      if (project !== ALL) return <List><EmptyFiltered text={t("empty.historyFiltered")} onClear={clearFilters} /></List>
      return show === "unread"
        ? <List><Empty icon="done" title={t("empty.unreadTitle")} detail={t("empty.unreadDetail")} action={<Button small onClick={() => { resetHistory(); setShow("all") }}>{t("filter.showAll")}</Button>} /></List>
        : <List><Empty icon="automations" title={t("empty.historyTitle")} detail={t("empty.historyDetail")} action={<Button small onClick={() => setView("active")}>{t("view.active")}</Button>} /></List>
    }
    const total = runs.data?.total ?? 0
    const loaded = runs.data?.items.length ?? 0
    return (
      <>
        <HistoryList
          items={projectRuns}
          selection={selection}
          onSelectionChange={setSelection}
          activeId={runId}
          onOpen={openRun}
          projectName={projectName}
          onMarkRead={ids => markRead(ids, true)}
          onMarkUnread={ids => markRead(ids, false)}
          busy={marking}
        />
        {total > loaded && (limit < MAX_PAGE
          ? <Button small variant="ghost" style={{ alignSelf: "center" }} disabled={runs.isFetching} onClick={() => setLimit(value => Math.min(value + PAGE, MAX_PAGE))}>{tc("actions.showMore")}</Button>
          : <span className="hint" style={{ alignSelf: "center" }}>{t("history.capped", { count: loaded })}</span>)}
      </>
    )
  }

  const showBar = view === "history" || !schedules.isPending
  return (
    <div className="split">
      <div className="page">
        <div className="ph">
          <div className="ph-text"><h1 className="h1">{t("title")}</h1></div>
          {view === "history" && unreadTotal.count > 0 && (
            <div className="ph-actions"><Button icon="check" disabled={marking} onClick={markAll}>{t("history.markAllRead")}</Button></div>
          )}
        </div>
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
                { value: "history", label: t("view.history"), badge: { count: unreadTotal.count, label: plural("history.unreadBadge", unreadTotal.count) } },
              ]}
            />
            {view === "history" && <Select<Show> label={t("filter.show")} value={show} options={showOptions} onChange={changeShow} />}
            <Select label={t("filter.project")} value={project} options={projectOptions} onChange={changeProject} />
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
      {runId && (
        <DeliveryPanel
          key={runId}
          runId={runId}
          projectName={projectName}
          onClose={() => navigate("/automations?view=history")}
          onPrevious={previousRun ? () => openRun(previousRun) : undefined}
          onNextUnread={nextUnreadRun ? () => openRun(nextUnreadRun) : undefined}
          onMarkUnread={markOneUnread}
        />
      )}
    </div>
  )
}
