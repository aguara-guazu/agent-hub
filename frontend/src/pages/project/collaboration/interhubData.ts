import { useQuery } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { MEMORY_REFRESH_MS } from "../../../lib/memory"
import type { InterhubAgentRole, InterhubMessageOrigin, InterhubRoster, InterhubRosterAgent, InterhubRosterHub } from "@agenthub/shared"
import type { Channel } from "./chatTypes"

/**
 * Lectura del canal compartido entre hubs. Todo es solo para ver: la unión, el código y la escalada
 * viajan por la terminal del agente. Los campos son opcionales para tolerar un backend sin canales inter-hub.
 */
// Solo tipos de @agenthub/shared: su índice trae módulos de Node que no deben entrar al bundle del navegador.
const INTERHUB_CHANNEL_KIND = "inter-hub" satisfies typeof import("@agenthub/shared").INTERHUB_CHANNEL_KIND

export function isInterhub(channel: Pick<Channel, "kind"> | undefined): boolean {
  return channel?.kind === INTERHUB_CHANNEL_KIND
}

export type { InterhubAgentRole, InterhubMessageOrigin, InterhubRoster, InterhubRosterAgent, InterhubRosterHub }

export interface InterhubOrphanChannel {
  channel_id: string
  name: string
  created_at: string
  archived_at: string | null
  closed_at: string | null
}

export function useInterhubOrphans() {
  return useQuery({
    queryKey: ["interhub-orphans"],
    queryFn: async ({ signal }) => {
      const items: InterhubOrphanChannel[] = []
      let total = 0
      do {
        const page = await api.get<{ items: InterhubOrphanChannel[]; total: number }>(`/memory/interhub/orphans?limit=100&offset=${items.length}`, signal)
        items.push(...page.items)
        total = page.total
        if (page.items.length === 0) break
      } while (items.length < total)
      return { items }
    },
    refetchInterval: MEMORY_REFRESH_MS,
    refetchIntervalInBackground: false,
  })
}

/** Hubs y agentes del canal, con el hub propio primero y el líder de cada hub al comienzo de su lista. */
export function useInterhubRoster(channelId: string, enabled = true) {
  return useQuery({
    queryKey: ["interhub-roster", channelId],
    queryFn: ({ signal }) => api.get<InterhubRoster>(`/memory/interhub/channels/${encodeURIComponent(channelId)}/roster`, signal),
    enabled,
    refetchInterval: MEMORY_REFRESH_MS,
    refetchIntervalInBackground: false,
  })
}
