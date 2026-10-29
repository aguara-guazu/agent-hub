import { useCallback, useEffect, useMemo, useState } from "react"
import type { CSSProperties } from "react"
import { useSearchParams } from "react-router-dom"
import {
  Avatar, Banner, Button, Empty, EmptyFiltered, ErrorState, List, RowHead, RowLink, SearchInput, Seg, Select, SkeletonRows, SplitButton,
  hasBlockingLayer, hueFor, initials, type MenuItem,
} from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import type { MemoryEntity } from "../../lib/memory"
import { projectActivity, projectStage, useAllProjects, useCompanies, type ProjectWithSummary } from "../../lib/projects"
import { ListDate, StageChip, useNarrow } from "../project/shared"
import { NewProjectDialog } from "./NewProjectDialog"
import { SharedProjectDialog, type SharedMode } from "./SharedProjectDialog"
import { SuggestionDialog, usePendingSuggestions } from "./SuggestionDialog"

type View = "active" | "completed" | "all"
type Sort = "recent" | "name"
const NO_COMPANY = "none"
/** tokens.css (previo al rediseño) define `.col` como columna flex; se fija la dirección para que los chips no se estiren. */
const col = (width: number, end = false): CSSProperties => ({ width, display: "flex", flexDirection: "row", alignItems: "center", gap: 0, justifyContent: end ? "flex-end" : "flex-start" })

/** Etapa «completada»: el resto (incluida «pausado») cuenta como activo. */
function isCompleted(project: MemoryEntity) {
  return projectStage(project) === "completed"
}

/** Proyectos · plantilla A sin panel: las filas abren la ficha. Atiende `?new=project`. */
export default function ProjectsPage() {
  const { t } = useT("projects")
  const [params, setParams] = useSearchParams()
  const view = (["active", "completed", "all"] as const).find(value => value === params.get("view")) ?? "active"
  const sort: Sort = params.get("sort") === "name" ? "name" : "recent"
  const query = params.get("q") ?? ""
  const companyFilter = params.get("company") ?? ""
  const [creating, setCreating] = useState(params.get("new") === "project")
  const [shared, setShared] = useState<SharedMode | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const projects = useAllProjects()
  const companies = useCompanies()
  const suggestions = usePendingSuggestions()
  const narrow = useNarrow()
  const medium = useNarrow(1279)

  const update = useCallback((values: Record<string, string>) => setParams(current => {
    const next = new URLSearchParams(current)
    for (const [key, value] of Object.entries(values)) {
      if (!value) next.delete(key)
      else next.set(key, value)
    }
    return next
  }, { replace: true }), [setParams])

  useEffect(() => {
    if (params.get("new") !== "project") return
    setCreating(true)
    update({ new: "" })
  }, [params, update])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "n") return
      if (hasBlockingLayer()) return
      event.preventDefault()
      setCreating(true)
    }
    document.addEventListener("keydown", listener)
    return () => document.removeEventListener("keydown", listener)
  }, [])

  const companyNames = useMemo(() => new Map((companies.data?.items ?? []).map(company => [company.id, company.title])), [companies.data])
  const items = projects.data?.items ?? []
  const companyOf = useCallback((project: ProjectWithSummary) => {
    const summary = project.summary?.project
    if (summary) return summary.company?.title
    const id = project.data.company_id
    return typeof id === "string" ? companyNames.get(id) : undefined
  }, [companyNames])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const list = items.filter(project => {
      if (companyFilter === NO_COMPANY ? Boolean(project.data.company_id) : companyFilter && project.data.company_id !== companyFilter) return false
      if (!needle) return true
      return project.title.toLowerCase().includes(needle) || (companyOf(project) ?? "").toLowerCase().includes(needle)
    })
    return list.sort((a, b) => sort === "name" ? a.title.localeCompare(b.title) : projectActivity(b).localeCompare(projectActivity(a)))
  }, [items, query, companyFilter, sort, companyOf])

  const counts = useMemo(() => {
    const completed = filtered.filter(isCompleted).length
    return { active: filtered.length - completed, completed, all: filtered.length }
  }, [filtered])
  const visible = filtered.filter(project => view === "all" || (view === "completed") === isCompleted(project))

  const companyOptions = useMemo(() => {
    const used = new Set(items.map(project => project.data.company_id).filter((id): id is string => typeof id === "string"))
    const named = [...used].map(id => ({ value: id, label: companyNames.get(id) ?? "" })).filter(option => option.label).sort((a, b) => a.label.localeCompare(b.label))
    return [{ value: "", label: t("filter.allCompanies") }, ...named, { value: NO_COMPANY, label: t("filter.noCompany") }]
  }, [items, companyNames, t])

  const menu: MenuItem[] = [
    { label: t("actions.join"), icon: "add", onSelect: () => setShared("join") },
    { label: t("actions.restore"), icon: "refresh", onSelect: () => setShared("restore") },
    ...(suggestions.data?.total ? [{ label: t("actions.fromSuggestion"), icon: "sparkles" as const, onSelect: () => setSuggesting(true) }] : []),
  ]
  const clear = () => update({ q: "", company: "" })

  return (
    <div className="page">
      <div className="ph">
        <div className="ph-text"><h1 className="h1">{t("title")}</h1></div>
        <div className="ph-actions">
          <SplitButton icon="add" onClick={() => setCreating(true)} items={menu} menuLabel={t("actions.moreCreate")}>{t("actions.create")}</SplitButton>
        </div>
      </div>

      {projects.data && projects.data.total > items.length && (
        <Banner tone="neutral">{t("states.truncated", { count: items.length })}</Banner>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }}>
        <Seg<View>
          label={t("filter.label")}
          value={view}
          onChange={value => update({ view: value === "active" ? "" : value })}
          options={[
            { value: "active", label: t("filter.active"), count: projects.data ? counts.active : undefined },
            { value: "completed", label: t("filter.completed"), count: projects.data ? counts.completed : undefined },
            { value: "all", label: t("filter.all"), count: projects.data ? counts.all : undefined },
          ]}
        />
        <SearchInput label={t("filter.search")} value={query} onChange={event => update({ q: event.target.value })} />
        <Select label={t("filter.company")} value={companyFilter} options={companyOptions} onChange={value => update({ company: value })} />
        <div style={{ marginLeft: "auto" }}>
          <Select<Sort> label={t("filter.sort")} value={sort} onChange={value => update({ sort: value === "recent" ? "" : value })}
            options={[{ value: "recent", label: t("filter.recent") }, { value: "name", label: t("filter.name") }]} />
        </div>
      </div>

      {projects.isPending ? <SkeletonRows label={t("states.loading")} />
        : projects.error ? <List><ErrorState error={projects.error} title={t("states.errorTitle")} onRetry={() => void projects.refetch()} /></List>
        : items.length === 0 ? <List><Empty icon="projects" title={t("states.emptyTitle")} detail={t("states.emptyDetail")} action={<Button small icon="add" onClick={() => setCreating(true)}>{t("states.emptyAction")}</Button>} /></List>
        : visible.length === 0 ? <List><EmptyFiltered text={query.trim() ? t("states.filteredQuery", { query: query.trim() }) : t("states.filtered")} onClear={() => { clear(); update({ view: "all" }) }} /></List>
        : (
          <List>
            <RowHead>
              <span style={{ flex: 1 }}>{t("columns.project")}</span>
              <span className="col" style={col(150)}>{t("columns.stage")}</span>
              {!narrow && <span className="col" style={col(200)}>{t("columns.content")}</span>}
              {!medium && <span className="col" style={col(84)}>{t("columns.people")}</span>}
              <span className="col" style={col(96, true)}>{t("columns.activity")}</span>
            </RowHead>
            {visible.map(project => <ProjectRow key={project.id} project={project} company={companyOf(project)} showContent={!narrow} showPeople={!medium} />)}
          </List>
        )}

      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
      <SharedProjectDialog mode={shared} onClose={() => setShared(null)} />
      <SuggestionDialog open={suggesting} onClose={() => setSuggesting(false)} suggestions={suggestions.data?.items ?? []} />
    </div>
  )
}

function ProjectRow({ project, company, showContent, showPeople }: { project: ProjectWithSummary; company?: string; showContent: boolean; showPeople: boolean }) {
  const { t } = useT("projects")
  const summary = project.summary?.project
  return (
    <RowLink
      to={`/projects/${project.id}`}
      lead={<Avatar name={project.title} />}
      title={project.title}
      sub={company ?? t("row.noCompany")}
      meta={<>
        <span className="col" style={col(150)}><StageChip stage={projectStage(project)} /></span>
        {showContent && <span className="col xs t2 num" style={col(200)}><ContentCount summary={summary} /></span>}
        {showPeople && <span className="col" style={col(84)}><People summary={summary} /></span>}
        <span className="col" style={col(96, true)}><ListDate value={projectActivity(project)} /></span>
      </>}
    />
  )
}

/** Tipos con etiqueta plural propia; el resto suma en «N más». */
const CONTENT_KINDS = ["meeting", "document", "note", "collection", "message", "issue", "event", "fact", "person"] as const
type ContentKind = typeof CONTENT_KINDS[number]
const isContentKind = (kind: string): kind is ContentKind => (CONTENT_KINDS as readonly string[]).includes(kind)

/** Los dos tipos con más elementos y el resto agrupado; el desglose completo queda en el tooltip. */
function ContentCount({ summary }: { summary?: NonNullable<ProjectWithSummary["summary"]>["project"] }) {
  const { t, plural } = useT("projects")
  if (!summary) return <span>—</span>
  if (summary.content_total === 0) return <span>{t("row.noContent")}</span>
  const parts = Object.entries(summary.content_by_kind).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1])
  const label = ([kind, count]: [string, number]) => isContentKind(kind) ? plural(`row.kinds.${kind}`, count) : plural("row.content", count)
  const shown = parts.slice(0, 2)
  const rest = parts.slice(2).reduce((total, [, count]) => total + count, 0)
  const text = [...shown.map(label), ...(rest ? [plural("row.more", rest)] : [])].join(" · ")
  return <span className="trunc" title={parts.map(label).join(" · ")}>{text}</span>
}

const AVATAR_STACK = { boxShadow: "0 0 0 2px var(--surface)" } satisfies CSSProperties
const AVATAR_OVERLAP = { ...AVATAR_STACK, marginLeft: "calc(-1 * var(--sp-1) - 2px)" } satisfies CSSProperties

/** Dos avatares y «+N» con el resto, como en el ejemplo de la plantilla; los nombres completos en el tooltip. */
function People({ summary }: { summary?: NonNullable<ProjectWithSummary["summary"]>["project"] }) {
  const { t, plural } = useT("projects")
  const { list } = useFormat()
  if (!summary || summary.people_count === 0) return <span className="xs t3">—</span>
  const shown = summary.people.slice(0, 2)
  const rest = summary.people_count - shown.length
  const names = summary.people.map(person => person.title)
  const hiddenCount = summary.people_count - names.length
  const title = hiddenCount > 0 ? `${list(names)} ${plural("row.morePeople", hiddenCount)}` : list(names)
  return (
    <span style={{ display: "flex" }} title={title} aria-label={plural("row.people", summary.people_count)}>
      {shown.map((person, index) => (
        <span key={person.id} style={index ? AVATAR_OVERLAP : AVATAR_STACK} className={`av av-sm av-round hue${hueFor(person.title)}`} aria-hidden="true">{initials(person.title)}</span>
      ))}
      {rest > 0 && <span style={AVATAR_OVERLAP} className={`av av-sm av-round hue${hueFor(`+${rest}`)}`} aria-hidden="true">{t("row.restPeople", { count: rest })}</span>}
    </span>
  )
}

