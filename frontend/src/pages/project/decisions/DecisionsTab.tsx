import { useInfiniteQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "react-router-dom"
import {
  Button, Chip, Dl, Empty, EmptyFiltered, ErrorState, List, Loading, MoreMenu, Panel, PanelBody, PanelHeader, Row, RowLink, Seg, SkeletonRows,
  type ChipTone,
} from "../../../components/ui"
import { useFormat, useT } from "../../../i18n"
import { entityPath, memoryCall, useMemory, type MemoryEntity, type Page } from "../../../lib/memory"
import type { EntityLink } from "../panels"
import { ListDate, entityDate, useProjectNavigation } from "../shared"
import { SidePanel, useWorkFilter, useWorkPanel } from "../work"

/** Categorías de `kind: "fact"` que extrae el procesamiento (`processing.ts`); `summary` y las propuestas internas no son decisiones. */
const CATEGORIES = ["decision", "commitment", "finding", "risk"] as const
type Category = (typeof CATEGORIES)[number]
type View = "all" | Category
const VIEWS: readonly View[] = ["all", ...CATEGORIES]
const TONE: Record<Category, ChipTone> = { decision: "ok", commitment: "info", finding: "info", risk: "warn" }
const PAGE = 200

const categoryOf = (fact: MemoryEntity): Category | null => (CATEGORIES as readonly string[]).includes(fact.data?.category) ? fact.data.category as Category : null
/** Un hecho descartado en la revisión no se muestra como decisión vigente. */
const visible = (fact: MemoryEntity) => categoryOf(fact) !== null && fact.data?.review_state !== "rejected"
const factText = (fact: MemoryEntity) => typeof fact.data?.text === "string" && fact.data.text.trim() ? fact.data.text.trim() : fact.title

interface FactDetail { entity: MemoryEntity; links: EntityLink[]; evidence: { id: string; text: string; version_id: string; entity_id: string }[] }

/** Decisiones, compromisos, hallazgos y riesgos del proyecto, con su fuente y la evidencia citada. */
export function DecisionsTab({ project }: { project: MemoryEntity }) {
  const { t } = useT("project")
  const common = useT("common").t
  const go = useProjectNavigation()
  const [view, setView] = useWorkFilter<View>("kind", VIEWS, "all")
  const panel = useWorkPanel("decision")
  const facts = useInfiniteQuery({
    queryKey: ["memory", "project-decisions", project.id],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => memoryCall<Page<MemoryEntity>>("list_entities", { project_id: project.id, kind: "fact", limit: PAGE, offset: pageParam }),
    getNextPageParam: last => last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })
  const all = (facts.data?.pages.flatMap(page => page.items) ?? []).filter(visible)
  const items = view === "all" ? all : all.filter(fact => categoryOf(fact) === view)
  const count = (value: View) => value === "all" ? all.length : all.filter(fact => categoryOf(fact) === value).length

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
      <Seg<View> label={t("decisions.segLabel")} value={view} onChange={setView} options={VIEWS.map(value => ({ value, label: t(`decisions.seg.${value}`), count: facts.data ? count(value) : undefined }))} />
      {facts.isPending ? <SkeletonRows avatar={false} label={t("decisions.loading")} />
        : facts.error ? <List><ErrorState error={facts.error} title={t("decisions.errorTitle")} onRetry={() => void facts.refetch()} /></List>
        : items.length === 0
          ? view !== "all" && all.length > 0
            ? <List><EmptyFiltered text={t("decisions.filtered")} onClear={() => setView("all")} /></List>
            : <List><Empty icon="note" title={t("decisions.emptyTitle")} detail={t("decisions.emptyDetail")} action={<Button small icon="add" onClick={() => go({ add: "files" })}>{t("decisions.emptyAction")}</Button>} /></List>
          : <>
              <List>
                {items.map(fact => <DecisionRow key={fact.id} fact={fact} selected={panel.value === fact.id} onOpen={() => panel.open(fact.id)} />)}
              </List>
              {facts.hasNextPage && (
                <Button small variant="ghost" style={{ alignSelf: "flex-start" }} disabled={facts.isFetchingNextPage} onClick={() => void facts.fetchNextPage()}>
                  {common("actions.showMore")}
                </Button>
              )}
            </>}
      {panel.value && <DecisionPanel key={panel.value} factId={panel.value} onClose={panel.close} />}
    </div>
  )
}

function CategoryChip({ fact }: { fact: MemoryEntity }) {
  const { t } = useT("project")
  const category = categoryOf(fact)
  if (!category) return null
  return <Chip tone={TONE[category]}>{t(`decisions.category.${category}`)}</Chip>
}

function DecisionRow({ fact, selected, onOpen }: { fact: MemoryEntity; selected: boolean; onOpen: () => void }) {
  const { t } = useT("project")
  return (
    <Row
      onOpen={onOpen}
      selected={selected}
      lead={<span style={{ width: 104, display: "flex", flex: "none" }}><CategoryChip fact={fact} /></span>}
      title={factText(fact)}
      sub={fact.data?.review_state === "pending" ? t("decisions.pendingReview") : undefined}
      meta={<ListDate value={entityDate(fact)} />}
    />
  )
}

/** Detalle de solo lectura: texto completo, fuente (`derived_from`) y fragmentos citados como evidencia. */
function DecisionPanel({ factId, onClose }: { factId: string; onClose: () => void }) {
  const { t } = useT("project")
  const status = useT("status").t
  const format = useFormat()
  const navigate = useNavigate()
  const detail = useMemory<FactDetail>("get_entity", { id: factId })
  const fact = detail.data?.entity
  const source = detail.data?.links.find(link => link.type === "derived_from" && link.from_id === factId)?.entity
  const review: unknown = fact?.data?.review_state
  const reviewLabel = review === "pending" || review === "accepted" || review === "rejected" ? status(`review.${review}`) : null
  return (
    <SidePanel>
      <Panel label={fact ? factText(fact) : t("decisions.panel.label")} onClose={onClose}>
        <PanelHeader
          title={fact ? factText(fact) : t("decisions.panel.label")}
          status={fact ? <CategoryChip fact={fact} /> : undefined}
          actions={fact ? <MoreMenu small ghost items={[{ label: t("decisions.panel.openMemory"), icon: "memory", onSelect: () => navigate(`/memory/entities/${fact.id}`) }]} /> : undefined}
        />
        <PanelBody>
          {detail.isPending ? <Loading />
            : detail.error || !fact ? <ErrorState error={detail.error} title={t("decisions.panel.errorTitle")} onRetry={() => void detail.refetch()} />
            : <>
                <p className="t2 prose" style={{ whiteSpace: "pre-wrap" }}>{factText(fact)}</p>
                <Dl items={[
                  { label: t("decisions.panel.date"), value: format.date(entityDate(fact)) },
                  { label: t("decisions.panel.source"), value: source ? <Link to={entityPath(source)} className="trunc" title={source.title}>{source.title}</Link> : null },
                  { label: t("decisions.panel.review"), value: reviewLabel },
                  { label: t("decisions.panel.model"), value: typeof fact.data.model === "string" ? <span className="mono">{fact.data.model}</span> : null },
                ]} />
                <section className="section">
                  <h3 className="h3">{t("decisions.panel.evidence")}</h3>
                  {detail.data.evidence.length === 0 ? <span className="t3">{t("decisions.panel.noEvidence")}</span> : (
                    <List>
                      {detail.data.evidence.map(fragment => (
                        <RowLink
                          key={fragment.id}
                          to={`/memory/entities/${fragment.entity_id}?version=${fragment.version_id}&fragment=${fragment.id}`}
                          title={fragment.text}
                          sub={source && fragment.entity_id === source.id ? source.title : undefined}
                        />
                      ))}
                    </List>
                  )}
                </section>
              </>}
        </PanelBody>
      </Panel>
    </SidePanel>
  )
}
