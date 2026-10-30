import { Avatar, Button, ErrorState, SkeletonRows, Tag, useToast } from "../../../components/ui"
import { useT } from "../../../i18n"
import { agentInitials } from "./chatShared"
import { useInterhubCode, useInterhubRoster, type InterhubHub } from "./interhubData"

const BLOCK = { borderBottom: "1px solid var(--border)" } as const
const AGENT_ROW = { minHeight: "var(--sp-6)", paddingTop: "var(--sp-1)", paddingBottom: "var(--sp-1)" } as const

/** Agentes del canal compartido, un desplegable por hub, y el código del canal si este hub lo creó. Solo lectura. */
export function InterhubAgents({ channelId, roster }: { channelId: string; roster: ReturnType<typeof useInterhubRoster> }) {
  const { t, plural } = useT("project")
  const data = roster.data

  return (
    <div style={BLOCK}>
      <div style={{ padding: "var(--sp-3) var(--sp-4) var(--sp-2)" }}>
        <span className="label">
          {data
            ? t("collaboration.interhub.agentsSummary", {
              hubs: plural("collaboration.interhub.hubs", data.hub_count),
              agents: plural("collaboration.board.agents", data.agent_count),
            })
            : t("collaboration.interhub.agentsTitle")}
        </span>
      </div>
      {roster.isPending ? <SkeletonRows count={2} avatar={false} label={t("collaboration.interhub.loadingAgents")} />
        : roster.error ? <ErrorState error={roster.error} title={t("collaboration.interhub.agentsError")} onRetry={() => void roster.refetch()} />
        : data && data.hubs.length === 0 ? <p className="xs t3" style={{ padding: "0 var(--sp-4) var(--sp-3)" }}>{t("collaboration.interhub.noAgents")}</p>
        : data?.hubs.map((hub, index) => <HubGroup key={hub.id} hub={hub} defaultOpen={index === 0} />)}
      <ChannelCode channelId={channelId} />
    </div>
  )
}

function HubGroup({ hub, defaultOpen }: { hub: InterhubHub; defaultOpen: boolean }) {
  const { t, plural } = useT("project")
  // Líder primero; el resto conserva el orden que entrega el servidor.
  const agents = [...hub.agents].sort((a, b) => Number(b.role === "leader") - Number(a.role === "leader"))
  return (
    <details open={defaultOpen} style={BLOCK}>
      <summary style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", padding: "var(--sp-3) var(--sp-4)", cursor: "pointer", listStyle: "none" }}>
        <span className={hub.is_local ? "chip c-ok" : "chip c-off"}>{t(hub.is_local ? "collaboration.interhub.thisHub" : "collaboration.interhub.remote")}</span>
        <span className="row-title trunc" style={{ flex: 1 }} title={hub.name}>{hub.name}</span>
        <span className="xs t3" style={{ textAlign: "right", whiteSpace: "nowrap" }}>{plural("collaboration.board.agents", hub.agent_count)}</span>
      </summary>
      {/* Con 20 agentes por hub la lista scrollea por dentro y no empuja el resto de la columna. */}
      <div className="list" style={{ maxHeight: "calc(var(--sp-8) * 6)", overflowY: "auto", border: 0, borderRadius: 0 }}>
        {agents.length === 0 ? <p className="xs t3" style={{ padding: "var(--sp-2) var(--sp-4)" }}>{t("collaboration.interhub.noAgents")}</p>
          : agents.map(agent => (
            <div key={agent.id} className="row" style={AGENT_ROW}>
              <Avatar name={agent.label} text={agentInitials(agent.label, agent.cli_kind)} small />
              <div className="row-main"><span className="row-title trunc" title={agent.label}>{agent.label}</span></div>
              {agent.role === "leader" && <Tag>{t("collaboration.interhub.leader")}</Tag>}
            </div>
          ))}
      </div>
    </details>
  )
}

/** Solo aparece si el servidor lo entrega: lo ve el hub creador mientras el código no se haya revocado. */
function ChannelCode({ channelId }: { channelId: string }) {
  const { t } = useT("project")
  const common = useT("common").t
  const toast = useToast()
  const code = useInterhubCode(channelId)
  if (code.isPending) return null
  if (code.error) {
    return (
      <div style={{ padding: "var(--sp-3) var(--sp-4)", display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
        <span className="xs t3" style={{ flex: 1 }}>{t("collaboration.interhub.codeError")}</span>
        <Button small variant="ghost" onClick={() => void code.refetch()}>{common("actions.retry")}</Button>
      </div>
    )
  }
  const value = code.data
  if (!value) return null

  async function copy() {
    try {
      await navigator.clipboard.writeText(value!)
      toast.success(common("toast.copied"))
    } catch {
      toast.error(t("collaboration.interhub.copyFailed"))
    }
  }

  return (
    <div style={{ padding: "var(--sp-3) var(--sp-4)", display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <span className="label">{t("collaboration.interhub.code")}</span>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", minWidth: 0 }}>
        <span className="chip c-info" style={{ fontFamily: "var(--mono)", minWidth: 0, maxWidth: "100%" }}><span className="trunc">{value}</span></span>
        <Button small style={{ flex: "none" }} onClick={() => void copy()}>{common("actions.copy")}</Button>
      </div>
      <span className="xs t3">{t("collaboration.interhub.codeHint")}</span>
    </div>
  )
}
