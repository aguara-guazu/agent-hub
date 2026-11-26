import type { ModuleDefinition } from './definition.js'

export const assistants = {
  id: 'assistants',
  label: 'Asistentes',
  setting: 'module_assistants_enabled',
  routes: ['/api/assistants'],
  destinations: ['/assistants'],
  requires: ['memory'],
  operations: ['resident_team'],
  operationPrefixes: [],
  jobs: [],
} as const satisfies ModuleDefinition
