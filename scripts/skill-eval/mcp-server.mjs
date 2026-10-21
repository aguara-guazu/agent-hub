#!/usr/bin/env node
// Stdio MCP adapter for the deterministic skill-eval Sandbox.  It deliberately
// implements only the small JSON-RPC surface the runner needs, so no live Hub
// endpoint, credentials, or production tool schema can enter an evaluation.
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { Sandbox, tools } from './sandbox.mjs';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const argument = (name, required = true) => {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (required && (!value || value.startsWith('--'))) throw new Error(`Missing ${name}`);
  return value;
};
const fixturePath = argument('--fixture');
const referencesPath = argument('--references');
const tracePath = argument('--trace');
const maxCalls = Number.parseInt(argument('--max-calls', false) ?? '100', 10);
if (!Number.isInteger(maxCalls) || maxCalls < 1) throw new Error('--max-calls must be a positive integer');

const [fixture, references] = await Promise.all([readJson(fixturePath), readJson(referencesPath)]);
const sandbox = new Sandbox(fixture, references);
const toolDescriptions = {
  memory_chat_join: 'Check the evaluation session identity.',
  memory_chat_inbox: 'Read pending evaluation notices once when appropriate.',
  memory_chat_work_list: 'Read the currently tracked evaluation work.',
  memory_chat_work_update: 'Record a bounded work state transition.',
  memory_chat_send: 'Send a report in the supplied evaluation thread.',
  memory_chat_ack: 'Acknowledge a handled evaluation notice.',
  memory_skill_reference: 'Retrieve an evaluation skill reference on demand.',
  memory_search: 'Search only the supplied evaluation project.',
  memory_get_evidence: 'Fetch a search result as evidence.',
};
const readOnlyTools = new Set(['memory_chat_inbox', 'memory_chat_work_list', 'memory_skill_reference', 'memory_search', 'memory_get_evidence']);
// These annotations describe this adapter only: every operation is confined to
// a per-run in-memory Sandbox plus its local trace, with no Hub or network
// connection. They do not alter Codex approval policy or confer production trust.
const toolAnnotations = name => ({
  destructiveHint: false,
  openWorldHint: false,
  readOnlyHint: readOnlyTools.has(name),
  idempotentHint: readOnlyTools.has(name),
});

async function persistTrace(extra = {}) {
  const value = JSON.stringify({ observations: sandbox.observations, violations: sandbox.violations, goals: [...sandbox.goals], ...extra });
  const temporary = `${tracePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, tracePath);
}
function toolList() {
  return Object.entries(tools).map(([name, inputSchema]) => ({
    name,
    description: toolDescriptions[name] ?? 'Evaluation-only sandbox tool.',
    inputSchema,
    annotations: toolAnnotations(name),
  }));
}
function reply(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
function failure(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`); }

let buffered = '';
let requestChain = Promise.resolve();
function enqueue(line) {
  requestChain = requestChain.then(() => handle(line)).catch(error => {
    // Never put diagnostics on stdout: it is the JSON-RPC transport.
    process.stderr.write(`skill-eval MCP error: ${error.message}\n`);
  });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffered += chunk;
  const lines = buffered.split('\n');
  buffered = lines.pop();
  for (const line of lines) enqueue(line);
});
process.stdin.on('end', () => { if (buffered.trim()) enqueue(buffered); });

async function handle(line) {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = request;
  if (method === 'initialize') {
    reply(id, { protocolVersion: params.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'agenthub-skill-eval-sandbox', version: '1.0.0' } });
    return;
  }
  if (method === 'ping') { reply(id, {}); return; }
  if (method === 'tools/list') { reply(id, { tools: toolList() }); return; }
  if (method !== 'tools/call') { if (id !== undefined) failure(id, -32601, `Unsupported method: ${method}`); return; }
  if (sandbox.observations.length >= maxCalls) {
    await persistTrace({ max_calls_reached: true });
    reply(id, { content: [{ type: 'text', text: JSON.stringify({ error: 'max-calls-exceeded' }) }], isError: true });
    return;
  }
  const result = sandbox.call(params.name, params.arguments ?? {});
  await persistTrace({ max_calls_reached: false });
  reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: Boolean(result.error) });
}

await persistTrace({ max_calls_reached: false });
