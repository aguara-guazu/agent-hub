import type { ModuleDefinition } from './definition.js'

export const schedules = {
  id: 'schedules', label: 'Cronjobs y automatizaciones', setting: 'automations_enabled',
  routes: ['/api/memory/schedules', '/api/memory/schedule-constraints',
    '/api/memory/projects/:id/automation', '/api/memory/projects/:id/repositories'],
  destinations: ['/automations'],
  operations: ['push_propose'],
  operationPrefixes: ['schedule_', 'project_automation_'],
  jobs: [],
} as const satisfies ModuleDefinition
