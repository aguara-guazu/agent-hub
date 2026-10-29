import { Chip, Empty, ErrorState, List, RowLink, SkeletonRows } from "../../../components/ui"
import { useT } from "../../../i18n"
import { useMemory, type Page } from "../../../lib/memory"
import type { Entity } from "../../../lib/types"
import { ListDate, entityDate, useKindLabel } from "../shared"

/**
 * Pestaña Decisiones de la ficha de proyecto (`?tab=decisiones`).
 * Contrato estable con ProjectPage: export default, props `{ project: Entity }`, sin más props ni contexto.
 * ProjectPage la carga con React.lazy dentro de un Suspense y le pasa la entidad ya cargada con `get_entity`.
 * Provisoria: lista los hechos (`kind: "fact"`) del proyecto, como la pestaña previa, hasta que la tanda 2 sobrescriba este archivo.
 */
export default function Decisiones({ project }: { project: Entity }) {
  const { t } = useT("project")
  const kindLabel = useKindLabel()
  const facts = useMemory<Page<Entity>>("list_entities", { project_id: project.id, kind: "fact", limit: 100, offset: 0 })
  if (facts.isPending) return <SkeletonRows avatar={false} label={t("content.placeholder.decisionsLoading")} />
  if (facts.error) return <List><ErrorState error={facts.error} onRetry={() => void facts.refetch()} /></List>
  if (!facts.data.items.length) return <List><Empty icon="note" title={t("content.placeholder.decisionsTitle")} detail={t("content.placeholder.decisionsDetail")} /></List>
  return (
    <List>
      {facts.data.items.map(fact => (
        <RowLink
          key={fact.id}
          to={`/memory/entities/${fact.id}`}
          lead={<Chip tone={fact.data.category === "decision" ? "ok" : "info"}>{kindLabel(fact)}</Chip>}
          title={fact.title}
          sub={typeof fact.data.text === "string" ? fact.data.text : undefined}
          meta={<ListDate value={entityDate(fact)} />}
        />
      ))}
    </List>
  )
}
