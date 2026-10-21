#!/usr/bin/env node
// Executes real CLI evaluations against only mcp-server.mjs.  Results are
// intentionally written outside the checkout and retain failures as runs.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCase, publicCase } from './cases.mjs';
import { exportInputs, makeManifest, protocol } from './evaluate.mjs';
import { hash } from './sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const defaultOutput = '/tmp/agenthub-skill-eval-real';
const usage = `Usage: node scripts/skill-eval/real-runner.mjs --spec /absolute/spec.json --out /tmp/agenthub-skill-eval-real/run \\
  --provider codex --model exact-model-id [--effort high] [--cases finish,idle] [--scenario-file /absolute/cases.json] \\
  [--repeats 1] [--timeout-ms 180000] [--max-calls 80] [--concurrency 1] [--smoke]

The runner creates one fresh ephemeral CLI process per case/repeat. It passes no
approval or bypass flags. Codex is started with --sandbox read-only,
--ignore-user-config and exactly one stdio MCP server: the local deterministic
sandbox.
All output paths must be outside the repository. --smoke validates the local
MCP protocol without calling a model. External scenarios follow {id,task,skills,fixture};
their traces follow the contract but cannot be scored by the frozen in-repo scorer
until that scenario is independently made available to it.`;

function parse(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i++) {
    const part = argv[i];
    if (!part.startsWith('--')) throw new Error(`Unexpected argument: ${part}`);
    if (part === '--help') return { help: true };
    if (part === '--smoke') { values.set(part, true); continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${part}`);
    values.set(part, value);
  }
  const integer = (name, fallback) => {
    const value = Number.parseInt(values.get(name) ?? String(fallback), 10);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const result = {
    spec: values.get('--spec'), out: values.get('--out') ?? defaultOutput, provider: values.get('--provider'), model: values.get('--model'),
    effort: values.has('--effort') ? values.get('--effort') : undefined, cases: values.get('--cases'), scenarioFile: values.get('--scenario-file'),
    repeats: integer('--repeats', 1), timeoutMs: integer('--timeout-ms', 180000), maxCalls: integer('--max-calls', 80), concurrency: integer('--concurrency', 1), smoke: Boolean(values.get('--smoke')),
  };
  if (!result.spec || !result.provider || !result.model) throw new Error('--spec, --provider and --model are required');
  if (!isAbsolute(result.out)) throw new Error('--out must be an absolute path outside the repository');
  if (result.provider !== 'codex') throw new Error(`Unsupported provider: ${result.provider} (currently only codex)`);
  if (result.concurrency > 8) throw new Error('--concurrency may not exceed 8');
  if (result.maxCalls > 1000) throw new Error('--max-calls may not exceed 1000');
  if (result.timeoutMs > 1800000) throw new Error('--timeout-ms may not exceed 1800000');
  return result;
}
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function forbiddenOutput(path) {
  const repo = await realpath(resolve(here, '../..'));
  const target = resolve(path);
  return target === repo || target.startsWith(`${repo}/`);
}
function usageFromEvents(text) {
  const events = [];
  for (const line of text.split('\n')) { try { if (line.trim()) events.push(JSON.parse(line)); } catch {} }
  const candidates = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Number.isInteger(value.input_tokens) && Number.isInteger(value.output_tokens)) candidates.push(value);
    for (const child of Object.values(value)) visit(child);
  };
  events.forEach(visit);
  const item = candidates.at(-1);
  return item ? { source: 'provider', input_tokens: item.input_tokens, output_tokens: item.output_tokens,
    cached_input_tokens: Number.isInteger(item.cached_input_tokens) ? item.cached_input_tokens : null } : null;
}
function modelFromEvents(text) {
  const models = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.model === 'string') models.push(value.model);
    for (const child of Object.values(value)) visit(child);
  };
  for (const line of text.split('\n')) { try { if (line.trim()) visit(JSON.parse(line)); } catch {} }
  return models.at(-1) ?? null;
}
function mcpErrorsFromEvents(text) {
  const errors = [];
  for (const line of text.split('\n')) {
    try {
      const item = JSON.parse(line)?.item;
      // A sandbox operation may intentionally return an isError result (such
      // as conflict, disabled capability, or simulated transport timeout).
      // Those calls have a result. Approval/transport rejection fails before
      // the adapter responds and therefore has item.error or no result.
      if (item?.type !== 'mcp_tool_call' || (!item.error && !(item.status === 'failed' && item.result == null))) continue;
      errors.push({ server: item.server ?? null, tool: item.tool ?? null, message: item.error?.message ?? 'MCP tool call failed', status: item.status ?? null });
    } catch {}
  }
  return errors;
}
function toolViolationsFromEvents(text) {
  const violations = new Set();
  const builtin = new Set(['command_execution', 'file_change', 'web_search', 'web_fetch', 'computer_call', 'shell', 'bash']);
  const inspect = value => {
    if (!value || typeof value !== 'object') return;
    const type = typeof value.type === 'string' ? value.type.toLowerCase() : '';
    if (builtin.has(type) || /(^|_)(command|shell|bash|file|web|computer)(_|$)/.test(type)) violations.add(`builtin-tool:${type}`);
    if (type.includes('mcp')) {
      const identity = [value.server, value.server_name, value.mcp_server, value.name, value.tool_name].filter(v => typeof v === 'string').join(' ').toLowerCase();
      if (!identity.includes('skill_eval')) violations.add(`non-sandbox-mcp:${identity || 'unattributed'}`);
    }
    for (const child of Object.values(value)) inspect(child);
  };
  for (const line of text.split('\n')) { try { if (line.trim()) inspect(JSON.parse(line)); } catch {} }
  return [...violations];
}
function runProcess(command, args, options, timeoutMs) {
  return new Promise(resolveResult => {
    const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, spawnError = null;
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => { spawnError = error; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, timeoutMs);
    child.on('close', (exitCode, signal) => { clearTimeout(timer); resolveResult({ stdout, stderr, timedOut, spawnError: spawnError?.message ?? null, exitCode, signal }); });
    child.stdin.end(options.input ?? '');
  });
}
function modelPrompt(scenario, artifactMap) {
  const suppliedSkills = scenario.skills.map(name => artifactMap.get(name)).filter(Boolean).map(artifact => `## ${artifact.name}\n${artifact.content}`).join('\n\n');
  // Fixture controls (timeouts, disabled tools, expected behavior and current
  // inbox/work state) intentionally remain server-side. The model learns those
  // only through tool responses, as it would in a real session.
  const { session_key, session_id, thread_id, project_id, work_id } = scenario.fixture;
  const context = { session_key, session_id, thread_id, project_id, work_id };
  return `You are completing one isolated Agent Hub behavior evaluation. Use the supplied local MCP sandbox tools to perform this task. Do not use shell, files, network, other MCP servers, or guess tool results. Do not request more work or poll.\n\nTask:\n${scenario.task}\n\nKnown startup identifiers (not current state or authorization):\n${JSON.stringify(context)}\n\nRecover current team scope, guidance, inbox, and work state through the MCP tools; do not treat cached metadata as verified.\n\nExact supplied skills:\n${suppliedSkills || '[No skill text is supplied. Retrieve an allowed reference only if needed.]'}\n\nYour final response is not scored; perform the task through the MCP tools.`;
}
async function loadScenarios(options) {
  const named = options.cases ? options.cases.split(',').filter(Boolean).map(id => publicCase(getCase(id))) : [];
  const external = options.scenarioFile ? await json(options.scenarioFile) : [];
  const externalList = Array.isArray(external) ? external : external.scenarios;
  if (!Array.isArray(externalList)) throw new Error('--scenario-file must contain an array or {scenarios: []}');
  for (const scenario of [...named, ...externalList]) {
    if (!scenario?.id || !scenario.task || !Array.isArray(scenario.skills) || !scenario.fixture) throw new Error('Every scenario needs id, task, skills and fixture');
  }
  if (!named.length && !externalList.length) throw new Error('Choose --cases and/or --scenario-file');
  const ids = new Set();
  for (const scenario of [...named, ...externalList]) { if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`); ids.add(scenario.id); }
  return [...named, ...externalList];
}
async function runSmoke(out) {
  const fixture = { session_key: 'smoke-session', session_id: 'smoke-agent', thread_id: 'smoke-thread', project_id: 'smoke-project', work_id: 'smoke-work', guidance_version: 'smoke', team: { leader_id: 'smoke-leader' }, linked_team: null, work: null, inbox: [], available_references: [], disabled_tools: [], timeout_once: null, conflict_once: false };
  const fixturePath = join(out, 'smoke-fixture.json'), refsPath = join(out, 'smoke-references.json'), tracePath = join(out, 'smoke-trace.json');
  await Promise.all([writeFile(fixturePath, JSON.stringify(fixture)), writeFile(refsPath, '{}')]);
  const child = spawn(process.execPath, [join(here, 'mcp-server.mjs'), '--fixture', fixturePath, '--references', refsPath, '--trace', tracePath, '--max-calls', '2'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolveDone => child.once('close', resolveDone));
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; }); child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_chat_join', arguments: { session_key: fixture.session_key } } })}\n`);
  await new Promise(resolveDone => setTimeout(resolveDone, 120)); child.stdin.end();
  await exited;
  const replies = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const trace = await json(tracePath);
  const passed = !stderr && replies.length === 3 && replies[1]?.result?.tools?.some(tool => tool.name === 'memory_chat_join') && trace.observations.length === 1;
  return { passed, replies: replies.length, observations: trace.observations.length, stderr: stderr || null };
}
async function oneRun(job, context) {
  const started = performance.now();
  const runId = `${job.scenario.id}-${job.repeat}-${randomUUID()}`;
  const folder = join(context.out, 'runs', runId);
  await mkdir(folder, { recursive: true });
  const fixturePath = join(folder, 'fixture.json'), referencesPath = join(folder, 'references.json'), tracePath = join(folder, 'mcp-trace.json'), stdoutPath = join(folder, 'provider.stdout.jsonl'), stderrPath = join(folder, 'provider.stderr.log');
  await Promise.all([writeFile(fixturePath, JSON.stringify(job.scenario.fixture)), writeFile(referencesPath, JSON.stringify(context.references))]);
  const isolatedCwd = await mkdtemp(join(tmpdir(), 'agenthub-skill-eval-codex-'));
  const serverArgs = [join(here, 'mcp-server.mjs'), '--fixture', fixturePath, '--references', referencesPath, '--trace', tracePath, '--max-calls', String(context.options.maxCalls)];
  // This is a new `codex exec` process for every run. --ignore-user-config
  // prevents the product Hub MCP configuration from being inherited, the empty
  // non-Git cwd needs the explicit repo-check exception, and read-only limits
  // the evaluation. Auth still follows Codex's native handling; no approval or
  // bypass flags pass.
  const prompt = modelPrompt(job.scenario, context.artifactMap);
  const args = ['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--model', context.options.model, '--cd', isolatedCwd,
    '-c', `mcp_servers.skill_eval.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.skill_eval.args=${JSON.stringify(serverArgs)}`];
  if (context.options.effort !== null) args.push('-c', `model_reasoning_effort=${JSON.stringify(context.options.effort)}`);
  args.push(prompt);
  let outcome;
  try { outcome = await runProcess('codex', args, {}, context.options.timeoutMs); } catch (error) { outcome = { stdout: '', stderr: '', timedOut: false, spawnError: error.message, exitCode: null, signal: null }; }
  await Promise.all([writeFile(stdoutPath, outcome.stdout), writeFile(stderrPath, outcome.stderr)]);
  const trace = await exists(tracePath) ? await json(tracePath) : { observations: [] };
  await rm(isolatedCwd, { recursive: true, force: true });
  const toolViolations = toolViolationsFromEvents(outcome.stdout);
  const mcpErrors = mcpErrorsFromEvents(outcome.stdout);
  const failure = outcome.timedOut ? { kind: 'timeout', message: `Exceeded ${context.options.timeoutMs}ms` }
    : outcome.spawnError ? { kind: 'spawn', message: outcome.spawnError }
    : outcome.exitCode !== 0 ? { kind: 'provider-exit', exit_code: outcome.exitCode, signal: outcome.signal }
    : mcpErrors.length ? { kind: 'mcp-tool-error', classification: 'infrastructure', errors: mcpErrors }
    : trace.max_calls_reached ? { kind: 'max-calls', message: `Reached ${context.options.maxCalls} sandbox calls` }
    : toolViolations.length ? { kind: 'evaluation-tool-violation', violations: toolViolations } : null;
  return { scenario_id: job.scenario.id, fixture_sha256: hash(job.scenario), repeat: job.repeat, source: 'model', calls: trace.observations.map(call => ({ ...call, latency_ms: null })),
    duration_ms: Math.round(performance.now() - started), usage: usageFromEvents(outcome.stdout), provider_model: modelFromEvents(outcome.stdout), prompt_sha256: hash(prompt), provider_mcp_errors: mcpErrors, evaluation_violations: toolViolations, status: failure ? 'failed' : 'completed', failure,
    artifacts: { provider_stdout_jsonl: stdoutPath, provider_stderr: stderrPath, mcp_trace: tracePath } };
}
async function pooled(items, limit, work) {
  const results = new Array(items.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const current = index++; if (current >= items.length) return; results[current] = await work(items[current]); }
  }));
  return results;
}
async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) { console.log(usage); return; }
  if (await forbiddenOutput(options.out)) throw new Error('--out must be outside the repository');
  await mkdir(options.out, { recursive: true });
  const smoke = await runSmoke(options.out);
  if (!smoke.passed) throw new Error(`Local MCP smoke failed: ${JSON.stringify(smoke)}`);
  if (options.smoke) { console.log(JSON.stringify({ protocol, smoke, model_called: false }, null, 2)); return; }
  const spec = await json(options.spec);
  spec.model = { provider: options.provider, id: options.model, effort: options.effort ?? spec.model?.effort ?? null };
  spec.client = { name: 'codex-cli', version: (await runProcess('codex', ['--version'], {}, 10000)).stdout.trim() || 'unknown' };
  const manifest = await makeManifest(spec); const exported = exportInputs(manifest);
  const scenarios = await loadScenarios(options);
  const references = Object.fromEntries(manifest.artifacts.filter(item => ['skill', 'reference'].includes(item.kind)).map(item => [item.name, item.content]));
  const context = { options: { ...options, effort: spec.model.effort }, out: options.out, references, artifactMap: new Map(manifest.artifacts.map(item => [item.name, item])) };
  await writeFile(join(options.out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(options.out, 'provider-inputs.json'), JSON.stringify({ inputs: exported.inputs, selected: scenarios.map(scenario => ({ id: scenario.id, task: scenario.task, skills: scenario.skills, fixture_sha256: hash(scenario) })) }, null, 2));
  const jobs = scenarios.flatMap(scenario => Array.from({ length: options.repeats }, (_, repeat) => ({ scenario, repeat })));
  const runs = await pooled(jobs, options.concurrency, job => oneRun(job, context));
  const [runnerSource, mcpSource] = await Promise.all([readFile(fileURLToPath(import.meta.url), 'utf8'), readFile(join(here, 'mcp-server.mjs'), 'utf8')]);
  const bundle = { manifest, runs, runner: { version: '1.0.0', provider: options.provider, timeout_ms: options.timeoutMs, max_calls: options.maxCalls, concurrency: options.concurrency, stdout_format: 'provider-jsonl', isolation: 'ephemeral codex exec; skip-git-repo-check; sandbox read-only; ignore-user-config; only local stdio MCP', runner_sha256: hash(runnerSource), mcp_server_sha256: hash(mcpSource) } };
  await writeFile(join(options.out, 'trace-bundle.json'), JSON.stringify(bundle, null, 2));
  console.log(JSON.stringify({ protocol, output: options.out, runs: runs.map(run => ({ scenario_id: run.scenario_id, repeat: run.repeat, status: run.status, calls: run.calls.length, failure: run.failure })), smoke }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
