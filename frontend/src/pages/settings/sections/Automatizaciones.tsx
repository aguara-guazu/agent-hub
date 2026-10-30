import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ErrorState, Input, List, SkeletonRows, Switch, useToast } from "../../../components/ui"
import { useFormat, useT } from "../../../i18n"
import { api } from "../../../lib/api"
import { automationKeys, useAutomationSettings, type AutomationSettings } from "../../../lib/automations"
import { SettingRow, SettingsSection, useErrorDetail } from "../SettingRow"

type Toggle = "automations_enabled" | "notify_schedule_created" | "notify_delivery" | "keep_awake"

function validHours(value: number): boolean {
  return Number.isFinite(value) && value >= 0.5 && value <= 24
}

/** Preferencias globales de automatización. Guardado automático: cada interruptor envía solo su campo; la jornada, al salir del campo. */
export default function Automatizaciones() {
  const { t } = useT("settings")
  const format = useFormat()
  const toast = useToast()
  const detail = useErrorDetail()
  const cache = useQueryClient()
  const settings = useAutomationSettings()
  const data = settings.data
  const save = useMutation({
    mutationFn: (patch: Partial<AutomationSettings>) => api.put<AutomationSettings>("/automations", patch),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: automationKeys.settings }) },
    onError: error => toast.error(t("automations.saveFailed"), detail(error)),
  })
  const [hours, setHours] = useState("")
  useEffect(() => { if (data) setHours(format.number(data.workday_hours)) }, [data, format])
  const parsed = Number(hours.replace(",", "."))
  const hoursValid = validHours(parsed)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const busy = !data || save.isPending

  const toggle = (key: Toggle) => {
    const pending = save.isPending && save.variables && key in save.variables ? save.variables[key] : undefined
    return (
      <Switch
        label={t(`automations.${key}.label`)}
        checked={pending ?? data?.[key] ?? true}
        disabled={busy}
        onChange={value => save.mutate({ [key]: value })}
      />
    )
  }

  if (settings.isPending) return <SettingsSection title={t("sections.automatizaciones")}><SkeletonRows count={4} avatar={false} /></SettingsSection>
  if (settings.error) return <SettingsSection title={t("sections.automatizaciones")}><ErrorState error={settings.error} onRetry={() => void settings.refetch()} /></SettingsSection>
  return (
    <SettingsSection title={t("sections.automatizaciones")}>
      <List>
        <SettingRow label={t("automations.automations_enabled.label")} hint={t("automations.automations_enabled.hint")}>{toggle("automations_enabled")}</SettingRow>
        <SettingRow label={t("automations.notify_schedule_created.label")} hint={t("automations.notify_schedule_created.hint")}>{toggle("notify_schedule_created")}</SettingRow>
        <SettingRow label={t("automations.notify_delivery.label")} hint={t("automations.notify_delivery.hint")}>{toggle("notify_delivery")}</SettingRow>
        {window.agentHub && <SettingRow label={t("automations.keep_awake.label")} hint={t("automations.keep_awake.hint")}>{toggle("keep_awake")}</SettingRow>}
        <SettingRow
          label={t("automations.workday.label")}
          htmlFor="settings-workday"
          hint={hoursValid || !hours ? t("automations.workday.hint", { timezone }) : t("automations.workday.invalid")}
        >
          <Input
            id="settings-workday"
            mono
            inputMode="decimal"
            value={hours}
            disabled={busy}
            aria-invalid={!hoursValid || undefined}
            style={{ width: 76 }}
            onChange={event => setHours(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape" && data) setHours(format.number(data.workday_hours)) }}
            onBlur={() => { if (data && hoursValid && parsed !== data.workday_hours) save.mutate({ workday_hours: parsed }) }}
          />
          <span className="t3">{t("automations.workday.unit")}</span>
        </SettingRow>
      </List>
    </SettingsSection>
  )
}
