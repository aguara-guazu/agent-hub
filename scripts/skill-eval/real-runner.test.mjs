import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = { session_key: 'test-session', session_id: 'test-agent', thread_id: 'test-thread', project_id: 'test-project', work_id: 'test-work', guidance_version: 'test', team: { leader_id: 'test-leader' }, linked_team: null, work: null, inbox: [], available_references: [], disabled_tools: [], timeout_once: null, conflict_once: false };

test('MCP server exposes sandbox schemas and records exact sandbox observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'skill-eval-server-test-'));
  const fixturePath = join(directory, 'fixture.json'), refsPath = join(directory, 'references.json'), tracePath = join(directory, 'trace.json');
  await Promise.all([writeFile(fixturePath, JSON.stringify(fixture)), writeFile(refsPath, '{}')]);
  const child = spawn(process.execPath, [join(here, 'mcp-server.mjs'), '--fixture', fixturePath, '--references', refsPath, '--trace', tracePath, '--max-calls', '2'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', resolve));
  let received = ''; child.stdout.setEncoding('utf8').on('data', value => { received += value; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_chat_join', arguments: { session_key: fixture.session_key } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'memory_chat_inbox', arguments: { session_key: fixture.session_key, offset: 0, unread_only: true } } }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 100)); child.stdin.end(); await exited;
  const replies = received.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies[0].result.serverInfo.name, 'agenthub-skill-eval-sandbox');
  assert.ok(replies[1].result.tools.some(tool => tool.name === 'memory_chat_join' && tool.inputSchema.required.includes('session_key')));
  assert.equal(replies.length, 4);
  assert.deepEqual((await JSON.parse(await readFile(tracePath, 'utf8'))).observations.map(call => call.tool), ['memory_chat_join', 'memory_chat_inbox']);
  await rm(directory, { recursive: true, force: true });
});
