import type { ModuleDefinition } from './definition.js'

export const agents = {
  id: 'agents', label: 'Agentes', setting: 'module_agents_enabled',
  routes: ['/api/memory/usage', '/api/memory/teams', '/api/memory/chat', '/api/machines',
    '/api/collaboration', '/api/assistants/work', '/api/assistants/teams'],
  destinations: ['/clients'],
  operations: ['resident_team'],
  operationPrefixes: ['team_', 'chat_', 'usage_'],
  jobs: [],
} as const satisfies ModuleDefinition
