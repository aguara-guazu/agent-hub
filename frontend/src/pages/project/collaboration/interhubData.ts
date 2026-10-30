import { useQuery } from "@tanstack/react-query"
import { ApiError, api } from "../../../lib/api"
import { MEMORY_REFRESH_MS } from "../../../lib/memory"
import { INTERHUB_CHANNEL_KIND } from "@agenthub/shared"
import type { InterhubAgentRole, InterhubChannelCode, InterhubMessageOrigin, InterhubRoster, InterhubRosterAgent, InterhubRosterHub } from "@agenthub/shared"
import type { Channel } from "./chatTypes"

/**
 * Lectura del canal compartido entre hubs. Todo es solo para ver: la unión, el código y la escalada
 * viajan por la terminal del agente. Los campos son opcionales para tolerar un backend sin canales inter-hub.
 */
export function isInterhub(channel: Pick<Channel, "kind"> | undefined): boolean {
  return channel?.kind === INTERHUB_CHANNEL_KIND
}

export type { InterhubAgentRole, InterhubMessageOrigin, InterhubRoster, InterhubRosterAgent, InterhubRosterHub }

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

/**
 * Código de unión del canal. Es un secreto: solo el hub creador lo recibe, no se guarda en caché más allá
 * de la vista montada y no se vuelve a pedir en segundo plano. 403/404 significa «no corresponde mostrarlo».
 */
export function useInterhubCode(channelId: string) {
  return useQuery({
    queryKey: ["interhub-code", channelId],
    queryFn: async () => {
      try {
        const body = await api.get<Partial<InterhubChannelCode>>(`/memory/interhub/channels/${encodeURIComponent(channelId)}/code`)
        return typeof body.code === "string" && body.code ? body.code : null
      } catch (failure) {
        if (failure instanceof ApiError && (failure.status === 403 || failure.status === 404)) return null
        throw failure
      }
    },
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  })
}
