import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button, Dl, Field, Input, Panel, PanelBody, PanelFooter, PanelHeader, useToast } from "../../../components/ui"
import { useFormat, useT } from "../../../i18n"
import { api } from "../../../lib/api"
import type { MemoryEntity } from "../../../lib/memory"
import { useErrorText, useMemoryAction } from "../shared"
import { SidePanel } from "../work"

const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,19}$/

/** Misma consulta y clave de caché que Ajustes › Integraciones: el sitio predeterminado se lee, no se edita acá. */
function useJiraDefaultSite() {
  return useQuery({ queryKey: ["memory", "jira-settings"], queryFn: () => api.get<{ default_site_url: string | null }>("/memory/jira-settings") })
}

/** Clave y sitio de Jira del proyecto · guardado explícito con `expected_updated_at` para no pisar otro cambio. */
export function JiraPanel({ project, onClose }: { project: MemoryEntity; onClose: () => void }) {
  const { t } = useT("project")
  const common = useT("common").t
  const format = useFormat()
  const toast = useToast()
  const errorText = useErrorText()
  const settings = useJiraDefaultSite()
  const defaultSite = settings.data?.default_site_url ?? ""
  const [initial, setInitial] = useState(() => ({
    key: typeof project.data.jira_project_key === "string" ? project.data.jira_project_key : "",
    site: typeof project.data.jira_site_url === "string" ? project.data.jira_site_url : "",
  }))
  const [key, setKey] = useState(initial.key)
  const [site, setSite] = useState(initial.site)
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState("")
  const save = useMemoryAction<MemoryEntity>("update_entity", { quiet: true })
  const dirty = key !== initial.key || site !== initial.site
  const keyError = key && !KEY_PATTERN.test(key) ? t("tasks.jira.keyInvalid") : undefined
  const siteError = site.trim() && !/^https:\/\/\S+$/.test(site.trim()) ? t("tasks.jira.siteInvalid") : undefined
  const syncedAt = typeof project.data.jira_synced_at === "string" ? project.data.jira_synced_at : null

  function submit() {
    if (!dirty || keyError || siteError || save.isPending) return
    setError("")
    save.mutate({ id: project.id, expected_updated_at: project.updated_at, data: { jira_project_key: key.trim() || null, jira_site_url: site.trim() || null } }, {
      onSuccess: () => { setInitial({ key, site }); setBlocked(false); toast.success(common("states.saved")) },
      onError: failure => setError(errorText(failure)),
    })
  }
  return (
    <SidePanel>
      <Panel label={t("tasks.jira.title")} onClose={onClose} dirty={dirty} onBlockedClose={() => setBlocked(true)}>
        <PanelHeader title={t("tasks.jira.title")} status={<span className="xs t3 trunc" title={project.title}>{project.title}</span>} />
        <PanelBody>
          <Field label={t("tasks.jira.key")} hint={t("tasks.jira.keyHint")} error={keyError}>
            <Input mono value={key} maxLength={20} placeholder={t("tasks.jira.keyPlaceholder")} disabled={save.isPending} onChange={event => { setKey(event.target.value.toUpperCase()); setBlocked(false) }} />
          </Field>
          <Field
            label={t("tasks.jira.site")}
            hint={defaultSite ? t("tasks.jira.siteDefaultHint", { site: defaultSite }) : t("tasks.jira.siteHint")}
            error={siteError ?? (error || undefined)}
          >
            <Input mono type="url" value={site} placeholder={defaultSite || t("tasks.jira.sitePlaceholder")} disabled={save.isPending} onChange={event => { setSite(event.target.value); setBlocked(false) }} />
          </Field>
          {site && defaultSite && <Button small variant="ghost" style={{ alignSelf: "flex-start" }} onClick={() => setSite("")}>{t("tasks.jira.useDefault")}</Button>}
          <Dl items={[
            { label: t("tasks.jira.effectiveSite"), value: (site.trim() || defaultSite) ? <span className="mono trunc">{site.trim() || defaultSite}</span> : null },
            { label: t("tasks.jira.lastSync"), value: syncedAt ? format.date(syncedAt) : null },
          ]} />
        </PanelBody>
        <PanelFooter dirty={dirty} saving={save.isPending} warning={blocked} onSave={submit} onDiscard={() => { setKey(initial.key); setSite(initial.site); setError(""); setBlocked(false) }} />
      </Panel>
    </SidePanel>
  )
}
