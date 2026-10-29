import { useMutation } from "@tanstack/react-query"
import { Button, List, useToast } from "../../../components/ui"
import { useT } from "../../../i18n"
import { SettingRow, SettingsSection, useErrorDetail } from "../SettingRow"

/**
 * Puente hasta la tanda 2 (dueño: ajustes-b): reinicio del servicio local, que antes vivía en `HubSettings`.
 * Contrato: `export default` sin props; la sección renderiza su propio `SettingsSection`.
 */
export default function Sistema() {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const restart = useMutation({
    mutationFn: () => window.agentHub!.restartCore(),
    onSuccess: () => toast.success(t("bridge.system.restarted")),
    onError: error => toast.error(t("bridge.system.restartFailed"), detail(error)),
  })
  return (
    <SettingsSection title={t("sections.sistema")}>
      <List>
        <SettingRow label={t("bridge.system.service")} hint={t("bridge.system.serviceHint")}>
          <Button small disabled={!window.agentHub || restart.isPending} onClick={() => restart.mutate()}>{restart.isPending ? t("bridge.system.restarting") : t("bridge.system.restart")}</Button>
        </SettingRow>
      </List>
    </SettingsSection>
  )
}
