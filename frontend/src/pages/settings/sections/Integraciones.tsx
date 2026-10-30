import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Avatar, Button, Chip, Field, Input, List, Select, SkeletonRows, useToast } from "../../../components/ui"
import { useT } from "../../../i18n"
import { api } from "../../../lib/api"
import { useJiraServer, useSaveJiraServer } from "../../../lib/automations"
import { useMemoryStatus } from "../../../lib/memory"
import { useJiraSettings } from "../../../lib/jira-settings"
import { GoogleClientRow } from "../GoogleClient"
import { useMemoryBanner } from "../MemoryBanner"
import { SettingRow, SettingsSection, useErrorDetail } from "../SettingRow"

const NONE = "none"
const JIRA_SETTINGS_KEY = ["memory", "jira-settings"] as const

/** `https://empresa.atlassian.net/` → `empresa.atlassian.net`; lo que no es URL se muestra tal cual. */
function host(url: string): string {
  try { return new URL(url).host || url } catch { return url }
}

/**
 * Integraciones: Jira (un solo lugar: sitio predeterminado de los proyectos y servidor con el que escribe el cierre
 * del día) y el cliente OAuth de Google. Las claves de proveedores de IA viven en IA y procesamiento.
 * Guardado automático: el sitio al salir del campo, el servidor al elegirlo. Los secretos nunca se leen de vuelta.
 */
export default function Integraciones() {
  const { t } = useT("settings")
  const status = useMemoryStatus()
  const banner = useMemoryBanner()
  const jiraSite = useJiraSettings()
  const jiraServer = useJiraServer()
  return (
    <SettingsSection title={t("sections.integraciones")}>
      {banner}
      {status.isPending || (jiraServer.isPending && !jiraServer.error) ? <SkeletonRows count={2} /> : (
        <List>
          <JiraRow
            site={status.data?.ready ? jiraSite.data?.default_site_url ?? null : null}
            siteReady={status.data?.ready === true && Boolean(jiraSite.data)}
            siteError={jiraSite.error}
            servers={jiraServer.data?.servers ?? []}
            selected={jiraServer.data?.selected ?? null}
            serverError={jiraServer.error}
          />
          <GoogleClientRow />
        </List>
      )}
    </SettingsSection>
  )
}

interface JiraRowProps {
  site: string | null
  siteReady: boolean
  siteError: unknown
  servers: { id: string; name: string; usable: boolean }[]
  selected: string | null
  serverError: unknown
}

function JiraRow({ site, siteReady, siteError, servers, selected, serverError }: JiraRowProps) {
  const { t } = useT("settings")
  const { t: tc } = useT("common")
  const toast = useToast()
  const detail = useErrorDetail()
  const cache = useQueryClient()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(site ?? "")
  useEffect(() => setDraft(site ?? ""), [site])
  const saveSite = useMutation({
    mutationFn: (value: string | null) => api.put<{ default_site_url: string | null }>("/memory/jira-settings", { default_site_url: value }),
    onSuccess: result => { cache.setQueryData(JIRA_SETTINGS_KEY, result); void cache.invalidateQueries({ queryKey: ["memory"] }) },
    onError: error => { setDraft(site ?? ""); toast.error(t("integrations.jira.siteFailed"), detail(error)) },
  })
  const saveServer = useSaveJiraServer()
  const usable = servers.filter(server => server.usable)
  const stale = selected !== null && !usable.some(server => server.id === selected)
  const selectedName = servers.find(server => server.id === selected)?.name ?? selected
  const options = [
    { value: NONE, label: t("integrations.jira.serverNone") },
    ...(stale ? [{ value: selected!, label: t("integrations.jira.serverUnavailable", { name: selectedName }) }] : []),
    ...usable.map(server => ({ value: server.id, label: server.name })),
  ]
  const serverHint = serverError ? t("integrations.jira.serverLoadFailed")
    : usable.length === 0 ? t("integrations.jira.noServers")
      : stale ? t("integrations.jira.serverStale") : t("integrations.jira.serverHint")
  const configured = Boolean(site) || selected !== null
  const summary = [
    site ? host(site) : t("integrations.jira.noSite"),
    selected === null ? t("integrations.jira.noServerSummary") : t("integrations.jira.viaServer", { name: selectedName }),
  ].join(" · ")
  function commitSite() {
    const value = draft.trim() || null
    if (!siteReady || value === site) return
    saveSite.mutate(value)
  }
  const chip = stale ? <Chip tone="warn">{t("integrations.jira.chip.review")}</Chip>
    : configured ? <Chip tone="ok">{t("integrations.jira.chip.configured")}</Chip>
      : <Chip tone="off">{t("integrations.jira.chip.missing")}</Chip>
  return <>
    <SettingRow lead={<Avatar name="Jira" text="J" small />} label={t("integrations.jira.label")} hint={summary}>
      {chip}
      <Button small aria-expanded={open} onClick={() => setOpen(!open)}>{t(configured ? "integrations.jira.change" : "integrations.jira.configure")}</Button>
    </SettingRow>
    {open && (
      <div
        style={{ padding: "var(--sp-4)", display: "flex", flexDirection: "column", gap: "var(--sp-4)", borderTop: "1px solid var(--border)" }}
        onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false) } }}
      >
        <Field
          id="settings-jira-site"
          label={t("integrations.jira.site")}
          hint={siteError ? t("integrations.jira.siteLoadFailed") : t("integrations.jira.siteHint")}
        >
          <Input
            type="url"
            mono
            autoFocus
            spellCheck={false}
            value={draft}
            placeholder={t("integrations.jira.sitePlaceholder")}
            disabled={!siteReady || saveSite.isPending}
            onChange={event => setDraft(event.target.value)}
            onBlur={commitSite}
            onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur() }}
          />
        </Field>
        <Field id="settings-jira-server" label={t("integrations.jira.server")} hint={serverHint}>
          <Select
            bare
            label={t("integrations.jira.server")}
            value={selected ?? NONE}
            options={options}
            disabled={Boolean(serverError) || saveServer.isPending}
            onChange={value => saveServer.mutate(value === NONE ? null : value)}
          />
        </Field>
        <span className="xs t3" role="status">{saveSite.isPending || saveServer.isPending ? tc("states.saving") : tc("states.autosave")}</span>
      </div>
    )}
  </>
}
