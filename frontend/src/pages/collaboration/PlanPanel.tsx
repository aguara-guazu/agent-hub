import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Button, Chip, Dl, ErrorState, List, Loading, MoreMenu, Panel, PanelBody, PanelHeader, Row, absoluteTime, type ChipTone, type MenuItem,
} from "../../components/ui"
import { useT } from "../../i18n"
import { api } from "../../lib/api"
import { EFFORTS, PLAN_TONE, QUOTA_TONE, memberQuota, planState, useCliLabel, type Effort } from "./shared"
import type { Member, Plan } from "./types"

type WorkState = "delivered" | "waiting" | "progress" | "report" | "none"
const WORK_TONE: Record<WorkState, ChipTone> = { delivered: "ok", waiting: "warn", progress: "info", report: "info", none: "off" }

type RuntimeState = "busy" | "idle" | "waiting_input" | "unknown" | "stopped" | "exited" | "failed" | "starting" | "joined" | "notStarted" | "notJoined"
const RUNTIME_TONE: Record<RuntimeState, ChipTone> = {
  busy: "info", idle: "ok", waiting_input: "warn", unknown: "off", stopped: "off", exited: "off", failed: "danger", starting: "info", joined: "off", notStarted: "off", notJoined: "off",
}
const RUNTIMES = ["busy", "idle", "waiting_input", "unknown", "stopped", "exited", "failed", "starting"] as const

function workState(member: Member): WorkState {
  if (member.work?.status === "completed") return "delivered"
  if (member.work?.status === "waiting") return "waiting"
  if (member.work) return "progress"
  return member.last_report ? "report" : "none"
}

/** El proceso y el trabajo se informan por separado: un proceso activo no es una entrega. */
function runtimeState(member: Member, plan: Plan): RuntimeState {
  if (member.runtime) return RUNTIMES.find(state => state === member.runtime!.state) ?? "unknown"
  if (member.state === "joined") return "joined"
  return member.state === "prepared" || plan.state === "prepared" ? "notStarted" : "notJoined"
}

export interface PlanPanelProps {
  planId: string
  onThread: (threadId: string, channelId?: string) => void
  onClose: () => void
}

type Approval = "ownerUi" | "coordinator" | "legacy" | "none"
const APPROVAL_TONE: Record<Approval, ChipTone> = { ownerUi: "ok", coordinator: "ok", legacy: "off", none: "off" }

function approvalOf(plan: Plan): Approval {
  const source = plan.authorization?.source
  if (source === "owner_ui") return "ownerUi"
  if (source === "coordinator_declaration") return "coordinator"
  if (source === "legacy_record") return "legacy"
  return "none"
}

/** Plan de equipo de la flota, de solo lectura: el coordinador lo prepara, lo aprueba y lo controla por MCP. */
export function PlanPanel({ planId, onThread, onClose }: PlanPanelProps) {
  const { t } = useT("collaboration")
  const modelLine = useModelLine()
  const [memberId, setMemberId] = useState<string | null>(null)
  const plan = useQuery({
    queryKey: ["memory", "team-plan", planId],
    queryFn: () => api.get<Plan>(`/memory/teams/${encodeURIComponent(planId)}`),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })

  const value = plan.data
  const state = planState(value?.state)
  const members = value ? (value.members?.length ? value.members : value.plan.members) : []
  const selected = members.find(member => member.id === memberId) ?? null
  const definition = (member: Member) => value?.plan.members.find(item => item.id === member.id)
  const virtual = value?.parent.kind === "virtual"
  const approval = value ? approvalOf(value) : "none"
  const authorization = value?.authorization

  return (
    <Panel label={t("plan.title")} onClose={onClose} wide>
      <PanelHeader
        title={t("plan.title")}
        status={value && <Chip tone={PLAN_TONE[state]}>{t(`planState.${state}`)}</Chip>}
      />
      <PanelBody>
        {plan.isPending && <Loading label={t("plan.loading")} />}
        {plan.error && <ErrorState error={plan.error} title={t("plan.error")} onRetry={() => void plan.refetch()} />}
        {value && <>
          <p className="prose" style={{ margin: 0, overflowWrap: "anywhere" }}>{value.objective}</p>
          <Dl items={[
            { label: t("plan.joined"), value: t("plan.ratio", { done: value.progress.joined, total: value.progress.total }) },
            { label: t("plan.processes"), value: t("plan.ratio", { done: value.progress.processes_accepted, total: value.progress.total }) },
            { label: t("plan.workspaces"), value: t("plan.ratio", { done: value.progress.workspaces_created, total: value.progress.total }) },
            { label: t("plan.permissions"), value: value.plan.permissions === "full_access" ? t("plan.permissionsFull") : t("plan.permissionsClient") },
            { label: t(virtual ? "plan.virtualSpace" : "plan.repository"), value: <span className="mono trunc" title={value.parent.path}>{value.parent.path}</span> },
            { label: t("plan.base"), value: <span className="mono trunc" title={value.base_revision}>{value.base_revision}</span> },
            { label: t("plan.digest"), value: <span className="mono xs" style={{ overflowWrap: "anywhere" }}>{value.digest}</span> },
          ]} />
          {virtual && <span className="xs t3">{t("plan.virtualNote")}</span>}

          <hr className="divider" />
          <section className="section" aria-label={t("plan.approval")}>
            <div className="section-h"><span className="h3">{t("plan.approval")}</span><Chip tone={APPROVAL_TONE[approval]}>{t(`approval.${approval}`)}</Chip></div>
            <Dl items={[
              { label: t("plan.instruction"), value: authorization?.instruction ? <span className="t2" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{authorization.instruction}</span> : null },
              { label: t("plan.approvedBy"), value: authorization?.approved_by_user_id ? <span className="mono trunc" title={authorization.approved_by_user_id}>{authorization.approved_by_user_id}</span> : null },
              { label: t("plan.coordinator"), value: authorization?.coordinator_id ? <span className="mono trunc" title={authorization.coordinator_id}>{authorization.coordinator_id}</span> : null },
              { label: t("plan.delegation"), value: authorization?.delegation ? t("plan.delegationVersion", { version: authorization.delegation.version }) : null },
              { label: t("plan.launchStarted"), value: value.launch?.started_at ? absoluteTime(value.launch.started_at) : null },
              { label: t("plan.launchAccepted"), value: value.launch?.accepted_at ? absoluteTime(value.launch.accepted_at) : null },
              { label: t("plan.closedAt"), value: value.close?.at ? absoluteTime(value.close.at) : null },
              { label: t("plan.closeReason"), value: value.close?.reason },
            ]} />
          </section>

          <hr className="divider" />
          <section className="section" aria-label={t("plan.members")}>
            <div className="section-h"><span className="h3">{t("plan.members")}</span></div>
            <List>
              {members.map(member => {
                const work = workState(member)
                return (
                  <Row
                    key={member.id}
                    selected={member.id === memberId}
                    onOpen={() => setMemberId(current => (current === member.id ? null : member.id))}
                    title={member.nickname ?? member.role.split(":")[0]}
                    sub={modelLine(member)}
                    meta={<Chip tone={WORK_TONE[work]}>{t(`work.${work}`)}</Chip>}
                  />
                )
              })}
            </List>
            {selected && <MemberDetail member={selected} plan={value} prompt={definition(selected)?.prompt ?? selected.prompt} onThread={onThread} />}
          </section>
        </>}
      </PanelBody>
      {value?.root_thread_id && (
        <div className="panel-f"><Button small onClick={() => onThread(value.root_thread_id!, value.master_channel_id)}>{t("actions.openCoordination")}</Button></div>
      )}
    </Panel>
  )
}

/** «Kiro · claude-opus-5.5 · esfuerzo medio». */
function useModelLine() {
  const { t } = useT("collaboration")
  const cliLabel = useCliLabel()
  return (member: Member) => [
    cliLabel(member.cli),
    member.model,
    member.effort ? t("plan.effort", { effort: EFFORTS.includes(member.effort as Effort) ? t(`effort.${member.effort as Effort}`) : member.effort }) : null,
  ].filter(Boolean).join(" · ")
}

function MemberDetail({ member, plan, prompt, onThread }: { member: Member; plan: Plan; prompt?: string; onThread: PlanPanelProps["onThread"] }) {
  const { t } = useT("collaboration")
  const runtime = runtimeState(member, plan)
  const quota = memberQuota(plan, member)
  const actions: MenuItem[] = []
  if (member.work_thread_id) actions.push({ label: t("actions.viewConversation"), onSelect: () => onThread(member.work_thread_id!, plan.master_channel_id) })
  if (member.last_report && member.last_report.thread_id !== member.work_thread_id) actions.push({ label: t("actions.viewLastReport"), onSelect: () => onThread(member.last_report!.thread_id, plan.master_channel_id) })
  return (
    <section className="section" aria-label={member.nickname ?? member.role}>
      <div className="section-h">
        <span className="h3 trunc" title={member.nickname ?? member.role}>{member.nickname ?? member.role.split(":")[0]}</span>
        {actions.length > 0 && <MoreMenu small ghost items={actions} />}
      </div>
      <Dl items={[
        { label: t("member.role"), value: member.role },
        { label: t("member.task"), value: member.task },
        { label: t("member.process"), value: <Chip tone={RUNTIME_TONE[runtime]}>{t(`runtime.${runtime}`)}</Chip> },
        { label: t("member.quota"), value: quota ? <Chip tone={QUOTA_TONE[quota]}>{t(`quota.${quota}`)}</Chip> : null },
        { label: t("member.workspace"), value: member.workspace_path ? <span className="mono trunc" title={member.workspace_path}>{member.workspace_path}</span> : t("member.workspacePending") },
        { label: t("member.summary"), value: member.work?.summary },
      ]} />
      {member.last_report && (
        <div className="card" style={{ padding: "var(--sp-3)", display: "flex", flexDirection: "column", gap: "var(--sp-1)", background: "var(--surface-2)" }}>
          <span className="xs t3">{t("member.lastReport", { date: absoluteTime(member.last_report.created_at) })}</span>
          <p className="t2" style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{member.last_report.text}</p>
        </div>
      )}
      {prompt && (
        <div className="field">
          <span className="label">{t("member.prompt")}</span>
          <pre className="mono xs t2 card" style={{ margin: 0, padding: "var(--sp-3)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 240, overflowY: "auto" }}>{prompt}</pre>
        </div>
      )}
    </section>
  )
}
