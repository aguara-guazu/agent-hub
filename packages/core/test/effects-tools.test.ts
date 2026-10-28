import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Database } from '../src/db/database.js'
import { runMigrations } from '../src/db/migrations.js'
import { Store } from '../src/store.js'
import { ensureLocalOwner } from '../src/local.js'
import { ensureRunProfileAgent } from '../src/effects/identities.js'
import { createEffectTools, EffectToolDenied } from '../src/effects/tools.js'
import type { ConnectionPool } from '@agenthub/gateway'

let db: Database, store: Store, ownerId: string, serverId: string, worklogId: string
const base = { description: '', transport: 'http' as const, command: '', args: [], env: {}, cwd: '', url: 'https://fixture.invalid/mcp', headers: {}, secret_refs: {}, requires_host_access: false,
  container_image: '', allow_hosts: [], allow_ports: [], read_mounts: [], write_mounts: [] }
const callTool = vi.fn(async () => ({ is_error: false, content: [] }))
const pool = { callTool } as unknown as ConnectionPool
const rows = () => store.toolCalls({ orgId: store.user(ownerId)!.organization_id, limit: 50 })

beforeEach(() => {
  callTool.mockClear()
  db = new Database(':memory:'); runMigrations(db, ':memory:'); store = new Store(db); ownerId = ensureLocalOwner(store).id
  store.insertMachine({ user_id: ownerId, hostname: 'test', os: 'test', daemon_version: 'test' })
  serverId = store.insertServer({ ...base, user_id: ownerId, slug: 'atlassian', display_name: 'Atlassian', auth: 'none' }).id
  for (const name of ['addWorklogToJiraIssue', 'getJiraIssue', 'deleteEverything']) store.insertTool({ server_id: serverId, name, title: name, exposed_name: `atl_${name}`, description: '', input_schema: { type: 'object' }, definition_hash: name })
  worklogId = store.toolsOfServer(serverId).find(tool => tool.name === 'addWorklogToJiraIssue')!.id
})
afterEach(() => db.close())

it('llama con la identidad hub_effects y pasa la correlación al pool', async () => {
  const agent = ensureRunProfileAgent(store, ownerId, 'hub_effects')!
  const tools = createEffectTools(store, pool, ownerId, { runId: 'run-1', intentId: 'int-1' })
  expect(tools.enabled('addWorklogToJiraIssue')).toBe(true)
  await tools.call('addWorklogToJiraIssue', { issueIdOrKey: 'ABC-1' })
  expect(callTool).toHaveBeenCalledTimes(1)
  const [agentId, spec, name, , meta, trace] = callTool.mock.calls[0] as unknown as [string, { slug: string }, string, unknown, unknown, Record<string, string>]
  expect(agentId).toBe(agent.id)
  expect(spec.slug).toBe('atlassian')
  expect(name).toBe('addWorklogToJiraIssue')
  expect(meta).toBeUndefined()
  expect(trace).toMatchObject({ runId: 'run-1', intentId: 'int-1' })
  expect(trace['callId']).toMatch(/^[0-9a-f-]{36}$/)
})

it('una herramienta fuera de la cota del perfil se deniega sin llamar y deja una fila deny', async () => {
  ensureRunProfileAgent(store, ownerId, 'hub_effects')
  const tools = createEffectTools(store, pool, ownerId, { runId: 'run-1', intentId: 'int-1' })
  expect(tools.enabled('deleteEverything')).toBe(false)
  await expect(tools.call('deleteEverything', { x: 1 })).rejects.toBeInstanceOf(EffectToolDenied)
  expect(callTool).not.toHaveBeenCalled()
  expect(rows()[0]).toMatchObject({ decision: 'deny', denial_reason: 'tool_off', tool_name: 'deleteEverything', principal: 'hub_effects', run_id: 'run-1', intent_id: 'int-1' })
})

it('apagar la herramienta entre dos llamadas surte efecto en la segunda', async () => {
  ensureRunProfileAgent(store, ownerId, 'hub_effects')
  const tools = createEffectTools(store, pool, ownerId)
  await tools.call('addWorklogToJiraIssue', {})
  store.insertRule({ user_id: ownerId, agent_instance_id: null, resource_type: 'mcp_tool', resource_id: worklogId, state: 'off', reason: 'persona' })
  await expect(tools.call('addWorklogToJiraIssue', {})).rejects.toBeInstanceOf(EffectToolDenied)
  expect(callTool).toHaveBeenCalledTimes(1)
})

it('sin máquina registrada no hay identidad y todo se deniega', async () => {
  db.run('DELETE FROM machines')
  const tools = createEffectTools(store, pool, ownerId)
  expect(tools.enabled('getJiraIssue')).toBe(false)
  await expect(tools.call('getJiraIssue', {})).rejects.toMatchObject({ reason: 'no_identity' })
})
