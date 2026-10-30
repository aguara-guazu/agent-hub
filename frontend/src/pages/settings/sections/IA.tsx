import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { Button, Chip, Combobox, Input, List, Seg, Select, SkeletonRows, Switch, useToast } from "../../../components/ui"
import type { ChipTone } from "../../../components/ui"
import { useT } from "../../../i18n"
import { api } from "../../../lib/api"
import { useMemoryStatus } from "../../../lib/memory"
import { DeepseekKeyRow, KiroKeyRow } from "../Credentials"
import { MediaSettingsBlock } from "../MediaBlock"
import { useMemoryBanner } from "../MemoryBanner"
import { QuotasBlock } from "../QuotasBlock"
import { SettingRow, SettingsSection, useErrorDetail } from "../SettingRow"
import { useMemoryAction } from "../memory"

/** Espeja el identificador de `packages/memory/src/embedding-model.ts`; el servidor lo usa para elegir el motor integrado. */
const NATIVE_EMBEDDING_MODEL = "embeddinggemma-2-native-q8-v1"
const OLLAMA_EMBEDDING_DEFAULT = "nomic-embed-text"
const CLI_PROVIDERS = ["claude_code", "codex_cli", "opencode", "kiro"] as const
const EXTRACTIONS = ["disabled", ...CLI_PROVIDERS, "ollama", "deepseek"] as const
type Extraction = (typeof EXTRACTIONS)[number]
type CliProvider = (typeof CLI_PROVIDERS)[number]
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const
const DEFAULT_EFFORT = "default"

interface AiConfig {
  extraction: string
  extraction_model: string
  extraction_reasoning_effort?: string
  remote_processing_enabled: boolean
  identity_auto_merge?: boolean
  project_auto_assign?: boolean
  embeddings_enabled?: boolean
  embedding_model: string
  ollama_url: string
}

interface CliStatus { installed: boolean; models: { id: string; name: string; reasoning_efforts?: string[] }[]; detail?: string }

function isCli(value: string): value is CliProvider {
  return (CLI_PROVIDERS as readonly string[]).includes(value)
}

function cliPath(provider: CliProvider): string {
  return provider === "opencode" ? "/memory/opencode" : `/memory/extraction-cli/${provider}`
}

function same(a: AiConfig | null | undefined, b: AiConfig | null | undefined): boolean {
  return Boolean(a && b && Object.keys({ ...a, ...b }).every(key => (a as any)[key] === (b as any)[key]))
}

/** La configuración se puede guardar: cada proveedor tiene lo que el servidor exige. */
function complete(ai: AiConfig): boolean {
  if (ai.extraction !== "disabled" && !ai.extraction_model.trim()) return false
  const ollamaEmbeddings = ai.embedding_model !== NATIVE_EMBEDDING_MODEL
  if (ollamaEmbeddings && !ai.embedding_model.trim()) return false
  if ((ollamaEmbeddings || ai.extraction === "ollama") && !ai.ollama_url.trim()) return false
  return true
}

/**
 * IA y procesamiento. Guardado automático en toda la sección: interruptores y selectores guardan al cambiar;
 * los campos de texto, al salir del campo. Si falta un dato obligatorio (por ejemplo el modelo de una CLI recién
 * elegida) el cambio queda en borrador hasta completarlo, con el motivo en la ayuda de la fila.
 */
export default function IA() {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const navigate = useNavigate()
  const cache = useQueryClient()
  const status = useMemoryStatus()
  const ready = status.data?.ready === true
  const saved: AiConfig | undefined = ready ? status.data?.ai : undefined
  const [draft, setDraft] = useState<AiConfig | null>(null)
  const ai = draft ?? saved ?? null

  const saveAI = useMutation({
    mutationFn: (selection: AiConfig) => api.put<AiConfig>("/memory/ai", selection),
    onSuccess: (result, submitted) => {
      cache.setQueryData(["memory-status"], (current: any) => ({ ...current, ai: result }))
      // Conserva lo que se editó mientras la verificación del modelo seguía en curso.
      setDraft(current => (same(current, submitted) ? null : current))
      void status.refetch()
    },
    onError: (error, submitted) => {
      toast.error(t("ai.saveFailed"), detail(error))
      setDraft(current => (same(current, submitted) ? null : current))
    },
  })

  function apply(patch: Partial<AiConfig>, commit = true) {
    if (!ai) return
    const next = { ...ai, ...patch }
    setDraft(next)
    if (commit && complete(next) && !same(next, saved)) saveAI.mutate({ ...next, embeddings_enabled: true })
  }
  const commit = () => { if (ai && complete(ai) && !same(ai, saved)) saveAI.mutate({ ...ai, embeddings_enabled: true }) }

  const queued = (key: "reprocess" | "dedupe" | "tidy" | "processFiles") => () => toast.show({ kind: "info", message: t(`ai.maintenance.queued.${key}`), action: { label: t("page.viewActivity"), onClick: () => navigate("/activity?tab=procesamiento") } })
  const reprocess = useMemoryAction("reprocess", t("ai.maintenance.failed"), queued("reprocess"))
  const dedupe = useMemoryAction("dedupe_people", t("ai.maintenance.failed"), queued("dedupe"))
  const tidy = useMemoryAction("tidy_memory", t("ai.maintenance.failed"), queued("tidy"))
  const processFiles = useMemoryAction("process_files", t("ai.maintenance.failed"), queued("processFiles"))

  const banner = useMemoryBanner()
  const savingNote = saveAI.isPending ? <span className="xs t3" role="status">{t("ai.saving")}</span> : undefined

  return <>
    <SettingsSection title={t("sections.ia")} action={savingNote}>
      {banner}
      {status.isPending || (ready && !ai) ? <SkeletonRows count={5} avatar={false} /> : ai && <>
        <List>
          <ExtractionRows ai={ai} apply={apply} commit={commit} deepseekConfigured={status.data?.deepseek_configured === true} needsModel={status.data?.defaults?.provider_state === "needs_model"} />
          <SettingRow label={t("ai.identity.label")} hint={t("ai.identity.hint")}>
            <Switch label={t("ai.identity.label")} checked={ai.identity_auto_merge !== false} onChange={value => apply({ identity_auto_merge: value })} />
          </SettingRow>
          <SettingRow label={t("ai.projectAssign.label")} hint={t("ai.projectAssign.hint")}>
            <Switch label={t("ai.projectAssign.label")} checked={ai.project_auto_assign !== false} onChange={value => apply({ project_auto_assign: value })} />
          </SettingRow>
          <EmbeddingRows ai={ai} apply={apply} commit={commit} />
        </List>
      </>}
    </SettingsSection>
    {ready && <MediaSettingsBlock />}
    {ready && <QuotasBlock />}
    {ready && (
      <section className="section">
        <div className="section-h"><h3 className="h3">{t("ai.maintenance.title")}</h3></div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
          <Button disabled={reprocess.isPending} onClick={() => reprocess.mutate({ force: true })}>{t("ai.maintenance.reprocess")}</Button>
          <Button disabled={dedupe.isPending} onClick={() => dedupe.mutate({})}>{t("ai.maintenance.dedupe")}</Button>
          <Button disabled={tidy.isPending} onClick={() => tidy.mutate({ force: true })}>{t("ai.maintenance.tidy")}</Button>
          <Button disabled={processFiles.isPending} onClick={() => processFiles.mutate({})}>{t("ai.maintenance.processFiles")}</Button>
        </div>
      </section>
    )}
  </>
}

function ExtractionRows({ ai, apply, commit, deepseekConfigured, needsModel }: { ai: AiConfig; apply: (patch: Partial<AiConfig>, commit?: boolean) => void; commit: () => void; deepseekConfigured: boolean; needsModel: boolean }) {
  const { t } = useT("settings")
  const extraction = (EXTRACTIONS as readonly string[]).includes(ai.extraction) ? ai.extraction as Extraction : "disabled"
  const cli = isCli(extraction) ? extraction : null
  const missingModel = extraction !== "disabled" && !ai.extraction_model.trim()
  function choose(value: Extraction) {
    if (value === ai.extraction) return
    apply({
      extraction: value,
      extraction_reasoning_effort: "",
      extraction_model: value === "deepseek" ? "deepseek-flash" : value === "ollama" || isCli(value) ? "" : ai.extraction_model,
    })
  }
  return <>
    <SettingRow label={t("ai.extraction.label")} hint={t("ai.extraction.hint")}>
      <Select bare label={t("ai.extraction.label")} value={extraction} onChange={choose} options={EXTRACTIONS.map(value => ({ value, label: t(`ai.extraction.options.${value}`) }))} />
    </SettingRow>
    {cli && <CliRows key={cli} provider={cli} ai={ai} apply={apply} missingModel={missingModel || needsModel} />}
    {(extraction === "ollama" || extraction === "deepseek") && (
      <SettingRow label={t("ai.model.nameLabel")} htmlFor="settings-extraction-model" hint={missingModel ? t("ai.model.required") : undefined}>
        <Input
          id="settings-extraction-model"
          mono
          value={ai.extraction_model}
          style={{ width: 200 }}
          onChange={event => apply({ extraction_model: event.target.value }, false)}
          onBlur={commit}
          onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur() }}
        />
      </SettingRow>
    )}
    {extraction === "deepseek" && <DeepseekKeyRow configured={deepseekConfigured} />}
    {(cli || extraction === "deepseek") && (
      <SettingRow
        label={t("ai.remote.label")}
        hint={cli ? t("ai.remote.hintCli", { cli: t(`ai.extraction.options.${cli}`) }) : t("ai.remote.hintDeepseek")}
      >
        <Switch label={t("ai.remote.label")} checked={ai.remote_processing_enabled} onChange={value => apply({ remote_processing_enabled: value })} />
      </SettingRow>
    )}
  </>
}

function CliRows({ provider, ai, apply, missingModel }: { provider: CliProvider; ai: AiConfig; apply: (patch: Partial<AiConfig>, commit?: boolean) => void; missingModel: boolean }) {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const path = cliPath(provider)
  const cliName = t(`ai.extraction.options.${provider}`)
  const status = useQuery({ queryKey: ["memory-extraction-cli", provider], queryFn: () => api.get<CliStatus>(path), staleTime: 30_000, retry: false })
  const models = status.data?.models ?? []
  const model = ai.extraction_model
  const effort = ai.extraction_reasoning_effort ?? ""
  const efforts = models.find(item => item.id === model)?.reasoning_efforts ?? []
  const test = useMutation({
    mutationFn: (selection: { model: string; reasoning_effort?: string }) => api.post<{ ok: boolean; model: string; resolved_model?: string }>(`${path}/test`, selection),
    onSuccess: result => toast.success(result.resolved_model ? t("ai.test.okResolved", { model: result.resolved_model }) : t("ai.test.ok")),
    onError: error => toast.error(t("ai.test.failed"), detail(error)),
  })
  const modelOptions = [
    ...(model && !models.some(item => item.id === model) ? [{ value: model, label: model, detail: t("ai.model.unverified") }] : []),
    ...models.map(item => ({ value: item.id, label: item.name })),
  ]
  const effortLabel = (value: string) => (EFFORTS as readonly string[]).includes(value) ? t(`ai.effort.levels.${value as (typeof EFFORTS)[number]}`) : value
  const effortOptions = [
    { value: DEFAULT_EFFORT, label: t("ai.effort.default") },
    ...(effort && !efforts.includes(effort) ? [{ value: effort, label: effort, detail: t("ai.model.unverified") }] : []),
    ...efforts.map(value => ({ value, label: effortLabel(value) })),
  ]
  const hint = status.isPending ? t("ai.model.loading")
    : status.data?.installed === false ? (status.data.detail ?? t("ai.model.notInstalled", { cli: cliName }))
      : missingModel ? t("ai.model.required")
        : status.data?.detail ?? t("ai.model.hintCli", { cli: cliName })
  const tone: ChipTone | null = status.error ? "danger" : status.data?.installed === false ? "warn" : null
  return <>
    {provider === "kiro" && <KiroKeyRow onChanged={() => test.reset()} />}
    <SettingRow label={t("ai.model.label")} hint={status.error ? detail(status.error) : hint}>
      {tone && <Chip tone={tone}>{t(tone === "danger" ? "ai.model.statusError" : "ai.model.statusMissing")}</Chip>}
      <div style={{ width: 220 }}>
        <Combobox
          label={t("ai.model.label")}
          value={model}
          options={modelOptions}
          placeholder={status.isPending ? t("ai.model.loading") : t("ai.model.placeholder")}
          disabled={status.isPending}
          onChange={value => apply({ extraction_model: value, extraction_reasoning_effort: "" })}
          onCreate={provider === "opencode" ? undefined : text => apply({ extraction_model: text, extraction_reasoning_effort: "" })}
        />
      </div>
    </SettingRow>
    <SettingRow label={t("ai.effort.label")} hint={model && !status.isPending && efforts.length === 0 ? t("ai.effort.noLevels") : t("ai.effort.hint")}>
      <Select bare label={t("ai.effort.label")} value={effort || DEFAULT_EFFORT} disabled={!model || status.isPending} options={effortOptions} onChange={value => apply({ extraction_reasoning_effort: value === DEFAULT_EFFORT ? "" : value })} />
      <Button small disabled={!model || status.data?.installed === false || test.isPending} onClick={() => test.mutate({ model, ...(effort ? { reasoning_effort: effort } : {}) })}>
        {test.isPending ? t("ai.test.running") : t("ai.test.action")}
      </Button>
    </SettingRow>
  </>
}

type NativeState = "ready" | "downloading" | "pending" | "paused" | "error" | "missing"
const NATIVE_KEY = ["memory-native-embeddings"] as const

function EmbeddingRows({ ai, apply, commit }: { ai: AiConfig; apply: (patch: Partial<AiConfig>, commit?: boolean) => void; commit: () => void }) {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const cache = useQueryClient()
  const native = ai.embedding_model === NATIVE_EMBEDDING_MODEL
  const status = useQuery({
    queryKey: NATIVE_KEY,
    queryFn: () => api.get<{ state?: NativeState; percent?: number; file?: string; error?: string }>("/memory/embeddings/native"),
    refetchInterval: query => (query.state.data?.state === "downloading" ? 1000 : false),
  })
  const action = useMutation({
    mutationFn: (name: "install" | "cancel") => api.post<any>(`/memory/embeddings/native/${name}`),
    onSuccess: result => { cache.setQueryData(NATIVE_KEY, result); void status.refetch() },
    onError: error => toast.error(t("ai.embeddings.downloadFailed"), detail(error)),
  })
  const state: NativeState = status.data?.state ?? "pending"
  const tone: ChipTone = state === "ready" ? "ok" : state === "downloading" ? "info" : state === "error" ? "danger" : "off"
  const chip = state === "downloading" && typeof status.data?.percent === "number"
    ? t("ai.embeddings.state.downloadingPercent", { percent: Math.round(status.data.percent) })
    : t(`ai.embeddings.state.${state}`)
  const ollamaUrl = !native || ai.extraction === "ollama"
  return <>
    <SettingRow label={t("ai.embeddings.label")} hint={native ? (status.data?.error ?? t("ai.embeddings.hintNative")) : t("ai.embeddings.hintOllama")}>
      {native && <Chip tone={tone}>{chip}</Chip>}
      {native && state !== "ready" && (
        <Button small disabled={action.isPending || status.isPending} onClick={() => action.mutate(state === "downloading" ? "cancel" : "install")}>
          {t(state === "downloading" ? "ai.embeddings.cancel" : state === "error" || state === "paused" ? "ai.embeddings.retry" : "ai.embeddings.download")}
        </Button>
      )}
      <Seg
        label={t("ai.embeddings.label")}
        value={native ? "native" : "ollama"}
        onChange={value => apply({ embedding_model: value === "native" ? NATIVE_EMBEDDING_MODEL : OLLAMA_EMBEDDING_DEFAULT })}
        options={[{ value: "native", label: t("ai.embeddings.options.native") }, { value: "ollama", label: t("ai.embeddings.options.ollama") }]}
      />
    </SettingRow>
    {!native && (
      <SettingRow label={t("ai.embeddings.ollamaModel")} htmlFor="settings-embedding-model" hint={ai.embedding_model.trim() ? undefined : t("ai.model.required")}>
        <Input id="settings-embedding-model" mono value={ai.embedding_model} style={{ width: 200 }} onChange={event => apply({ embedding_model: event.target.value }, false)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur() }} />
      </SettingRow>
    )}
    {ollamaUrl && (
      <SettingRow label={t("ai.embeddings.ollamaUrl")} htmlFor="settings-ollama-url" hint={ai.ollama_url.trim() ? undefined : t("ai.embeddings.urlRequired")}>
        <Input id="settings-ollama-url" mono value={ai.ollama_url} style={{ width: 240 }} onChange={event => apply({ ollama_url: event.target.value }, false)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur() }} />
      </SettingRow>
    )}
  </>
}
