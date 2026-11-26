import { readFile } from 'node:fs/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { residentTeamOperations } from './team-contract.js'

/** Private per-turn client. Only the Hub-supplied loopback destination receives this process's bearer. */
async function call(input: unknown) {
  const index = process.argv.indexOf('--grant-file', 2)
  const path = index >= 0 && process.argv[index + 1]
  if (!path) throw new Error('Falta el archivo de autorización.')
  const grant = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  const uri = new URL(String(grant.AGENTHUB_RESIDENT_TEAM_URL ?? ''))
  const token = grant.AGENTHUB_RESIDENT_TEAM_TOKEN
  if (uri.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(uri.hostname) || uri.pathname !== '/api/assistants/teams/call'
    || uri.username || uri.password || uri.search || uri.hash || typeof token !== 'string' || !token) throw new Error('No hay un turno local de equipos disponible.')
  const response = await fetch(uri, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    redirect: 'error', body: JSON.stringify(input) })
  const data = await response.json() as Record<string, unknown>
  if (!response.ok) throw new Error(String(data.detail ?? data.message ?? 'Error del Hub ' + response.status))
  return JSON.stringify(data)
}

const server = new Server({ name: 'resident_team', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'team', description: 'Coordinate the resident’s Hub team in its current project. List existing plans, get the catalog, prepare and launch, inspect reports and questions, read or reply to threads, control, answer or close.',
  inputSchema: { type: 'object', properties: { operation: { type: 'string', enum: [...residentTeamOperations] }, input: { type: 'object', additionalProperties: true } }, required: ['operation'], additionalProperties: false } }] }))
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    if (request.params.name !== 'team') throw new Error('Herramienta desconocida.')
    return { content: [{ type: 'text', text: await call(request.params.arguments) }] }
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'La operación no pudo completarse.' }] }
  }
})
await server.connect(new StdioServerTransport())
