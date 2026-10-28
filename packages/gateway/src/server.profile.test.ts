import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { PolicyStore, SnapshotView } from './policy.js'
import type { ConnectionPool } from './runtime.js'
import { GatewayServer, type ToolCallRecord } from './server.js'
import { collectingReporter } from './audit.js'

const AGENT = 'profile-agent'

const tool = (name: string) => ({ id: name, name, exposed_name: `x_${name}`, title: '', description: '', input_schema: { type: 'object', properties: {} }, definition_hash: `h-${name}` })
const server = (slug: string, tools: string[], url: string) => ({ id: slug, slug, display_name: slug, transport: 'http', command: '', args: [], env: {}, cwd: '', url, headers: {}, secret_refs: {}, tools: tools.map(tool) })

function snapshot(cliKind: string): Record<string, unknown> {
  return {
    agent_instance_id: AGENT, cli_kind: cliKind, snapshot_hash: `hash-${cliKind}`, generated_at: '2026-01-01T00:00:00Z', user_email: 'dev@craftech.io', skills: [], denied: [],
    servers: [
      server('memory', ['search', 'remember', 'schedule_create', 'run_report'], 'http://127.0.0.1:4010/api/memory/mcp'),
      server('atlassian', ['getJiraIssue', 'addWorklogToJiraIssue', 'deleteEverything'], 'https://mcp.atlassian.com/v1/mcp'),
    ],
  }
}

let gateway: GatewayServer | undefined
let client: Client | undefined
afterEach(async () => { await client?.close(); await gateway?.close(); gateway = client = undefined })

async function wire(cliKind: string, calls: string[], records: ToolCallRecord[]): Promise<Client> {
  const pool = { async callTool(_agent: string, _spec: unknown, name: string) { calls.push(name); return { content: [{ type: 'text', text: 'ok' }], is_error: false } } } as unknown as ConnectionPool
  const store = new PolicyStore(AGENT, SnapshotView.fromSnapshot(snapshot(cliKind)))
  gateway = new GatewayServer(AGENT, store, pool, { reporter: collectingReporter(records) })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'cli-de-prueba', version: '0.0.0' })
  await Promise.all([gateway.connect(serverTransport), client.connect(clientTransport)])
  return client
}

describe('GatewayServer: perfiles de run', () => {
  it('un cliente normal ve y llama todo lo que el snapshot expone', async () => {
    const calls: string[] = [], records: ToolCallRecord[] = []
    const c = await wire('claude_code', calls, records)
    expect((await c.listTools()).tools).toHaveLength(7)
    await c.callTool({ name: 'x_schedule_create', arguments: {} })
    expect(calls).toEqual(['schedule_create'])
  })
  it('el perfil action filtra tools/list aunque el snapshot traiga más', async () => {
    const calls: string[] = [], records: ToolCallRecord[] = []
    const c = await wire('hub_run_action', calls, records)
    expect((await c.listTools()).tools.map(item => item.name).sort()).toEqual(['x_run_report', 'x_search'])
  })
  it('el perfil action rechaza en tools/call una herramienta cacheada fuera de su capacidad, sin llamar al upstream, y lo audita', async () => {
    const calls: string[] = [], records: ToolCallRecord[] = []
    const c = await wire('hub_run_action', calls, records)
    for (const name of ['x_schedule_create', 'x_remember', 'x_addWorklogToJiraIssue', 'x_deleteEverything']) {
      const result = await c.callTool({ name, arguments: {} })
      expect(result.isError).toBe(true)
    }
    expect(calls).toEqual([])
    expect(records.map(record => record.decision)).toEqual(['deny', 'deny', 'deny', 'deny'])
    const allowed = await c.callTool({ name: 'x_search', arguments: {} })
    expect(allowed.isError).toBeFalsy()
    expect(calls).toEqual(['search'])
  })
  it('hub_effects no ve la memoria y solo las lecturas y escrituras exactas del ejecutor', async () => {
    const calls: string[] = [], records: ToolCallRecord[] = []
    const c = await wire('hub_effects', calls, records)
    expect((await c.listTools()).tools.map(item => item.name).sort()).toEqual(['x_addWorklogToJiraIssue', 'x_getJiraIssue'])
    expect((await c.callTool({ name: 'x_search', arguments: {} })).isError).toBe(true)
    expect(calls).toEqual([])
  })
})
