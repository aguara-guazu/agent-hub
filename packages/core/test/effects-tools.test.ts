import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Database } from '../src/db/database.js'
import { runMigrations } from '../src/db/migrations.js'
import { Store } from '../src/store.js'
import { ensureLocalOwner } from '../src/local.js'
import { ensureRunProfileAgent } from '../src/effects/identities.js'
import { createEffectToolResolver, EffectToolDenied } from '../src/effects/tools.js'
import type { ConnectionPool } from '@agenthub/gateway'

let db: Database, store: Store, ownerId: string
const base = { description: '', transport: 'http' as const, command: '', args: [], env: {}, cwd: '', headers: {}, secret_refs: {}, requires_host_access: false,
  container_image: '', allow_hosts: [], allow_ports: [], read_mounts: [], write_mounts: [] }
const callTool = vi.fn(async () => ({ is_error: false, content: [] }))
const pool = { callTool } as unknown as ConnectionPool
const rows = () => store.toolCalls({ orgId: store.user(ownerId)!.organization_id, limit: 50 })
const TOOLS = ['addWorklogToJiraIssue', 'getJiraIssue', 'atlassianUserInfo', 'deleteEverything']

function server(slug: string, url: string, transport: 'http' | 'stdio' = 'http', tools = TOOLS) {
  const row = store.insertServer({ ...base, user_id: ownerId, slug, display_name: slug, auth: 'none', transport, url, command: transport === 'stdio' ? 'node' : '' })
  for (const name of tools) store.insertTool({ server_id: row.id, name, title: name, exposed_name: `${slug}_${name}`, description: '', input_schema: { type: 'object' }, definition_hash: `${slug}-${name}` })
  return row
}
const toolOf = (serverId: string, name: string) => store.toolsOfServer(serverId).find(tool => tool.name === name)!
const off = (resourceId: string) => store.insertRule({ user_id: ownerId, agent_instance_id: null, resource_type: 'mcp_tool', resource_id: resourceId, state: 'off', reason: 'persona' })

beforeEach(() => {
  callTool.mockClear()
  db = new Database(':memory:'); runMigrations(db, ':memory:'); store = new Store(db); ownerId = ensureLocalOwner(store).id
  store.insertMachine({ user_id: ownerId, hostname: 'test', os: 'test', daemon_version: 'test' })
})
afterEach(() => db.close())

it('llama con la identidad hub_effects dentro del servidor indicado y pasa la correlación al pool', async () => {
  const jira = server('atlassian_rovo', 'https://mcp.atlassian.com/v1/mcp')
  const agent = ensureRunProfileAgent(store, ownerId, 'hub_effects')!
  const tools = createEffectToolResolver(store, pool, ownerId).forServer(jira.id, { runId: 'run-1', intentId: 'int-1' })
  expect(tools.enabled('addWorklogToJiraIssue')).toBe(true)
  await tools.call('addWorklogToJiraIssue', { issueIdOrKey: 'ABC-1' })
  const [agentId, spec, name, , meta, trace] = callTool.mock.calls[0] as unknown as [string, { slug: string; id: string }, string, unknown, unknown, Record<string, string>]
  expect(agentId).toBe(agent.id)
  expect(spec).toMatchObject({ slug: 'atlassian_rovo', id: jira.id })
  expect(name).toBe('addWorklogToJiraIssue')
  expect(meta).toBeUndefined()
  expect(trace).toMatchObject({ runId: 'run-1', intentId: 'int-1' })
  expect(trace['callId']).toMatch(/^[0-9a-f-]{36}$/)
})

it('una herramienta fuera de la cota del perfil se deniega sin llamar y deja una fila deny', async () => {
  const jira = server('atlassian_rovo', 'https://mcp.atlassian.com/v1/mcp')
  const tools = createEffectToolResolver(store, pool, ownerId).forServer(jira.id, { runId: 'run-1', intentId: 'int-1' })
  expect(tools.enabled('deleteEverything')).toBe(false)
  await expect(tools.call('deleteEverything', { x: 1 })).rejects.toBeInstanceOf(EffectToolDenied)
  expect(callTool).not.toHaveBeenCalled()
  expect(rows()[0]).toMatchObject({ decision: 'deny', denial_reason: 'tool_off', tool_name: 'deleteEverything', server_slug: 'atlassian_rovo', principal: 'hub_effects', run_id: 'run-1', intent_id: 'int-1' })
})

it('dos servidores con la misma herramienta: ambos son candidatos y un servidor fijado no cae al otro', async () => {
  const first = server('atlassian_rovo', 'https://mcp.atlassian.com/v1/mcp'), second = server('atlassian_rovo_2', 'https://mcp.atlassian.com/v1/sse')
  const resolver = createEffectToolResolver(store, pool, ownerId)
  expect(resolver.candidates(['atlassianUserInfo', 'addWorklogToJiraIssue']).sort()).toEqual([first.id, second.id].sort())
  off(toolOf(second.id, 'addWorklogToJiraIssue').id)
  expect(resolver.candidates(['atlassianUserInfo', 'addWorklogToJiraIssue'])).toEqual([first.id])
  const bound = resolver.forServer(second.id)
  await expect(bound.call('addWorklogToJiraIssue', {})).rejects.toBeInstanceOf(EffectToolDenied)
  expect(callTool).not.toHaveBeenCalled()
})

it('el guard y la escritura de una misma intención quedan registrados contra el mismo servidor', async () => {
  const first = server('atlassian_rovo', 'https://mcp.atlassian.com/v1/mcp')
  server('atlassian_rovo_2', 'https://mcp.atlassian.com/v1/sse')
  const tools = createEffectToolResolver(store, pool, ownerId).forServer(first.id, { runId: 'run-1', intentId: 'int-1' })
  await tools.call('atlassianUserInfo', {})
  await tools.call('addWorklogToJiraIssue', {})
  const specs = callTool.mock.calls.map(call => (call as unknown as [string, { id: string }])[1].id)
  expect(specs).toEqual([first.id, first.id])
})

it('un servidor local o de otro dominio que publique las mismas herramientas no es candidato', async () => {
  server('local_jira', '', 'stdio')
  server('impostor', 'https://example.invalid/mcp')
  server('slack_mcp', 'https://mcp.slack.com/mcp', 'http', ['slack_send_message'])
  server('slack_local', '', 'stdio', ['slack_send_message'])
  const resolver = createEffectToolResolver(store, pool, ownerId)
  expect(resolver.candidates(['addWorklogToJiraIssue'])).toEqual([])
  expect(resolver.candidates(['slack_send_message'])).toHaveLength(1)
})

it('una herramienta de Slack en un host de Atlassian (y al revés) no entra en la cota', async () => {
  server('mixed_a', 'https://mcp.atlassian.com/v1/mcp', 'http', ['slack_send_message', 'getJiraIssue'])
  server('mixed_s', 'https://mcp.slack.com/mcp', 'http', ['addWorklogToJiraIssue', 'slack_read_channel'])
  const resolver = createEffectToolResolver(store, pool, ownerId)
  expect(resolver.candidates(['slack_send_message'])).toEqual([])
  expect(resolver.candidates(['addWorklogToJiraIssue'])).toEqual([])
  expect(resolver.candidates(['getJiraIssue'])).toHaveLength(1)
  expect(resolver.candidates(['slack_read_channel'])).toHaveLength(1)
})

it('sin máquina registrada no hay identidad y todo se deniega', async () => {
  const jira = server('atlassian_rovo', 'https://mcp.atlassian.com/v1/mcp')
  db.run('DELETE FROM machines')
  const resolver = createEffectToolResolver(store, pool, ownerId)
  expect(resolver.candidates(['getJiraIssue'])).toEqual([])
  const tools = resolver.forServer(jira.id)
  expect(tools.enabled('getJiraIssue')).toBe(false)
  await expect(tools.call('getJiraIssue', {})).rejects.toMatchObject({ reason: 'no_identity' })
})
