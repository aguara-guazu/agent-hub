import { Empty } from "../../components/ui"
import { useT } from "../../i18n"

/** Punto de conexión de la salida en vivo de un agente. Al integrar se reemplaza por AgentOutput de pages/activity. */
export function LiveOutputSlot({ agentId }: { agentId: string }) {
  const { t } = useT("collaboration")
  return <div data-agent-output={agentId}><Empty icon="activity" title={t("agent.outputPending")} /></div>
}
