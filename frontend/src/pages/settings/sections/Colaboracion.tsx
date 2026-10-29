import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { List, Switch, useToast } from "../../../components/ui"
import { useT } from "../../../i18n"
import { api } from "../../../lib/api"
import { SharingSettings } from "../../MemorySharing"
import { SettingRow, SettingsSection, useErrorDetail } from "../SettingRow"

/**
 * Puente hasta la tanda 2 (dueño: ajustes-b): monta la función actual de Colaboración y red.
 * Contrato: `export default` sin props; la sección renderiza su propio `SettingsSection`.
 * `SharingSettings` sigue con su marcado y textos previos al rediseño.
 */
export default function Colaboracion() {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const cache = useQueryClient()
  const collaboration = useQuery({ queryKey: ["collaboration"], queryFn: () => api.get<{ enabled: boolean }>("/collaboration") })
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.put<{ enabled: boolean }>("/collaboration", { enabled }),
    onSuccess: async () => { await cache.invalidateQueries() },
    onError: error => toast.error(t("bridge.saveFailed"), detail(error)),
  })
  return (
    <SettingsSection title={t("sections.colaboracion")}>
      <List>
        <SettingRow label={t("bridge.collaboration.label")} hint={t("bridge.collaboration.hint")}>
          <Switch
            label={t("bridge.collaboration.label")}
            checked={save.isPending ? Boolean(save.variables) : collaboration.data?.enabled ?? true}
            disabled={!collaboration.data || save.isPending}
            onChange={value => save.mutate(value)}
          />
        </SettingRow>
      </List>
      <SharingSettings />
    </SettingsSection>
  )
}
