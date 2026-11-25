import type { ModuleDefinition } from './definition.js'

export const connections = {
  id: 'connections', label: 'Conexiones a servicios', setting: 'module_connections_enabled',
  routes: ['/api/memory/connectors', '/api/memory/google', '/api/memory/jira-settings', '/api/automations/jira-server'],
  destinations: [],
  operations: ['list_connectors', 'save_connector', 'sync_connector', 'sync_sources',
    'repair_google', 'google_setup_status', 'import_google_client', 'connect_google',
    'sync_tasks'],
  operationPrefixes: [],
  jobs: ['sync', 'gmail', 'google_document', 'google_repair'],
} as const satisfies ModuleDefinition
