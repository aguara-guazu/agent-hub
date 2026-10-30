import { useCallback, useState } from "react"
import type { ReactNode } from "react"
import { useSearchParams } from "react-router-dom"
import { useMutation } from "@tanstack/react-query"
import { Chip, MoreMenu, Tabs, useToast } from "../../components/ui"
import { useT } from "../../i18n"
import { ApiError, api } from "../../lib/api"
import { useAuth } from "../../lib/auth"
import { useMemoryQuery } from "../../lib/memory-view"
import { ACTIVE_STATES, type ProcessingStatus } from "../../lib/activity"
import CallsTab from "./CallsTab"
import ProcessingTab from "./ProcessingTab"

type Tab = "llamadas" | "procesamiento"

/** Actividad · plantilla A con panel. Cada pestaña arma su propio `.split` para poner el panel al lado de la lista;
 *  el encabezado y las pestañas llegan armados desde acá. */
export default function ActivityPage() {
  const { t } = useT("activity")
  const ts = useT("status").t
  const toast = useToast()
  const { isAdmin } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get("tab") === "procesamiento" ? "procesamiento" : "llamadas"
  const [verifyForbidden, setVerifyForbidden] = useState(false)

  const status = useMemoryQuery<ProcessingStatus>("processing_status")
  const running = ACTIVE_STATES.reduce((sum, state) => sum + (status.data?.states?.[state] ?? 0), 0)

  const setTab = useCallback((next: Tab) => {
    // Los filtros de una pestaña no aplican a la otra: cambiar de pestaña limpia la consulta.
    setParams(next === "procesamiento" ? { tab: next } : {}, { replace: true })
  }, [setParams])

  const verify = useMutation({
    mutationFn: () => api.get<{ ok: boolean; broken_at: string | null }>("/audit/verify"),
    onSuccess: result => {
      if (result.ok) toast.success(t("header.verifyIntact"))
      else toast.error(t("header.verifyBroken", { id: result.broken_at ? result.broken_at.slice(0, 8) : "—" }))
    },
    onError: error => {
      if (error instanceof ApiError && error.status === 403) { setVerifyForbidden(true); return }
      toast.error(t("header.verifyFailed"), error instanceof Error ? error.message : undefined)
    },
  })

  const header: ReactNode = <>
    <div className="ph">
      <div className="ph-text"><h1 className="h1">{t("title")}</h1></div>
      <div className="ph-actions">
        <Chip tone="ok">{ts("chip.live")}</Chip>
        {isAdmin && !verifyForbidden && (
          <MoreMenu items={[{ label: t("header.verify"), disabled: verify.isPending, onSelect: () => verify.mutate() }]} />
        )}
      </div>
    </div>
    <Tabs<Tab>
      label={t("tabs.label")}
      idPrefix="activity"
      value={tab}
      onChange={setTab}
      tabs={[
        { value: "llamadas", label: t("tabs.calls") },
        { value: "procesamiento", label: t("tabs.processing"), count: running > 0 ? running : undefined },
      ]}
    />
  </>

  return tab === "procesamiento"
    ? <ProcessingTab header={header} counts={status.data?.states} />
    : <CallsTab header={header} />
}
