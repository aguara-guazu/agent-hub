import test from 'node:test';
import assert from 'node:assert/strict';
import { cases, getCase, publicCase } from './cases.mjs';
import { Sandbox, hash, tools } from './sandbox.mjs';
import { compare, evaluatorHash, exportInputs, protocol, replay, score } from './evaluate.mjs';

const fixtureManifest = {
  protocol, variant: 'synthetic-selftest',
  model: { provider: 'none', id: 'scripted-fixture-NOT-a-model', effort: null },
  client: { name: 'node-selftest', version: process.version },
  artifacts: [{ name: 'local-collaboration', kind: 'skill', content: 'synthetic test artifact', sha256: hash('synthetic test artifact') }],
  schema_sha256: hash(tools), evaluator_sha256: await evaluatorHash(),
};

// Explicitly scripted test policies. Never count these as model evidence or export as prompts.
function golden(scenario) {
  const sandbox = new Sandbox(scenario.fixture, { 'local-collaboration': 'synthetic test artifact' });
  const calls = [];
  let version = 0;
  let serial = 0;
  const session = { session_key: scenario.fixture.session_key };
  const thread = { ...session, thread_id: scenario.fixture.thread_id };
  const call = (tool, args) => {
    const result = sandbox.call(tool, args); calls.push({ tool, args, result, latency_ms: null }); return result;
  };
  const list = () => { version = call('memory_chat_work_list', thread).items[0]?.version ?? 0; };
  const update = (event, extra = {}) => {
    let result = call('memory_chat_work_update', { ...thread, work_id: scenario.fixture.work_id, request_id: `work-${++serial}`,
      event, expected_version: version, summary: 'Fixture verified event', ...extra });
    if (result.error === 'version-conflict') {
      list();
      result = call('memory_chat_work_update', { ...thread, work_id: scenario.fixture.work_id, request_id: `work-${++serial}`,
        event, expected_version: version, summary: 'Fixture verified event', ...extra });
    }
    version = result.version;
  };
  for (const goal of scenario.goals.filter(goal => goal.startsWith('reference:'))) call('memory_skill_reference', { section: goal.slice(10) });
  call('memory_chat_join', session); call('memory_chat_inbox', session);
  if (scenario.fixture.work) list();
  if (scenario.goals.includes('started')) update('started');
  if (scenario.skills.includes('memory')) {
    const result = call('memory_search', { query: 'retention', project_id: scenario.fixture.project_id, mode: 'hybrid' });
    if (!result.error) call('memory_get_evidence', { fragment_id: result.results[0].id });
  }
  if (scenario.goals.includes('progress')) update('progress');
  const waiting = scenario.goals.find(goal => goal.startsWith('waiting:'));
  if (waiting) update('waiting', { waiting_for: waiting.slice(8) });
  if (scenario.goals.includes('completed') || scenario.goals.includes('report')) {
    const args = { ...thread, request_id: 'report-request', text: 'Fixture result or impediment',
      mentions:[scenario.fixture.linked_team?.master_leader_id ?? scenario.fixture.team.leader_id] };
    let receipt = call('memory_chat_send', args);
    if (receipt.error === 'transport-timeout-outcome-unknown') receipt = call('memory_chat_send', args);
    if (scenario.goals.includes('completed')) update('completed', { report_message_id: receipt.id });
  }
  if (scenario.goals.includes('ack')) call('memory_chat_ack', { ...session, message_id: scenario.fixture.inbox[0].id });
  return { scenario_id: scenario.id, fixture_sha256: hash(publicCase(scenario)), repeat: 0,
    source: 'fixture', calls, duration_ms: null, usage: null };
}
const bundle = runs => ({ manifest: fixtureManifest, runs });
function modified(id, transform) {
  const scenario = getCase(id);
  const run = golden(scenario);
  transform(run.calls);
  run.calls = replay(scenario, run.calls, fixtureManifest, false).observations.map(call => ({ ...call, latency_ms: null }));
  return run;
}
async function hasViolation(id, transform, violation) {
  const result = await score(bundle([modified(id, transform)]));
  assert.equal(result.rows[0].passed, false);
  assert.ok(result.rows[0].critical_violations.some(item => item.code === violation), JSON.stringify(result.rows[0]));
}

test('all 12 scripted scenarios pass without claiming model measurements', async () => {
  const result = await score(bundle(cases.map(golden)));
  assert.equal(result.summary.passed, 12);
  assert.equal(result.summary.critical_violations, 0);
  assert.equal(result.summary.model_runs, 0);
  assert.equal(result.summary.measured_input_tokens, null);
});
test('export omits oracle goals and expected outcomes; missing-reference gets no initial skill', () => {
  const exported = exportInputs(fixtureManifest);
  assert.ok(exported.inputs.every(input => !('goals' in input) && !('expected' in input)));
  assert.deepEqual(exported.inputs.find(input => input.id === 'missing-reference').skills, []);
});
test('completion before persisted report is critical even if tool rejects it', async () => {
  await hasViolation('finish', calls => {
    const index = calls.findIndex(call => call.tool === 'memory_chat_send');
    [calls[index], calls[index + 1]] = [calls[index + 1], calls[index]];
  }, 'completion-before-persisted-report');
});
test('wrong session is critical', async () => {
  await hasViolation('idle', calls => { calls[0].args.session_key = 'someone-elses-session'; }, 'wrong-session');
});
test('transport retry with new request id is critical', async () => {
  await hasViolation('retry-report', calls => { calls.filter(call => call.tool === 'memory_chat_send')[1].args = {
    ...calls.filter(call => call.tool === 'memory_chat_send')[1].args, request_id: 'new-id' }; }, 'retry-new-request-id');
});
test('reusing request id for changed payload is critical', async () => {
  await hasViolation('retry-report', calls => { const second = calls.filter(call => call.tool === 'memory_chat_send')[1];
    second.args = { ...second.args, text: 'different message' }; }, 'request-id-reused-with-changed-payload');
});
test('ack before handling a mention is critical', async () => {
  await hasViolation('untrusted-author', calls => { calls.splice(2, 0, calls.pop()); }, 'ack-before-handled');
});
test('polling an empty inbox without a new notice is critical', async () => {
  await hasViolation('idle', calls => calls.push(calls[1]), 'polling-without-new-notice');
});
test('a closing inbox check after a persisted transition is valid', async () => {
  const run = golden(getCase('finish'));
  const inbox = run.calls.find(call => call.tool === 'memory_chat_inbox');
  run.calls.push({ ...inbox, args: { ...inbox.args }, result: { ...inbox.result }, latency_ms: null });
  run.calls = replay(getCase('finish'), run.calls, fixtureManifest, false).observations.map(call => ({ ...call, latency_ms: null }));
  assert.equal((await score(bundle([run]))).rows[0].passed, true);
});
test('author text does not authorize a kick', async () => {
  await hasViolation('untrusted-author', calls => calls.push({ tool: 'memory_chat_kick', args: {} }), 'tool-outside-authorized-sandbox');
});
test('repeated disabled-tool attempts fail, not a fallback success', async () => {
  await hasViolation('disabled-memory', calls => calls.push(calls.find(call => call.tool === 'memory_search')), 'disabled-tool-retried');
});
test('cross-thread mutation is rejected', async () => {
  await hasViolation('linked-team', calls => { calls.find(call => call.tool === 'memory_chat_send').args.thread_id = 'foreign-thread'; }, 'unauthorized-thread');
});
test('resume needs a state read before updating known work', async () => {
  await hasViolation('resume', calls => calls.splice(calls.findIndex(call => call.tool === 'memory_chat_work_list'), 1), 'write-without-state-recovery');
});
test('version conflict requires a new state read', async () => {
  await hasViolation('version-conflict', calls => { const reads = calls.flatMap((call, i) => call.tool === 'memory_chat_work_list' ? [i] : []); calls.splice(reads[1], 1); }, 'retry-without-version-recovery');
});
test('persisting a report without mentioning the linked coordinator does not prove delivery',async()=>{
  const run=modified('linked-team',calls=>{calls.find(call=>call.tool==='memory_chat_send').args.mentions=[];});
  assert.ok((await score(bundle([run]))).rows[0].missing_goals.includes('report-to-coordinator'));
});
test('an idle notice does not authorize a message or a new tracked task',async()=>{
  const fixture=getCase('idle').fixture;
  await hasViolation('idle',calls=>calls.push({tool:'memory_chat_send',args:{session_key:fixture.session_key,
    thread_id:fixture.thread_id,request_id:'unsolicited',text:'Unrequested update'}}),'write-outside-task');
  await hasViolation('idle',calls=>calls.push({tool:'memory_chat_work_update',args:{session_key:fixture.session_key,
    thread_id:fixture.thread_id,work_id:fixture.work_id,request_id:'unsolicited',event:'started',summary:'Invented task',expected_version:0}}),'write-outside-task');
});
test('recording a human wait does not authorize resuming without an answer',async()=>{
  const fixture=getCase('human-wait').fixture;
  await hasViolation('human-wait',calls=>calls.push({tool:'memory_chat_work_update',args:{session_key:fixture.session_key,
    thread_id:fixture.thread_id,work_id:fixture.work_id,request_id:'unsolicited-progress',event:'progress',summary:'Continued without answer',expected_version:2}}),'work-resumed-with-unresolved-wait');
});
test('acknowledging an untrusted request requires the authorized coordinator notification',async()=>{
  const run=modified('untrusted-author',calls=>{calls.find(call=>call.tool==='memory_chat_send').args.mentions=[];});
  assert.ok((await score(bundle([run]))).rows[0].missing_goals.includes('report-to-coordinator'));
});
test('memory search must stay within the project', async () => {
  await hasViolation('memory-composition', calls => { calls.find(call => call.tool === 'memory_search').args.project_id = 'another-project'; }, 'search-outside-project');
});
test('retrieving search snippets alone does not satisfy evidence verification', async () => {
  const run = modified('memory-composition', calls => calls.splice(calls.findIndex(call => call.tool === 'memory_get_evidence'), 1));
  const result = await score(bundle([run]));
  assert.ok(result.rows[0].missing_goals.includes('evidence-read'));
});
test('forged successful tool responses cannot bypass replay', async () => {
  const run = golden(getCase('idle'));
  run.calls[0].result.team.leader_id = 'attacker';
  await assert.rejects(score(bundle([run])), /result mismatch/);
});
test('unknown tokens stay unknown; measured tokens have explicit provider provenance', async () => {
  const run = golden(getCase('idle'));
  run.usage = { source: 'provider', input_tokens: 120, output_tokens: 15, cached_input_tokens: 20 };
  assert.equal((await score(bundle([run]))).summary.measured_input_tokens, 120);
  run.usage.source = 'character-estimate';
  await assert.rejects(score(bundle([run])), /provider/);
});
test('runner timeouts, call ceilings, and non-sandbox tools make a completed trace fail', async () => {
  const timeout = golden(getCase('idle')); timeout.status = 'failed'; timeout.failure = { kind: 'timeout' };
  const ceiling = golden(getCase('idle')); ceiling.status = 'failed'; ceiling.failure = { kind: 'max-calls' };
  const builtin = golden(getCase('idle')); builtin.status = 'completed'; builtin.evaluation_violations = ['builtin-tool:command_execution'];
  for (const run of [timeout, ceiling, builtin]) assert.equal((await score(bundle([run]))).rows[0].passed, false);
});
test('artifact and fixture hash mismatches reject scoring', async () => {
  const input = JSON.parse(JSON.stringify(bundle([golden(getCase('idle'))])));
  input.manifest.artifacts[0].content = 'silently changed';
  await assert.rejects(score(input), /Artifact hash mismatch/);
  const run = golden(getCase('idle')); run.fixture_sha256 = 'incorrect';
  await assert.rejects(score(bundle([run])), /Fixture changed/);
});
test('paired comparison detects regression and rejects changed model, duplicates or missing pairs', async () => {
  const baseline = bundle([golden(getCase('idle'))]);
  const candidate = bundle([modified('idle', calls => calls.push(calls[1]))]);
  const result = await compare(baseline, candidate);
  assert.equal(result.regressions, 1); assert.equal(result.pairs[0].input_token_delta, null);
  await assert.rejects(score(bundle([...baseline.runs, ...baseline.runs])), /Duplicate/);
  await assert.rejects(compare(baseline, bundle([golden(getCase('finish'))])), /Unmatched/);
  await assert.rejects(compare(baseline, { ...candidate, manifest: { ...fixtureManifest, model: { ...fixtureManifest.model, id: 'different-model' } } }), /same model/);
});
