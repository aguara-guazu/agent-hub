import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button, Field, IconButton, Input, List, Switch, Textarea, useToast } from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"
import { memoryCall } from "../../lib/memory"
import { ProjectPicker } from "./ProjectPicker"
import { useErrorDetail } from "./SettingRow"
import { connectorInput, type Connector } from "./memory"

type ListKey = "calendars" | "folder_ids" | "document_ids" | "page_ids" | "channel_ids"
type GoogleFlag = "calendar_enabled" | "meet_enabled" | "gmail_enabled" | "gmail_send_enabled"

const DATE = /^\d{4}-\d{2}-\d{2}$/
const URL_PATTERN = /^https?:\/\/\S+$/i

function parseList(text: string): string[] {
  return text.split(/[\n,]+/).map(value => value.trim()).filter(Boolean)
}

/**
 * Edición en línea de una fuente, debajo de la lista (plantilla C, sin modal). Guardado explícito:
 * «Descartar» y «Guardar cambios» se activan solo con cambios. Las credenciales escritas se envían con el mismo
 * guardado y nunca se leen de vuelta. `authorize` muestra primero el bloque de autorización de Google.
 */
export function SourceEditor({ connector, authorizing, onAuthorize, authorizePending, onClose }: {
  connector: Connector
  authorizing: boolean
  onAuthorize: () => void
  authorizePending: boolean
  onClose: () => void
}) {
  const { t } = useT("settings")
  const toast = useToast()
  const detail = useErrorDetail()
  const cache = useQueryClient()
  const [name, setName] = useState(connector.name)
  const [config, setConfig] = useState<Record<string, any>>(connector.config ?? {})
  const [lists, setLists] = useState<Record<ListKey, string>>(() => ({
    calendars: (connector.config?.calendars ?? []).join("\n"),
    folder_ids: (connector.config?.folder_ids ?? []).join("\n"),
    document_ids: (connector.config?.document_ids ?? []).join("\n"),
    page_ids: (connector.config?.page_ids ?? []).join("\n"),
    channel_ids: (connector.config?.channel_ids ?? []).join("\n"),
  }))
  const [since, setSince] = useState<string>(connector.config?.since?.slice(0, 10) ?? "")
  const [projects, setProjects] = useState<string[]>(connector.project_ids ?? [])
  const [interval, setIntervalText] = useState(String(connector.interval_minutes))
  const [token, setToken] = useState("")
  const [email, setEmail] = useState("")

  const provider = connector.provider
  const listKeys: ListKey[] = provider === "google" ? ["calendars", "folder_ids", "document_ids"] : provider === "notion" ? ["page_ids"] : provider === "slack" ? ["channel_ids"] : []

  const nextConfig = (() => {
    const next: Record<string, any> = { ...config }
    for (const key of listKeys) {
      const values = parseList(lists[key])
      if (values.length || key in (connector.config ?? {})) next[key] = values
    }
    if (provider === "slack") {
      if (since) next.since = `${since}T00:00:00Z`
      else delete next.since
    }
    return next
  })()

  const intervalValue = Number(interval)
  const errors = {
    name: name.trim() ? undefined : t("sources.editor.errors.name"),
    interval: Number.isInteger(intervalValue) && intervalValue >= 5 && intervalValue <= 1440 ? undefined : t("sources.editor.errors.interval"),
    since: !since || DATE.test(since) ? undefined : t("sources.editor.errors.date"),
    site: provider !== "jira" || URL_PATTERN.test(String(config.site_url ?? "")) ? undefined : t("sources.editor.errors.site"),
    jql: provider !== "jira" || String(config.jql ?? "").trim() ? undefined : t("sources.editor.errors.jql"),
    email: provider === "jira" && token && !email.includes("@") ? t("sources.editor.errors.email") : undefined,
  }
  const valid = Object.values(errors).every(error => !error)
  const dirty = name !== connector.name
    || JSON.stringify(nextConfig) !== JSON.stringify(connector.config ?? {})
    || JSON.stringify(projects) !== JSON.stringify(connector.project_ids ?? [])
    || intervalValue !== connector.interval_minutes
    || token !== ""

  const save = useMutation({
    mutationFn: async () => {
      if (token) await api.put(`/memory/credentials/${encodeURIComponent(connector.id)}`, { token, ...(email ? { email } : {}) })
      await memoryCall("save_connector", connectorInput(connector, { name: name.trim(), config: nextConfig, project_ids: projects, interval_minutes: intervalValue }))
    },
    onSuccess: async () => {
      setToken("")
      await cache.invalidateQueries({ queryKey: ["memory"] })
      toast.success(t("sources.toast.saved", { name: name.trim() }))
      onClose()
    },
    onError: error => toast.error(t("sources.toast.saveFailed"), detail(error)),
  })

  const flag = (key: GoogleFlag, fallback: boolean) => (
    <Switch label={t(`sources.editor.google.${key}`)} checked={config[key] === undefined ? fallback : config[key] === true} onChange={value => setConfig({ ...config, [key]: value })} />
  )
  const flagRow = (key: GoogleFlag, fallback: boolean) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-3)" }}>
      <span>{t(`sources.editor.google.${key}`)}</span>
      {flag(key, fallback)}
    </div>
  )
  const gmailOn = config.gmail_enabled !== false

  return (
    <section className="section" aria-label={t("sources.editor.title", { name: connector.name })}>
      <div className="section-h">
        <h3 className="h3 trunc" title={connector.name}>{t("sources.editor.title", { name: connector.name })}</h3>
        <IconButton small variant="ghost" icon="close" label={t("sources.editor.close")} onClick={onClose} />
      </div>
      <List>
        <div style={{ padding: "var(--sp-4)", display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          {provider === "google" && authorizing && (
            <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span className="md" style={{ fontWeight: 500 }}>{t("sources.authorize.title")}</span>
                <span className="xs t3">{t("sources.authorize.detail", { email: connector.account_email ?? t("sources.authorize.ownAccount") })}</span>
              </div>
              <Button disabled={authorizePending} onClick={onAuthorize}>{t("sources.authorize.action")}</Button>
            </div>
          )}
          <Field label={t("sources.editor.name")} error={errors.name}>
            <Input value={name} onChange={event => setName(event.target.value)} />
          </Field>
          {listKeys.map(key => (
            <Field key={key} label={t(`sources.editor.lists.${key}.label`)} hint={t(`sources.editor.lists.${key}.hint`)}>
              <Textarea mono rows={2} value={lists[key]} onChange={event => setLists({ ...lists, [key]: event.target.value })} />
            </Field>
          ))}
          {provider === "google" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
              {flagRow("calendar_enabled", true)}
              {flagRow("meet_enabled", true)}
              {flagRow("gmail_enabled", true)}
              {gmailOn && flagRow("gmail_send_enabled", false)}
              <span className="hint">{gmailOn ? t("sources.editor.google.gmailHint") : t("sources.editor.google.rangeHint")}</span>
            </div>
          )}
          {provider === "slack" && (
            <Field label={t("sources.editor.since")} hint={t("sources.editor.sinceHint")} error={errors.since}>
              <Input mono placeholder={t("sources.editor.datePlaceholder")} value={since} onChange={event => setSince(event.target.value.trim())} style={{ width: 140 }} />
            </Field>
          )}
          {provider === "jira" && <>
            <Field label={t("sources.editor.jira.site")} error={errors.site}>
              <Input mono type="url" placeholder="https://empresa.atlassian.net" value={config.site_url ?? ""} onChange={event => setConfig({ ...config, site_url: event.target.value })} />
            </Field>
            <Field label={t("sources.editor.jira.jql")} error={errors.jql}>
              <Textarea mono rows={3} placeholder="project = POC ORDER BY updated DESC" value={config.jql ?? ""} onChange={event => setConfig({ ...config, jql: event.target.value })} />
            </Field>
          </>}
          <Field label={t("sources.editor.projects")} hint={t("sources.editor.projectsHint")}>
            <ProjectPicker value={projects} onChange={setProjects} />
          </Field>
          <Field label={t("sources.editor.interval")} error={errors.interval}>
            <Input mono inputMode="numeric" value={interval} onChange={event => setIntervalText(event.target.value)} style={{ width: 96 }} />
          </Field>
          {provider !== "google" && <>
            {provider === "jira" && (
              <Field label={t("sources.editor.credentials.email")} error={errors.email}>
                <Input type="email" autoComplete="off" value={email} onChange={event => setEmail(event.target.value)} />
              </Field>
            )}
            <Field label={t("sources.editor.credentials.token")} hint={t("sources.editor.credentials.hint")}>
              <Input type="password" autoComplete="new-password" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} />
            </Field>
          </>}
        </div>
        <div className="panel-f" style={{ display: "flex", justifyContent: "flex-end", gap: "var(--sp-2)" }}>
          <Button variant="ghost" disabled={!dirty || save.isPending} onClick={onClose}>{t("sources.editor.discard")}</Button>
          <Button variant="primary" disabled={!dirty || !valid || save.isPending} onClick={() => save.mutate()}>{save.isPending ? t("sources.editor.saving") : t("sources.editor.save")}</Button>
        </div>
      </List>
    </section>
  )
}
