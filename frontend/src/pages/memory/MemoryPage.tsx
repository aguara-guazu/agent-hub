import { useEffect, useMemo, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { Button, IconButton } from "../../components/ui/basics"
import { MoreMenu } from "../../components/ui/actions"
import { Banner, Empty, EmptyFiltered, ErrorState, List, RowHead, RowLink, SkeletonRows } from "../../components/ui/display"
import { Input, Select } from "../../components/ui/fields"
import { Icon } from "../../components/Icon"
import type { Option } from "../../components/ui/fields"
import { useT } from "../../i18n/useT"
import { ENTITY_KINDS, entityHref, excerpt, isEntityKind, useMemoryPages, useMemoryQuery, type Fragment, type MemoryEntity, type Page, type SearchPage } from "../../lib/memory-view"
import { NewCollectionPanel } from "./NewCollectionPanel"
import { NewNoteDialog } from "./NewNoteDialog"
import { useEntityOptions } from "./pickers"
import { EvidenceCard, KindColumn, TALL_ROW } from "./Evidence"
import { Highlight, LoadMore, MemoryGate, useListDate } from "./shared"

const DATE_RANGES = ["7d", "30d", "90d", "year"] as const
type DateRange = typeof DATE_RANGES[number]

/** Inicio del rango a medianoche local: estable entre renders, porque forma parte de la clave de la consulta. */
function rangeStart(range: DateRange): string {
  const now = new Date()
  if (range === "year") return new Date(now.getFullYear(), 0, 1).toISOString()
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).toISOString()
}

/** Filtros en la URL para que Atrás y los enlaces (⌘K, `?person=`) restauren el contexto. */
function useFilters() {
  const [params, setParams] = useSearchParams()
  const get = (key: string) => params.get(key) ?? ""
  const kind = get("kind"), date = get("date")
  const set = (values: Record<string, string>) => setParams(current => {
    const next = new URLSearchParams(current)
    for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key) }
    return next
  }, { replace: true })
  return {
    q: get("q"),
    kind: isEntityKind(kind) ? kind : "",
    project: get("project"),
    person: get("person"),
    date: ((DATE_RANGES as readonly string[]).includes(date) ? date : "") as DateRange | "",
    creating: get("new"),
    set,
  }
}

/** Filtro de la barra: selector propio; activo, con borde de acento y X para quitarlo. */
function FilterSelect<T extends string>({ label, value, options, anyLabel, onChange }: { label: string; value: T | ""; options: readonly Option<T>[]; anyLabel: string; onChange: (value: T | "") => void }) {
  const { t: common } = useT("common")
  const current = options.find(option => option.value === value)
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2, maxWidth: 280, minWidth: 0, ...(value ? { borderRadius: "var(--r-sm)", boxShadow: "0 0 0 1px var(--accent-border)" } : {}) }}>
      <Select label={label} value={value} options={options} placeholder={anyLabel} onChange={onChange} />
      {value && <IconButton icon="close" small variant="ghost" label={common("a11y.removeFilter", { name: `${label}: ${current?.label ?? ""}` })} onClick={() => onChange("")} />}
    </span>
  )
}

export default function MemoryPage() {
  const { t, plural } = useT("memory")
  const filters = useFilters(), navigate = useNavigate()
  const [text, setText] = useState(filters.q)
  // La URL es la fuente de verdad; el campo local evita escribir el historial en cada tecla.
  useEffect(() => { setText(filters.q) }, [filters.q])
  useEffect(() => {
    if (text.trim() === filters.q) return
    const timer = setTimeout(() => filters.set({ q: text.trim() }), 300)
    return () => clearTimeout(timer)
  }, [text]) // Solo el texto local dispara la escritura; `filters` cambia en cada render.

  const closeCreate = () => filters.set({ new: "" })
  const hasFilters = Boolean(filters.kind || filters.project || filters.person || filters.date)
  const clearFilters = () => { setText(""); filters.set({ q: "", kind: "", project: "", person: "", date: "" }) }

  return (
    <div className="split">
      <div className="page">
        <div className="ph">
          <div className="ph-text"><h1 className="h1">{t("title")}</h1></div>
          <div className="ph-actions">
            <Button variant="primary" icon="add" onClick={() => filters.set({ new: "note" })}>{t("newNote.action")}</Button>
            <MoreMenu items={[{ label: t("collection.newAction"), icon: "add", onSelect: () => filters.set({ new: "collection" }) }]} />
          </div>
        </div>
        <MemoryGate>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
            {/* `.search` tiene flex-basis 240px: dentro de una columna sería su alto; va en una fila. */}
            <div style={{ display: "flex" }}><div className="search" style={{ maxWidth: "none" }}>
              <Icon name="find" />
              <Input type="search" aria-label={t("search.label")} placeholder={t("search.placeholder")} value={text} onChange={event => setText(event.target.value)} style={{ height: 44, fontSize: "var(--fs-md)", paddingLeft: 34 }} />
            </div></div>
            <FilterBar filters={filters} />
          </div>
          <Results filters={filters} hasFilters={hasFilters} onClear={clearFilters} onConnect={() => navigate("/settings?section=fuentes")} plural={plural} />
        </MemoryGate>
      </div>
      {filters.creating === "collection" && <NewCollectionPanel onClose={closeCreate} />}
      {filters.creating === "note" && <NewNoteDialog onClose={closeCreate} projectId={filters.project} />}
    </div>
  )
}

type Filters = ReturnType<typeof useFilters>

function FilterBar({ filters }: { filters: Filters }) {
  const { t } = useT("memory")
  const projects = useEntityOptions("project"), people = useEntityOptions("person")
  const kindOptions = ENTITY_KINDS.map(kind => ({ value: kind, label: t(`kindPlural.${kind}`) }))
  const dateOptions = DATE_RANGES.map(range => ({ value: range, label: t(`date.${range}`) }))
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center", minWidth: 0 }}>
      <FilterSelect label={t("filter.kind")} anyLabel={t("filter.all")} value={filters.kind} options={kindOptions} onChange={kind => filters.set({ kind })} />
      <FilterSelect label={t("filter.project")} anyLabel={t("filter.any")} value={filters.project} options={projects.options} onChange={project => filters.set({ project })} />
      <FilterSelect label={t("filter.person")} anyLabel={t("filter.any")} value={filters.person} options={people.options} onChange={person => filters.set({ person })} />
      <FilterSelect label={t("filter.date")} anyLabel={t("filter.any")} value={filters.date} options={dateOptions} onChange={date => filters.set({ date })} />
    </div>
  )
}

function Results({ filters, hasFilters, onClear, onConnect, plural }: {
  filters: Filters; hasFilters: boolean; onClear: () => void; onConnect: () => void; plural: ReturnType<typeof useT<"memory">>["plural"]
}) {
  const { t } = useT("memory"), navigate = useNavigate()
  // Persona y fecha solo existen en los fragmentos: con texto o con esos filtros se busca en el contenido.
  const inContent = Boolean(filters.q || filters.person || filters.date)
  const base = { ...(filters.kind ? { kind: filters.kind } : {}), ...(filters.project ? { project_id: filters.project } : {}) }
  const fragments = useMemoryPages<Fragment>("search", { ...base, query: filters.q, ...(filters.person ? { person_id: filters.person } : {}), ...(filters.date ? { from: rangeStart(filters.date) } : {}) }, 30, inContent)
  const entities = useMemoryPages<MemoryEntity>("list_entities", base, 50, !inContent)
  const byName = useMemoryQuery<Page<MemoryEntity>>("list_entities", { ...base, query: filters.q, limit: 5 }, Boolean(filters.q) && !filters.person && !filters.date)
  const source = inContent ? fragments : entities
  const items = useMemo<(Fragment | MemoryEntity)[]>(() => inContent ? fragments.data?.pages.flatMap(page => page.items) ?? [] : entities.data?.pages.flatMap(page => page.items) ?? [], [inContent, fragments.data, entities.data])
  const total = source.data?.pages[0]?.total ?? 0
  const semantic = inContent && filters.q ? (fragments.data?.pages[0] as SearchPage | undefined)?.semantic_status : undefined
  const names = byName.data?.items ?? []

  if (source.isPending) return <SkeletonRows count={4} avatar={false} label={t("search.loading")} />
  if (source.error) return <ErrorState error={source.error} onRetry={() => void source.refetch()} />
  if (!items.length && !names.length) {
    if (filters.q || hasFilters) return <List><EmptyFiltered text={filters.q ? t("empty.query", { query: filters.q }) : t("empty.filters")} onClear={onClear} /></List>
    return <List><Empty icon="memory" title={t("empty.title")} detail={t("empty.detail")} action={<Button small onClick={onConnect}>{t("empty.connect")}</Button>} /></List>
  }
  return <>
    {semantic === "unavailable" && <Banner tone="neutral" action={<Button small onClick={() => navigate("/activity?tab=procesamiento")}>{t("search.viewProcessing")}</Button>}>{t("search.semanticUnavailable")}</Banner>}
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "calc(-1 * var(--sp-2))" }}>
      <span className="xs t3" role="status">{plural("search.results", total)}</span>
    </div>
    {names.length > 0 && <List>
      <RowHead>{t("search.byName")}</RowHead>
      {names.map(entity => <EntityRow key={entity.id} entity={entity} query={filters.q} />)}
    </List>}
    {items.length > 0 && <List>
      {names.length > 0 && <RowHead>{t("search.inContent")}</RowHead>}
      {inContent
        ? (items as Fragment[]).map(fragment => <EvidenceCard key={fragment.id} fragment={fragment} query={filters.q} showKind />)
        : (items as MemoryEntity[]).map(entity => <EntityRow key={entity.id} entity={entity} query="" />)}
    </List>}
    {source.hasNextPage && <LoadMore loading={source.isFetchingNextPage} onMore={() => void source.fetchNextPage()} />}
  </>
}

function EntityRow({ entity, query }: { entity: MemoryEntity; query: string }) {
  const listDate = useListDate()
  const date = listDate(entity.data.occurred_at ?? entity.updated_at)
  const detail: string = entity.data.description || entity.data.text || entity.data.email || ""
  return (
    <RowLink
      to={entityHref(entity)}
      style={TALL_ROW}
      lead={<KindColumn kind={entity.kind} />}
      title={query ? <Highlight text={entity.title} query={query} /> : entity.title}
      titleText={entity.title}
      sub={detail ? excerpt(detail, query, 160) : undefined}
      meta={date.title ? <span title={date.title}>{date.text}</span> : undefined}
    />
  )
}
