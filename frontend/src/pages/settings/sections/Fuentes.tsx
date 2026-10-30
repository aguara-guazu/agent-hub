import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { Link, useNavigate } from "react-router-dom"
import { Avatar, Banner, Button, Chip, Dialog, Empty, ErrorState, Field, Input, List, MoreMenu, Row, Select, SkeletonRows, useToast } from "../../../components/ui"
import type { ChipTone, MenuItem } from "../../../components/ui"
import { useFormat, useT } from "../../../i18n"
import { api } from "../../../lib/api"
import { useMemory, useMemoryStatus } from "../../../lib/memory"
import { useMemoryBanner } from "../MemoryBanner"
import { SettingsSection, useErrorDetail } from "../SettingRow"
import { SourceEditor } from "../SourceEditor"
import { connectorInput, needsAuthorization, useMemoryAction, type Connector } from "../memory"

const PROVIDERS = ["google", "notion", "slack", "jira"] as const
type Provider = (typeof PROVIDERS)[number]

type ChipKey = "paused" | "requiresAuth" | "error" | "neverSynced" | "upToDate"

function chipOf(connector: Connector): [ChipKey, ChipTone] {
  if (!connector.enabled) return ["paused", "off"]
  if (needsAuthorization(connector)) return ["requiresAuth", "warn"]
  if (connector.last_error) return ["error", "danger"]
  if (!connector.last_success_at) return ["neverSynced", "off"]
  return ["upToDate", "ok"]
}

/** Fuentes: lista de conexiones de la memoria, alta en un diálogo corto y edición en línea debajo de la lista. */
export default function Fuentes() {
  const { t, plural } = useT("settings")
  const format = useFormat()
  const toast = useToast()
  const detail = useErrorDetail()
  const navigate = useNavigate()
  const status = useMemoryStatus()
  const ready = status.data?.ready === true
  const connectors = useMemory<Connector[]>("list_connectors", {}, ready)
  const [editing, setEditing] = useState<{ id: string; authorizing: boolean } | null>(null)
  const [creating, setCreating] = useState(false)

  const save = useMemoryAction<Connector>("save_connector", t("sources.toast.saveFailed"))
  const sync = useMemoryAction("sync_connector", t("sources.toast.syncFailed"), (_data, input) => {
    const source = connectors.data?.find(item => item.id === input.id)
    toast.show({ kind: "info", message: t("sources.toast.syncing", { name: source?.name ?? "" }), action: { label: t("page.viewActivity"), onClick: () => navigate("/activity?tab=procesamiento") } })
  })
  const repair = useMemoryAction("repair_google", t("sources.toast.repairFailed"), () => toast.info(t("sources.toast.repairQueued")))
  const oauth = useMutation({
    mutationFn: (id: string) => api.post<{ authorization_url: string }>(`/memory/connectors/${encodeURIComponent(id)}/google/start`),
    onSuccess: result => window.open(result.authorization_url, "_blank", "noopener,noreferrer"),
    onError: error => toast.error(t("sources.toast.authorizeFailed"), detail(error)),
  })

  const items = connectors.data ?? []
  const pendingAuth = items.filter(needsAuthorization)
  const googleClient = status.data?.google_client_configured === true

  function authorize(connector: Connector) {
    // Pedir el envío obliga a Google a mostrar su advertencia de cliente no verificado: se explica antes de abrirlo.
    if (connector.config?.gmail_send_enabled === true && connector.gmail_send_authorized !== true && !(editing?.id === connector.id && editing.authorizing)) {
      setEditing({ id: connector.id, authorizing: true })
      return
    }
    oauth.mutate(connector.id)
  }

  function setEnabled(connector: Connector, enabled: boolean) {
    save.mutate(connectorInput(connector, { enabled }), {
      onSuccess: () => toast.show({
        message: t(enabled ? "sources.toast.resumed" : "sources.toast.paused", { name: connector.name }),
        undo: () => save.mutate(connectorInput(connector, { enabled: !enabled })),
      }),
    })
  }

  const own = !ready ? null
    : pendingAuth.length > 0
      ? <Banner action={pendingAuth.length === 1 ? <Button small onClick={() => authorize(pendingAuth[0]!)}>{t("sources.authorize.action")}</Button> : undefined}>{plural("sources.banner.authNeeded", pendingAuth.length)}</Banner>
      : !googleClient && !items.some(item => item.provider === "google") && connectors.isSuccess
        ? <Banner tone="neutral" action={<Link className="btn btn-sm" to={{ search: "?section=integraciones" }}>{t("sources.banner.configureClient")}</Link>}>{t("sources.banner.googleClient")}</Banner>
        : null
  const banner = useMemoryBanner(own)

  function menu(connector: Connector): MenuItem[] {
    const google = connector.provider === "google"
    return [
      { label: t("sources.menu.configure"), onSelect: () => setEditing({ id: connector.id, authorizing: false }) },
      google
        ? { label: t("sources.authorize.action"), onSelect: () => authorize(connector), disabled: oauth.isPending }
        : { label: t("sources.menu.credentials"), onSelect: () => setEditing({ id: connector.id, authorizing: false }) },
      { label: t("sources.menu.syncNow"), onSelect: () => sync.mutate({ id: connector.id }), disabled: !connector.enabled || sync.isPending },
      ...(google ? [{ label: t("sources.menu.repair"), onSelect: () => repair.mutate({ id: connector.id }), disabled: !connector.enabled || repair.isPending }] : []),
      { label: t(connector.enabled ? "sources.menu.pause" : "sources.menu.resume"), onSelect: () => setEnabled(connector, !connector.enabled), disabled: save.isPending },
    ]
  }

  function sub(connector: Connector): string {
    const google = connector.provider === "google"
    const what = google
      ? connector.config?.gmail_enabled !== false ? t("sources.detail.googleGmail") : t("sources.detail.google")
      : t(`sources.detail.${connector.provider as Exclude<Provider, "google">}`)
    const when = connector.last_success_at
      ? t("sources.detail.lastSync", { when: format.relative(connector.last_success_at) })
      : t("sources.detail.interval", { minutes: connector.interval_minutes })
    return `${what} · ${when}`
  }

  const editingConnector = editing ? items.find(item => item.id === editing.id) : undefined

  return (
    <SettingsSection title={t("sections.fuentes")} action={<Button small disabled={!ready} onClick={() => setCreating(true)}>{t("sources.add")}</Button>}>
      {banner}
      {status.isPending || (ready && connectors.isPending)
        ? <SkeletonRows count={2} />
        : connectors.error
          ? <List><ErrorState error={connectors.error} onRetry={() => void connectors.refetch()} /></List>
          : !ready
            ? null
            : items.length === 0
              ? <List><Empty icon="sync" title={t("sources.empty.title")} detail={t("sources.empty.detail")} action={<Button small onClick={() => setCreating(true)}>{t("sources.add")}</Button>} /></List>
              : (
                <List>
                  {items.map(connector => {
                    const [chip, tone] = chipOf(connector)
                    const label = t(`sources.provider.${connector.provider as Provider}`, { defaultValue: connector.provider })
                    const title = connector.account_email ? `${connector.name} · ${connector.account_email}` : connector.name
                    return (
                      <Row
                        key={connector.id}
                        selected={editing?.id === connector.id}
                        lead={<Avatar name={label} text={label.slice(0, 1).toUpperCase()} />}
                        title={title}
                        sub={sub(connector)}
                        meta={<Chip tone={tone} title={chip === "error" ? connector.last_error ?? undefined : undefined}>{t(`sources.chip.${chip}`)}</Chip>}
                        action={<MoreMenu small ghost items={menu(connector)} />}
                      />
                    )
                  })}
                </List>
              )}
      {editingConnector && (
        <SourceEditor
          key={`${editingConnector.id}-${editing!.authorizing}`}
          connector={editingConnector}
          authorizing={editing!.authorizing}
          authorizePending={oauth.isPending}
          onAuthorize={() => oauth.mutate(editingConnector.id)}
          onClose={() => setEditing(null)}
        />
      )}
      <NewSourceDialog
        open={creating}
        googleClient={googleClient}
        onClose={() => setCreating(false)}
        onCreated={connector => { setCreating(false); if (connector?.id) setEditing({ id: connector.id, authorizing: false }) }}
      />
    </SettingsSection>
  )
}

/** Alta corta (2 campos). La fuente nueva queda pausada; el resto se completa en el editor en línea. */
function NewSourceDialog({ open, googleClient, onClose, onCreated }: { open: boolean; googleClient: boolean; onClose: () => void; onCreated: (connector: Connector | undefined) => void }) {
  const { t } = useT("settings")
  const toast = useToast()
  const [provider, setProvider] = useState<Provider>("google")
  const [name, setName] = useState("")
  const create = useMemoryAction<Connector>("save_connector", t("sources.toast.createFailed"), connector => {
    toast.success(t("sources.toast.created", { name: name.trim() }), t("sources.toast.createdDetail"))
    setName("")
    onCreated(connector)
  })
  const submit = () => {
    if (!name.trim() || create.isPending) return
    create.mutate({ provider, name: name.trim(), config: provider === "google" ? { gmail_send_enabled: true } : {}, project_ids: [], interval_minutes: 30, enabled: false })
  }
  return (
    <Dialog
      open={open}
      title={t("sources.new.title")}
      onClose={onClose}
      onSubmit={submit}
      busy={create.isPending}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={create.isPending}>{t("sources.new.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={!name.trim() || create.isPending}>{t("sources.new.create")}</Button>
      </>}
    >
      <Field label={t("sources.new.provider")} hint={provider === "google" && !googleClient ? t("sources.new.googleClientHint") : undefined}>
        <Select bare label={t("sources.new.provider")} value={provider} onChange={setProvider} options={PROVIDERS.map(value => ({ value, label: t(`sources.provider.${value}`) }))} />
      </Field>
      <Field label={t("sources.new.name")} hint={name.trim() ? undefined : t("sources.new.nameHint")}>
        <Input value={name} placeholder={t("sources.new.namePlaceholder")} onChange={event => setName(event.target.value)} />
      </Field>
    </Dialog>
  )
}
