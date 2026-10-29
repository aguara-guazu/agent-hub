import { z } from 'zod'
import { check, parse } from './contracts.js'
import type { AgentContext } from './agents.js'
import { activateInput, automationStatusInput, pushProposeInput } from './project-automation.js'
import type { ProjectAutomationService } from './project-automation-service.js'

// memory_project_automation_activate and memory_push_propose. They are not collaboration tools: they work in solo mode and no run profile can call them.

export const projectAutomationReadOperations = ['project_automation_status']

export const projectAutomationDefinitions = {
  project_automation_status: ['Project activation state: enabled?, current delegation version (expected_version), who declared it and the phrase, channel, repos, open push candidates. Read before (de)activating: memory_project_automation_activate requires expected_version.',
    automationStatusInput],
  project_automation_activate: ['At the person\'s request, enable/disable a project\'s brief, close and action proposals. human_instruction must hold the person\'s verbatim phrase, kept as delegation provenance (coordinator_declaration). The automation channel is authorized in the same question: send channel {name, objective} only if the person saw that name and objective. The project anchors to YOUR current channel if it belongs to it. Needs expected_version (from memory_project_automation_status; null if not activated); if it changed, nothing applies. Activation grants no write power: each external action needs authenticated per-item approval. Brief, close and status auto-schedule.',
    activateInput],
  push_propose: ['Propose pushing today\'s work on an activated project: local branch, exact SHA, reason. Pushes nothing: the daily close makes it an item the person approves in the channel. Only delegation-allowed branches, never main; SHA must be the current branch tip. If you asked the person what to push, propose only that.',
    pushProposeInput],
} satisfies Record<string, [string, z.ZodType]>

export async function callProjectAutomationTool(service: ProjectAutomationService, operation: string, raw: unknown, agent: AgentContext | undefined) {
  const definition = projectAutomationDefinitions[operation as keyof typeof projectAutomationDefinitions]
  check(definition, 'Operación de automatización inexistente', 404)
  check(agent?.agent_id, 'Solo los agentes usan esta operación', 403)
  const input = parse(definition[1] as z.ZodType, raw ?? {}) as any
  if (operation === 'project_automation_status') return { ...await service.view(input.project_id), push_candidates: await service.openPushCandidates(input.project_id) }
  if (operation === 'push_propose') {
    const { session_key, request_id: _request, ...rest } = input
    return service.proposePush({ agent: agent!, session_key }, rest)
  }
  const { session_key, request_id: _request, ...rest } = input
  return service.activate({ kind: 'agent', agent: agent!, session_key }, rest)
}
