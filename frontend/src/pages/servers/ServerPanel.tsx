import { useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Avatar, Button, Chip, Dl, Field, Input, MoreMenu, Panel, PanelBody, PanelFooter, PanelHeader, Select, Textarea, useToast } from "../../components/ui"
import type { ChipTone, MenuItem } from "../../components/ui"
import { useT } from "../../i18n/useT"
import type { LocalClient } from "../../lib/local"
import {
  STATUS_TONE, acceptToolChanges, buildPayload, draftOf, logoutOAuth, needsAuth, oauthRedirectUrl, probeServer, putRule,
  quarantinedCount, rowEnabled, sameDraft, saveOAuthClient, serverStatus, startOAuth, updateServer, useServersCache,
} from "../../lib/servers"
import type { ServerDraft } from "../../lib/servers"
import type { MatrixCell, MatrixRow, McpServer, ServerAuth, Transport } from "../../lib/types"
import { useFailDetail, useIssueText } from "./shared"

type Availability = "on" | "off" | "paused" | "restartPending" | "pendingSync" | "unknown"

const AVAILABILITY_TONE: Record<Availability, ChipTone> = { on: "ok", off: "off", paused: "off", restartPending: "warn", pendingSync: "info", unknown: "off" }

/** Lo que el cliente muestra de verdad, no solo lo que decidió el hub: un reinicio pendiente se ve como tal. */
function availabilityOf(cell: MatrixCell | undefined): Availability {
  if (!cell) return "unknown"
  if (cell.source === "client_disabled") return "paused"
  if (!cell.exposed) return "off"
  if (cell.propagation === "pending_restart" || cell.propagation === "applied_stale_list") return "restartPending"
  if (cell.propagation === "pending_sync") return "pendingSync"
  if (cell.propagation === "unknown") return "unknown"
  return "on"
}

/** Bloque de acción que va primero en el panel cuando el servidor necesita algo para funcionar. */
function ActionBlock({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <div className="card card-pad" style={{ background: "var(--surface-2)", display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
      <span>{children}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>{action}</div>
    </div>
  )
}

export interface ServerPanelProps {
  server: McpServer
  row: MatrixRow | undefined
  toolRows: ReadonlyMap<string, MatrixRow>
  clients: readonly LocalClient[]
  onClose: () => void
  onDelete: (server: McpServer) => void
  onDirtyChange: (dirty: boolean) => void
  /** Cambia cada vez que la vista impide cerrar el panel por cambios sin guardar. */
  blockedSignal: number
}

/** Guardado explícito: configuración técnica, herramientas expuestas y credenciales de cliente se aplican juntas con «Guardar cambios». */
export function ServerPanel({ server, row, toolRows, clients, onClose, onDelete, onDirtyChange, blockedSignal }: ServerPanelProps) {
  const { t, plural } = useT("servers")
  const status = useT("status").t
  const toast = useToast()
  const failDetail = useFailDetail()
  const issueText = useIssueText()
  const refresh = useServersCache()

  const base = useMemo(() => draftOf(server), [server])
  const [draft, setDraft] = useState<ServerDraft>(base)
  const [tools, setTools] = useState<Record<string, boolean>>({})
  const [ownClientOpen, setOwnClientOpen] = useState(false)
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<"probe" | "auth" | "accept" | "logout" | null>(null)
  const [warning, setWarning] = useState(false)

  const serverOn = rowEnabled(row)
  const toolExposed = (id: string, quarantined: boolean) => serverOn && !quarantined && rowEnabled(toolRows.get(id))
  const toolChanges = Object.entries(tools).filter(([id, value]) => {
    const tool = server.tools.find(item => item.id === id)
    return tool ? value !== toolExposed(id, tool.quarantined) : false
  })
  const configDirty = !sameDraft(draft, base)
  const clientDirty = draft.auth === "oauth" && clientId.trim() !== ""
  const dirty = configDirty || toolChanges.length > 0 || clientDirty
  const { payload, issues } = useMemo(() => buildPayload(draft, server), [draft, server])
  const shown = issues.filter(issue => touched.has(issue.field))

  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  useEffect(() => { if (blockedSignal > 0) setWarning(true) }, [blockedSignal])
  useEffect(() => { if (!dirty) setWarning(false) }, [dirty])

  const redirect = useQuery({ queryKey: ["oauth-settings"], queryFn: oauthRedirectUrl, enabled: ownClientOpen && draft.auth === "oauth" })

  const set = <K extends keyof ServerDraft>(key: K, value: ServerDraft[K]) => setDraft(current => ({ ...current, [key]: value }))
  const touch = (field: string) => () => setTouched(current => new Set(current).add(field))

  function discard() {
    setDraft(base)
    setTools({})
    setClientId("")
    setClientSecret("")
    setOwnClientOpen(false)
    setTouched(new Set())
  }

  async function save() {
    if (configDirty && !payload) {
      setTouched(new Set(issues.map(issue => issue.field)))
      return
    }
    setSaving(true)
    try {
      let saved = server
      if (configDirty && payload) saved = await updateServer(server.id, payload)
      if (clientDirty) saved = await saveOAuthClient(server.id, clientId, clientSecret)
      for (const [id, value] of toolChanges) await putRule({ type: "mcp_tool", id, state: value ? "on" : "off" })
      setDraft(draftOf(saved))
      setTools({})
      setClientId("")
      setClientSecret("")
      setOwnClientOpen(false)
      setTouched(new Set())
      if (configDirty) {
        const probed = await probeServer(server.id).catch(() => null)
        if (probed && !probed.last_probe_error) toast.success(t("toast.saved"), plural("toast.toolsReady", probed.tools.length))
        else toast.error(t("toast.notConnected", { name: saved.display_name }), probed?.last_probe_error)
      } else {
        toast.success(t("toast.saved"))
      }
    } catch (error) {
      toast.error(t("toast.saveFailed"), failDetail(error))
    } finally {
      setSaving(false)
      await refresh()
    }
  }

  async function run(kind: NonNullable<typeof busy>, action: () => Promise<void>) {
    setBusy(kind)
    try { await action() } catch (error) { toast.error(t("toast.actionFailed"), failDetail(error)) } finally {
      setBusy(null)
      await refresh()
    }
  }

  const probe = () => run("probe", async () => {
    const result = await probeServer(server.id)
    if (result.last_probe_error) toast.error(t("toast.probeFailed", { name: server.display_name }), result.last_probe_error)
    else toast.success(plural("toast.probeOk", result.tools.length))
  })
  const authorize = () => run("auth", async () => {
    const result = await startOAuth(server.id)
    if (result.authorization_url) {
      // En Electron abre el navegador del sistema; en un navegador, una pestaña nueva.
      window.open(result.authorization_url, "_blank", "noopener")
      toast.info(t("toast.authBrowser"), t("toast.authBrowserDetail"))
    } else toast.success(t("toast.authorized"))
  })
  const accept = () => run("accept", async () => {
    await acceptToolChanges(server.id)
    toast.success(t("toast.accepted", { name: server.display_name }))
  })
  const logout = () => run("logout", async () => {
    await logoutOAuth(server.id)
    toast.success(t("toast.disconnected", { name: server.display_name }))
  })

  const state = serverStatus(server, row)
  const changed = quarantinedCount(server)
  const authorized = server.auth === "oauth" && server.oauth_status === "authorized"
  const menu: MenuItem[] = [
    { label: t("actions.probe"), icon: "sync", onSelect: () => void probe(), disabled: busy !== null },
    ...(authorized ? [{ label: t("actions.disconnect"), onSelect: () => void logout(), disabled: busy !== null }] : []),
    { label: t("actions.delete"), danger: true, onSelect: () => onDelete(server), disabled: saving },
  ]
  const stdio = draft.transport === "stdio"
  const primaryUsed = needsAuth(server)

  return (
    <Panel label={server.display_name} onClose={onClose} dirty={dirty} onBlockedClose={() => setWarning(true)}>
      <PanelHeader
        lead={<Avatar name={server.display_name} />}
        title={server.display_name}
        status={<Chip tone={STATUS_TONE[state]}>{t(`status.${state}`)}</Chip>}
        actions={<MoreMenu items={menu} label={t("actions.more")} small ghost />}
      />
      <PanelBody>
        {needsAuth(server) && (
          <ActionBlock action={<Button variant="primary" disabled={busy !== null} onClick={() => void authorize()}>{busy === "auth" ? t("panel.authOpening") : t("actions.authorize")}</Button>}>
            {t("panel.authBlock", { name: server.display_name })}
          </ActionBlock>
        )}
        {changed > 0 && (
          <ActionBlock action={<Button variant={primaryUsed ? "default" : "primary"} disabled={busy !== null} onClick={() => void accept()}>{t("actions.acceptChanges")}</Button>}>
            {plural("panel.changedBlock", changed)}
          </ActionBlock>
        )}
        {state === "error" && (
          <ActionBlock action={<Button disabled={busy !== null} onClick={() => void probe()}>{busy === "probe" ? t("panel.probing") : t("actions.probe")}</Button>}>
            <span className="clamp2" title={server.last_probe_error}>{server.last_probe_error}</span>
            <span className="xs t3" style={{ display: "block", marginTop: "var(--sp-1)" }}>{t("panel.errorBlock")}</span>
          </ActionBlock>
        )}

        <Field label={t("panel.fields.name")} error={issueText(shown, "displayName")}>
          <Input value={draft.displayName} onChange={event => set("displayName", event.target.value)} onBlur={touch("displayName")} />
        </Field>
        <Field label={t("panel.fields.description")}>
          <Textarea rows={2} value={draft.description} onChange={event => set("description", event.target.value)} />
        </Field>
        <Field label={t("panel.fields.transport")}>
          <Select<Transport>
            bare
            label={t("panel.fields.transport")}
            value={draft.transport}
            options={[{ value: "http", label: status("transport.http") }, { value: "stdio", label: status("transport.stdio") }]}
            onChange={value => set("transport", value)}
          />
        </Field>
        {stdio ? <>
          <Field label={t("panel.fields.command")} error={issueText(shown, "command")}>
            <Input mono value={draft.command} onChange={event => set("command", event.target.value)} onBlur={touch("command")} />
          </Field>
          <Field label={t("panel.fields.args")} hint={t("panel.fields.argsHint")}>
            <Textarea mono rows={3} value={draft.args} spellCheck={false} onChange={event => set("args", event.target.value)} />
          </Field>
          <Field label={t("panel.fields.cwd")}>
            <Input mono value={draft.cwd} onChange={event => set("cwd", event.target.value)} />
          </Field>
        </> : <>
          <Field label={t("panel.fields.url")} error={issueText(shown, "url")}>
            <Input mono value={draft.url} onChange={event => set("url", event.target.value)} onBlur={touch("url")} />
          </Field>
          <Field label={t("panel.fields.auth")}>
            <Select<ServerAuth>
              bare
              label={t("panel.fields.auth")}
              value={draft.auth}
              options={[{ value: "none", label: t("panel.fields.authNone") }, { value: "oauth", label: t("panel.fields.authOauth") }]}
              onChange={value => set("auth", value)}
            />
          </Field>
        </>}
        <Dl items={[
          { label: t("panel.fields.slug"), value: <span className="mono t2">{server.slug}</span> },
          { label: t("panel.fields.definition"), value: server.definition_hash ? <span className="mono t2" title={server.definition_hash}>{server.definition_hash.slice(0, 12)}</span> : null },
        ]} />

        <details style={{ borderTop: "1px solid var(--border)", paddingTop: "var(--sp-3)" }}>
          <summary style={{ cursor: "pointer", color: "var(--text-2)", fontWeight: 500 }}>{t("panel.fields.advanced")}</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)", paddingTop: "var(--sp-3)" }}>
            {stdio
              ? <Field label={t("panel.fields.env")} hint={t("panel.fields.envHint")} error={issueText(shown, "env")}>
                <Textarea mono rows={3} value={draft.env} spellCheck={false} onChange={event => set("env", event.target.value)} onBlur={touch("env")} />
              </Field>
              : <Field label={t("panel.fields.headers")} hint={t("panel.fields.headersHint")} error={issueText(shown, "headers")}>
                <Textarea mono rows={3} value={draft.headers} spellCheck={false} onChange={event => set("headers", event.target.value)} onBlur={touch("headers")} />
              </Field>}
            <Field label={t("panel.fields.secretRefs")} hint={t("panel.fields.secretRefsHint")} error={issueText(shown, "secretRefs")}>
              <Textarea mono rows={3} value={draft.secretRefs} spellCheck={false} onChange={event => set("secretRefs", event.target.value)} onBlur={touch("secretRefs")} />
            </Field>
            {draft.auth === "oauth" && !stdio && <>
              <label style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
                <input type="checkbox" checked={ownClientOpen} style={{ accentColor: "var(--accent)" }} onChange={event => setOwnClientOpen(event.target.checked)} />
                {server.oauth_client_configured ? t("panel.fields.ownClientConfigured") : t("panel.fields.ownClient")}
              </label>
              {ownClientOpen && <>
                {redirect.data && <Field label={t("panel.fields.redirect")}><Input mono readOnly value={redirect.data.redirect_url} /></Field>}
                <Field label={t("panel.fields.clientId")}>
                  <Input mono autoComplete="off" value={clientId} onChange={event => setClientId(event.target.value)} />
                </Field>
                <Field label={t("panel.fields.clientSecret")} hint={t("panel.fields.clientSecretHint")}>
                  <Input mono type="password" autoComplete="off" value={clientSecret} onChange={event => setClientSecret(event.target.value)} />
                </Field>
              </>}
            </>}
          </div>
        </details>

        <section className="section">
          <div className="section-h"><h3 className="h3">{t("panel.sections.tools")}</h3><span className="xs t3 num">{server.tools.length}</span></div>
          {server.tools.length === 0
            ? <span className="xs t3">{t("panel.tools.empty")}</span>
            : <>
              {!serverOn && <span className="xs t3">{t("panel.tools.serverOff")}</span>}
              <div className="list">
                {server.tools.map(tool => {
                  const checked = tools[tool.id] ?? toolExposed(tool.id, tool.quarantined)
                  const detail = tool.quarantined ? tool.quarantine_reason : tool.description || t("panel.tools.noDescription")
                  return (
                    <label className="row" key={tool.id} style={{ cursor: serverOn && !tool.quarantined ? "pointer" : undefined }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!serverOn || tool.quarantined || saving}
                        aria-label={t("panel.tools.expose", { name: tool.name })}
                        style={{ accentColor: "var(--accent)" }}
                        onChange={event => setTools(current => ({ ...current, [tool.id]: event.target.checked }))}
                      />
                      <div className="row-main">
                        <span className="row-title mono" title={tool.exposed_name}>{tool.name}</span>
                        <span className="row-sub" title={detail}>{detail}</span>
                      </div>
                      {tool.quarantined && <Chip tone="warn">{t("panel.tools.changed")}</Chip>}
                    </label>
                  )
                })}
              </div>
            </>}
        </section>

        {clients.length > 0 && (
          <section className="section">
            <div className="section-h"><h3 className="h3">{t("panel.sections.clients")}</h3></div>
            <Dl items={clients.map(client => {
              const availability = availabilityOf(row?.cells[client.id])
              const repeated = clients.filter(other => other.cli_kind === client.cli_kind).length > 1
              const name = status(`client.${client.cli_kind}`)
              return { label: repeated ? `${name} · ${client.machine_hostname}` : name, value: <Chip tone={AVAILABILITY_TONE[availability]}>{t(`availability.${availability}`)}</Chip> }
            })} />
          </section>
        )}
      </PanelBody>
      <PanelFooter dirty={dirty} saving={saving} warning={warning} onSave={() => void save()} onDiscard={discard} />
    </Panel>
  )
}
