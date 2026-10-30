import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useToast } from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"
import { LOCAL_KEY } from "../../lib/local"
import { queryKeys } from "../../lib/queries"
import type { MatrixRow, RuleState } from "../../lib/types"

/** Una regla de exposición de skill. Sin `client` vale para todos y, salvo `resetClients: false`, borra las de cada cliente. */
export interface RuleWrite { id: string; state: RuleState; client?: string; resetClients?: boolean }

function putRule({ id, state, client, resetClients }: RuleWrite): Promise<void> {
  return api.put<void>("/policy/rules", {
    scope: client ? "client" : "user",
    scope_id: client ?? "",
    resource_type: "skill",
    resource_id: id,
    state,
    reset_clients: resetClients ?? !client,
  })
}

/** Reglas que dejan la skill como está ahora: la de la persona y la propia de cada cliente.
 *  `reset_clients` borra las de cliente, así que deshacer un cambio global tiene que reescribirlas. */
export function snapshotRules(row: MatrixRow | undefined, id: string): RuleWrite[] {
  if (!row) return [{ id, state: "inherit", resetClients: false }]
  const writes: RuleWrite[] = [{ id, state: row.user_rule ?? "inherit", resetClients: false }]
  for (const [client, cell] of Object.entries(row.cells)) {
    if (cell.own_rule) writes.push({ id, client, state: cell.own_rule, resetClients: false })
  }
  return writes
}

/** Regla propia de un cliente antes del cambio; `inherit` si no tenía. */
export function snapshotClientRule(row: MatrixRow | undefined, id: string, client: string): RuleWrite {
  return { id, client, state: row?.cells[client]?.own_rule ?? "inherit" }
}

/** Escribe las reglas en orden: la de la persona primero, porque puede limpiar las de cliente. */
export function useSkillRule() {
  const cache = useQueryClient()
  const toast = useToast()
  const { t } = useT("common")
  return useMutation({
    mutationFn: async (writes: RuleWrite[]) => { for (const write of writes) await putRule(write) },
    onSettled: () => cache.invalidateQueries({ queryKey: LOCAL_KEY }),
    onError: error => toast.error(t("toast.saveFailed"), error.message),
  })
}

export async function invalidateSkills(cache: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    cache.invalidateQueries({ queryKey: queryKeys.skills }),
    cache.invalidateQueries({ queryKey: LOCAL_KEY }),
  ])
}
