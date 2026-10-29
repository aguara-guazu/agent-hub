import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useToast } from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"
import { LOCAL_KEY } from "../../lib/local"
import { queryKeys } from "../../lib/queries"

export interface RuleChange {
  id: string
  enabled: boolean
  /** Sin cliente, la regla vale para todos y limpia las reglas propias de cada cliente. */
  client?: string
}

/** Misma escritura que `useLocalRule`, con el error traducido. */
export function useSkillRule() {
  const cache = useQueryClient()
  const toast = useToast()
  const { t } = useT("common")
  return useMutation({
    mutationFn: ({ id, enabled, client }: RuleChange) => api.put("/policy/rules", {
      scope: client ? "client" : "user",
      scope_id: client ?? "",
      resource_type: "skill",
      resource_id: id,
      state: enabled ? "on" : "off",
      reset_clients: !client,
    }),
    onSuccess: () => cache.invalidateQueries({ queryKey: LOCAL_KEY }),
    onError: error => toast.error(t("toast.saveFailed"), error.message),
  })
}

export async function invalidateSkills(cache: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    cache.invalidateQueries({ queryKey: queryKeys.skills }),
    cache.invalidateQueries({ queryKey: LOCAL_KEY }),
  ])
}
