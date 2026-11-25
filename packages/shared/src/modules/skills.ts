import type { ModuleDefinition } from './definition.js'

export const skills = {
  id: 'skills', label: 'Skills', setting: 'module_skills_enabled',
  routes: ['/api/catalog/skills', '/api/sync/external-skills'],
  destinations: ['/skills'],
  operations: ['skill_reference'],
  operationPrefixes: [],
  jobs: [],
} as const satisfies ModuleDefinition
