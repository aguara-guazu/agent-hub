import { Avatar, Button, Chip, Dl, Panel, PanelBody, PanelHeader, absoluteTime } from "../../../components/ui"
import { useT } from "../../../i18n"
import { LiveOutputSlot } from "./LiveOutputSlot"
import { AGENT_TONE, agentState, capabilityKey, useCliLabel } from "./chatShared"
import type { Participant } from "./chatTypes"

/** Agente de un canal: datos de conexión y su salida en vivo. Solo lectura. */
export function AgentPanel({ agentId, agent, onClose, onThreads }: { agentId: string; agent?: Participant; onClose: () => void; onThreads: () => void }) {
  const { t } = useT("collaboration")
  const cliLabel = useCliLabel()
  const label = agent?.label ?? t("agent.unknown")
  const state = agent ? agentState(agent) : null
  return (
    <Panel label={t("agent.activityOf", { name: label })} onClose={onClose} wide>
      <PanelHeader
        lead={<Avatar name={label} round />}
        title={label}
        status={state && <Chip tone={AGENT_TONE[state]}>{t(`agentState.${state}`)}</Chip>}
      />
      <PanelBody>
        {agent && (
          <Dl items={[
            { label: t("agent.client"), value: cliLabel(agent.cli_kind) },
            { label: t("agent.role"), value: agent.team_role ?? (agent.role === "leader" && !agent.team_id ? t("agent.leader") : null) },
            { label: t("agent.notices"), value: capabilityKey(agent.capability) ? t(`capability.${capabilityKey(agent.capability)!}`) : agent.capability },
            { label: t("agent.lastSeenLabel"), value: absoluteTime(agent.last_seen_at) },
            { label: t("agent.lastObservedLabel"), value: agent.state_observed_at ? absoluteTime(agent.state_observed_at) : null },
            { label: t("agent.team"), value: agent.team_state === "cancelled" || agent.team_state === "completed" ? t("agent.teamClosed") : null },
            { label: t("agent.wakeErrorLabel"), value: agent.wake_error ? <span style={{ color: "var(--danger)", overflowWrap: "anywhere" }}>{agent.wake_error}</span> : null },
          ]} />
        )}
        {state === "stale" && <span className="xs t3">{t("agent.staleNote")}</span>}
        <hr className="divider" />
        <section className="section" aria-label={t("agent.output")}>
          <div className="section-h"><span className="h3">{t("agent.output")}</span></div>
          <LiveOutputSlot agentId={agentId} />
        </section>
      </PanelBody>
      <div className="panel-f"><Button small onClick={onThreads}>{t("actions.agentThreads")}</Button></div>
    </Panel>
  )
}
