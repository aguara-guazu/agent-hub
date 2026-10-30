import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Avatar, Chip, ConfirmDialog, Dl, Empty, ErrorState, Field, Input, List, MoreMenu, Panel, PanelBody, PanelHeader, Row, SkeletonRows,
  absoluteTime, describeError, type ChipTone, type MenuItem,
} from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"
import { useMemory, type Page } from "../../lib/memory"
import { AGENT_PAGE, AGENT_TONE, Pager, SCOPE, agentState, capabilityKey, useCliLabel, visibleAgents, TRUNC } from "./shared"
import type { Channel, Participant } from "./types"

// Motivos que el Hub guarda en el historial; son datos de la API, no texto de la interfaz.
const KICK_REASON = "Expulsado por la persona desde la UI"
export const DELETE_REASON = "Eliminado por la persona desde la UI"

export type ChannelKind = "closed" | "readOnly" | "task" | "orca" | "branch" | "detached"
export const CHANNEL_TONE: Record<ChannelKind, ChipTone> = { closed: "off", readOnly: "locked", task: "ok", orca: "ok", branch: "ok", detached: "ok" }

export function channelKind(channel: Channel): ChannelKind {
  if (channel.closed_at) return "closed"
  if (channel.read_only) return "readOnly"
  if (channel.kind === "virtual") return "task"
  if (channel.orca_workspace_id) return "orca"
  return channel.branch ? "branch" : "detached"
}

type Uncertain = { uncertain_members?: string[] }

export interface ChannelPanelProps {
  channel: Channel
  /** Alcance de chat_agents y de la expulsión: canal del proyecto (`project_id`) o sin proyecto. */
  projectId?: string
  agentOffset: number
  onAgentOffset: (offset: number) => void
  onThreads: (channelId: string, agentId?: string) => void
  onThread: (threadId: string, channelId?: string) => void
  onPlan: (planId: string) => void
  onChannel: (channelId: string) => void
  onInspect: (agent: Participant) => void
  onDesignated: (uncertain: boolean) => void
  onClose: () => void
}

function ErrorDetail({ error }: { error: Error | null }) {
  if (!error) return null
  return (
    <div role="alert" style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
      <span className="xs" style={{ color: "var(--danger)" }}>{describeError(error)}</span>
      {error.message && <span className="xs t3" style={{ overflowWrap: "anywhere" }}>{error.message}</span>}
    </div>
  )
}

/** Eliminar un canal a la papelera: corta el acceso de sus sesiones y detiene sus trabajadores; se restaura desde la papelera. */
export function DeleteChannelDialog({ channel, open, onClose, onDeleted }: { channel: Channel; open: boolean; onClose: () => void; onDeleted: (channel: Channel, uncertain: boolean) => void }) {
  const { t } = useT("collaboration")
  const cache = useQueryClient()
  const remove = useMutation({
    mutationFn: (channel_id: string) => api.post<Uncertain>("/memory/chat/channels/delete", { channel_id, reason: DELETE_REASON }),
    onSuccess: result => {
      void cache.invalidateQueries({ queryKey: ["memory"] })
      onDeleted(channel, Boolean(result?.uncertain_members?.length))
    },
  })
  return (
    <ConfirmDialog
      open={open}
      title={t("confirm.deleteTitle", { name: channel.name })}
      confirmLabel={remove.isPending ? t("confirm.deleting") : t("confirm.deleteAction")}
      busy={remove.isPending}
      onClose={() => { remove.reset(); onClose() }}
      onConfirm={() => remove.mutate(channel.id)}
      message={<div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
        <p className="t2" style={{ margin: 0 }}>{t("confirm.deleteBody")}</p>
        <p className="t2" style={{ margin: 0 }}>{t("confirm.deleteKeeps")}</p>
        <ErrorDetail error={remove.error} />
      </div>}
    />
  )
}

/** Canal: datos, agentes y acciones de administración (expulsar, designar coordinador). */
export function ChannelPanel(props: ChannelPanelProps) {
  const { channel, projectId, agentOffset, onAgentOffset, onThreads, onThread, onPlan, onChannel, onInspect, onDesignated, onClose } = props
  const { t, plural } = useT("collaboration")
  const cliLabel = useCliLabel()
  const cache = useQueryClient()
  const [removing, setRemoving] = useState<Participant | null>(null)
  const [reason, setReason] = useState("")
  const [coordinating, setCoordinating] = useState<Participant | null>(null)
  const scope = projectId ? { project_id: projectId } : SCOPE

  const agents = useMemory<Page<Participant>>("chat_agents", { ...scope, include_team_history: true, channel_id: channel.id, limit: AGENT_PAGE, offset: agentOffset })
  const refresh = () => void cache.invalidateQueries({ queryKey: ["memory"] })

  const kick = useMutation({
    mutationFn: (input: { channel_id: string; participant_id: string; reason: string }) => api.post("/memory/chat/kick", projectId ? { ...input, project_id: projectId } : input),
    onSuccess: () => { setRemoving(null); setReason(""); onAgentOffset(0); refresh() },
  })
  const designate = useMutation({
    mutationFn: (input: { channel_id: string; participant_id: string; expected_leader_id: string | null }) => api.post<Uncertain>("/memory/chat/coordinator", input),
    onSuccess: result => { setCoordinating(null); refresh(); onDesignated(Boolean(result?.uncertain_members?.length)) },
  })

  const kind = channelKind(channel)
  const visible = visibleAgents(agents.data?.items)
  const leader = visible.find(agent => agent.id === channel.leader_id)

  const menu: MenuItem[] = [{ label: t("actions.channelThreads"), onSelect: () => onThreads(channel.id) }]
  if (channel.team_plan_id) menu.push({ label: t("actions.viewTeam"), onSelect: () => onPlan(channel.team_plan_id!) })
  if (channel.parent_channel_id) menu.push({ label: t("actions.parentChannel"), onSelect: () => onChannel(channel.parent_channel_id!) })

  function agentMenu(agent: Participant): MenuItem[] {
    const items: MenuItem[] = [
      { label: t("actions.viewActivity"), onSelect: () => onInspect(agent) },
      { label: t("actions.agentThreads"), onSelect: () => onThreads(agent.master_channel_id ?? agent.channel_id, agent.id) },
    ]
    if (agent.work_thread_id) items.push({ label: t("actions.viewConversation"), onSelect: () => onThread(agent.work_thread_id!, agent.master_channel_id ?? agent.channel_id) })
    if (!agent.closed_at && !agent.team_id && agent.role !== "leader" && agent.connection_state === "online" && channel.id === agent.channel_id) {
      items.push({ label: t("actions.designate"), onSelect: () => { designate.reset(); setCoordinating(agent) } })
    }
    if (!agent.team_id) items.push({ label: t("actions.kick"), danger: true, onSelect: () => { kick.reset(); setReason(""); setRemoving(agent) } })
    return items
  }

  function agentTooltip(agent: Participant): string {
    return [
      agent.label,
      capabilityKey(agent.capability) ? t(`capability.${capabilityKey(agent.capability)!}`) : agent.capability,
      t("agent.lastSeen", { date: absoluteTime(agent.last_seen_at) }),
      agent.state_observed_at ? t("agent.lastObserved", { date: absoluteTime(agent.state_observed_at) }) : null,
      agent.state_reason === "activity_stale" ? t("agent.staleNote") : null,
      agent.wake_error ? t("agent.wakeError", { error: agent.wake_error }) : null,
    ].filter(Boolean).join(" · ")
  }

  function agentSub(agent: Participant): string {
    const parts = [cliLabel(agent.cli_kind)]
    if (agent.role === "leader" && !agent.team_id) parts.push(t("agent.leader"))
    if (agent.team_role) parts.push(agent.team_role)
    if (agent.team_state === "cancelled" || agent.team_state === "completed") parts.push(t("agent.teamClosed"))
    return parts.join(" · ")
  }

  return (
    <Panel label={`#${channel.name}`} onClose={onClose}>
      <PanelHeader
        title={`#${channel.name}`}
        status={<Chip tone={CHANNEL_TONE[kind]}>{t(`channelKind.${kind}`)}</Chip>}
        actions={<MoreMenu small ghost items={menu} />}
      />
      <PanelBody>
        <Dl items={[
          { label: t("channel.path"), value: <span className="mono trunc" style={TRUNC} title={channel.path}>{channel.path}</span> },
          { label: t("channel.branch"), value: channel.branch ? <span className="mono trunc" style={TRUNC} title={channel.branch}>{channel.branch}</span> : null },
          { label: t("channel.threads"), value: channel.threads },
          { label: t("channel.leader"), value: leader?.label },
        ]} />
        {kind === "closed" && <span className="xs t3">{t("channel.closedNote")}</span>}
        {kind === "readOnly" && <span className="xs t3">{t("channel.readOnlyNote")}</span>}
        <hr className="divider" />
        <section className="section" aria-label={t("channel.agents")}>
          <div className="section-h"><span className="h3">{t("channel.agents")}</span>{agents.data && <span className="xs t3">{plural("channel.agentCount", agents.data.total)}</span>}</div>
          {agents.isPending && <SkeletonRows count={2} label={t("channel.loadingAgents")} />}
          {agents.error && <List><ErrorState error={agents.error} title={t("channel.agentsError")} onRetry={() => void agents.refetch()} /></List>}
          {agents.data && visible.length === 0 && <List><Empty icon="clients" title={t("channel.noAgents")} detail={t("channel.noAgentsDetail")} /></List>}
          {visible.length > 0 && (
            <List>
              {visible.map(agent => {
                const state = agentState(agent)
                return (
                  <Row
                    key={agent.id}
                    onOpen={() => onInspect(agent)}
                    lead={<Avatar name={agent.label} small round />}
                    title={agent.label}
                    titleText={agentTooltip(agent)}
                    sub={agentSub(agent)}
                    meta={<Chip tone={AGENT_TONE[state]}>{t(`agentState.${state}`)}</Chip>}
                    action={<MoreMenu small ghost label={t("agent.actionsOf", { name: agent.label })} items={agentMenu(agent)} />}
                  />
                )
              })}
            </List>
          )}
          {agents.data && <Pager total={agents.data.total} offset={agentOffset} limit={AGENT_PAGE} onChange={onAgentOffset} />}
        </section>
      </PanelBody>

      <ConfirmDialog
        open={Boolean(coordinating)}
        title={t("confirm.designateTitle", { name: coordinating?.label ?? "" })}
        confirmLabel={t("confirm.designateAction")}
        destructive={false}
        busy={designate.isPending}
        onClose={() => setCoordinating(null)}
        onConfirm={() => coordinating && designate.mutate({ channel_id: coordinating.channel_id, participant_id: coordinating.id, expected_leader_id: channel.leader_id ?? null })}
        message={<div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <p className="t2" style={{ margin: 0 }}>{t("confirm.designateBody")}</p>
          <ErrorDetail error={designate.error} />
        </div>}
      />
      <ConfirmDialog
        open={Boolean(removing)}
        title={t("confirm.kickTitle", { name: removing?.label ?? "" })}
        confirmLabel={kick.isPending ? t("confirm.kicking") : t("confirm.kickAction")}
        busy={kick.isPending}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && kick.mutate({ channel_id: removing.channel_id, participant_id: removing.id, reason: reason.trim() || KICK_REASON })}
        message={<div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
          <p className="t2" style={{ margin: 0 }}>{t("confirm.kickBody")}</p>
          <p className="t2" style={{ margin: 0 }}>{t("confirm.kickKeeps")}</p>
          {removing?.role === "leader" && <p className="t2" style={{ margin: 0 }}>{t("confirm.kickLeader")}</p>}
          <Field label={t("confirm.kickReason")}>
            <Input maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} />
          </Field>
          <ErrorDetail error={kick.error} />
        </div>}
      />
    </Panel>
  )
}
