import { useState } from "react"
import {
  Avatar, Banner, Button, ConfirmDialog, Empty, ErrorState, Field, List, MoreMenu, Panel, PanelBody, PanelHeader, Row, Select, SkeletonRows, Textarea, useToast,
  type MenuItem,
} from "../../../components/ui"
import { useFormat, useT } from "../../../i18n"
import { useMemory, type MemoryEntity } from "../../../lib/memory"
import { useErrorText } from "../shared"
import { ROLES, isActive, mayInvite, useSharingAction, useSharingStatus, type Identity, type Member, type PeerProgress, type Role, type SharedDetail } from "./sharing"

type View = { kind: "members" } | { kind: "invite" } | { kind: "recovery"; phrase: string }

/**
 * Panel «Compartir» de la ficha (`?panel=share`): personas con acceso al proyecto compartido entre hubs, roles, vencimiento,
 * recepción de cambios e invitaciones. Invitar y la frase de recuperación reemplazan el contenido del mismo panel.
 */
export function SharePanel({ project, onClose }: { project: MemoryEntity; onClose: () => void }) {
  const { t } = useT("project")
  const toast = useToast()
  const errorText = useErrorText()
  const status = useSharingStatus()
  const shared = status.data?.projects.find(item => item.id === project.id)
  const detail = useMemory<SharedDetail>("shared_status", { project_id: project.id }, Boolean(shared))
  const create = useSharingAction<{ recovery_phrase?: string }>()
  const [view, setView] = useState<View>({ kind: "members" })
  const me = detail.data?.members.find(member => member.identity.id === status.data?.identity.id)
  const owner = me?.role === "owner" && !me.revoked
  const canInvite = mayInvite(me)
  const conflict = detail.data?.conflict ?? shared?.conflict ?? null
  const members = () => setView({ kind: "members" })

  function enable() {
    create.mutate({ operation: "create", project_id: project.id }, {
      onSuccess: result => {
        toast.success(t("collaboration.sharing.enabled"))
        if (result?.recovery_phrase) setView({ kind: "recovery", phrase: result.recovery_phrase })
      },
      onError: failure => toast.error(errorText(failure)),
    })
  }

  if (view.kind === "invite" && shared && canInvite) return <InvitePanel project={project} owner={owner} onClose={members} />
  if (view.kind === "recovery") return <RecoveryPanel phrase={view.phrase} onClose={members} />

  return (
    <Panel label={t("collaboration.sharing.title")} onClose={onClose}>
      <PanelHeader
        title={t("collaboration.sharing.title")}
        status={<span className="xs t3 trunc" title={project.title}>{project.title}</span>}
        actions={shared && canInvite ? <Button small onClick={() => setView({ kind: "invite" })}>{t("collaboration.sharing.invite")}</Button> : undefined}
      />
      <PanelBody>
        {conflict && <Banner tone="danger">{conflict}</Banner>}
        {status.isPending || (shared && detail.isPending) ? <SkeletonRows count={2} label={t("collaboration.sharing.loading")} />
          : status.error || detail.error ? <List><ErrorState error={status.error ?? detail.error} title={t("collaboration.sharing.errorTitle")} onRetry={() => { void status.refetch(); void detail.refetch() }} /></List>
          : !shared ? (
            <List>
              <Empty
                icon="collaboration"
                title={t("collaboration.sharing.emptyTitle")}
                detail={t("collaboration.sharing.emptyDetail")}
                action={<Button small icon="collaboration" disabled={create.isPending} onClick={enable}>{t("collaboration.sharing.enable")}</Button>}
              />
            </List>
          ) : (
            <List>
              {(detail.data?.members ?? []).map(member => (
                <MemberRow
                  key={member.identity.id}
                  project={project}
                  member={member}
                  self={member.identity.id === status.data?.identity.id}
                  selfName={status.data?.identity.name}
                  owner={owner}
                  progress={status.data?.network.peers?.find(peer => peer.project_id === project.id && peer.member_id === member.identity.id)}
                />
              ))}
            </List>
          )}
      </PanelBody>
    </Panel>
  )
}

function useRoleLabel() {
  const { t } = useT("project")
  return (role: Role) => t(`collaboration.sharing.role.${role}`)
}

function MemberRow({ project, member, self, selfName, owner, progress }: { project: MemoryEntity; member: Member; self: boolean; selfName?: string; owner: boolean; progress?: PeerProgress }) {
  const { t } = useT("project")
  const format = useFormat()
  const toast = useToast()
  const errorText = useErrorText()
  const roleLabel = useRoleLabel()
  const change = useSharingAction()
  const [revoking, setRevoking] = useState(false)
  const name = self ? selfName ?? member.identity.name : member.identity.name

  const access = member.revoked ? t("collaboration.sharing.revoked")
    : member.expires_at ? t(self ? "collaboration.sharing.accessUntil" : "collaboration.sharing.expires", { date: format.date(member.expires_at, "date") })
    : t("collaboration.sharing.noExpiry")
  const sync = !self && isActive(member) ? progressLabel(progress, t) : null

  function apply(next: { role: Role; invite: boolean; revoke?: boolean }, message: string, undo?: { role: Role; invite: boolean }) {
    change.mutate({ operation: "member", project_id: project.id, identity: member.identity, role: next.role, invite: next.role === "reader" ? false : next.invite, ...(next.revoke ? { revoke: true } : {}) }, {
      onSuccess: () => {
        setRevoking(false)
        toast.show({ kind: "success", message, ...(undo ? { undo: () => change.mutate({ operation: "member", project_id: project.id, identity: member.identity, role: undo.role, invite: undo.invite }, { onError: failure => toast.error(errorText(failure)) }) } : {}) })
      },
      onError: failure => toast.error(errorText(failure)),
    })
  }

  const previous = { role: member.role, invite: member.invite }
  const items: MenuItem[] = owner && !self ? [
    ...(member.revoked ? [] : ROLES.filter(role => role !== member.role).map(role => ({
      label: t(`collaboration.sharing.makeRole.${role}`),
      disabled: change.isPending,
      onSelect: () => apply({ role, invite: role === "reader" ? false : member.invite }, t("collaboration.sharing.roleChanged", { name, role: roleLabel(role) }), previous),
    }))),
    ...(!member.revoked && member.role !== "reader" ? [{
      label: t(member.invite ? "collaboration.sharing.denyInvite" : "collaboration.sharing.allowInvite"),
      disabled: change.isPending,
      onSelect: () => apply({ role: member.role, invite: !member.invite }, t(member.invite ? "collaboration.sharing.inviteDenied" : "collaboration.sharing.inviteAllowed", { name }), previous),
    }] : []),
    {
      label: t(member.revoked ? "collaboration.sharing.readmit" : "collaboration.sharing.renew"),
      disabled: change.isPending,
      onSelect: () => apply(previous, t(member.revoked ? "collaboration.sharing.readmitted" : "collaboration.sharing.renewed", { name })),
    },
    ...(!member.revoked ? [{ label: t("collaboration.sharing.revoke"), danger: true, disabled: change.isPending, onSelect: () => setRevoking(true) }] : []),
  ] : []

  return <>
    <Row
      lead={<Avatar name={name} small round />}
      title={self ? t("collaboration.sharing.you", { name }) : name}
      sub={sync ? `${access} · ${sync}` : access}
      meta={<span className="xs t3">{roleLabel(member.role)}</span>}
      action={items.length ? <MoreMenu small ghost items={items} label={t("collaboration.sharing.memberActions", { name })} /> : undefined}
    />
    <ConfirmDialog
      open={revoking}
      title={t("collaboration.sharing.revokeTitle", { name })}
      message={t("collaboration.sharing.revokeMessage")}
      confirmLabel={t("collaboration.sharing.revoke")}
      busy={change.isPending}
      onClose={() => setRevoking(false)}
      onConfirm={() => apply({ ...previous, revoke: true }, t("collaboration.sharing.revokedToast", { name }))}
    />
  </>
}

type Translate = ReturnType<typeof useT<"project">>["t"]

/** Recepción confirmada por el hub del participante; no mide el análisis de sus agentes. */
function progressLabel(progress: PeerProgress | undefined, t: Translate): string {
  if (!progress) return t("collaboration.sharing.sync.offline")
  if (progress.state === "waiting") return t("collaboration.sharing.sync.waiting")
  if (progress.state === "synced") return t("collaboration.sharing.sync.synced")
  const percent = progress.total ? Math.floor(progress.confirmed * 100 / progress.total) : 0
  return t("collaboration.sharing.sync.syncing", { percent, confirmed: progress.confirmed, total: progress.total })
}

/** Alta de un participante (técnica: identidad pública en JSON) · panel con creación explícita y la invitación resultante para copiar. */
function InvitePanel({ project, owner, onClose }: { project: MemoryEntity; owner: boolean; onClose: () => void }) {
  const { t } = useT("project")
  const common = useT("common").t
  const toast = useToast()
  const errorText = useErrorText()
  const roleLabel = useRoleLabel()
  const create = useSharingAction<unknown>()
  const [identity, setIdentity] = useState("")
  const [role, setRole] = useState<Role>("maintainer")
  const [canInvite, setCanInvite] = useState<"yes" | "no">("no")
  const [error, setError] = useState("")
  const [invitation, setInvitation] = useState("")
  const roles = ROLES.filter(value => owner || value !== "owner")
  const dirty = identity.trim() !== "" && !invitation

  function parseIdentity(): Identity | null {
    try {
      const value = JSON.parse(identity) as Identity
      return value && typeof value === "object" && typeof value.id === "string" ? value : null
    } catch { return null }
  }
  function submit() {
    const parsed = parseIdentity()
    if (!parsed) { setError(t("collaboration.invite.identityInvalid")); return }
    setError("")
    create.mutate({ operation: "member", project_id: project.id, identity: parsed, role, invite: owner && role !== "reader" && canInvite === "yes" }, {
      onSuccess: result => { setInvitation(JSON.stringify(result)); toast.success(t("collaboration.invite.created")) },
      onError: failure => setError(errorText(failure)),
    })
  }
  async function copy() {
    try { await navigator.clipboard.writeText(invitation); toast.success(common("toast.copied")) }
    catch { toast.error(t("collaboration.invite.copyFailed")) }
  }
  return (
    <Panel label={t("collaboration.invite.title")} onClose={onClose} dirty={dirty} onBlockedClose={() => setError(common("states.unsavedClose"))}>
        <PanelHeader title={t("collaboration.invite.title")} status={<span className="xs t3 trunc" title={project.title}>{project.title}</span>} />
        <PanelBody>
          {invitation ? (
            <Field label={t("collaboration.invite.result")} hint={t("collaboration.invite.resultHint")}>
              <Textarea mono rows={6} readOnly value={invitation} />
            </Field>
          ) : <>
            <Field label={t("collaboration.invite.identity")} hint={t("collaboration.invite.identityHint")} error={error || undefined}>
              <Textarea mono rows={4} value={identity} disabled={create.isPending} onChange={event => { setIdentity(event.target.value); setError("") }} />
            </Field>
            <Field label={t("collaboration.invite.role")}>
              <Select<Role> bare label={t("collaboration.invite.role")} value={role} disabled={create.isPending} onChange={setRole} options={roles.map(value => ({ value, label: roleLabel(value) }))} />
            </Field>
            {owner && role !== "reader" && (
              <Field label={t("collaboration.invite.canInvite")}>
                <Select<"yes" | "no"> bare label={t("collaboration.invite.canInvite")} value={canInvite} disabled={create.isPending} onChange={setCanInvite} options={[{ value: "no", label: t("collaboration.invite.no") }, { value: "yes", label: t("collaboration.invite.yes") }]} />
              </Field>
            )}
          </>}
        </PanelBody>
        <div className="panel-f">
          {invitation ? <>
            <Button variant="ghost" onClick={onClose}>{common("actions.close")}</Button>
            <Button onClick={() => void copy()}>{t("collaboration.invite.copy")}</Button>
          </> : <>
            <Button variant="ghost" disabled={create.isPending} onClick={() => { setIdentity(""); setError(""); onClose() }}>{common("actions.cancel")}</Button>
            <Button disabled={!identity.trim() || create.isPending} onClick={submit}>{t("collaboration.invite.submit")}</Button>
          </>}
        </div>
      </Panel>
  )
}

/** Las 24 palabras se muestran una sola vez al compartir; viven solo en el estado de este componente, nunca en la URL ni en la caché. */
function RecoveryPanel({ phrase, onClose }: { phrase: string; onClose: () => void }) {
  const { t } = useT("project")
  const common = useT("common").t
  const toast = useToast()
  async function copy() {
    try { await navigator.clipboard.writeText(phrase); toast.success(common("toast.copied")) }
    catch { toast.error(t("collaboration.invite.copyFailed")) }
  }
  return (
    <Panel label={t("collaboration.recovery.title")} onClose={onClose}>
        <PanelHeader title={t("collaboration.recovery.title")} />
        <PanelBody>
          <Field label={t("collaboration.recovery.phrase")} hint={t("collaboration.recovery.hint")}>
            <Textarea mono rows={4} readOnly value={phrase} />
          </Field>
        </PanelBody>
        <div className="panel-f">
          <Button variant="ghost" onClick={() => void copy()}>{t("collaboration.recovery.copy")}</Button>
          <Button onClick={onClose}>{t("collaboration.recovery.done")}</Button>
        </div>
      </Panel>
  )
}
