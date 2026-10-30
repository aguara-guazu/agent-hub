import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { List, Seg, Switch, useToast } from "../../../components/ui"
import { LanguageSelect, useT } from "../../../i18n"
import { useTheme, type ThemePreference } from "../../../lib/theme"
import { SettingRow, SettingsSection, useErrorDetail } from "../SettingRow"

const AUTOSTART_KEY = ["desktop-autostart"] as const
const THEMES: readonly ThemePreference[] = ["dark", "light", "system"]

/** General: idioma, tema e inicio automático (este último solo con el puente de escritorio). Guardado automático. */
export default function General() {
  const { t } = useT("settings")
  const theme = useTheme()
  const toast = useToast()
  const detail = useErrorDetail()
  const cache = useQueryClient()
  const desktop = typeof window !== "undefined" ? window.agentHub : undefined
  const autostart = useQuery({ queryKey: AUTOSTART_KEY, queryFn: () => desktop!.getAutostart(), enabled: Boolean(desktop) })
  const saveAutostart = useMutation({
    mutationFn: (enabled: boolean) => desktop!.setAutostart(enabled),
    onSuccess: enabled => cache.setQueryData(AUTOSTART_KEY, enabled),
    onError: error => toast.error(t("general.autostartFailed"), detail(error)),
  })
  return (
    <SettingsSection title={t("sections.general")}>
      <List>
        <SettingRow label={t("general.language")}><LanguageSelect /></SettingRow>
        <SettingRow label={t("general.theme")}>
          <Seg
            label={t("general.theme")}
            value={theme.preference}
            onChange={value => theme.setPreference(value)}
            options={THEMES.map(value => ({ value, label: t(`general.themes.${value}`) }))}
          />
        </SettingRow>
        {desktop && (
          <SettingRow label={t("general.autostart")} hint={t("general.autostartHint")}>
            <Switch
              label={t("general.autostart")}
              checked={saveAutostart.isPending ? Boolean(saveAutostart.variables) : autostart.data ?? false}
              disabled={autostart.isPending || saveAutostart.isPending}
              onChange={value => saveAutostart.mutate(value)}
            />
          </SettingRow>
        )}
      </List>
    </SettingsSection>
  )
}
