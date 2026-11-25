import type { ModuleDefinition } from './definition.js'

export const transcriptions = {
  id: 'transcriptions', label: 'Transcripciones y multimedia', setting: 'module_transcriptions_enabled',
  routes: ['/api/memory/media', '/api/memory/recordings'],
  destinations: [],
  operations: ['process_files', 'transcript', 'assign_fragment'],
  operationPrefixes: [],
  jobs: ['media', 'recording'],
} as const satisfies ModuleDefinition
