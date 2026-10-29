import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { useSearchParams } from "react-router-dom"
import {
  Avatar, Banner, Button, Empty, EmptyFiltered, ErrorState, List, RowHead, RowLink, SearchInput, Seg, Select, SkeletonRows, SplitButton,
  hasBlockingLayer, type MenuItem,
} from "../../components/ui"
import { useT } from "../../i18n"
import type { MemoryEntity } from "../../lib/memory"
import { projectActivity, projectStage, useAllProjects, useCompanies, useProjectContentCount } from "../../lib/projects"
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
  const companyOf = useCallback((project: MemoryEntity) => {
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
              {!narrow && <span className="col" style={col(120)}>{t("columns.content")}</span>}
              <span className="col" style={col(96, true)}>{t("columns.activity")}</span>
            </RowHead>
            {visible.map(project => <ProjectRow key={project.id} project={project} company={companyOf(project)} showContent={!narrow} />)}
          </List>
        )}

      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
      <SharedProjectDialog mode={shared} onClose={() => setShared(null)} />
      <SuggestionDialog open={suggesting} onClose={() => setSuggesting(false)} suggestions={suggestions.data?.items ?? []} />
    </div>
  )
}

function ProjectRow({ project, company, showContent }: { project: MemoryEntity; company?: string; showContent: boolean }) {
  const { t, plural } = useT("projects")
  return (
    <RowLink
      to={`/projects/${project.id}`}
      lead={<Avatar name={project.title} />}
      title={project.title}
      sub={company ?? t("row.noCompany")}
      meta={<>
        <span className="col" style={col(150)}><StageChip stage={projectStage(project)} /></span>
        {showContent && <span className="col xs t2 num" style={col(120)}><ContentCount projectId={project.id} plural={plural} empty={t("row.noContent")} /></span>}
        <span className="col" style={col(96, true)}><ListDate value={projectActivity(project)} /></span>
      </>}
    />
  )
}

/** El conteo se pide recién cuando la fila entra en pantalla (y queda en caché), con el tope de concurrencia de `useProjectContentCount`. */
function ContentCount({ projectId, plural, empty }: { projectId: string; plural: ReturnType<typeof useT<"projects">>["plural"]; empty: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || seen) return
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setSeen(true) }, { rootMargin: "200px" })
    observer.observe(element)
    return () => observer.disconnect()
  }, [seen])
  const count = useProjectContentCount(projectId, undefined, seen)
  return <span ref={ref}>{count.data === undefined ? "—" : count.data ? plural("row.content", count.data) : empty}</span>
}
