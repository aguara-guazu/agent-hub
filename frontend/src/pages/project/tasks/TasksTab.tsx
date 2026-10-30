import { useState } from "react"
import type { KeyboardEvent } from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import {
  Button, Chip, Empty, EmptyFiltered, ErrorState, Input, List, MoreMenu, Row, RowHead, SearchInput, Seg, Select, SkeletonRows, useToast,
  type MenuItem,
} from "../../../components/ui"
import { useT } from "../../../i18n"
import { memoryCall, type MemoryEntity } from "../../../lib/memory"
import { ListDate, useErrorText, useMemoryAction } from "../shared"
import { useDebounced, useWorkFilter, useWorkPanel } from "../work"
import { JiraPanel } from "./JiraPanel"
import { StatsPanel } from "./StatsPanel"
import { TaskPanel } from "./TaskPanel"
import { useTaskLabels } from "./labels"
import { OPEN_STATUSES, TASK_STATUSES, TASK_TONE, type SyncResult, type TaskPage, type TaskRow, type TaskStatus } from "./types"

type View = "open" | "done" | "dropped" | "all"
const VIEWS: readonly View[] = ["open", "done", "dropped", "all"]
type Kind = "all" | "jira" | "pending"
const KINDS: readonly Kind[] = ["all", "jira", "pending"]
const PAGE = 50

/**
 * Tareas del proyecto: espejo de Jira (solo lectura salvo notas locales) y pendientes internos.
 * Ninguna acción de esta pestaña escribe en Jira: sincronizar solo lee y las notas quedan en el hub.
 */
export function TasksTab({ project }: { project: MemoryEntity }) {
  const { t, plural } = useT("project")
  const common = useT("common").t
  const toast = useToast()
  const errorText = useErrorText()
  const [view, setView] = useWorkFilter<View>("view", VIEWS, "open")
  const [kind, setKind] = useWorkFilter<Kind>("kind", KINDS, "all")
  const [text, setText] = useState("")
  const query = useDebounced(text.trim())
  const taskPanel = useWorkPanel("task")
  const jiraPanel = useWorkPanel("jira")
  const statsPanel = useWorkPanel("stats")
  const sync = useMemoryAction<SyncResult>("sync_tasks")
  const jiraKey = typeof project.data.jira_project_key === "string" && project.data.jira_project_key ? project.data.jira_project_key : ""

  const statusFilter = view === "all" ? {} : { status: view }
  const tasks = useInfiniteQuery({
    queryKey: ["memory", "project-tasks", project.id, view, kind, query],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => memoryCall<TaskPage>("list_tasks", { project_id: project.id, ...(kind === "all" ? {} : { kind }), ...statusFilter, ...(query ? { query } : {}), limit: PAGE, offset: pageParam }),
    getNextPageParam: last => last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })
  const items = tasks.data?.pages.flatMap(page => page.items) ?? []
  const counts = (tasks.data?.pages[0]?.counts ?? []).filter(count => kind === "all" || count.kind === kind)
  const sum = (statuses: readonly TaskStatus[]) => counts.filter(count => statuses.includes(count.status)).reduce((total, count) => total + Number(count.count), 0)
  const viewCounts: Record<View, number> = { open: sum(OPEN_STATUSES), done: sum(["done"]), dropped: sum(["dropped"]), all: sum(TASK_STATUSES) }
  const viewLabels: Record<View, string> = { open: t("tasks.seg.open"), done: t("tasks.seg.done"), dropped: t("tasks.seg.dropped"), all: t("tasks.seg.all") }

  function runSync() {
    sync.mutate({ project_id: project.id }, {
      onSuccess: result => {
        const unmatched = result.unmatched?.length ?? 0
        const detail = `${plural("tasks.syncDetail", result.received, { created: result.created, changed: result.status_changed })}${unmatched ? ` · ${plural("tasks.syncUnmatched", unmatched)}` : ""}`
        toast.show({ kind: "success", message: t("tasks.synced"), detail })
      },
    })
  }

  const more: MenuItem[] = [
    { label: jiraKey ? t("tasks.more.configureJira") : t("tasks.more.connectJira"), icon: "settings", onSelect: () => jiraPanel.open() },
    { label: t("tasks.more.stats"), icon: "activity", onSelect: () => statsPanel.open() },
  ]
  const clear = () => { setText(""); setKind("all"); setView("open") }
  const filtered = Boolean(query) || kind !== "all" || view !== "open"

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
      <QuickAdd projectId={project.id} onError={failure => toast.error(errorText(failure))} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }}>
        <Seg<View> label={t("tasks.segLabel")} value={view} onChange={setView} options={VIEWS.map(value => ({ value, label: viewLabels[value], count: tasks.data ? viewCounts[value] : undefined }))} />
        <Select<Kind> label={t("tasks.kindLabel")} value={kind} onChange={setKind} options={KINDS.map(value => ({ value, label: t(`tasks.kind.${value}`) }))} />
        <SearchInput label={t("tasks.filter")} value={text} onChange={event => setText(event.target.value)} />
        <div style={{ display: "flex", gap: "var(--sp-2)", marginLeft: "auto" }}>
          {jiraKey && <Button small icon="sync" disabled={sync.isPending} onClick={runSync}>{sync.isPending ? t("tasks.syncing") : t("tasks.sync")}</Button>}
          <MoreMenu small items={more} />
        </div>
      </div>

      {tasks.isPending ? <SkeletonRows avatar={false} label={t("tasks.loading")} />
        : tasks.error ? <List><ErrorState error={tasks.error} title={t("tasks.errorTitle")} onRetry={() => void tasks.refetch()} /></List>
        : items.length === 0
          ? filtered && viewCounts.all > 0
            ? <List><EmptyFiltered text={query ? t("tasks.filteredQuery", { query }) : t("tasks.filteredStatus")} onClear={clear} /></List>
            : <List><Empty icon="done" title={t("tasks.emptyTitle")} detail={t("tasks.emptyDetail")} action={jiraKey ? <Button small icon="sync" disabled={sync.isPending} onClick={runSync}>{t("tasks.sync")}</Button> : <Button small onClick={() => jiraPanel.open()}>{t("tasks.more.connectJira")}</Button>} /></List>
          : <>
              <List>
                {view === "open"
                  ? OPEN_STATUSES.map((group, index) => {
                      const rows = items.filter(task => task.status === group)
                      if (!rows.length) return null
                      return [
                        <RowHead key={`head-${group}`} style={index > 0 ? { borderTop: "1px solid var(--border)" } : undefined}>
                          {t("tasks.groupCount", { label: t(`tasks.group.${group}`), value: sum([group]) })}
                        </RowHead>,
                        ...rows.map(task => <TaskListRow key={task.id} task={task} selected={taskPanel.value === task.id} onOpen={() => taskPanel.open(task.id)} />),
                      ]
                    })
                  : items.map(task => <TaskListRow key={task.id} task={task} selected={taskPanel.value === task.id} onOpen={() => taskPanel.open(task.id)} />)}
              </List>
              {tasks.hasNextPage && (
                <Button small variant="ghost" style={{ alignSelf: "flex-start" }} disabled={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>
                  {common("actions.showMore")}
                </Button>
              )}
            </>}

      {taskPanel.value && <TaskPanel key={taskPanel.value} taskId={taskPanel.value} onClose={taskPanel.close} />}
      {jiraPanel.value && <JiraPanel project={project} onClose={jiraPanel.close} />}
      {statsPanel.value && <StatsPanel project={project} onClose={statsPanel.close} />}
    </div>
  )
}

function TaskListRow({ task, selected, onOpen }: { task: TaskRow; selected: boolean; onOpen: () => void }) {
  const labels = useTaskLabels()
  return (
    <Row
      onOpen={onOpen}
      selected={selected}
      lead={<span style={{ width: 96, display: "flex", flex: "none" }}><Chip tone={TASK_TONE[task.status] ?? "off"}>{labels.statusLabel(task.status)}</Chip></span>}
      title={task.title}
      sub={labels.rowDetail(task) || undefined}
      meta={<ListDate value={task.updated_at} />}
    />
  )
}

/** «Agregar una tarea y presionar Enter»: crea un pendiente interno sin modal. */
function QuickAdd({ projectId, onError }: { projectId: string; onError: (error: unknown) => void }) {
  const { t } = useT("project")
  const labels = useTaskLabels()
  const toast = useToast()
  const [title, setTitle] = useState("")
  const [state, setState] = useState<TaskStatus>("todo")
  const create = useMemoryAction("save_task", { quiet: true })
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
    event.preventDefault()
    const value = title.trim()
    if (!value || create.isPending) return
    create.mutate({ project_id: projectId, title: value, status: state, origin: "manual" }, {
      onSuccess: () => { setTitle(""); toast.success(t("tasks.created")) },
      onError,
    })
  }
  return (
    <div style={{ display: "flex", gap: "var(--sp-2)", minWidth: 0 }}>
      <Input
        style={{ flex: 1, minWidth: 0 }}
        aria-label={t("tasks.newLabel")}
        placeholder={t("tasks.newPlaceholder")}
        maxLength={500}
        value={title}
        disabled={create.isPending}
        onChange={event => setTitle(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <Select<TaskStatus> label={t("tasks.newStatus")} value={state} onChange={setState} options={(["todo", "in_progress", "blocked"] as const).map(value => ({ value, label: labels.statusLabel(value) }))} />
    </div>
  )
}
