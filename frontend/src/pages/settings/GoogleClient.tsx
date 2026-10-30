import { useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Avatar, Button, Chip, Field, Input } from "../../components/ui"
import { useToast } from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"
import { useMemoryStatus } from "../../lib/memory"
import { SettingRow, useErrorDetail } from "./SettingRow"

/**
 * Cliente OAuth de escritorio de Google: fila de Integraciones con edición en línea. Al guardarlo el servidor crea
 * la fuente Google (si falta) y devuelve la URL de autorización, que se abre en el navegador.
 * El secreto se envía una vez y nunca se lee de vuelta.
 */
export function GoogleClientRow() {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const cache = useQueryClient()
  const status = useMemoryStatus()
  const configured = status.data?.google_client_configured === true
  const [open, setOpen] = useState(false)
  const [clientId, setClientId] = useState("")
  const [secret, setSecret] = useState("")
  const file = useRef<HTMLInputElement>(null)
  const save = useMutation({
    mutationFn: () => api.put<{ authorization_url?: string }>("/memory/credentials/google-client", { client_id: clientId.trim(), ...(secret ? { client_secret: secret } : {}) }),
    onSuccess: result => {
      setSecret("")
      setClientId("")
      setOpen(false)
      void cache.invalidateQueries()
      toast.success(t("sources.googleClient.saved"))
      if (result?.authorization_url) window.open(result.authorization_url, "_blank", "noopener,noreferrer")
    },
    onError: error => toast.error(t("sources.googleClient.saveFailed"), detail(error)),
  })
  async function load(selected?: File) {
    if (!selected) return
    try {
      const data = JSON.parse(await selected.text())
      const client = data.installed ?? data.web
      if (!client?.client_id) throw new Error("missing client_id")
      setClientId(client.client_id)
      setSecret(client.client_secret ?? "")
    } catch {
      toast.error(t("sources.googleClient.invalidFile"))
    }
  }
  return <>
    <SettingRow
      lead={<Avatar name="Google" text="G" small />}
      label={t("sources.googleClient.label")}
      hint={status.data?.google_redirect_url ?? t("sources.googleClient.hint")}
      monoHint={Boolean(status.data?.google_redirect_url)}
    >
      <Chip tone={configured ? "ok" : "off"}>{t(configured ? "sources.googleClient.configured" : "sources.googleClient.missing")}</Chip>
      <Button small disabled={!status.data?.ready} aria-expanded={open} onClick={() => setOpen(!open)}>{t(configured ? "sources.googleClient.change" : "sources.googleClient.configure")}</Button>
    </SettingRow>
    {open && (
      <form
        style={{ padding: "var(--sp-4)", display: "flex", flexDirection: "column", gap: "var(--sp-4)", borderTop: "1px solid var(--border)" }}
        onSubmit={event => { event.preventDefault(); if (clientId.trim() && !save.isPending) save.mutate() }}
      >
        <div>
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={event => void load(event.target.files?.[0])} />
          <Button small icon="document" onClick={() => file.current?.click()}>{t("sources.googleClient.loadFile")}</Button>
        </div>
        <Field label={t("sources.googleClient.clientId")}>
          <Input mono autoComplete="off" spellCheck={false} value={clientId} onChange={event => setClientId(event.target.value)} />
        </Field>
        <Field label={t("sources.googleClient.secret")} hint={t("sources.googleClient.secretHint")}>
          <Input type="password" autoComplete="new-password" spellCheck={false} value={secret} onChange={event => setSecret(event.target.value)} />
        </Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--sp-2)" }}>
          <Button variant="ghost" disabled={save.isPending} onClick={() => { setOpen(false); setClientId(""); setSecret("") }}>{t("sources.editor.discard")}</Button>
          <Button variant="primary" type="submit" disabled={!clientId.trim() || save.isPending}>{t("sources.googleClient.save")}</Button>
        </div>
      </form>
    )}
  </>
}
