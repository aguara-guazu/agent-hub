import { useEffect, useState } from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { useSearchParams } from "react-router-dom"
import { Button, Empty, EmptyFiltered, ErrorState, List, RowLink, SearchInput, Seg, SkeletonRows, Tag } from "../../../components/ui"
import { useT } from "../../../i18n"
import { entityPath, memoryCall, type Page } from "../../../lib/memory"
import { useProjectContentCount } from "../../../lib/projects"
import type { Entity } from "../../../lib/types"
import { ListDate, entityDate, entityDetail, useKindLabel, useProjectNavigation } from "../shared"

type Kind = "all" | "meeting" | "document" | "note" | "collection"
const KINDS: readonly Kind[] = ["all", "meeting", "document", "note", "collection"]
const PAGE = 50

/** El texto del filtro llega al servidor (coincidencia por título) con una pausa para no consultar en cada tecla. */
function useDebounced(value: string, ms = 250) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

/**
 * Pestaña Contenido (`?tab=contenido`): todo lo vinculado al proyecto, segmentado por tipo (`?kind=`) y filtrado por título.
 * Contrato: export default, props `{ project: Entity }`.
 */
export default function Contenido({ project }: { project: Entity }) {
  const { t } = useT("project")
  const common = useT("common").t
  const kindLabel = useKindLabel()
  const go = useProjectNavigation()
  const [params, setParams] = useSearchParams()
  const kind = KINDS.find(value => value === params.get("kind")) ?? "all"
  const [text, setText] = useState("")
  const query = useDebounced(text.trim())
  const content = useInfiniteQuery({
    queryKey: ["memory", "project-content", project.id, kind, query],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => memoryCall<Page<Entity>>("list_entities", { project_id: project.id, ...(kind === "all" ? {} : { kind }), query, limit: PAGE, offset: pageParam }),
    getNextPageParam: last => last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })
  const counts = {
    all: useProjectContentCount(project.id).data,
    meeting: useProjectContentCount(project.id, "meeting").data,
    document: useProjectContentCount(project.id, "document").data,
    note: useProjectContentCount(project.id, "note").data,
    collection: useProjectContentCount(project.id, "collection").data,
  }
  const labels: Record<Kind, string> = { all: t("content.all"), meeting: t("content.meetings"), document: t("content.documents"), note: t("content.notes"), collection: t("content.collections") }
  const items = content.data?.pages.flatMap(page => page.items) ?? []
  const setKind = (value: Kind) => setParams(current => {
    const next = new URLSearchParams(current)
    if (value === "all") next.delete("kind")
    else next.set("kind", value)
    return next
  }, { replace: true })
  const clear = () => { setText(""); setKind("all") }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }}>
        <Seg<Kind> label={t("content.kindsLabel")} value={kind} onChange={setKind} options={KINDS.map(value => ({ value, label: labels[value], count: counts[value] || undefined }))} />
        <SearchInput label={t("content.filter")} value={text} onChange={event => setText(event.target.value)} />
      </div>
      {content.isPending ? <SkeletonRows avatar={false} label={t("content.loading")} />
        : content.error ? <List><ErrorState error={content.error} title={t("content.errorTitle")} onRetry={() => void content.refetch()} /></List>
        : items.length === 0
          ? (query || kind !== "all")
            ? <List><EmptyFiltered text={query ? t("content.filteredQuery", { query }) : t("content.filteredKind")} onClear={clear} /></List>
            : <List><Empty icon="document" title={t("content.emptyTitle")} detail={t("content.emptyDetail")} action={<Button small icon="add" onClick={() => go({ add: "files" })}>{t("content.emptyAction")}</Button>} /></List>
          : <>
              <List>
                {items.map(item => (
                  <RowLink
                    key={item.id}
                    to={entityPath(item)}
                    lead={<span style={{ width: 96, display: "flex", flex: "none" }}><Tag>{kindLabel(item)}</Tag></span>}
                    title={item.title}
                    sub={entityDetail(item)}
                    meta={<ListDate value={entityDate(item)} />}
                  />
                ))}
              </List>
              {content.hasNextPage && (
                <Button small variant="ghost" style={{ alignSelf: "flex-start" }} disabled={content.isFetchingNextPage} onClick={() => void content.fetchNextPage()}>
                  {common("actions.showMore")}
                </Button>
              )}
            </>}
    </div>
  )
}
