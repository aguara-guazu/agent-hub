import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Button, Chip, ConfirmDialog, Dl, ErrorState, List, Loading, MoreMenu, Panel, PanelBody, PanelHeader, Row, absoluteTime, describeError,
  useToast, type ChipTone, type MenuItem,
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

/** Plan de equipo de la flota. Aprobar envía exactamente el digest mostrado; el Hub vuelve a validar al lanzar. */
export function PlanPanel({ planId, onThread, onClose }: PlanPanelProps) {
  const { t, plural } = useT("collaboration")
  const toast = useToast()
  const modelLine = useModelLine()
  const cache = useQueryClient()
  const [memberId, setMemberId] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const plan = useQuery({
    queryKey: ["memory", "team-plan", planId],
    queryFn: () => api.get<Plan>(`/memory/teams/${encodeURIComponent(planId)}`),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })
  const approve = useMutation({
    mutationFn: (digest: string) => api.post<Plan>(`/memory/teams/${encodeURIComponent(planId)}/approve`, { digest }),
    onSuccess: result => {
      cache.setQueryData(["memory", "team-plan", planId], result)
      void cache.invalidateQueries({ queryKey: ["memory"] })
      setReviewing(false)
      toast.success(t("plan.approved"))
    },
  })

  const value = plan.data
  const state = planState(value?.state)
  const prepared = value?.state === "prepared"
  const members = value ? (value.members?.length ? value.members : value.plan.members) : []
  const selected = members.find(member => member.id === memberId) ?? null
  const definition = (member: Member) => value?.plan.members.find(item => item.id === member.id)
  const virtual = value?.parent.kind === "virtual"
  const permissions = value?.plan.permissions === "full_access" ? t("plan.permissionsFull") : t("plan.permissionsClient")

  return (
    <Panel label={t("plan.title")} onClose={onClose} wide>
      <PanelHeader
        title={t("plan.title")}
        status={value && <Chip tone={PLAN_TONE[state]}>{t(`planState.${state}`)}</Chip>}
        actions={value?.root_thread_id ? <MoreMenu small ghost items={[{ label: t("actions.openCoordination"), onSelect: () => onThread(value.root_thread_id!, value.master_channel_id) }]} /> : undefined}
      />
      <PanelBody>
        {plan.isPending && <Loading label={t("plan.loading")} />}
        {plan.error && <ErrorState error={plan.error} title={t("plan.error")} onRetry={() => void plan.refetch()} />}
        {value && <>
          {prepared && (
            <div className="card" style={{ padding: "var(--sp-3)", display: "flex", flexDirection: "column", gap: "var(--sp-2)", background: "var(--surface-2)" }}>
              <span>{plural("plan.pendingApproval", members.length)}</span>
              <div><Button variant="primary" small onClick={() => { approve.reset(); setReviewing(true) }}>{t("actions.reviewTeam")}</Button></div>
            </div>
          )}
          <p className="prose" style={{ margin: 0, overflowWrap: "anywhere" }}>{value.objective}</p>
          <Dl items={[
            { label: t("plan.joined"), value: t("plan.ratio", { done: value.progress.joined, total: value.progress.total }) },
            { label: t("plan.processes"), value: t("plan.ratio", { done: value.progress.processes_accepted, total: value.progress.total }) },
            { label: t("plan.workspaces"), value: t("plan.ratio", { done: value.progress.workspaces_created, total: value.progress.total }) },
            { label: t("plan.permissions"), value: permissions },
            { label: t(virtual ? "plan.virtualSpace" : "plan.repository"), value: <span className="mono trunc" title={value.parent.path}>{value.parent.path}</span> },
            { label: t("plan.base"), value: <span className="mono trunc" title={value.base_revision}>{value.base_revision}</span> },
            { label: t("plan.digest"), value: <span className="mono xs" style={{ overflowWrap: "anywhere" }}>{value.digest}</span> },
          ]} />
          {virtual && <span className="xs t3">{t("plan.virtualNote")}</span>}

          <List aria-label={t("plan.members")}>
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
        </>}
      </PanelBody>
      {value && !prepared && value.root_thread_id && (
        <div className="panel-f"><Button small onClick={() => onThread(value.root_thread_id!, value.master_channel_id)}>{t("actions.openCoordination")}</Button></div>
      )}
      {value && (
        <ConfirmDialog
          open={reviewing}
          title={t("plan.confirmTitle")}
          confirmLabel={approve.isPending ? t("plan.approving") : t("actions.approveTeam")}
          destructive={false}
          busy={approve.isPending}
          onClose={() => setReviewing(false)}
          onConfirm={() => approve.mutate(value.digest)}
          message={
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
              <p className="t2 clamp2" style={{ margin: 0 }} title={value.objective}>{value.objective}</p>
              <span className="t2">{plural("plan.confirmMembers", members.length, { permissions })}</span>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
                {members.map(member => {
                  const quota = memberQuota(value, member)
                  return (
                    <li key={member.id} style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", minWidth: 0 }}>
                      <span className="xs t2 trunc" style={{ flex: 1 }} title={modelLine(member)}>{member.role.split(":")[0]} · {modelLine(member)}</span>
                      {quota && <Chip tone={QUOTA_TONE[quota]}>{t(`quota.${quota}`)}</Chip>}
                    </li>
                  )
                })}
              </ul>
              <div className="field">
                <span className="label">{t("plan.digest")}</span>
                <span className="mono xs" style={{ overflowWrap: "anywhere" }}>{value.digest}</span>
              </div>
              {approve.error && (
                <div role="alert" style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
                  <span className="xs" style={{ color: "var(--danger)" }}>{describeError(approve.error)}</span>
                  {approve.error.message && <span className="xs t3" style={{ overflowWrap: "anywhere" }}>{approve.error.message}</span>}
                </div>
              )}
            </div>
          }
        />
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
