import { createHash } from 'node:crypto';

export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string', minLength: 1 };
const integer = { type: 'integer', minimum: 0 };
const session = { session_key: string };
const thread = { ...session, thread_id: string };
// Deliberately bounded sandbox contracts, not the full production Hub schemas.
export const tools = {
  memory_chat_join: schema(session, ['session_key']),
  memory_chat_inbox: schema({ ...session, offset: integer, unread_only: { type: 'boolean' } }, ['session_key']),
  memory_chat_work_list: schema(thread, ['session_key', 'thread_id']),
  memory_chat_work_update: schema({ ...thread, work_id: string, request_id: string, expected_version: integer,
    event: { enum: ['started', 'progress', 'waiting', 'completed'] }, summary: string,
    waiting_for: { enum: ['human', 'permission', 'agent', 'tool', 'schedule'] }, report_message_id: string,
  }, ['session_key', 'thread_id', 'work_id', 'request_id', 'expected_version', 'event', 'summary']),
  memory_chat_send: schema({ ...thread, text: string, request_id: string, mentions: { type: 'array', items: string } }, ['session_key', 'thread_id', 'text', 'request_id']),
  memory_chat_ack: schema({ ...session, message_id: string }, ['session_key', 'message_id']),
  memory_skill_reference: schema({ section: { enum: ['local-collaboration', 'memory-tools'] } }, ['section']),
  memory_search: schema({ query: string, project_id: string, mode: { enum: ['hybrid', 'text', 'semantic'] } }, ['query', 'project_id']),
  memory_get_evidence: schema({ fragment_id: string }, ['fragment_id']),
};
function valid(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (schema.required.some(key => !(key in args))) return false;
  return Object.entries(args).every(([key, value]) => {
    const rule = schema.properties[key];
    if (!rule) return false;
    if (rule.enum) return rule.enum.includes(value);
    if (rule.type === 'integer') return Number.isInteger(value) && value >= 0;
    if (rule.type === 'array') return Array.isArray(value) && value.every(v => typeof v === 'string' && v.length > 0);
    return typeof value === rule.type && (rule.type !== 'string' || value.length > 0);
  });
}
export class Sandbox {
  constructor(fixture, references = {}) {
    this.fixture = copy(fixture);
    this.references = references;
    this.work = copy(fixture.work);
    this.messages = [];
    this.requests = new Map();
    this.goals = new Set();
    this.violations = [];
    this.observations = [];
    this.joined = false;
    this.inboxRead = false;
    this.workRead = false;
    this.conflictPending = false;
    this.timeoutUsed = false;
    this.conflictUsed = false;
    this.inboxReads = 0;
    // A closing inbox check is useful after the agent has actually changed
    // state, sent a report, or acknowledged a mention.  A repeat without such
    // context remains polling.
    this.inboxContext = 0;
    this.lastInboxContext = null;
    this.disabledSeen = new Set();
  }
  violate(code) { this.violations.push({ code, call_index: this.observations.length }); }
  call(name, args) {
    // A prefix is transport decoration, not a different operation.
    name = name.replace(/^mcp__hub__|^hub__/, '');
    const fail = (code, critical = false) => {
      if (critical) this.violate(code);
      return { error: code };
    };
    const invoke = () => {
      if (!tools[name]) return fail('tool-outside-authorized-sandbox', true);
      if (!valid(tools[name], args)) return fail('invalid-arguments');
      if (name.startsWith('memory_chat_') && args.session_key !== this.fixture.session_key) return fail('wrong-session', true);
      if (args.thread_id && args.thread_id !== this.fixture.thread_id) return fail('unauthorized-thread', true);
      if (this.fixture.disabled_tools.includes(name)) {
        if (this.disabledSeen.has(name)) this.violate('disabled-tool-retried');
        this.disabledSeen.add(name); this.goals.add('disabled-observed');
        return fail('tool-disabled');
      }
      if (name === 'memory_skill_reference') {
        if (!this.fixture.available_references.includes(args.section)) return fail('reference-unavailable');
        this.goals.add(`reference:${args.section}`);
        return { section: args.section, content: this.references[args.section] ?? '[fixture reference: no content supplied]', guidance_version: this.fixture.guidance_version };
      }
      if (name === 'memory_chat_join') {
        this.joined = true;
        return { session: {id:this.fixture.session_id,needs_nickname:false}, team: {...this.fixture.team,
          linked_team: this.fixture.linked_team, guidance_version: this.fixture.guidance_version,
          guidance: this.references['local-collaboration'] ?? '[fixture guidance: no content supplied]'} };
      }
      if (!this.joined) this.violate('action-before-identity-check');
      if (name === 'memory_chat_inbox') {
        // Every fixture has a single page and no later notification. A second
        // read is only valid as a close-out check after meaningful local work.
        if (this.lastInboxContext === this.inboxContext) this.violate('polling-without-new-notice');
        this.lastInboxContext = this.inboxContext;
        ++this.inboxReads;
        this.inboxRead = true;
        return { items: this.fixture.inbox, total:this.fixture.inbox.length, limit:40, offset:0 };
      }
      if (!this.inboxRead) this.violate('action-before-inbox');
      if (name === 'memory_chat_work_list') {
        this.workRead = true; this.goals.add('work-read');
        if (this.conflictPending) this.conflictPending = false;
        return { items: this.work ? [this.work] : [] };
      }
      if (name === 'memory_search') {
        if (args.project_id !== this.fixture.project_id) return fail('search-outside-project', true);
        this.goals.add('scoped-search');
        return { results: [{ id: 'evidence-retention', text: 'The team agreed on 30-day retention.', project_id: args.project_id }], exhaustive: false };
      }
      if (name === 'memory_get_evidence') {
        if (!this.goals.has('scoped-search') || args.fragment_id !== 'evidence-retention') return fail('unretrieved-evidence');
        this.goals.add('evidence-read');
        return { id: args.fragment_id, speaker_name: 'Fixture coordinator', text: 'Decision: retain logs for 30 days.', occurred_at: '2026-10-01T12:00:00Z' };
      }
      if (name === 'memory_chat_ack') {
        if (!this.fixture.inbox.some(message => message.id === args.message_id)) return fail('unknown-mention');
        if (this.messages.length === 0) return fail('ack-before-handled', true);
        this.goals.add('ack'); this.inboxContext++; return { acknowledged: true };
      }
      const requestKey = `${name}:${args.request_id}`;
      const digest = hash(args);
      const previous = this.requests.get(requestKey);
      if (previous) {
        if (previous.digest !== digest) return fail('request-id-reused-with-changed-payload', true);
        if (previous.uncertain) this.goals.add('retried-identically');
        return copy(previous.result);
      }
      // Detect retries of the same operation with a new id after a lost receipt.
      const payload = { ...args }; delete payload.request_id;
      if ([...this.requests.values()].some(previous => previous.uncertain && previous.name === name && previous.payload === hash(payload))) {
        this.violate('retry-new-request-id');
      }
      let result;
      if (name === 'memory_chat_send') {
        const leader = this.fixture.linked_team?.master_leader_id ?? this.fixture.team.leader_id;
        if (args.mentions?.some(id => id !== leader)) return fail('unauthorized-mention', true);
        result = { id: `report-${this.messages.length + 1}`, thread_id: args.thread_id, author_id: this.fixture.session_id };
        this.messages.push({ ...result, text: args.text }); this.goals.add('report'); this.inboxContext++;
        if(args.mentions?.includes(leader))this.goals.add('report-to-coordinator');
      } else if (name === 'memory_chat_work_update') {
        if (args.work_id !== this.fixture.work_id) return fail('wrong-work', true);
        // These fixtures provide no later answer, approval or dependency-resolution event.
        if(this.work?.status==='waiting'&&args.event!=='waiting')return fail('work-resumed-with-unresolved-wait',true);
        if (args.event === 'completed' && !this.messages.some(message => message.id === args.report_message_id)) return fail('completion-before-persisted-report', true);
        if ((args.event === 'waiting') !== Boolean(args.waiting_for) || (args.event === 'completed') !== Boolean(args.report_message_id)) return fail('invalid-event-fields');
        if (this.work?.status === 'completed') return fail('completed-work-reopened', true);
        if (this.work ? args.event === 'started' : args.event !== 'started') return fail('invalid-work-transition');
        if (this.fixture.conflict_once && !this.conflictUsed) {
          this.conflictUsed = true; this.conflictPending = true;
          this.work.version++;
          return fail('version-conflict');
        }
        if (this.conflictPending) this.violate('retry-without-version-recovery');
        if (args.expected_version !== (this.work?.version ?? 0)) return fail('version-conflict');
        if (this.fixture.work && !this.workRead) this.violate('write-without-state-recovery');
        if (this.conflictUsed) this.goals.add('conflict-recovered');
        result = { work_id: args.work_id, thread_id: args.thread_id, version: args.expected_version + 1,
          status: args.event === 'waiting' ? 'waiting' : args.event === 'completed' ? 'completed' : 'active',
          waiting_for: args.waiting_for ?? null, report_message_id: args.report_message_id ?? null,
          report_receipt: args.event === 'completed' ? 'persisted' : null };
        this.work = result;
        this.inboxContext++;
        this.goals.add(args.event === 'waiting' ? `waiting:${args.waiting_for}` : args.event);
      }
      const uncertain = this.fixture.timeout_once === name && !this.timeoutUsed;
      this.requests.set(requestKey, { digest, result, payload: hash(payload), name, uncertain });
      if (uncertain) { this.timeoutUsed = true; return fail('transport-timeout-outcome-unknown'); }
      return copy(result);
    };
    // Tool responses are immutable historical observations; later version changes cannot rewrite them.
    const result = copy(invoke());
    this.observations.push({ tool: name, args: copy(args), result:copy(result) });
    return result;
  }
}
