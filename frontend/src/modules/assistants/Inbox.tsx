import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Banner, Button, Empty, EmptyFiltered, ErrorState, MoreMenu, SearchInput, Seg, Select, SkeletonRows, List, useToast } from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import { api } from "../../lib/api"
import { useModules } from "../state"
import { AssistantPanel } from "./AssistantPanel"
import { DelegateDialog } from "./DelegateDialog"
import { IssueList, type IssueGroup, type IssueRow } from "./IssueList"
import { WorkRows } from "./WorkRows"
import { band, useInbox, useIssue, useNotice, usePendingCount, useProfile, useProjects, useWork, type Band, type Issue, type View, type Work } from "./data"
import { useFailure, useLabels } from "./shared"
import "./assistants.css"

const VIEWS: readonly View[] = ["attention", "history", "work"]
const BANDS: readonly Band[] = ["urgent", "important", "low"]
const BAND_LABEL = { urgent: "bandUrgent", important: "bandImportant", low: "bandLow" } as const
// Above this many, blocked tasks are summarized in one row instead of being listed among the issues.
const INLINE_BLOCKED = 5

function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
}

/** One row for many blocked tasks: how many, the reason most of them share, and the way to their list. */
function BlockedSummary({ items, total, onOpen }: { items: readonly Work[]; total: number; onOpen: () => void }) {
  const { t, plural } = useT("assistants")
  const reasons = new Map<string, number>()
  for (const item of items) if (item.result?.summary) reasons.set(item.result.summary, (reasons.get(item.result.summary) ?? 0) + 1)
  const reason = [...reasons].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ""
  return (
    <div className="row">
      <div className="row-main">
        <span className="row-title">{plural("blockedMany", total)}</span>
        {reason && (
          <span className="row-sub" title={reason}>
            {reason}
          </span>
        )}
      </div>
      <Button small onClick={onOpen}>
        {t("openTasks")}
      </Button>
    </div>
  )
}

export default function Inbox() {
  const { t, plural } = useT("assistants")
  const format = useFormat()
  const labels = useLabels()
  const toast = useToast()
  const fail = useFailure()
  const cache = useQueryClient()
  const go = useNavigate()
  const { id } = useParams()
  const [params] = useSearchParams()
  const project = params.get("project") ?? ""
  const noticeId = params.get("notice")
  const taskId = params.get("task") ?? undefined
  const requested = params.get("view")
  const view: View = VIEWS.includes(requested as View) ? (requested as View) : "attention"
  const [typed, setTyped] = useState("")
  const [search, setSearch] = useState("")
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [delegating, setDelegating] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed.trim()), 250)
    return () => clearTimeout(timer)
  }, [typed])

  const modules = useModules()
  const projects = useProjects()
  const profile = useProfile(project)
  const pending = usePendingCount(project)
  const state = view === "history" ? "history" : "attention"
  const inbox = useInbox(project, state, search, view !== "work" && !noticeId)
  const notice = useNotice(noticeId)
  const agents = modules.data?.agents !== false
  const work = useWork(project)
  const selected = useIssue(id)
  const selectedWork = taskId && !id ? work.data?.items.find((w) => w.id === taskId) : undefined

  const items = projects.data?.items ?? []
  const model = projects.data?.model
  const tracked = items.filter((p) => p.active)
  const name = (projectId: string) => items.find((p) => p.id === projectId)?.title ?? ""
  const failing = (project ? tracked.filter((p) => p.id === project) : tracked).filter((p) => p.last_error)
  const lastScan = project
    ? profile.data?.last_scan
    : tracked
        .map((p) => p.last_scan)
        .filter((s): s is string => !!s)
        .sort()
        .at(-1)
  const blocked = agents ? (work.data?.items ?? []).filter((w) => w.state === "blocked") : []
  const blockedTotal = agents ? Math.max(work.data?.blocked ?? 0, blocked.length) : 0
  const waiting = pending.data ?? 0

  /** Route of this page for an issue (path) or a delegated task (`task`), keeping the filters that still apply. */
  function to(next: { id?: string | undefined; task?: string | undefined; view?: View; project?: string; notice?: string | null }) {
    const query = new URLSearchParams()
    const nextView = next.view ?? view
    const nextProject = next.project ?? project
    const nextNotice = next.notice === undefined ? noticeId : next.notice
    if (nextProject) query.set("project", nextProject)
    if (nextNotice) query.set("notice", nextNotice)
    if (nextView !== "attention") query.set("view", nextView)
    if (next.task && !next.id) query.set("task", next.task)
    const text = query.toString()
    return "/assistants" + (next.id ? "/" + next.id : "") + (text ? "?" + text : "")
  }
  const openWork = (w: Work) => go(to({ task: w.id === taskId ? undefined : w.id }))
  const refresh = () => cache.invalidateQueries({ queryKey: ["assistants"] })

  const loaded = useMemo(() => [...new Map((inbox.data?.pages ?? []).flatMap((p) => p.items).map((c) => [c.id, c])).values()], [inbox.data])
  const totals = inbox.data?.pages[0]
  const rowOf = (issue: Issue): IssueRow => ({
    id: issue.id,
    title: issue.title,
    project: issue.project_title ?? name(issue.project_id),
    detail: issue.reason,
    score: issue.score,
    tag: labels.kind(issue.kind),
    chip: labels.issue(issue),
    at: issue.updated_at,
    selectable: view === "attention" && issue.state === "open",
  })
  const noticeRows: IssueRow[] = (notice.data?.entries ?? [])
    .filter((e) => e.kind !== "work")
    .map((e) => ({
      id: e.id,
      title: e.title,
      project: e.project,
      detail: [e.calendar, e.reason].filter(Boolean).join(" · "),
      score: e.severity,
      tag: e.source,
      chip: null,
      selectable: true,
    }))
  const rows = noticeId ? noticeRows : loaded.map(rowOf)
  const order = rows.map((r) => r.id)

  const retry = useMutation({
    mutationFn: (w: Work) => api.post("/assistants/work/" + w.project_id + "/" + w.id + "/retry", {}),
    onSuccess: () => {
      toast.success(t("retried"))
    },
    onError: fail,
    onSettled: () => cache.invalidateQueries({ queryKey: ["assistants", "work"] }),
  })
  const restore = useMutation({
    mutationFn: (ids: string[]) => api.post<{ ids: string[] }>("/assistants/cases/restore", { ids }),
    onError: fail,
    onSettled: refresh,
  })
  const dismiss = useMutation({
    mutationFn: (ids: string[]) => api.post<{ ids: string[] }>("/assistants/cases/dismiss", { ids }),
    onSuccess: ({ ids }) => {
      setSelection(new Set())
      if (id && ids.includes(id)) go(to({}))
      if (ids.length) toast.show({ message: plural("dismissed", ids.length), undo: () => restore.mutate(ids) })
    },
    onError: fail,
    onSettled: refresh,
  })
  const scan = useMutation({
    mutationFn: () => api.post(project ? "/assistants/projects/" + project + "/scan" : "/assistants/scan", {}),
    onSuccess: () => {
      toast.success(t("scanDone"))
    },
    onError: fail,
    onSettled: refresh,
  })
  function restoreIssues(ids: string[]) {
    restore.mutate(ids, { onSuccess: (result) => void (result.ids.length && toast.success(plural("restored", result.ids.length))) })
  }

  const keys = useRef({ order, id, open: (next: string) => go(to({ id: next })) })
  keys.current = { order, id, open: (next: string) => go(to({ id: next })) }
  useEffect(() => {
    if (view === "work") return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return
      const key = event.key.toLowerCase()
      if (key !== "j" && key !== "k") return
      if (typing(event.target) || document.querySelector("[aria-modal='true'], .pop")) return
      const { order, id, open } = keys.current
      const at = id ? order.indexOf(id) : -1
      const next = order[key === "j" ? at + 1 : at < 0 ? 0 : at - 1]
      if (!next) return
      event.preventDefault()
      open(next)
      document.getElementById("issue-" + next)?.scrollIntoView({ block: "nearest" })
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [view])

  if (projects.error && !projects.data)
    return (
      <div className="page">
        <header className="ph">
          <h1 className="h1">{t("title")}</h1>
        </header>
        <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
      </div>
    )
  if (projects.data && !items.length)
    return (
      <div className="page">
        <header className="ph">
          <h1 className="h1">{t("title")}</h1>
        </header>
        <Empty icon="projects" title={t("emptyProjects")} />
      </div>
    )

  const groups: IssueGroup[] = []
  if (view === "attention" && !noticeId) {
    for (const key of BANDS) {
      const members = rows.filter((r) => band(r.score) === key)
      const count = totals ? (key === "urgent" ? totals.urgent : key === "important" ? totals.important : totals.total - totals.urgent - totals.important) : members.length
      if (members.length) groups.push({ key, label: t("groupCount", { label: t(BAND_LABEL[key]), count: Math.max(count, members.length) }), rows: members })
      if (key === "important" && blockedTotal && !search)
        groups.push({
          key: "work",
          label: t("groupCount", { label: t("blockedWork"), count: blockedTotal }),
          node:
            blockedTotal <= INLINE_BLOCKED ? (
              <WorkRows items={blocked} activeId={selectedWork?.id} onOpen={openWork} onRetry={(w) => retry.mutate(w)} busy={retry.isPending} />
            ) : (
              <BlockedSummary items={blocked} total={blockedTotal} onOpen={() => go(to({ view: "work", notice: null }))} />
            ),
        })
    }
  } else if (rows.length) groups.push({ key: "all", label: noticeId ? plural("noticeFilter", rows.length) : t("history"), rows })

  const filtered = !!search || !!project
  const listLoading = noticeId ? notice.isPending : inbox.isPending
  const listError = noticeId ? notice.error : inbox.error
  const clear = () => {
    setTyped("")
    setSearch("")
    go(to({ id, project: "" }))
  }
  const shown = loaded.length
  const paused = !!project && profile.data?.config.active === false

  return (
    <div className="page page-fill assistant-page">
      <header className="ph">
        <div className="ph-text">
          <h1 className="h1">{t("title")}</h1>
          {projects.data && (
            <span className="t2">
              {waiting ? plural("summary", waiting) : t("summaryClear")}
              {paused ? <> · {t("paused")}</> : lastScan && <> · {t("lastScan", { when: format.relative(lastScan) })}</>}
            </span>
          )}
        </div>
        <div className="ph-actions">
          {agents && tracked.length > 0 && <Button onClick={() => setDelegating(true)}>{t("delegateTask")}</Button>}
          <MoreMenu
            label={t("moreActions")}
            items={[
              { label: t("scan"), icon: "refresh", onSelect: () => scan.mutate(), disabled: scan.isPending || !tracked.length },
              { label: t("settings"), icon: "settings", onSelect: () => go("/settings?section=assistants") },
            ]}
          />
        </div>
      </header>
      {(model?.gap || failing.length > 0) && (
        <Banner
          tone="warn"
          action={
            model?.gap ? (
              <Button small onClick={() => go("/settings?section=memory")}>
                {t("configureModel")}
              </Button>
            ) : undefined
          }
        >
          {model?.gap && (
            <>
              <strong>{t(model.gap === "local" ? "localModelMissing" : "modelMissing")}</strong>
              <span className="t2 clamp2">{model.gap === "local" ? plural("localModelDetail", model.projects) : t("modelMissingDetail")}</span>
            </>
          )}
          {failing.length > 0 && (
            <>
              <strong>{plural("scanErrors", failing.length)}</strong>
              <span className="t2 clamp2" title={failing.map((p) => p.title + ": " + p.last_error).join("\n")}>
                {failing[0]!.title}: {failing[0]!.last_error}
              </span>
            </>
          )}
        </Banner>
      )}
      <div className="fill assistant-board">
        <section className="assistant-list" aria-label={t("issues")}>
          <div className="assistant-bar">
            <Seg
              label={t("views")}
              value={view}
              onChange={(next) => {
                setSelection(new Set())
                go(to({ view: next, notice: null }))
              }}
              options={[
                { value: "attention", label: t("attention"), badge: { count: waiting, label: plural("summary", waiting) } },
                { value: "history", label: t("history") },
                ...(agents
                  ? [{ value: "work" as const, label: t("tasks"), count: work.data?.total ?? 0, badge: { count: blockedTotal, label: plural("blockedMany", blockedTotal) } }]
                  : []),
              ]}
            />
            {view !== "work" && !noticeId && (
              <SearchInput label={t("searchIssues")} value={typed} onChange={(event) => setTyped(event.target.value)} />
            )}
            {noticeId ? (
              <Button small icon="close" onClick={() => go(to({ notice: null }))}>
                {t("showAllIssues")}
              </Button>
            ) : (
              <Select
                label={t("project")}
                value={project}
                options={[{ label: t("allProjects"), value: "" }, ...items.map((p) => ({ label: p.title, value: p.id }))]}
                onChange={(next) => {
                  setSelection(new Set())
                  go(to({ project: next }))
                }}
              />
            )}
          </div>
          {view === "work" ? (
            work.error && !work.data ? (
              <ErrorState error={work.error} onRetry={() => void work.refetch()} />
            ) : !work.data ? (
              <SkeletonRows count={4} avatar={false} />
            ) : !work.data.items.length ? (
              <Empty
                icon="automations"
                title={t("emptyTasks")}
                action={tracked.length > 0 ? <Button small onClick={() => setDelegating(true)}>{t("delegateTask")}</Button> : undefined}
              />
            ) : (
              <List className="assistant-rows" aria-label={t("tasks")}>
                <WorkRows items={work.data.items} activeId={selectedWork?.id} onOpen={openWork} onRetry={(w) => retry.mutate(w)} busy={retry.isPending} />
                {(work.data.total ?? 0) > work.data.items.length && (
                  <div className="assistant-more">
                    <span className="xs t3 num">{t("shown", { shown: work.data.items.length, total: work.data.total })}</span>
                  </div>
                )}
                {!!profile.data?.estimates.length && (
                  <details className="assistant-sources assistant-cost">
                    <summary className="xs t3">{t("cost")}</summary>
                    <ul>
                      {profile.data.estimates.map((e) => (
                        <li key={e.role + e.model} className="xs t2">
                          {t(e.role)} · {e.model} · {e.median_tokens === null ? t("insufficient") : t("tokens", { count: e.median_tokens })} ·{" "}
                          {t("sample", { count: e.samples })}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </List>
            )
          ) : listError && !rows.length ? (
            <ErrorState error={listError} onRetry={() => void (noticeId ? notice.refetch() : inbox.refetch())} />
          ) : listLoading ? (
            <SkeletonRows count={6} avatar={false} label={t("loadingIssues")} />
          ) : !groups.length ? (
            noticeId ? (
              <Empty icon="done" title={t("noticeCleared")} action={<Button small onClick={() => go(to({ notice: null }))}>{t("showAllIssues")}</Button>} />
            ) : filtered ? (
              <EmptyFiltered text={t("emptyFiltered")} onClear={clear} />
            ) : view === "history" ? (
              <Empty icon="done" title={t("emptyHistory")} />
            ) : (
              <Empty
                icon="done"
                title={t("emptyAttention")}
                detail={t("emptyAttentionDetail")}
                action={
                  tracked.length > 0 ? (
                    <Button small disabled={scan.isPending} onClick={() => scan.mutate()}>
                      {t("scan")}
                    </Button>
                  ) : undefined
                }
              />
            )
          ) : (
            <IssueList
              groups={groups}
              activeId={id}
              onOpen={(row) => go(to({ id: row.id === id ? undefined : row.id }))}
              selection={selection}
              onSelectionChange={setSelection}
              onDismiss={(ids) => dismiss.mutate(ids)}
              busy={dismiss.isPending}
              footer={
                !noticeId && totals && (inbox.hasNextPage || totals.total > shown) ? (
                  <div className="assistant-more">
                    <span className="xs t3 num">{t("shown", { shown, total: totals.total })}</span>
                    {inbox.hasNextPage && (
                      <Button small disabled={inbox.isFetchingNextPage} onClick={() => void inbox.fetchNextPage()}>
                        {t("more")}
                      </Button>
                    )}
                  </div>
                ) : undefined
              }
            />
          )}
        </section>
        <AssistantPanel
          tracked={tracked.length}
          issue={id ? selected.data : null}
          issueProject={selected.data ? name(selected.data.project_id) : ""}
          issueActive={!!selected.data && tracked.some((p) => p.id === selected.data!.project_id)}
          issueError={id && !selected.data ? selected.error : null}
          work={selectedWork}
          connections={modules.data?.connections !== false}
          onClose={() => go(to({}))}
          onDismiss={(ids) => dismiss.mutate(ids)}
          onRestore={restoreIssues}
          onRetry={(w) => retry.mutate(w)}
          busy={dismiss.isPending || restore.isPending || retry.isPending}
        />
      </div>
      <DelegateDialog open={delegating} onClose={() => setDelegating(false)} projects={items} project={project || selected.data?.project_id || ""} />
    </div>
  )
}
