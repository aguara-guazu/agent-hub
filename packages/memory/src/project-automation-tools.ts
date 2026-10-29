import { z } from 'zod'
import { check, parse } from './contracts.js'
import type { AgentContext } from './agents.js'
import { activateInput, pushProposeInput } from './project-automation.js'
import type { ProjectAutomationService } from './project-automation-service.js'

// memory_project_automation_activate and memory_push_propose. They are not collaboration tools: they work in solo mode and no run profile can call them.

export const projectAutomationDefinitions = {
  project_automation_activate: ['Activar o desactivar, a pedido de la persona, el brief, el cierre y la propuesta de acciones de un proyecto. Requiere la frase textual de la persona en human_instruction; queda como procedencia de la delegación (coordinator_declaration). El canal de automatización se autoriza en la misma pregunta: manda channel {name, objective} solo si la persona vio ese nombre y objetivo. El proyecto queda anclado a TU canal actual si pertenece a él. Activar no da poder de escritura: toda acción externa exige la aprobación autenticada de cada ítem. Los brief, cierre y estado se programan solos.',
    activateInput],
  push_propose: ['Proponer un push de lo que trabajaste hoy en un proyecto activado: rama local, SHA exacto y motivo. No empuja nada: el cierre del día lo arma como ítem y la persona lo aprueba por el canal. Solo ramas permitidas por la delegación, nunca la principal; el SHA debe ser la punta actual de la rama. Si preguntaste a la persona qué empujar, propón solo eso.',
    pushProposeInput],
} satisfies Record<string, [string, z.ZodType]>

export async function callProjectAutomationTool(service: ProjectAutomationService, operation: string, raw: unknown, agent: AgentContext | undefined) {
  const definition = projectAutomationDefinitions[operation as keyof typeof projectAutomationDefinitions]
  check(definition, 'Operación de automatización inexistente', 404)
  check(agent?.agent_id, 'Solo los agentes usan esta operación', 403)
  const input = parse(definition[1] as z.ZodType, raw ?? {}) as any
  if (operation === 'push_propose') {
    const { session_key, request_id: _request, ...rest } = input
    return service.proposePush({ agent: agent!, session_key }, rest)
  }
  const { session_key, request_id: _request, ...rest } = input
  return service.activate({ kind: 'agent', agent: agent!, session_key }, rest)
}
