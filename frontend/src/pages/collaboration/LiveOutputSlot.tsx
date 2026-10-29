import { AgentOutput } from "../activity/AgentOutput"

/** Salida en vivo de solo lectura de un agente; el componente vive en Actividad y se monta en el panel del agente. */
export function LiveOutputSlot({ agentId }: { agentId: string }) {
  return <AgentOutput agentId={agentId} />
}
