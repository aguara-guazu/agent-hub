import { Link } from "react-router-dom"
import { Chip } from "../../components/ui/basics"
import type { MenuItem } from "../../components/ui/Menu"
import { Dl } from "../../components/ui/display"
import { useToast } from "../../components/ui/Toast"
import { useFormat, useT } from "../../i18n/useT"
import { memoryCall } from "../../lib/memory"
import { useMemoryAction, type EntityDetail, type MemoryEntity } from "../../lib/memory-view"

const CATEGORIES = ["preference", "decision", "lesson", "procedure", "context"] as const
const CONFIDENCE = ["observed", "confirmed", "inferred"] as const

export function rememberState(entity: MemoryEntity): "archived" | "pinned" | "active" {
  return entity.data.memory_state === "archived" ? "archived" : entity.data.memory_pinned ? "pinned" : "active"
}

export function RememberChip({ entity }: { entity: MemoryEntity }) {
  const { t } = useT("memory"), state = rememberState(entity)
  return <Chip tone={state === "archived" ? "off" : state === "pinned" ? "info" : "ok"}>{t(`remember.state.${state}`)}</Chip>
}

/** Acciones del recuerdo para el «…» de la ficha. Son reversibles: se ejecutan y ofrecen Deshacer. */
export function useRememberActions(entity: MemoryEntity): MenuItem[] {
  const { t } = useT("memory"), toast = useToast()
  const manage = useMemoryAction("manage_memory")
  if (!entity.data.agent_memory) return []
  const state = rememberState(entity)
  const run = (action: string, inverse: string, message: string) => manage.mutate(
    { id: entity.id, action, expected_updated_at: entity.updated_at, reason: t("remember.reason") },
    // Deshacer necesita el `updated_at` posterior al cambio: el servidor rechaza versiones viejas (409).
    { onSuccess: () => toast.show({ message, undo: () => void memoryCall<EntityDetail>("get_entity", { id: entity.id }).then(fresh => manage.mutate({ id: entity.id, action: inverse, expected_updated_at: fresh.entity.updated_at, reason: t("remember.reason") })) }) },
  )
  return state === "archived"
    ? [{ label: t("remember.restore"), onSelect: () => run("restore", "archive", t("remember.restored")), disabled: manage.isPending }]
    : [
      { label: state === "pinned" ? t("remember.unpin") : t("remember.pin"), onSelect: () => state === "pinned" ? run("unpin", "pin", t("remember.unpinned")) : run("pin", "unpin", t("remember.pinned")), disabled: manage.isPending },
      { label: t("remember.archive"), onSelect: () => run("archive", "restore", t("remember.archived")), disabled: manage.isPending },
    ]
}

/** Metadatos de un recuerdo de agente: categoría, confianza, importancia, vigencia y motivo de archivo. */
export function RememberDetails({ entity }: { entity: MemoryEntity }) {
  const { t } = useT("memory"), format = useFormat()
  const category = (CATEGORIES as readonly string[]).includes(entity.data.memory_category) ? entity.data.memory_category as typeof CATEGORIES[number] : "context"
  const confidence = (CONFIDENCE as readonly string[]).includes(entity.data.memory_confidence) ? entity.data.memory_confidence as typeof CONFIDENCE[number] : null
  return (
    <section className="section">
      <div className="section-h"><h2 className="h2">{t("remember.title")}</h2></div>
      <Dl items={[
        { label: t("remember.category"), value: t(`remember.categories.${category}`) },
        { label: t("remember.confidence"), value: confidence ? t(`remember.confidences.${confidence}`) : t("remember.unverified") },
        { label: t("remember.importance"), value: t("remember.importanceValue", { value: entity.data.memory_importance ?? 3 }) },
        ...(entity.data.memory_expires_at ? [{ label: t("remember.expires"), value: format.date(entity.data.memory_expires_at) }] : []),
        ...(entity.data.memory_archive_reason ? [{ label: t("remember.archiveReason"), value: entity.data.memory_archive_reason }] : []),
        ...(entity.data.memory_duplicate_of ? [{ label: t("remember.duplicateOf"), value: <Link to={`/memory/entities/${entity.data.memory_duplicate_of}`}>{t("remember.viewCurrent")}</Link> }] : []),
      ]} />
      <span className="hint">{t("remember.hint")}</span>
    </section>
  )
}
