import { useMutation } from "@tanstack/react-query"
import { Avatar, Button, Dl, MoreMenu, Panel, PanelBody, PanelHeader, useToast } from "../../components/ui"
import type { MenuItem } from "../../components/ui"
import { shortHash } from "../../components/DataTable"
import { useFormat, useT } from "../../i18n"
import type { LocalClient } from "../../lib/local"
import { CLI_FILE_SKILLS } from "../../lib/types"
import type { Machine } from "../../lib/types"
import { useCopy } from "./EnrollDialog"
import { UsageSection } from "./UsageSection"
import { ClientChip, shortenPath } from "./state"

function pendingCount(client: LocalClient): number | null {
  const pending = client.pending
  if (!pending) return null
  const { skills, servers } = pending
  return skills.added.length + skills.removed.length + skills.changed.length + servers.added.length + servers.removed.length
}

export function ClientPanel({ client, machine, showPerson, onClose, onRevoke }: { client: LocalClient; machine?: Machine; showPerson: boolean; onClose: () => void; onRevoke: (machine: Machine) => void }) {
  const { t, plural } = useT("clients")
  const status = useT("status").t
  const format = useFormat()
  const toast = useToast()
  const copy = useCopy()
  const name = status(`client.${client.cli_kind}`)
  const desktop = client.cli_kind === "claude_desktop"
  const canRestart = desktop && Boolean(window.agentHub)
  const restart = useMutation({
    mutationFn: () => window.agentHub!.restartClient(client.cli_kind),
    onSuccess: result => result.ok ? toast.success(t("toast.restarted", { client: name })) : toast.error(t("toast.restartFailed", { client: name }), result.detail),
    onError: error => toast.error(t("toast.restartFailed", { client: name }), error instanceof Error ? error.message : undefined),
  })
  const count = pendingCount(client)
  const restartText = count === null || count === 0
    ? (canRestart ? t("panel.restartUnknownDesktop") : t("panel.restartUnknown", { client: name }))
    : canRestart ? plural("panel.restartDesktop", count) : plural("panel.restartManual", count, { client: name })
  const fileSkills = CLI_FILE_SKILLS[client.cli_kind]
  const menu: MenuItem[] = [
    { label: t("actions.copyPath"), onSelect: () => void copy(client.config_path), disabled: !client.config_path },
    ...(machine ? [{ label: t("actions.revoke"), danger: true, onSelect: () => onRevoke(machine) }] : []),
  ]

  return (
    <Panel label={name} onClose={onClose}>
      <PanelHeader lead={<Avatar name={name} />} title={name} status={<ClientChip client={client} />} actions={<MoreMenu items={menu} small ghost />} />
      <PanelBody>
        {client.restart_pending && client.enabled && (
          <div className="card" style={{ padding: "var(--sp-3)", display: "flex", flexDirection: "column", gap: "var(--sp-2)", background: "var(--surface-2)" }}>
            <span>{restartText}</span>
            {canRestart && <Button variant="primary" style={{ alignSelf: "flex-start" }} disabled={restart.isPending} onClick={() => restart.mutate()}>{t("actions.restart", { client: name })}</Button>}
          </div>
        )}
        {client.drift_detected && (
          <div className="card" style={{ padding: "var(--sp-3)", display: "flex", flexDirection: "column", gap: "var(--sp-2)", background: "var(--surface-2)" }}>
            <span>{t("panel.drift")}</span>
            {client.drift_detail && <pre className="mono xs t2" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{client.drift_detail}</pre>}
          </div>
        )}
        <Dl items={[
          { label: t("panel.file"), value: client.config_path ? <span className="mono trunc" title={client.config_path}>{shortenPath(client.config_path)}</span> : null },
          { label: t("panel.servers"), value: format.number(client.server_count) },
          { label: t("panel.skills"), value: fileSkills ? format.number(client.skill_count) : t("panel.skillsViaTool", { count: client.skill_count }) },
          { label: t("panel.version"), value: client.cli_version ? <span className="mono">{client.cli_version}</span> : null },
          { label: t("panel.reload"), value: client.hot_reload ? t("panel.reloadLive") : t("panel.reloadRestart") },
          { label: t("panel.lastConnection"), value: client.last_connected_at ? format.date(client.last_connected_at) : t("panel.never") },
          { label: t("panel.lastSync"), value: client.synced_at ? format.date(client.synced_at) : null },
        ]} />
        <hr className="divider" />
        <UsageSection client={client} />
        <hr className="divider" />
        <Dl items={[
          { label: t("panel.computer"), value: <span className="trunc" title={client.machine_hostname}>{client.machine_hostname}</span> },
          ...(showPerson && machine ? [{ label: t("panel.person"), value: machine.user_email }] : []),
          { label: t("enroll.os"), value: machine?.os },
          { label: t("enroll.daemon"), value: machine?.daemon_version ? <span className="mono">{machine.daemon_version}</span> : null },
          { label: t("panel.lastSeen"), value: machine?.last_seen_at ? format.date(machine.last_seen_at) : null },
          { label: t("panel.snapshot"), value: machine?.last_snapshot_hash ? <span className="mono" title={machine.last_snapshot_hash}>{shortHash(machine.last_snapshot_hash)}</span> : null },
        ]} />
      </PanelBody>
    </Panel>
  )
}
