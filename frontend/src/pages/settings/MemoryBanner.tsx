import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { Banner, Button } from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"
import { useMemoryStatus } from "../../lib/memory"
import { workerActive } from "./memory"

/**
 * El único aviso de página de una sección que depende de la memoria. Prioridad: memoria caída o migrando,
 * después `own` (el aviso propio de la sección) y por último el trabajador detenido. Devuelve `null` si no hay nada.
 */
export function useMemoryBanner(own: ReactNode = null): ReactNode {
  const { t } = useT("settings")
  const status = useMemoryStatus()
  const cache = useQueryClient()
  const retryMigration = useMutation({ mutationFn: () => api.post("/memory/migration/retry"), onSuccess: () => cache.invalidateQueries({ queryKey: ["memory-status"] }) })
  const data = status.data
  if (status.error) return <Banner tone="danger" action={<Button small onClick={() => void status.refetch()}>{t("page.memory.retry")}</Button>}>{t("page.memory.unreachable")}</Banner>
  if (!data) return own
  if (data.state === "unavailable") return <Banner tone="danger" action={<Button small onClick={() => void status.refetch()}>{t("page.memory.retry")}</Button>}>{t("page.memory.unavailable")}</Banner>
  if (data.state === "migrating") {
    const total = data.migration?.total ?? 0
    const percent = total ? Math.floor((data.migration?.copied ?? 0) * 100 / total) : null
    return <Banner tone="neutral">{percent === null ? t("page.memory.migrating") : t("page.memory.migratingPercent", { percent })}</Banner>
  }
  if (data.state === "migration_pending") return <Banner tone="warn" action={<Button small disabled={retryMigration.isPending} onClick={() => retryMigration.mutate()}>{t("page.memory.retryMigration")}</Button>}>{t("page.memory.migrationPending")}</Banner>
  if (own) return own
  if (data.ready && !workerActive(data)) return <Banner tone="warn">{t("page.memory.workerIdle")}</Banner>
  return null
}
