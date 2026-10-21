#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getCase } from './cases.mjs';
import { compare, evaluatorHash, exportInputs, makeManifest, replay, score, validateManifest } from './evaluate.mjs';

const help = `Hub skill behavior evaluation — offline sandbox, no model/API calls

node scripts/skill-eval/cli.mjs selftest
node scripts/skill-eval/cli.mjs export /absolute/spec.json
node scripts/skill-eval/cli.mjs step /absolute/partial-trace.json
node scripts/skill-eval/cli.mjs score /absolute/trace-bundle.json
node scripts/skill-eval/cli.mjs compare /absolute/baseline.json /absolute/candidate.json

All commands write JSON (selftest: TAP) to stdout. Keep results outside the repo.
spec.json:
{
  "variant": "baseline",
  "model": {"provider": "exact-provider", "id": "exact-model-id", "effort": null},
  "client": {"name": "exact-runner-name", "version": "exact-version"},
  "artifacts": [
    {"name":"local-collaboration","kind":"skill","path":"/absolute/SKILL.md"},
    {"name":"memory","kind":"skill","path":"/absolute/memory.md"},
    {"name":"memory-tools","kind":"reference","path":"/absolute/reference.md"},
    {"name":"system","kind":"prompt","path":"/absolute/system.txt"},
    {"name":"hub-mcp","kind":"schema","path":"/absolute/captured-tool-schemas.json"}
  ]
}

export snapshots the exact UTF-8 artifacts, hashes, public tasks and sandbox schemas.
Pass only each task, fixture, requested skills, prompts and schemas to your model.
Keep reference artifacts for on-demand tool responses. No oracles are exported.
step input: {manifest, scenario_id, calls:[{tool,args}, ...]}.
It replays locally and returns responses; append each model-selected call and repeat.
Import final runs using the trace_contract returned by export. Preserve exact
responses, model/client versions, repetition, source=model, measured duration,
per-call latency and provider usage (null when unavailable; no token estimates).
Trace metadata is importer-reported, not provider-authenticated. Do not pass
scorer output or repository test traces into model contexts. Nothing launches agents.

Compare the same scenario/repetition pairs on the same model, effort and client;
run that comparison separately for each model. Record all planned runs, including
failures. Inspect critical violations before token/call savings. These are known
regression scenarios: independent withheld cases and human review of report
quality are still required. No automatic skill replacement or prompt promotion.
`;

async function main(args) {
  const [command, ...paths] = args;
  if (!command || ['--help', '-h'].includes(command)) { console.log(help); return; }
  if (command === 'selftest') {
    if (paths.length) throw new Error('selftest takes no arguments');
    const result = spawnSync(process.execPath, ['--test', fileURLToPath(new URL('evaluate.test.mjs', import.meta.url))], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1; return;
  }
  const counts = { export: 1, step: 1, score: 1, compare: 2 };
  if (counts[command] !== paths.length) throw new Error('Invalid command or arguments; use --help');
  const inputs = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, 'utf8'))));
  let result;
  if (command === 'export') result = exportInputs(await makeManifest(inputs[0]));
  if (command === 'score') result = await score(inputs[0]);
  if (command === 'compare') result = await compare(...inputs);
  if (command === 'step') {
    const { manifest, scenario_id, calls } = inputs[0];
    validateManifest(manifest);
    if (manifest.evaluator_sha256 !== await evaluatorHash()) throw new Error('Evaluator changed; regenerate inputs');
    const sandbox = replay(getCase(scenario_id), calls, manifest, false);
    result = { calls: sandbox.observations.map(call => ({ ...call, latency_ms: null })) };
  }
  console.log(JSON.stringify(result, null, 2));
}
main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
