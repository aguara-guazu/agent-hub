import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../lib/api"
import { usePendingInbox } from "../lib/home"
import { useOverview } from "../lib/local"
import { memoryCall } from "../lib/memory"
import { useServers } from "../lib/queries"
import type { IconName } from "./Icon"
import { useToast } from "./ui/Toast"
import { useT } from "../i18n/useT"

type DestinationLabel = "home" | "projects" | "memory" | "collaboration" | "automations" | "servers" | "skills" | "clients" | "activity" | "settings"
type DestinationKeywords = "cmdk.keywordsHome" | "cmdk.keywordsSettings" | "cmdk.keywordsActivity"

export interface Destination {
  to: string
  /** Clave del namespace `nav`. */
  labelKey: DestinationLabel
  icon: IconName
  group: "top" | "work" | "connections" | "bottom"
  /** Prefijos de ruta que mantienen el ítem activo. */
  sections: readonly string[]
  keywordsKey?: DestinationKeywords
}

/** Arquitectura fija de la barra lateral: ningún agente agrega destinos. */
export const DESTINATIONS: readonly Destination[] = [
  { to: "/home", labelKey: "home", icon: "home", group: "top", sections: ["/home"], keywordsKey: "cmdk.keywordsHome" },
  { to: "/projects", labelKey: "projects", icon: "projects", group: "work", sections: ["/projects"] },
  { to: "/memory", labelKey: "memory", icon: "memory", group: "work", sections: ["/memory"] },
  { to: "/collaboration", labelKey: "collaboration", icon: "collaboration", group: "work", sections: ["/collaboration"] },
  { to: "/automations", labelKey: "automations", icon: "automations", group: "work", sections: ["/automations"] },
  { to: "/servers", labelKey: "servers", icon: "servers", group: "connections", sections: ["/servers"] },
  { to: "/skills", labelKey: "skills", icon: "book", group: "connections", sections: ["/skills"] },
  { to: "/clients", labelKey: "clients", icon: "clients", group: "connections", sections: ["/clients"] },
  { to: "/activity", labelKey: "activity", icon: "activity", group: "connections", sections: ["/activity"], keywordsKey: "cmdk.keywordsActivity" },
  { to: "/settings", labelKey: "settings", icon: "settings", group: "bottom", sections: ["/settings"], keywordsKey: "cmdk.keywordsSettings" },
]

export function isActiveDestination(destination: Destination, pathname: string): boolean {
  return destination.sections.some(section => pathname === section || pathname.startsWith(`${section}/`))
}

export type SyncTone = "ok" | "warn" | "danger"

/** Estado del equipo para la línea al pie de la barra lateral, los contadores de atención y «Sincronizar ahora». */
export function useShellStatus() {
  const overview = useOverview()
  const servers = useServers()
  const pending = usePendingInbox()
  const core = useQuery({ queryKey: ["desktop-status"], queryFn: () => window.agentHub?.getCoreStatus() ?? Promise.resolve(null), refetchInterval: 2000 })
  const cache = useQueryClient()
  const toast = useToast()
  const { t, plural } = useT("nav")
  // Clientes y fuentes de memoria se sincronizan por separado: si una parte falla, la otra sigue.
  const sync = useMutation({
    mutationFn: async () => {
      const [clientSync, memory] = await Promise.allSettled([
        window.agentHub ? window.agentHub.syncNow() : Promise.resolve(),
        api.get<{ ready: boolean }>("/memory/status").then(status => (status.ready ? memoryCall<{ queued: number }>("sync_sources") : null)),
      ])
      await cache.invalidateQueries()
      if (clientSync.status === "rejected") throw clientSync.reason
      if (memory.status === "rejected") throw memory.reason
      return memory.value
    },
    onSuccess: memory => toast.success(t("syncDone"), memory?.queued ? plural("syncSources", memory.queued) : undefined),
    onError: error => toast.error(t("syncFailed"), error instanceof Error ? error.message : undefined),
  })
  const clients = overview.data?.clients ?? []
  const restartPending = clients.filter(client => client.cli_kind === "claude_desktop" && client.restart_pending)
  const unsynced = clients.filter(client => !client.synchronized).length
  const failing = core.isError || core.data?.state === "failed" || core.data?.daemonState === "failed"
  const lastSync = clients.map(client => client.synced_at).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null
  const serversNeedingAttention = (servers.data ?? []).filter(server => server.oauth_status === "required").length
  const tone: SyncTone = failing ? "danger" : unsynced > 0 || clients.length === 0 ? "warn" : "ok"
  return {
    hostname: overview.data?.hostname ?? null,
    clients,
    restartPending,
    unsynced,
    failing,
    lastSync,
    tone,
    sync,
    /** Mismas filas que Inicio › Pendientes. */
    pendingCount: pending.count,
    serversNeedingAttention,
  }
}
