import type { ModuleDefinition } from './definition.js'

export const sharing = {
  id: 'sharing', label: 'Proyectos compartidos', setting: 'module_sharing_enabled',
  requires: ['memory'],
  routes: ['/api/memory/sharing', '/api/memory/interhub'],
  destinations: [],
  operations: ['publish_source', 'resolve_shared', 'send_message', 'read_messages',
    'ack_message', 'claim_work'],
  operationPrefixes: ['shared_', 'chat_interhub_'],
  jobs: [],
} as const satisfies ModuleDefinition
