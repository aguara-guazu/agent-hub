import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Database } from '../src/db/database.js'
import { runMigrations } from '../src/db/migrations.js'
import { Store } from '../src/store.js'
import { ensureLocalOwner } from '../src/local.js'
import { createJiraTaskReader } from '../src/memory-jira.js'
import type { ConnectionPool, OAuthStore } from '@agenthub/gateway'

let db: Database, store: Store, ownerId: string, serverId: string, searchId: string
const SEARCH = 'searchJiraIssuesUsingJql'
const resource = (site = 'example') => ({ id: `${site}-cloud`, url: `https://${site}.atlassian.net`, scopes: ['read:jira-work'] })
const response = (value: unknown) => ({ is_error: false, content: [{ type: 'text', text: JSON.stringify(value) }] })
const request = { key: 'EGA', site: 'https://example.atlassian.net' }
beforeEach(() => {
  db = new Database(':memory:'); runMigrations(db, ':memory:'); store = new Store(db); ownerId = ensureLocalOwner(store).id
  serverId = store.insertServer({ user_id: ownerId, slug: 'jira', display_name: 'Jira', description: '', transport: 'http', auth: 'oauth',
    url: 'https://fixture.invalid/mcp', command: '', args: [], env: {}, cwd: '', headers: {}, secret_refs: {}, requires_host_access: false,
    container_image: '', allow_hosts: [], allow_ports: [], read_mounts: [], write_mounts: [] }).id
  for (const name of [SEARCH, 'getAccessibleAtlassianResources']) store.insertTool({ server_id: serverId, name, title: name, exposed_name: `jira_${name}`, description: '', input_schema: { type: 'object' }, definition_hash: name })
  searchId = store.toolsOfServer(serverId).find(t => t.name === SEARCH)!.id
})
afterEach(() => db.close())
function reader(callTool: ReturnType<typeof vi.fn>) { return createJiraTaskReader(store, ownerId, { callTool } as unknown as ConnectionPool, { hasTokens: () => true } as unknown as OAuthStore) }
function deny(resourceId: string, agentId: string | null = null) { store.insertRule({ user_id: ownerId, agent_instance_id: agentId, resource_type: 'mcp_tool', resource_id: resourceId, state: 'off', reason: 'test' }) }

it('usa la cuenta conectada, resuelve el sitio y recorre todas las páginas sin escribir en Jira', async () => {
  const call = vi.fn().mockResolvedValueOnce(response([resource()]))
    .mockResolvedValueOnce(response({ issues: Array.from({ length: 100 }, (_, i) => ({ key: `EGA-${i + 1}` })), isLast: false, nextPageToken: 'page2' }))
    .mockResolvedValueOnce(response({ issues: [{ key: 'EGA-101' }], isLast: true }))
  const pages = vi.fn(async () => {})
  await reader(call)(request, pages)
  expect(pages.mock.calls.map(args => (args as unknown as [unknown[]])[0].length)).toEqual([100, 1])
  expect(call.mock.calls.map(args => args[2])).toEqual(['getAccessibleAtlassianResources', SEARCH, SEARCH])
  expect(call.mock.calls[2]![3]).toMatchObject({ cloudId: 'example-cloud', jql: 'project = "EGA" ORDER BY key ASC', nextPageToken: 'page2' })
})
it('requiere elegir el sitio cuando la cuenta tiene varios', async () => {
  const call = vi.fn().mockResolvedValue(response([resource(), resource('other')]))
  await expect(reader(call)({ key: 'EGA', site: null }, async () => {})).rejects.toThrow('varios sitios')
  expect(call).toHaveBeenCalledTimes(1)
})
it.each(['off', 'quarantine'])('no usa una herramienta en %s', async mode => {
  if (mode === 'off') deny(searchId); else store.updateTool(searchId, { quarantined: true })
  const call = vi.fn()
  await expect(reader(call)(request, async () => {})).rejects.toMatchObject({ statusCode: 409 })
  expect(call).not.toHaveBeenCalled()
})
it('respeta la política del agente y vuelve a comprobar OFF entre páginas', async () => {
  const machine = store.insertMachine({ user_id: ownerId, hostname: 'test', os: 'test', daemon_version: 'test' })
  const agent = store.insertAgent({ machine_id: machine.id, cli_kind: 'codex_cli', cli_version: 'test', config_path: '' })
  deny(searchId, agent.id)
  const call = vi.fn().mockResolvedValueOnce(response([resource()])).mockResolvedValue(response({ issues: [], isLast: false, nextPageToken: 'next' }))
  await expect(reader(call)({ ...request, agentId: agent.id }, async () => {})).rejects.toMatchObject({ statusCode: 409 })
  expect(call).not.toHaveBeenCalled()
  await expect(reader(call)(request, async () => { deny(searchId) })).rejects.toMatchObject({ statusCode: 403 })
  expect(call).toHaveBeenCalledTimes(2)
})
it('no anuncia éxito si Jira repite el cursor o entrega una página inválida', async () => {
  const call = vi.fn().mockResolvedValueOnce(response([resource()])).mockResolvedValue(response({ issues: [], isLast: false, nextPageToken: 'same' }))
  await expect(reader(call)(request, async () => {})).rejects.toThrow('repitió un cursor')
  call.mockReset().mockResolvedValueOnce(response([resource()])).mockResolvedValue(response({ message: 'invalid' }))
  await expect(reader(call)(request, async () => {})).rejects.toThrow('página de issues válida')
})
