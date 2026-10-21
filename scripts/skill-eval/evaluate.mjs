import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { cases, getCase, publicCase } from './cases.mjs';
import { Sandbox, tools, hash, canonical } from './sandbox.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const measure = value => value === null || (Number.isFinite(value) && value >= 0);
export const protocol = 'hub-skill-eval/v1';
export async function evaluatorHash() {
  const files = ['cases.mjs', 'sandbox.mjs', 'evaluate.mjs'];
  return hash(await Promise.all(files.map(async name => ({ name, content: await readFile(new URL(name, import.meta.url), 'utf8') }))));
}
export async function makeManifest(spec) {
  const artifacts = await Promise.all(spec.artifacts.map(async ({ name, kind, path }) => {
    const content = await readFile(path, 'utf8');
    return { name, kind, content, sha256: hash(content) };
  }));
  return { protocol, variant: spec.variant, model: spec.model, client: spec.client, artifacts,
    schema_sha256: hash(tools), evaluator_sha256: await evaluatorHash() };
}
export function validateManifest(manifest) {
  assert(manifest?.protocol === protocol && nonempty(manifest.variant), 'Invalid protocol/variant');
  assert(nonempty(manifest.model?.id) && nonempty(manifest.model?.provider), 'Exact model id/provider required');
  assert(Object.hasOwn(manifest.model, 'effort') && (manifest.model.effort === null || nonempty(manifest.model.effort)), 'Record effort, or null if unavailable');
  assert(nonempty(manifest.client?.name) && nonempty(manifest.client?.version), 'Exact client name/version required');
  assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, 'Record exact skill/prompt/schema artifacts');
  const names = new Set();
  for (const artifact of manifest.artifacts) {
    assert(nonempty(artifact.name) && !names.has(artifact.name), 'Artifact names must be unique');
    names.add(artifact.name);
    assert(['skill', 'prompt', 'schema', 'reference'].includes(artifact.kind), 'Invalid artifact kind');
    assert(typeof artifact.content === 'string' && hash(artifact.content) === artifact.sha256, `Artifact hash mismatch: ${artifact.name}`);
  }
  assert(manifest.schema_sha256 === hash(tools), 'Sandbox schema changed; regenerate inputs');
}
export function exportInputs(manifest) {
  validateManifest(manifest);
  return { manifest, tools, inputs: cases.map(scenario => ({ ...publicCase(scenario), fixture_sha256: hash(publicCase(scenario)) })),
    trace_contract: {
      envelope: '{ manifest, runs: [...] }',
      run: '{ scenario_id, fixture_sha256, repeat (integer >= 0), source (model|fixture), calls, duration_ms (number|null), usage (object|null) }',
      call: '{ tool, args, result (exact sandbox response), latency_ms (number|null) }',
      usage: '{ source: "provider", input_tokens, output_tokens, cached_input_tokens (integer|null) }',
      note: 'Use Sandbox.call or CLI step to obtain responses; never call live tools. Inject task + requested skills + tools into the model, not this entire envelope. Reference artifacts are returned on demand. Import traces honestly; metadata is recorded, not provider-authenticated.',
    } };
}
export function references(manifest) {
  return Object.fromEntries(manifest.artifacts.filter(a => ['skill', 'reference'].includes(a.kind)).map(a => [a.name, a.content]));
}
export function replay(scenario, calls, manifest, requireResults = true) {
  assert(Array.isArray(calls) && calls.length <= 1000, 'calls must be an array of at most 1000 requests');
  const sandbox = new Sandbox(scenario.fixture, references(manifest));
  for (const [index, call] of calls.entries()) {
    assert(nonempty(call.tool) && call.args && typeof call.args === 'object', `Malformed call ${index}`);
    const result = sandbox.call(call.tool, call.args);
    if (requireResults) {
      assert(Object.hasOwn(call, 'result') && canonical(call.result) === canonical(result), `Recorded sandbox result mismatch at call ${index}`);
      assert(Object.hasOwn(call, 'latency_ms') && measure(call.latency_ms), `Record call latency or null: ${index}`);
    }
  }
  return sandbox;
}
export async function score(bundle) {
  validateManifest(bundle.manifest);
  assert(bundle.manifest.evaluator_sha256 === await evaluatorHash(), 'Evaluator/oracle changed; refusing cross-version scoring');
  assert(Array.isArray(bundle.runs) && bundle.runs.length > 0, 'At least one run is required');
  const keys = new Set();
  const rows = bundle.runs.map(run => {
    const scenario = getCase(run.scenario_id);
    assert(run.fixture_sha256 === hash(publicCase(scenario)), `Fixture changed: ${run.scenario_id}`);
    assert(Number.isInteger(run.repeat) && run.repeat >= 0, 'repeat must be a nonnegative integer');
    assert(['model', 'fixture'].includes(run.source), 'source must distinguish model output from fixture selftests');
    const key = `${run.scenario_id}:${run.repeat}`;
    assert(!keys.has(key), `Duplicate scenario/repeat: ${key}`); keys.add(key);
    assert(Object.hasOwn(run, 'duration_ms') && measure(run.duration_ms), 'Record measured duration_ms or null');
    assert(Object.hasOwn(run, 'usage'), 'Record usage or null; never estimate tokens from characters');
    if (run.usage !== null) {
      assert(run.usage.source === 'provider', 'Token counts must come from the provider');
      for (const name of ['input_tokens', 'output_tokens']) assert(Number.isInteger(run.usage[name]) && run.usage[name] >= 0, `Invalid ${name}`);
      assert(run.usage.cached_input_tokens === null || (Number.isInteger(run.usage.cached_input_tokens) && run.usage.cached_input_tokens >= 0 && run.usage.cached_input_tokens <= run.usage.input_tokens), 'Invalid cached input tokens');
    }
    const sandbox = replay(scenario, run.calls, bundle.manifest);
    const missing = scenario.goals.filter(goal => !sandbox.goals.has(goal));
    const violations=[...sandbox.violations];
    const tracks=scenario.goals.some(goal=>['started','progress','completed','conflict-recovered'].includes(goal)||goal.startsWith('waiting:'));
    const reports=scenario.goals.includes('report')||scenario.goals.includes('completed');
    for(const [index,call] of sandbox.observations.entries()) {
      if((call.tool==='memory_chat_work_update'&&!tracks)||(call.tool==='memory_chat_send'&&!reports)||
         (call.tool==='memory_chat_ack'&&!scenario.goals.includes('ack')))violations.push({code:'write-outside-task',call_index:index});
    }
    const waiting=scenario.goals.find(goal=>goal.startsWith('waiting:'));
    if(waiting&&(sandbox.work?.status!=='waiting'||sandbox.work?.waiting_for!==waiting.slice(8)))missing.push('final-wait-state');
    if(scenario.goals.includes('completed')&&sandbox.work?.status!=='completed')missing.push('final-completed-state');
    if (!sandbox.joined) missing.push('identity-check');
    if (!sandbox.inboxRead) missing.push('inbox-check');
    return { key, scenario_id: run.scenario_id, repeat: run.repeat, fixture_sha256: run.fixture_sha256, source: run.source,
      passed: missing.length === 0 && violations.length === 0,
      missing_goals: missing, critical_violations: violations, calls: run.calls.length,
      errors: sandbox.observations.filter(call => call.result.error).map(call => call.result.error),
      duration_ms: run.duration_ms, usage: run.usage };
  });
  const measured = rows.filter(row => row.usage !== null);
  return { protocol, manifest: bundle.manifest, rows, summary: {
    runs: rows.length, scenarios: new Set(rows.map(row => row.scenario_id)).size,
    passed: rows.filter(row => row.passed).length, critical_violations: rows.reduce((n, row) => n + row.critical_violations.length, 0),
    calls: rows.reduce((n, row) => n + row.calls, 0), tool_errors: rows.reduce((n, row) => n + row.errors.length, 0),
    model_runs: rows.filter(row => row.source === 'model').length,
    token_coverage: `${measured.length}/${rows.length}`,
    measured_input_tokens: measured.length ? measured.reduce((n, row) => n + row.usage.input_tokens, 0) : null,
    measured_output_tokens: measured.length ? measured.reduce((n, row) => n + row.usage.output_tokens, 0) : null,
  }, limitations: [
    'Synthetic regression fixtures, not a blind holdout or production incident evidence.',
    'Sandbox contracts cover a subset of Hub behavior; no live tool execution or transport integration is validated.',
    'Report prose correctness, honesty of progress, and semantic task quality require independent human review.',
    'Recorded model/client/effort and provider usage are asserted by the trace importer, not independently authenticated.',
  ] };
}
export async function compare(baseline, candidate) {
  const [before, after] = await Promise.all([score(baseline), score(candidate)]);
  assert(canonical(before.manifest.model) === canonical(after.manifest.model), 'Compare prompt variants within the same model/effort; score different models separately');
  assert(canonical(before.manifest.client) === canonical(after.manifest.client), 'Client/version must match for a paired prompt comparison');
  const lookup = new Map(before.rows.map(row => [row.key, row]));
  assert(before.rows.length === after.rows.length, 'Baseline and candidate must cover the same scenario/repeat pairs');
  const pairs = after.rows.map(row => {
    const previous = lookup.get(row.key);
    assert(previous && previous.fixture_sha256 === row.fixture_sha256 && previous.source === row.source, `Unmatched fixture/source: ${row.key}`);
    return { key: row.key, baseline_passed: previous.passed, candidate_passed: row.passed,
      critical_delta: row.critical_violations.length - previous.critical_violations.length,
      call_delta: row.calls - previous.calls,
      duration_delta_ms: row.duration_ms === null || previous.duration_ms === null ? null : row.duration_ms - previous.duration_ms,
      input_token_delta: row.usage === null || previous.usage === null ? null : row.usage.input_tokens - previous.usage.input_tokens,
      output_token_delta: row.usage === null || previous.usage === null ? null : row.usage.output_tokens - previous.usage.output_tokens };
  });
  return { protocol, baseline: before.summary, candidate: after.summary, pairs,
    improvements: pairs.filter(p => !p.baseline_passed && p.candidate_passed).length,
    regressions: pairs.filter(p => p.baseline_passed && !p.candidate_passed).length,
    interpretation: 'Descriptive paired regression results only. Repetitions are not independent scenarios. No automatic prompt promotion; review critical failures and use new withheld cases before deployment.' };
}
