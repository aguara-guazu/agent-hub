import { List, Select } from "../../../components/ui"
import { useT } from "../../../i18n"
import { useJiraServer, useSaveJiraServer } from "../../../lib/automations"
import { JiraSettings } from "../../JiraSettings"
import { GoogleClientRow } from "../GoogleClient"
import { SettingRow, SettingsSection } from "../SettingRow"

const NONE = "none"

/**
 * Puente hasta la tanda 2 (dueño: ajustes-b): cliente OAuth de Google (componente final, `GoogleClient.tsx`),
 * servidor de Jira de las automatizaciones y el sitio de Jira predeterminado (`JiraSettings`, marcado previo).
 * Contrato: `export default` sin props; la sección renderiza su propio `SettingsSection`.
 */
export default function Integraciones() {
  const { t } = useT("settings")
  const jira = useJiraServer()
  const saveJira = useSaveJiraServer()
  const servers = jira.data?.servers ?? []
  const usable = servers.filter(server => server.usable)
  const selected = jira.data?.selected ?? null
  const stale = selected !== null && !usable.some(server => server.id === selected)
  const options = [
    { value: NONE, label: t("bridge.jiraServer.none") },
    ...(stale ? [{ value: selected!, label: t("bridge.jiraServer.unavailable", { name: servers.find(server => server.id === selected)?.name ?? selected }) }] : []),
    ...usable.map(server => ({ value: server.id, label: server.name })),
  ]
  const hint = jira.data && usable.length === 0 ? t("bridge.jiraServer.noServers") : stale ? t("bridge.jiraServer.stale") : t("bridge.jiraServer.hint")
  return (
    <SettingsSection title={t("sections.integraciones")}>
      <List>
        <GoogleClientRow />
        <SettingRow label={t("bridge.jiraServer.label")} hint={hint}>
          <Select bare label={t("bridge.jiraServer.label")} value={selected ?? NONE} options={options} disabled={!jira.data || saveJira.isPending} onChange={value => saveJira.mutate(value === NONE ? null : value)} />
        </SettingRow>
      </List>
      <JiraSettings />
    </SettingsSection>
  )
}
