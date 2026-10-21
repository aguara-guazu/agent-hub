#!/usr/bin/env node
// Scores frozen holdouts without registering them in cases.mjs or exporting
// their goals to a model. The frozen file remains an external artifact.
import { readFile, writeFile } from 'node:fs/promises';
import { evaluatorHash, replay, validateManifest } from './evaluate.mjs';
import { canonical, hash } from './sandbox.mjs';

const usage = `Usage: node scripts/skill-eval/score-external.mjs /absolute/validation-public.json /absolute/validation-frozen.json /absolute/trace-bundle.json /absolute/report.json`;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const measure = value => value === null || (Number.isFinite(value) && value >= 0);
const publicView = ({ id, task, skills, fixture }) => ({ id, task, skills, fixture });

function verifyFreeze(publicScenarios, frozen) {
  assert(frozen?.protocol === 'hub-skill-compatible-holdout/v1', 'Unsupported frozen-holdout protocol');
  assert(Array.isArray(publicScenarios) && Array.isArray(frozen.scenarios) && Array.isArray(frozen.integrity), 'Invalid holdout inputs');
  assert(publicScenarios.length === frozen.scenarios.length && frozen.scenarios.length === frozen.integrity.length, 'Holdout scenario count mismatch');
  const records = new Map(frozen.integrity.map(record => [record.id, record]));
  for (const publicScenario of publicScenarios) {
    const frozenScenario = frozen.scenarios.find(scenario => scenario.id === publicScenario.id);
    const record = records.get(publicScenario.id);
    assert(frozenScenario && record, `Unrecognized external scenario: ${publicScenario.id}`);
    assert(canonical(publicView(frozenScenario)) === canonical(publicView(publicScenario)), `Public/frozen scenario differs: ${publicScenario.id}`);
    assert(hash(publicScenario.task) === record.task_sha256, `Frozen task hash mismatch: ${publicScenario.id}`);
    assert(hash(publicScenario.fixture) === record.fixture_sha256, `Frozen fixture hash mismatch: ${publicScenario.id}`);
    assert(Array.isArray(frozenScenario.goals), `Frozen goals unavailable: ${publicScenario.id}`);
  }
  return { input_sha256: frozen.input_sha256, public_sha256: hash(publicScenarios), frozen_scenarios_sha256: hash(frozen.scenarios), integrity_verified: true };
}
function rowFor(run, publicScenario, frozenScenario, manifest) {
  assert(run.fixture_sha256 === hash(publicScenario), `Fixture changed: ${run.scenario_id}`);
  assert(Number.isInteger(run.repeat) && run.repeat >= 0, 'repeat must be a nonnegative integer');
  assert(['model', 'fixture'].includes(run.source), 'source must distinguish model output from fixture selftests');
  assert(Object.hasOwn(run, 'duration_ms') && measure(run.duration_ms), 'Record measured duration_ms or null');
  const sandbox = replay(frozenScenario, run.calls, manifest);
  const missing = frozenScenario.goals.filter(goal => !sandbox.goals.has(goal));
  const violations = [...sandbox.violations];
  if (run.status && run.status !== 'completed') violations.push({ code: `runner-${run.status}`, call_index: null });
  if (run.failure?.kind) violations.push({ code: `runner-${run.failure.kind}`, call_index: null });
  for (const code of run.evaluation_violations ?? []) violations.push({ code, call_index: null });
  const tracks = frozenScenario.goals.some(goal => ['started', 'progress', 'completed', 'conflict-recovered'].includes(goal) || goal.startsWith('waiting:'));
  const reports = frozenScenario.goals.includes('report') || frozenScenario.goals.includes('completed');
  for (const [index, call] of sandbox.observations.entries()) {
    if ((call.tool === 'memory_chat_work_update' && !tracks) || (call.tool === 'memory_chat_send' && !reports) || (call.tool === 'memory_chat_ack' && !frozenScenario.goals.includes('ack'))) violations.push({ code: 'write-outside-task', call_index: index });
  }
  const waiting = frozenScenario.goals.find(goal => goal.startsWith('waiting:'));
  if (waiting && (sandbox.work?.status !== 'waiting' || sandbox.work?.waiting_for !== waiting.slice(8))) missing.push('final-wait-state');
  if (frozenScenario.goals.includes('completed') && sandbox.work?.status !== 'completed') missing.push('final-completed-state');
  if (!sandbox.joined) missing.push('identity-check');
  if (!sandbox.inboxRead) missing.push('inbox-check');
  return { scenario_id: run.scenario_id, repeat: run.repeat, source: run.source, passed: missing.length === 0 && violations.length === 0,
    missing_goals: missing, critical_violations: violations, calls: run.calls.length,
    errors: sandbox.observations.filter(call => call.result.error).map(call => call.result.error), duration_ms: run.duration_ms, usage: run.usage ?? null,
    status: run.status ?? 'unreported', failure: run.failure ?? null };
}

async function main(args) {
  if (args[0] === '--help' || args[0] === '-h') { console.log(usage); return; }
  if (args.length !== 4) throw new Error(usage);
  const [publicPath, frozenPath, bundlePath, outputPath] = args;
  const [publicScenarios, frozen, bundle] = await Promise.all([readJson(publicPath), readJson(frozenPath), readJson(bundlePath)]);
  const freeze = verifyFreeze(publicScenarios, frozen);
  validateManifest(bundle.manifest);
  assert(bundle.manifest.evaluator_sha256 === await evaluatorHash(), 'Evaluator changed; regenerate traces');
  assert(Array.isArray(bundle.runs) && bundle.runs.length > 0, 'At least one run is required');
  const seen = new Set();
  const rows = bundle.runs.map(run => {
    const key = `${run.scenario_id}:${run.repeat}`;
    assert(!seen.has(key), `Duplicate scenario/repeat: ${key}`); seen.add(key);
    const publicScenario = publicScenarios.find(scenario => scenario.id === run.scenario_id);
    const frozenScenario = frozen.scenarios.find(scenario => scenario.id === run.scenario_id);
    assert(publicScenario && frozenScenario, `Run is not in the frozen holdout: ${run.scenario_id}`);
    return rowFor(run, publicScenario, frozenScenario, bundle.manifest);
  });
  const result = { protocol: frozen.protocol, freeze, manifest: bundle.manifest, rows, summary: {
    runs: rows.length, scenarios: new Set(rows.map(row => row.scenario_id)).size, passed: rows.filter(row => row.passed).length,
    critical_violations: rows.reduce((sum, row) => sum + row.critical_violations.length, 0), calls: rows.reduce((sum, row) => sum + row.calls, 0),
    infrastructure_failures: rows.filter(row => row.failure?.kind === 'mcp-tool-error').length,
  }, limitations: ['Frozen goals were never placed in provider input. input_sha256 is preserved from the frozen artifact; per-scenario task and fixture hashes are verified against its integrity records.'] };
  await writeFile(outputPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output: outputPath, passed: result.summary.passed, runs: result.summary.runs, freeze }, null, 2));
}
main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
