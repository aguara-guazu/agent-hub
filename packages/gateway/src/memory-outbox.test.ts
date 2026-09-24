import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryOutbox } from './memory-outbox.js'
import { recordLifecycle, sessionForCall, nativeSession } from './memory-lifecycle.js'
import { SnapshotView } from './policy.js'
import type { ConnectionPool } from './runtime.js'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'memory-delivery-test-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
function view(enabled = true) {
  return SnapshotView.fromSnapshot({ agent_instance_id: 'agent', cli_kind: 'codex_cli', servers: [
    { id: 'm', slug: 'memory', transport: 'http', url: 'http://localhost:8765/api/memory/mcp', tools: enabled ? ['sync_tasks','finish_notes'].map(name => ({ name, exposed_name: `memory_${name}` })) : [] },
    { id: 'j', slug: 'jira', transport: 'http', url: 'https://fixture.invalid/mcp', tools: ['getJiraIssue','getAccessibleAtlassianResources'].map(name=>({ name,exposed_name:`jira_${name}` })) },
  ] })
}
it('conserva entregas al fallar, reinicia y reintenta sólo lectura Jira + escritura local', async () => {
  const first = new MemoryOutbox(directory)
  const id = await first.enqueue({ operation: 'sync_tasks', args: { source: 'mcp_mirror' }, meta: {},
    reread: { server: 'jira', tool: 'getJiraIssue', args: { cloudId: 'cloud', issueIdOrKey: 'APP-1' } } })
  const callTool = vi.fn().mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ is_error: false, content: [{ type: 'text', text: JSON.stringify({ key: 'APP-1', fields: { summary: 'API', status: { name: 'Done' } } }) }] })
    .mockResolvedValue({ is_error: false, content: [{ type: 'text', text: '{"unmatched":[],"invalid":0}' }] })
  const pool = { callTool } as unknown as ConnectionPool
  await first.flush(() => view(), pool)
  expect(await first.pending()).toBe(1)
  const path = join(directory, `${id}.json`), data = JSON.parse(await readFile(path, 'utf8'))
  expect(data.attempts).toBe(1)
  await writeFile(path, JSON.stringify({ ...data, available_at: 0 }))
  const restarted = new MemoryOutbox(directory)
  await restarted.flush(() => view(), pool)
  expect(await restarted.pending()).toBe(0)
  expect(callTool.mock.calls.map(c => c[2])).toEqual(['getJiraIssue','getJiraIssue','sync_tasks'])
})
it('dos procesos de entrega no escriben simultáneamente y una política apagada no se saltea', async () => {
  const one = new MemoryOutbox(directory), two = new MemoryOutbox(directory)
  await one.enqueue({ operation: 'finish_notes', args: { reason: 'turn_end' }, meta: {} })
  const callTool = vi.fn(async () => ({ is_error: false, content: [] })), pool = { callTool } as unknown as ConnectionPool
  await one.flush(() => view(false), pool)
  expect(callTool).not.toHaveBeenCalled(); expect(await one.pending()).toBe(1)
  await Promise.all([one.flush(() => view(), pool), two.flush(() => view(), pool)])
  expect(callTool).toHaveBeenCalledTimes(1)
  expect(await one.pending()).toBe(0)
})
it('resuelve el sitio por cloud UUID antes de reflejar issues homónimos', async () => {
  const outbox = new MemoryOutbox(directory)
  await outbox.enqueue({ operation:'sync_tasks',args:{ issues:[{key:'APP-1'}] },meta:{},siteLookup:{server:'jira',tool:'getAccessibleAtlassianResources',cloudId:'cloud-b'} })
  const callTool = vi.fn().mockResolvedValueOnce({ is_error:false,content:[{type:'text',text:JSON.stringify([{id:'cloud-a',url:'https://a.atlassian.net'},{id:'cloud-b',url:'https://b.atlassian.net'}])}] })
    .mockResolvedValue({is_error:false,structured_content:{invalid:0,unmatched:[]}})
  await outbox.flush(()=>view(),{callTool} as unknown as ConnectionPool)
  expect(callTool.mock.calls[1]![3]).toMatchObject({site_url:'https://b.atlassian.net'})
  expect(await outbox.pending()).toBe(0)
})
it('usa sesión nativa sin guardar argumentos y cierra sólo esa sesión al terminar el turno', async () => {
  const event = { session_id: 'thread-a', cwd: '/project', hook_event_name: 'PreToolUse', tool_name: 'mcp__hub__memory_write_note', tool_input: { text: 'PRIVATE_NOTE' } }
  await recordLifecycle(directory, 'agent', 'codex_cli', event)
  const files = await readdir(join(directory, 'calls'))
  expect(await readFile(join(directory, 'calls', files[0]!), 'utf8')).not.toContain('PRIVATE_NOTE')
  const who = await sessionForCall(directory, 'memory_write_note', event.tool_input)
  expect(who).toEqual(nativeSession('agent','codex_cli','thread-a','/project'))
  expect(await sessionForCall(directory, 'memory_write_note', event.tool_input)).toBeUndefined()
  await recordLifecycle(directory, 'agent', 'codex_cli', { ...event, hook_event_name: 'Stop' })
  const callTool = vi.fn(async () => ({ is_error: false, content: [] }))
  await new MemoryOutbox(directory).flush(() => view(), { callTool } as unknown as ConnectionPool)
  expect(callTool).toHaveBeenCalledWith('agent', expect.anything(), 'finish_notes', { reason: 'turn_end', before: expect.any(String) }, { 'agenthub/agent': who })
})
it('no atribuye una llamada ambigua a la sesión de otro agente', async () => {
  for (const session_id of ['a','b']) await recordLifecycle(directory,'agent','claude_code',{ session_id, hook_event_name:'PreToolUse',tool_name:'mcp__hub__memory_context',tool_input:{} })
  expect(await sessionForCall(directory,'memory_context',{})).toBeUndefined()
})
it('reconoce el prefijo MCP de Gemini', async () => {
  await recordLifecycle(directory,'gemini','gemini_cli',{session_id:'s',hook_event_name:'BeforeTool',tool_name:'mcp_hub_memory_write_note',tool_input:{text:'Trabajando'}})
  expect(await sessionForCall(directory,'memory_write_note',{text:'Trabajando'})).toEqual(nativeSession('gemini','gemini_cli','s',undefined))
})
