import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Avatar, Button, ConfirmDialog, Empty, EmptyFiltered, ErrorState, List, MoreMenu, Row, Select, SkeletonRows, Switch, useToast } from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import { api } from "../../lib/api"
import { useAuth } from "../../lib/auth"
import { LOCAL_KEY, useOverview } from "../../lib/local"
import type { LocalClient } from "../../lib/local"
import { invalidateAfterMachineChange, useMachines } from "../../lib/queries"
import { CLI_LABELS } from "../../lib/types"
import type { CliKind, Machine } from "../../lib/types"
import { ClientPanel } from "./ClientPanel"
import { EnrollDialog } from "./EnrollDialog"
import { ClientChip } from "./state"

const ALL = "all"

/** Clientes · plantilla A con panel. Sin primario: los clientes se detectan solos. */
export default function ClientsPage() {
  const { t, plural } = useT("clients")
  const nav = useT("nav").t
  const common = useT("common").t
  const status = useT("status").t
  const format = useFormat()
  const { isAdmin } = useAuth()
  const overview = useOverview()
  const machines = useMachines()
  const toast = useToast()
  const cache = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [computer, setComputer] = useState<string>(ALL)
  const [enrollOpen, setEnrollOpen] = useState(false)
  const [revoking, setRevoking] = useState<Machine | null>(null)

  const clients = overview.data?.clients ?? []
  const hosts = [...new Set(clients.map(client => client.machine_hostname))].sort()
  const visible = computer === ALL ? clients : clients.filter(client => client.machine_hostname === computer)
  const selected = clients.find(client => client.id === selectedId)
  const machineOf = (client: LocalClient) => machines.data?.find(machine => machine.id === client.machine_id)
  const missing = (Object.keys(CLI_LABELS) as CliKind[]).filter(kind => !clients.some(client => client.cli_kind === kind))

  const pause = useMutation({
    mutationFn: ({ client, enabled }: { client: LocalClient; enabled: boolean }) => api.patch(`/machines/agents/${client.id}`, { enabled }),
    onSuccess: () => cache.invalidateQueries({ queryKey: LOCAL_KEY }),
    onError: (error, { client }) => toast.error(t("toast.pauseFailed", { client: status(`client.${client.cli_kind}`) }), error.message),
  })
  function setEnabled(client: LocalClient, enabled: boolean) {
    const name = status(`client.${client.cli_kind}`)
    pause.mutate({ client, enabled }, {
      onSuccess: () => toast.show({
        message: common(enabled ? "toast.resumed" : "toast.paused", { name }),
        undo: () => pause.mutate({ client, enabled: !enabled }),
      }),
    })
  }

  const scan = useMutation({
    mutationFn: async () => {
      if (window.agentHub) await window.agentHub.syncNow()
      await Promise.all([overview.refetch(), machines.refetch()])
    },
    onError: error => toast.error(t("toast.scanFailed"), error.message),
  })

  const revoke = useMutation({
    mutationFn: (machine: Machine) => api.delete(`/machines/${machine.id}`),
    onSuccess: async (_data, machine) => {
      setRevoking(null)
      setSelectedId(null)
      await Promise.all([invalidateAfterMachineChange(cache), cache.invalidateQueries({ queryKey: LOCAL_KEY })])
      toast.success(t("toast.revoked", { host: machine.hostname }))
    },
    onError: (error, machine) => toast.error(t("toast.revokeFailed", { host: machine.hostname }), error.message),
  })

  function detail(client: LocalClient): string {
    if (!client.enabled) return t("row.paused")
    const servers = plural("row.servers", client.server_count)
    const skills = plural("row.skills", client.skill_count)
    return client.last_connected_at
      ? t("row.detail", { servers, skills, when: format.relative(client.last_connected_at) })
      : t("row.neverConnected", { servers, skills })
  }

  return (
    <div className="split">
      <div className="page">
        <div className="ph">
          <div className="ph-text"><h1 className="h1">{nav("clients")}</h1></div>
          <div className="ph-actions">
            <Button icon="sync" disabled={scan.isPending} onClick={() => scan.mutate()}>{t("actions.scan")}</Button>
            <MoreMenu items={[{ label: t("actions.addComputer"), onSelect: () => setEnrollOpen(true) }]} />
          </div>
        </div>

        {hosts.length > 1 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }}>
            <Select label={t("filter.computer")} value={computer} onChange={setComputer}
              options={[{ value: ALL, label: t("filter.all") }, ...hosts.map(host => ({ value: host, label: host }))]} />
          </div>
        )}

        {overview.isPending ? <SkeletonRows label={common("states.loading")} />
          : overview.error ? <List><ErrorState error={overview.error} title={t("error.title")} onRetry={() => void overview.refetch()} /></List>
            : clients.length === 0 ? (
              <List><Empty icon="clients" title={t("empty.title")} detail={t("empty.detail")}
                action={<Button small disabled={scan.isPending} onClick={() => scan.mutate()}>{t("actions.scan")}</Button>} /></List>
            ) : visible.length === 0 ? (
              <List><EmptyFiltered text={t("empty.filtered")} onClear={() => setComputer(ALL)} /></List>
            ) : (
              <List>
                {visible.map(client => {
                  const name = status(`client.${client.cli_kind}`)
                  return (
                    <Row
                      key={client.id}
                      selected={client.id === selectedId}
                      onOpen={() => setSelectedId(client.id)}
                      lead={<Avatar name={name} />}
                      title={name}
                      sub={detail(client)}
                      meta={<ClientChip client={client} />}
                      action={<Switch checked={client.enabled} disabled={pause.isPending} label={t("row.toggle", { client: name })} onChange={value => setEnabled(client, value)} />}
                    />
                  )
                })}
              </List>
            )}

        {!overview.isPending && !overview.error && missing.length > 0 && (
          <section className="section">
            <div className="section-h"><h2 className="h3 t2">{t("compatible.title")}</h2></div>
            <List>
              {missing.map(kind => {
                const name = status(`client.${kind}`)
                return (
                  <div className="row" key={kind} style={{ minHeight: 46 }}>
                    <Avatar name={name} small />
                    <div className="row-main"><span className="trunc" style={{ fontWeight: 500 }}>{name}</span></div>
                    <span className="xs t3">{t("compatible.missing")}</span>
                  </div>
                )
              })}
            </List>
          </section>
        )}
      </div>

      {selected && (
        <ClientPanel key={selected.id} client={selected} machine={machineOf(selected)} showPerson={isAdmin} onClose={() => setSelectedId(null)} onRevoke={setRevoking} />
      )}

      <EnrollDialog open={enrollOpen} onClose={() => setEnrollOpen(false)} />
      <ConfirmDialog
        open={revoking !== null}
        title={t("revoke.title", { host: revoking?.hostname ?? "" })}
        message={t("revoke.message")}
        confirmLabel={t("actions.revoke")}
        busy={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking)}
        onClose={() => setRevoking(null)}
      />
    </div>
  )
}
