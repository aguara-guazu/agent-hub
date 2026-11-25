import { renderMemoryToolReference } from '../skill.js'
import { interhubReference, localCollaborationSkill, localOrchestrationReference } from '../agents/local-chat-skill.js'
import { z } from 'zod'

export const referenceReadOperations = ['skill_reference'] as const satisfies readonly (keyof typeof referenceDefinitions)[]

export const referenceDefinitions = {
  skill_reference: ['Only when needed: collaboration guides or the full tool reference. Runs nothing; grants no permissions.', z.object({section:z.enum(['memory-tools','local-collaboration','team-orchestration','inter-hub'])}).strict()],
} satisfies Record<string, [string, z.ZodType]>

export function skillReference(section: 'memory-tools' | 'local-collaboration' | 'inter-hub' | 'team-orchestration') {
  const text = section === 'memory-tools' ? renderMemoryToolReference()
    : section === 'local-collaboration' ? localCollaborationSkill.body
    : section === 'inter-hub' ? interhubReference : localOrchestrationReference
  return { section, text }
}
