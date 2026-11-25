import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { List, Select, Switch, useToast } from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"
import { SettingRow, useErrorDetail } from "./SettingRow"

interface RecordingSettings { enabled: boolean; notify: boolean; lead_minutes: number; retention_days: number }

const RECORDING_KEY = ["memory-recording-settings"] as const
const LEAD_MINUTES = [0, 1, 2, 5, 10] as const
const RETENTION_DAYS = [7, 30, 90, 365] as const

/** Preferencias del grabador de reuniones del Hub. */
export function RecordingSettingsBlock() {
  const { t, plural } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const cache = useQueryClient()
  const query = useQuery({ queryKey: RECORDING_KEY, queryFn: () => api.get<RecordingSettings>("/memory/recordings/settings") })
  const save = useMutation({
    mutationFn: async (patch: Partial<RecordingSettings>) => {
      if (patch.enabled !== undefined && window.agentHub?.setRecordingEnabled) {
        await window.agentHub.setRecordingEnabled(patch.enabled)
        return { ...query.data!, enabled: patch.enabled }
      }
      return api.put<RecordingSettings>("/memory/recordings/settings", patch)
    },
    onSuccess: result => { cache.setQueryData(RECORDING_KEY, result) },
    onError: error => {
      toast.error(t("ai.recording.saveFailed"), detail(error))
      void query.refetch()
    },
  })
  const settings = query.data
  if (!settings) return null
  const change = (patch: Partial<RecordingSettings>) => save.mutate(patch)
  const leads = LEAD_MINUTES.includes(settings.lead_minutes as never) ? LEAD_MINUTES : [...LEAD_MINUTES, settings.lead_minutes].sort((a, b) => a - b)
  const retentions = RETENTION_DAYS.includes(settings.retention_days as never) ? RETENTION_DAYS : [...RETENTION_DAYS, settings.retention_days].sort((a, b) => a - b)
  return (
    <section className="section">
      <div className="section-h"><h3 className="h3">{t("ai.recording.title")}</h3></div>
      <List>
        <SettingRow label={t("ai.recording.enabled")} hint={t("ai.recording.enabledHint")}>
          <Switch label={t("ai.recording.enabled")} checked={settings.enabled} disabled={save.isPending} onChange={enabled => change({ enabled })} />
        </SettingRow>
        <SettingRow label={t("ai.recording.notify")} hint={t("ai.recording.notifyHint")}>
          <Switch label={t("ai.recording.notify")} checked={settings.notify} disabled={save.isPending || !settings.enabled} onChange={notify => change({ notify })} />
        </SettingRow>
        <SettingRow label={t("ai.recording.lead")}>
          <Select<string>
            bare
            label={t("ai.recording.lead")}
            disabled={save.isPending || !settings.enabled || !settings.notify}
            value={String(settings.lead_minutes)}
            options={leads.map(minutes => ({ value: String(minutes), label: minutes === 0 ? t("ai.recording.leadAtStart") : plural("ai.recording.leadValue", minutes) }))}
            onChange={value => change({ lead_minutes: Number(value) })}
          />
        </SettingRow>
        <SettingRow label={t("ai.recording.retention")} hint={t("ai.recording.retentionHint")}>
          <Select<string>
            bare
            label={t("ai.recording.retention")}
            disabled={save.isPending}
            value={String(settings.retention_days)}
            options={retentions.map(days => ({ value: String(days), label: plural("ai.recording.retentionValue", days) }))}
            onChange={value => change({ retention_days: Number(value) })}
          />
        </SettingRow>
      </List>
    </section>
  )
}
