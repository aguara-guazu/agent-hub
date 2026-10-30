import { useQuery } from "@tanstack/react-query"
import { Navigate, useLocation, useParams } from "react-router-dom"
import { api } from "../lib/api"
import { memoryCall, type Page } from "../lib/memory"
import { Loading } from "./ui/display"
import { useT } from "../i18n"

/** Redirección que conserva la consulta (`?focus=`, `?plan=`, `?q=`) y agrega la propia. */
export function Redirect({ to, keepSearch = true }: { to: string | ((params: Record<string, string | undefined>) => string); keepSearch?: boolean }) {
  const params = useParams()
  const location = useLocation()
  const target = typeof to === "function" ? to(params) : to
  const [path, own = ""] = target.split("?")
  const search = new URLSearchParams(keepSearch ? location.search : "")
  new URLSearchParams(own).forEach((value, key) => search.set(key, value))
  const query = search.toString()
  return <Navigate to={`${path}${query ? `?${query}` : ""}`} replace />
}

/** Parámetros de la vista global que la pestaña Colaboración del proyecto entiende. */
const KEPT = ["channel", "thread", "plan"] as const

/**
 * Ya no hay vista global de colaboración: `/collaboration` y `/memory/collaboration` (enlaces de notificaciones,
 * `approval_url` de los planes de equipo) llevan a la pestaña del proyecto dueño del canal o del plan.
 * Sin proyecto resoluble (canal sin proyecto, sin parámetros o error), a `/projects`.
 */
export function CollaborationRedirect() {
  const { t } = useT("common")
  const { search } = useLocation()
  const params = new URLSearchParams(search)
  const channel = params.get("channel") ?? ""
  const plan = params.get("plan") ?? ""
  const project = useQuery({
    queryKey: ["collaboration-redirect", channel, plan],
    retry: false,
    staleTime: Infinity,
    queryFn: async (): Promise<string | null> => {
      let channelId = channel
      if (!channelId && plan) {
        const found = await api.get<{ master_channel_id?: string; delegation?: { project_id?: string } }>(`/memory/teams/${encodeURIComponent(plan)}`)
        if (found.delegation?.project_id) return found.delegation.project_id
        channelId = found.master_channel_id ?? ""
      }
      if (!channelId) return null
      const page = await memoryCall<Page<{ id: string; project_id?: string | null }>>("chat_channels", { channel_id: channelId, include_workers: true, limit: 1, offset: 0 })
      return page.items[0]?.project_id ?? null
    },
  })
  if (!channel && !plan) return <Navigate to="/projects" replace />
  if (project.isPending) return <Loading label={t("states.loading")} />
  if (!project.data) return <Navigate to="/projects" replace />
  const next = new URLSearchParams({ tab: "colaboracion" })
  for (const key of KEPT) {
    const value = params.get(key)
    if (value) next.set(key, value)
  }
  return <Navigate to={`/projects/${encodeURIComponent(project.data)}?${next.toString()}`} replace />
}
