import type { ModuleDefinition } from './definition.js'

export const mcp = {
  id: 'mcp', label: 'Servidores MCP', setting: 'module_mcp_enabled',
  routes: ['/api/catalog/servers', '/api/oauth', '/api/memory/mcp'],
  destinations: ['/servers'],
  operations: [],
  operationPrefixes: [],
  jobs: [],
} as const satisfies ModuleDefinition
