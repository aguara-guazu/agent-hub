import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ErrorState, List, Select, SkeletonRows, Switch, useToast } from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"
import { useMemoryBanner } from "../../pages/settings/MemoryBanner"
import { SettingRow, SettingsSection, useErrorDetail } from "../../pages/settings/SettingRow"

type Backend = "hub" | "native"
const BACKENDS: readonly Backend[] = ["hub", "native"]
const TEAM_KEY = ["memory", "team-preference"] as const

/**
 * Colaboración y red: colaboración entre agentes de esta computadora, cómo se forman los equipos y la red P2P de
 * proyectos compartidos. Guardado automático: interruptores y selectores al cambiar; campos de texto al salir.
 * Unirse con una invitación y restaurar un proyecto compartido viven en Proyectos («Nuevo proyecto ▾»).
 */
export default function Colaboracion() {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const cache = useQueryClient()
  const collaboration = useQuery({ queryKey: ["collaboration"], queryFn: () => api.get<{ enabled: boolean }>("/collaboration") })
  const saveCollaboration = useMutation({
    mutationFn: (enabled: boolean) => api.put<{ enabled: boolean }>("/collaboration", { enabled }),
    // El interruptor cambia qué herramientas y vistas de colaboración responden: se refresca todo.
    onSuccess: async () => { await cache.invalidateQueries() },
    onError: error => toast.error(t("collaboration.agents.saveFailed"), detail(error)),
  })
  const team = useQuery({ queryKey: TEAM_KEY, queryFn: () => api.get<{ preferred_backend: Backend }>("/memory/teams/preferences") })
  const saveTeam = useMutation({
    mutationFn: (preferred_backend: Backend) => api.put("/memory/teams/preferences", { preferred_backend }),
    onSuccess: (_, preferred_backend) => { cache.setQueryData(TEAM_KEY, { preferred_backend }) },
    onError: error => toast.error(t("collaboration.teams.saveFailed"), detail(error)),
  })
  const banner = useMemoryBanner()
  const enabled = saveCollaboration.isPending ? Boolean(saveCollaboration.variables) : collaboration.data?.enabled ?? true
  const backend = saveTeam.isPending ? saveTeam.variables! : team.data?.preferred_backend ?? "hub"
  return <>
    <SettingsSection title={t("collaboration.agents.label")}>
      {banner}
      {collaboration.error ? (
        <ErrorState error={collaboration.error} title={t("collaboration.agents.loadFailed")} onRetry={() => void collaboration.refetch()} />
      ) : collaboration.isPending ? <SkeletonRows count={2} avatar={false} /> : (
        <List>
          <SettingRow label={t("collaboration.agents.label")} hint={t("collaboration.agents.hint")}>
            <Switch label={t("collaboration.agents.label")} checked={enabled} disabled={saveCollaboration.isPending} onChange={value => saveCollaboration.mutate(value)} />
          </SettingRow>
          <SettingRow label={t("collaboration.teams.label")} hint={team.error ? t("collaboration.teams.unavailable") : t("collaboration.teams.hint")}>
            <Select
              bare
              label={t("collaboration.teams.label")}
              value={backend}
              disabled={!team.data || saveTeam.isPending || !enabled}
              onChange={value => saveTeam.mutate(value)}
              options={BACKENDS.map(value => ({ value, label: t(`collaboration.teams.options.${value}`) }))}
            />
          </SettingRow>
        </List>
      )}
    </SettingsSection>

  </>
}
