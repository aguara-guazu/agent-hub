import { expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { GatewayServer } from './server.js'
import { PolicyStore } from './policy.js'
import type { CallResult, ConnectionPool, UpstreamSpec } from './runtime.js'
import { MEMORY_META_KEY } from './memory-bridge.js'

it.each([false, true])('relee la escritura Jira y refleja el resultado o avisa si memoria falla (%s)', async failed => {
  const agentId = 'test-agent', policy = new PolicyStore(agentId)
  const tool = (name: string, slug: string) => ({ id: name, name, exposed_name: `${slug}_${name}`, input_schema: { type: 'object' }, definition_hash: name })
  policy.apply({ agent_instance_id: agentId, cli_kind: 'codex_cli', snapshot_hash: 'test', servers: [
    { id: 'jira', slug: 'jira', transport: 'http', url: 'https://fixture.invalid/mcp', tools: ['transitionJiraIssue', 'getJiraIssue'].map(n => tool(n, 'jira')) },
    { id: 'memory', slug: 'memory', transport: 'http', url: 'http://127.0.0.1:8765/api/memory/mcp', tools: ['sync_tasks', 'finish_notes'].map(n => tool(n, 'memory')) },
  ] })
  const issue = { key: 'APP-1', fields: { summary: 'API', status: { name: 'Done', statusCategory: { key: 'done' } } } }
  const callTool = vi.fn(async (_agent: string, _spec: UpstreamSpec, name: string): Promise<CallResult> => {
    if (name === 'getJiraIssue') return { is_error: false, content: [{ type: 'text', text: JSON.stringify(issue) }] }
    if (name === 'sync_tasks') return { is_error: failed, content: [{ type: 'text', text: failed ? 'Unavailable' : '{"created":1,"unmatched":[]}' }] }
    return { is_error: false, content: [{ type: 'text', text: 'OK' }] }
  })
  const gateway = new GatewayServer(agentId, policy, { callTool } as unknown as ConnectionPool)
  const client = new Client({ name: 'fixture', version: '1' })
  const [c, s] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([gateway.connect(s), client.connect(c)])
    const result = await client.callTool({ name: 'jira_transitionJiraIssue', arguments: { cloudId: 'fixture-cloud', issueIdOrKey: 'APP-1', transition: { id: '1' } } })
    expect(result.isError).toBe(false)
    expect(callTool.mock.calls.map(c => c[2])).toEqual(['transitionJiraIssue', 'getJiraIssue', 'sync_tasks'])
    expect(callTool).toHaveBeenNthCalledWith(3, agentId, expect.anything(), 'sync_tasks', { issues: [issue], source: 'mcp_mirror' },
      { [MEMORY_META_KEY]: expect.objectContaining({ agent_id: agentId, cli_kind: 'codex_cli', client: 'fixture', session_id: expect.any(String) }) })
    expect(JSON.stringify(result).includes('No repitas el cambio en Jira')).toBe(failed)
    await gateway.close()
    expect(callTool).toHaveBeenLastCalledWith(agentId, expect.anything(), 'finish_notes', { reason: 'session_end' }, expect.anything())
  } finally { await client.close(); await gateway.close() }
})
