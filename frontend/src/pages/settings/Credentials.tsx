import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button, ConfirmDialog, Input, useToast } from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"
import { SettingRow, useErrorDetail } from "./SettingRow"

const KIRO_KEY = ["memory-kiro-credentials"] as const
const KIRO_ACCOUNT = "https://app.kiro.dev"
const KIRO_DOCS = "https://kiro.dev/docs/getting-started/authentication/#generate-an-api-key"

/** Clave de Kiro para la extracción en segundo plano. El valor se envía una vez y no se vuelve a leer. */
export function KiroKeyRow({ onChanged }: { onChanged: () => void }) {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const cache = useQueryClient()
  const status = useQuery({ queryKey: KIRO_KEY, queryFn: () => api.get<{ configured: boolean; stored: boolean }>("/memory/credentials/kiro"), retry: false })
  const [key, setKey] = useState("")
  const [confirming, setConfirming] = useState(false)
  const refresh = async () => {
    onChanged()
    await Promise.all([cache.invalidateQueries({ queryKey: KIRO_KEY }), cache.invalidateQueries({ queryKey: ["memory-extraction-cli", "kiro"] })])
  }
  // La clave no viaja como variable de la mutación para que no quede en la caché compartida.
  const save = useMutation({
    mutationFn: () => api.put("/memory/credentials/kiro", { api_key: key.trim() }),
    onSuccess: async () => { setKey(""); toast.success(t("ai.kiroKey.saved")); await refresh() },
    onError: error => toast.error(t("ai.kiroKey.saveFailed"), detail(error)),
  })
  const remove = useMutation({
    mutationFn: () => api.delete("/memory/credentials/kiro"),
    onSuccess: async () => { setConfirming(false); toast.success(t("ai.kiroKey.removed")); await refresh() },
    onError: error => toast.error(t("ai.kiroKey.removeFailed"), detail(error)),
  })
  const busy = save.isPending || remove.isPending
  const hint = status.isPending ? t("ai.kiroKey.checking")
    : status.data?.stored ? t("ai.kiroKey.stored")
      : status.data?.configured ? t("ai.kiroKey.available")
        : t("ai.kiroKey.missing")
  return <>
    <SettingRow label={t("ai.kiroKey.label")} htmlFor="settings-kiro-key" hint={hint}>
      <Input
        id="settings-kiro-key"
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        placeholder="ksk_…"
        value={key}
        disabled={busy}
        style={{ width: 200 }}
        onChange={event => setKey(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter" && key.trim() && !busy) { event.preventDefault(); save.mutate() } }}
      />
      <Button small disabled={!key.trim() || busy} onClick={() => save.mutate()}>{t(status.data?.stored ? "ai.kiroKey.replace" : "ai.kiroKey.save")}</Button>
    </SettingRow>
    <SettingRow label={t("ai.kiroKey.accountLabel")} hint={t("ai.kiroKey.accountHint")}>
      <a className="btn btn-sm btn-ghost" href={KIRO_ACCOUNT} target="_blank" rel="noreferrer">{t("ai.kiroKey.openAccount")}</a>
      <a className="btn btn-sm btn-ghost" href={KIRO_DOCS} target="_blank" rel="noreferrer">{t("ai.kiroKey.docs")}</a>
      {status.data?.stored && <Button small variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>{t("ai.kiroKey.remove")}</Button>}
    </SettingRow>
    <ConfirmDialog
      open={confirming}
      title={t("ai.kiroKey.removeTitle")}
      message={t("ai.kiroKey.removeMessage")}
      confirmLabel={t("ai.kiroKey.remove")}
      cancelLabel={t("ai.kiroKey.cancel")}
      destructive
      busy={remove.isPending}
      onClose={() => setConfirming(false)}
      onConfirm={() => remove.mutate()}
    />
  </>
}

/** Clave de la API de DeepSeek. */
export function DeepseekKeyRow({ configured }: { configured: boolean }) {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const cache = useQueryClient()
  const [key, setKey] = useState("")
  const save = useMutation({
    mutationFn: () => api.put("/memory/credentials/deepseek", { api_key: key.trim() }),
    onSuccess: async () => { setKey(""); toast.success(t("ai.deepseekKey.saved")); await cache.invalidateQueries({ queryKey: ["memory-status"] }) },
    onError: error => toast.error(t("ai.deepseekKey.saveFailed"), detail(error)),
  })
  return (
    <SettingRow label={t("ai.deepseekKey.label")} htmlFor="settings-deepseek-key" hint={t(configured ? "ai.deepseekKey.configured" : "ai.deepseekKey.missing")}>
      <Input
        id="settings-deepseek-key"
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        value={key}
        disabled={save.isPending}
        style={{ width: 200 }}
        onChange={event => setKey(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter" && key.trim() && !save.isPending) { event.preventDefault(); save.mutate() } }}
      />
      <Button small disabled={!key.trim() || save.isPending} onClick={() => save.mutate()}>{t(configured ? "ai.deepseekKey.replace" : "ai.deepseekKey.save")}</Button>
    </SettingRow>
  )
}
