import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../lib/api"
import { useRuns } from "../lib/automations"
import { useOverview } from "../lib/local"
import { memoryCall } from "../lib/memory"
import { useServers } from "../lib/queries"
import type { IconName } from "./Icon"
import { useToast } from "./ui/Toast"
import { uiText, type UiStringKey } from "./ui/strings"

export interface Destination {
  to: string
  labelKey: UiStringKey
  icon: IconName
  group: "top" | "work" | "connections" | "bottom"
  /** Prefijos de ruta que mantienen el ítem activo. */
  sections: readonly string[]
  keywordsKey?: UiStringKey
}

/** Arquitectura fija de la barra lateral: ningún agente agrega destinos. */
export const DESTINATIONS: readonly Destination[] = [
  { to: "/home", labelKey: "nav.home", icon: "home", group: "top", sections: ["/home"], keywordsKey: "cmdk.keywords.home" },
  { to: "/projects", labelKey: "nav.projects", icon: "projects", group: "work", sections: ["/projects"] },
  { to: "/memory", labelKey: "nav.memory", icon: "memory", group: "work", sections: ["/memory"] },
  { to: "/collaboration", labelKey: "nav.collaboration", icon: "collaboration", group: "work", sections: ["/collaboration"] },
  { to: "/automations", labelKey: "nav.automations", icon: "automations", group: "work", sections: ["/automations"] },
  { to: "/servers", labelKey: "nav.servers", icon: "servers", group: "connections", sections: ["/servers"] },
  { to: "/skills", labelKey: "nav.skills", icon: "book", group: "connections", sections: ["/skills"] },
  { to: "/clients", labelKey: "nav.clients", icon: "clients", group: "connections", sections: ["/clients"] },
  { to: "/activity", labelKey: "nav.activity", icon: "activity", group: "connections", sections: ["/activity"], keywordsKey: "cmdk.keywords.activity" },
  { to: "/settings", labelKey: "nav.settings", icon: "settings", group: "bottom", sections: ["/settings"], keywordsKey: "cmdk.keywords.settings" },
]

export function isActiveDestination(destination: Destination, pathname: string): boolean {
  return destination.sections.some(section => pathname === section || pathname.startsWith(`${section}/`))
}

export type SyncTone = "ok" | "warn" | "danger"

/** Estado del equipo para la línea al pie de la barra lateral, los contadores de atención y «Sincronizar ahora». */
export function useShellStatus() {
  const overview = useOverview()
  const servers = useServers()
  const unreadDeliveries = useRuns({ unread: "true", limit: "1" }).data?.total ?? 0
  const core = useQuery({ queryKey: ["desktop-status"], queryFn: () => window.agentHub?.getCoreStatus() ?? Promise.resolve(null), refetchInterval: 2000 })
  const cache = useQueryClient()
  const toast = useToast()
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
    onSuccess: memory => toast.success(uiText("status.syncDone"), memory?.queued ? uiText("status.syncSources", { count: memory.queued }) : undefined),
    onError: error => toast.error(uiText("status.syncFailed"), error instanceof Error ? error.message : undefined),
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
    pendingCount: restartPending.length + unreadDeliveries,
    serversNeedingAttention,
  }
}
