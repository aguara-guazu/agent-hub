import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button, Chip, List, Select, Switch, useToast } from "../../components/ui"
import type { ChipTone } from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"
import { SettingRow, useErrorDetail } from "./SettingRow"

const MODULES = ["ocr", "decoder", "speech", "vision", "audio"] as const
type ModuleKey = (typeof MODULES)[number]
const OPTIONS = ["pdf", "ocr", "transcription", "vision", "audio", "automatic"] as const
type OptionKey = (typeof OPTIONS)[number]
const LANGUAGES = ["es", "en", "pt", "fr", "de", "it", "ja", "zh", "ko", "ru", "ar", "hi"] as const
type TranscriptionLanguage = (typeof LANGUAGES)[number]
const MEDIA_GUIDE = "https://github.com/aguara-guazu/agent-hub/blob/main/docs/media-processing.md"

interface ModuleStatus { state?: "ready" | "missing" | "downloading" | "error" | string; percent?: number; file?: string; error?: string }
type MediaOptions = Record<OptionKey, boolean> & { language: string }
interface MediaStatus { modules?: Partial<Record<ModuleKey, ModuleStatus>>; settings?: MediaOptions }

const MEDIA_KEY = ["memory-media"] as const

/** Módulos locales de medios y sus opciones. Guardado automático: cada interruptor envía la configuración completa. */
export function MediaSettingsBlock() {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const cache = useQueryClient()
  const query = useQuery({
    queryKey: MEDIA_KEY,
    queryFn: () => api.get<MediaStatus>("/memory/media"),
    refetchInterval: q => (Object.values(q.state.data?.modules ?? {}).some(module => module?.state === "missing" || module?.state === "downloading") ? 1000 : false),
  })
  const [draft, setDraft] = useState<MediaOptions | null>(null)
  const settings = draft ?? query.data?.settings
  const save = useMutation({
    mutationFn: (value: MediaOptions) => api.put<MediaStatus>("/memory/media", value),
    onSuccess: (result, submitted) => {
      cache.setQueryData(MEDIA_KEY, result)
      setDraft(current => (JSON.stringify(current) === JSON.stringify(submitted) ? null : current))
    },
    onError: (error, submitted) => {
      toast.error(t("ai.media.saveFailed"), detail(error))
      setDraft(current => (JSON.stringify(current) === JSON.stringify(submitted) ? null : current))
    },
  })
  const change = (patch: Partial<MediaOptions>) => {
    if (!settings) return
    const next = { ...settings, ...patch }
    setDraft(next)
    save.mutate(next)
  }
  return (
    <section className="section">
      <div className="section-h">
        <h3 className="h3">{t("ai.media.title")}</h3>
        <a className="btn btn-sm btn-ghost" href={MEDIA_GUIDE} target="_blank" rel="noreferrer">{t("ai.media.guide")}</a>
      </div>
      <List>
        {MODULES.map(key => <ModuleRow key={key} module={key} status={query.data?.modules?.[key]} onChange={() => void query.refetch()} />)}
      </List>
      {settings && (
        <List>
          {OPTIONS.map(key => (
            <SettingRow key={key} label={t(`ai.media.options.${key}`)} hint={key === "automatic" ? t("ai.media.limits") : key === "vision" || key === "audio" ? t("ai.media.needsNative") : undefined}>
              <Switch label={t(`ai.media.options.${key}`)} checked={settings[key]} onChange={value => change({ [key]: value })} />
            </SettingRow>
          ))}
          <SettingRow label={t("ai.media.language")}>
            <Select<TranscriptionLanguage>
              bare
              label={t("ai.media.language")}
              value={(LANGUAGES as readonly string[]).includes(settings.language) ? settings.language as TranscriptionLanguage : ""}
              options={LANGUAGES.map(value => ({ value, label: t(`ai.media.languages.${value}`) }))}
              onChange={language => change({ language })}
            />
          </SettingRow>
        </List>
      )}
    </section>
  )
}

function ModuleRow({ module, status, onChange }: { module: ModuleKey; status: ModuleStatus | undefined; onChange: () => void }) {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const action = useMutation({
    mutationFn: (name: "install" | "cancel") => api.post(`/memory/media/${module}/${name}`),
    onSuccess: onChange,
    onError: error => toast.error(t("ai.media.moduleFailed"), detail(error)),
  })
  const state = status?.state
  const busy = state === "downloading"
  const tone: ChipTone = state === "ready" ? "ok" : busy ? "info" : state === "error" ? "danger" : "off"
  const chip = busy && typeof status?.percent === "number"
    ? t("ai.media.state.downloadingPercent", { percent: Math.round(status.percent) })
    : t(state === "ready" ? "ai.media.state.ready" : busy ? "ai.media.state.downloading" : state === "error" ? "ai.media.state.error" : "ai.media.state.missing")
  const hint = status?.error ?? t(`ai.media.modules.${module}.size`)
  return (
    <SettingRow label={t(`ai.media.modules.${module}.title`)} hint={hint}>
      <Chip tone={tone} title={busy ? status?.file : undefined}>{chip}</Chip>
      {state !== "ready" && (
        <Button small disabled={action.isPending} onClick={() => action.mutate(busy ? "cancel" : "install")}>
          {t(busy ? "ai.media.cancel" : state === "error" ? "ai.media.retry" : "ai.media.download")}
        </Button>
      )}
    </SettingRow>
  )
}
