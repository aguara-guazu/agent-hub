import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { List, Seg, Switch, useToast } from "../../../components/ui"
import { LanguageSelect, useT } from "../../../i18n"
import { useTheme, type ThemePreference } from "../../../lib/theme"
import { SettingRow, SettingsSection, useErrorDetail } from "../SettingRow"

const AUTOSTART_KEY = ["desktop-autostart"] as const
const AUTO_UPDATE_KEY = ["desktop-auto-update"] as const
const UPDATE_STATUS_KEY = ["desktop-update-status"] as const
const UPDATE_STATUS_REFRESH_MS = 5_000
const KNOWN_REASONS = new Set(["fleet_live", "legacy_gateways", "legacy_gateways_unknown", "mcp_inflight", "jobs_nonresumable", "already_draining", "drain_lease_lost", "swap_helper_unavailable", "runtime_unavailable", "blockers_unknown", "core_unreachable", "mcp_bridges", "stop_waiting_leaders", "stop_waiting_coordinators", "stop_waiting_members", "stop_state_requested", "stop_state_notifying", "stop_state_waiting_confirmations", "stop_state_waiting_members", "stop_state_stopping_fleet", "stop_state_ready", "stop_state_applied", "stop_postponed", "stop_cancelled", "stop_cooldown", "core_did_not_exit", "commit_refused", "stop_not_created", "transaction_required", "stop_resumed", "unexpected", "backup_failed", "coordinator_authority_changed", "drain_not_ready", "admission_close_failed", "admission_publish_failed", "admission_reopen_unconfirmed", "commit_persistence_pending", "commit_abandoned", "drain_owner_recovered", "fleet_stop_unconfirmed"])
const PLURAL_REASONS = new Set(["fleet_live", "legacy_gateways", "stop_waiting_leaders", "stop_waiting_coordinators", "stop_waiting_members"])
const THEMES: readonly ThemePreference[] = ["dark", "light", "system"]

/** General: idioma, tema e inicio automático (este último solo con el puente de escritorio). Guardado automático. */
export default function General() {
  const { t, plural } = useT("settings")
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
  // Versiones anteriores del escritorio no exponen el interruptor: la fila no aparece.
  const updatable = Boolean(desktop?.getAutoUpdate && desktop.setAutoUpdate)
  const autoUpdate = useQuery({ queryKey: AUTO_UPDATE_KEY, queryFn: () => desktop!.getAutoUpdate!(), enabled: updatable })
  const updateStatus = useQuery({
    queryKey: UPDATE_STATUS_KEY,
    queryFn: () => desktop!.getUpdateStatus!(),
    enabled: updatable && Boolean(desktop?.getUpdateStatus),
    refetchInterval: UPDATE_STATUS_REFRESH_MS,
  })
  const reasonText = (reasons: readonly { code: string; count?: number }[]): string => reasons.map(reason => {
    const code = KNOWN_REASONS.has(reason.code) ? reason.code : "unknown"
    return PLURAL_REASONS.has(code)
      ? plural(`general.updateStatus.reasons.${code}` as "general.updateStatus.reasons.fleet_live", reason.count ?? 1)
      : t(`general.updateStatus.reasons.${code}` as "general.updateStatus.reasons.unknown")
  }).join("; ")
  const statusLine = (): string => {
    const status = updateStatus.data
    if (!status?.enabled || !status.version) return t("general.autoUpdateHint")
    const version = status.version
    const trust = status.trust === "publisher_authenticated" ? t("general.updateStatus.authenticated")
      : status.trust === "integrity_only" ? t("general.updateStatus.integrityOnly") : ""
    const lead = status.phase === "downloading" ? t("general.updateStatus.downloading", { version })
      : status.phase === "ready" ? t("general.updateStatus.ready", { version })
      : status.phase === "postponed" ? t("general.updateStatus.postponed", { version, reasons: reasonText(status.reasons ?? []) })
      : status.phase === "applying" ? t("general.updateStatus.applying", { version })
      : status.phase === "failed" ? t("general.updateStatus.failed", { version })
      : null
    return lead ? (trust ? `${lead}. ${trust}` : lead) : t("general.autoUpdateHint")
  }
  const saveAutoUpdate = useMutation({
    mutationFn: (enabled: boolean) => desktop!.setAutoUpdate!(enabled),
    onSuccess: enabled => cache.setQueryData(AUTO_UPDATE_KEY, enabled),
    onError: error => toast.error(t("general.autoUpdateFailed"), detail(error)),
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
        {updatable && (
          <SettingRow label={t("general.autoUpdate")} hint={statusLine()}>
            <Switch
              label={t("general.autoUpdate")}
              checked={saveAutoUpdate.isPending ? Boolean(saveAutoUpdate.variables) : autoUpdate.data ?? true}
              disabled={autoUpdate.isPending || saveAutoUpdate.isPending}
              onChange={value => saveAutoUpdate.mutate(value)}
            />
          </SettingRow>
        )}
      </List>
    </SettingsSection>
  )
}
