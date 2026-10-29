import { createHash, randomUUID } from 'node:crypto'
import type { MemoryDatabase } from './database.js'
import { MemoryError } from './contracts.js'
import type { Actor, ArtifactAuthorityReader, DecisionSummary, AttemptState, DeliveryTarget, GracePolicy, HumanOverrideField, IncidentAction, IncidentCause, ItemState, PublicStateSink, Recurrence, RunPhase, RunState, RunTrigger,
  ScheduleKind, ScheduleScope, ScheduleSnapshot, ScheduleState, ScheduleTemplate, ScheduleEventType } from './schedule-contract.js'

type Row = Record<string, any>
const isoNow = () => new Date().toISOString()
const json = (value: unknown) => JSON.stringify(value)
/** States in which a run no longer advances by itself. */
export const TERMINAL_RUN_STATES: readonly RunState[] = ['succeeded', 'partial', 'failed', 'uncertain', 'skipped', 'cancelled']

export interface ScheduleRow {
  id: string; scope: ScheduleScope; project_id: string | null; template: ScheduleTemplate; template_version: number; kind: ScheduleKind; title: string; instructions: string
  params: Record<string, unknown>; recurrence: Recurrence; delivery: DeliveryTarget[]; misfire: 'run_once' | 'skip'; grace_minutes: number; grace_policy: GracePolicy; grace_until: string | null
  target_key: string; state: ScheduleState; paused_by: Actor | null; next_run_at: string | null; expires_at: string | null; revision: number
  created_by_kind: Actor; created_by_agent: string | null; created_by_session: string | null; origin: Record<string, unknown>; human_override: HumanOverrideField[]
  cancelled_at: string | null; cancelled_by: Actor | null; cancel_reason: string | null; created_at: string; updated_at: string
}
export interface RunRow {
  id: string; schedule_id: string; scheduled_for: string; schedule_revision: number; definition: ScheduleSnapshot & { scope: ScheduleScope; project_id: string | null; covered_since?: string | null; extend_from?: string | null }
  trigger: RunTrigger; state: RunState; phase: RunPhase | 'done'; generation: number; skip_reason: string | null; deferred_reason: string | null; next_attempt_at: string | null
  quota: Record<string, unknown> | null; artifact_id: string | null; continuity: string | null; error_code: string | null
  created_at: string; started_at: string | null; finished_at: string | null; updated_at: string
}
export type NewSchedule = Omit<ScheduleRow, 'revision' | 'human_override' | 'paused_by' | 'cancelled_at' | 'cancelled_by' | 'cancel_reason' | 'created_at' | 'updated_at' | 'state'> & { state?: ScheduleState }

export const targetKey = (parts: unknown) => createHash('sha256').update(json(parts)).digest('hex')
/** Canonical copy of the mutable columns, frozen into schedule_runs.definition when an occurrence is created. */
export function snapshotOf(row: ScheduleRow): RunRow['definition'] {
  return { template: row.template, template_version: row.template_version, kind: row.kind, title: row.title, instructions: row.instructions, params: row.params, recurrence: row.recurrence,
    delivery: row.delivery, misfire: row.misfire, grace_minutes: row.grace_minutes, grace_policy: row.grace_policy, grace_until: row.grace_until, expires_at: row.expires_at, scope: row.scope, project_id: row.project_id }
}

/** SQL repository of the scheduler. Methods join the caller's transaction when there is one (see MemoryDatabase.transaction). */
export class ScheduleStore implements PublicStateSink, ArtifactAuthorityReader {
  constructor(readonly db: MemoryDatabase) {}

  // --- schedules ---------------------------------------------------------------------------------------------------------------------------------
  async insertSchedule(input: NewSchedule): Promise<ScheduleRow> {
    const now = isoNow(), row = { state: 'active', ...input }
    await this.db.query(`INSERT INTO schedules(id,scope,project_id,template,template_version,kind,title,instructions,params,recurrence,delivery,misfire,grace_minutes,grace_policy,grace_until,
      target_key,state,next_run_at,expires_at,created_by_kind,created_by_agent,created_by_session,origin,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$24)`,
    [row.id, row.scope, row.project_id, row.template, row.template_version, row.kind, row.title, row.instructions, json(row.params), json(row.recurrence), json(row.delivery), row.misfire,
      row.grace_minutes, row.grace_policy, row.grace_until, row.target_key, row.state, row.next_run_at, row.expires_at, row.created_by_kind, row.created_by_agent, row.created_by_session, json(row.origin), now])
    return (await this.schedule(row.id))!
  }
  async schedule(id: string): Promise<ScheduleRow | undefined> { return (await this.db.query<ScheduleRow>('SELECT * FROM schedules WHERE id=$1', [id]))[0] }
  async listSchedules(filter: { project_id?: string | undefined; state?: ScheduleState | undefined; created_by_agent?: string | undefined; limit: number; offset: number }) {
    const where = ['($1 IS NULL OR project_id=$1)', '($2 IS NULL OR state=$2)', '($3 IS NULL OR created_by_agent=$3)']
    const params = [filter.project_id ?? null, filter.state ?? null, filter.created_by_agent ?? null]
    const count = (await this.db.query<{ count: number }>(`SELECT count(*) AS count FROM schedules WHERE ${where.join(' AND ')}`, params))[0]!.count
    const items = await this.db.query<ScheduleRow>(`SELECT * FROM schedules WHERE ${where.join(' AND ')} ORDER BY (state='active') DESC,next_run_at IS NULL,next_run_at,created_at DESC LIMIT $4 OFFSET $5`,
      [...params, filter.limit, filter.offset])
    return { items, total: count }
  }
  /** Optimistic update: returns undefined when the revision no longer matches. */
  async updateSchedule(id: string, expectedRevision: number, patch: Partial<Pick<ScheduleRow, 'title' | 'instructions' | 'params' | 'recurrence' | 'delivery' | 'misfire' | 'expires_at' | 'target_key' | 'state' | 'paused_by' | 'next_run_at' | 'cancelled_at' | 'cancelled_by' | 'cancel_reason' | 'human_override'>>) {
    const entries = Object.entries(patch), sets = entries.map(([key], i) => `${key}=$${i + 3}`)
    const values = entries.map(([key, value]) => ['params', 'recurrence', 'delivery', 'human_override'].includes(key) ? json(value) : value)
    const rows = await this.db.query<ScheduleRow>(`UPDATE schedules SET ${sets.length ? `${sets.join(',')},` : ''}revision=revision+1,updated_at=$${entries.length + 3} WHERE id=$1 AND revision=$2 RETURNING *`,
      [id, expectedRevision, ...values, isoNow()])
    return rows[0]
  }
  /** System-side change that does not take part in optimistic concurrency (clock advance, expiry). */
  async touchSchedule(id: string, patch: Partial<Pick<ScheduleRow, 'state' | 'next_run_at' | 'paused_by' | 'cancelled_at' | 'cancelled_by' | 'cancel_reason'>>) {
    const entries = Object.entries(patch), sets = entries.map(([key], i) => `${key}=$${i + 2}`)
    await this.db.query(`UPDATE schedules SET ${sets.join(',')},updated_at=$${entries.length + 2} WHERE id=$1`, [id, ...entries.map(([, value]) => value), isoNow()])
  }
  async liveCounts(agentId: string | null, projectId: string | null, template: ScheduleTemplate) {
    const [row] = await this.db.query<{ agent: number; owner: number; project_template: number }>(`SELECT
      coalesce(sum(created_by_agent=$1),0) AS agent, count(*) AS owner, coalesce(sum(template=$3 AND ($2 IS NULL AND project_id IS NULL OR project_id=$2)),0) AS project_template
      FROM schedules WHERE state IN ('active','paused')`, [agentId, projectId, template])
    return { agent: Number(row!.agent), owner: Number(row!.owner), project_template: Number(row!.project_template) }
  }
  async liveByTarget(key: string) { return (await this.db.query<ScheduleRow>("SELECT * FROM schedules WHERE target_key=$1 AND state IN ('active','paused')", [key]))[0] }
  async dueSchedules(now: string) { return this.db.query<ScheduleRow>("SELECT * FROM schedules WHERE state='active' AND next_run_at IS NOT NULL AND next_run_at<=$1 ORDER BY next_run_at", [now]) }
  async expiredSchedules(now: string) { return this.db.query<ScheduleRow>("SELECT * FROM schedules WHERE state IN ('active','paused') AND expires_at IS NOT NULL AND expires_at<=$1", [now]) }
  async dailySchedules() { return this.db.query<ScheduleRow>("SELECT * FROM schedules WHERE state='active' AND json_extract(recurrence,'$.type')='daily'") }
  /** Projects with a live project_status schedule, for owner-level templates. */
  async statusProjects(): Promise<string[]> {
    return (await this.db.query<{ project_id: string }>("SELECT DISTINCT project_id FROM schedules WHERE template='project_status' AND state IN ('active','paused') AND project_id IS NOT NULL")).map(row => row.project_id)
  }

  // --- human constraints -------------------------------------------------------------------------------------------------------------------------
  async constraintFor(projectId: string | null, template: ScheduleTemplate, key: string): Promise<Row | undefined> {
    return (await this.db.query(`SELECT * FROM schedule_constraints WHERE lifted_at IS NULL AND template=$2 AND COALESCE(project_id,'')=COALESCE($1,'')
      AND (scope='template_project' OR (scope='target' AND target_key=$3)) ORDER BY created_at DESC LIMIT 1`, [projectId, template, key]))[0]
  }
  async addConstraint(input: { subject: ScheduleScope; project_id: string | null; template: ScheduleTemplate; scope: 'target' | 'template_project'; target_key: string | null; schedule_id: string | null; user: string; reason?: string }) {
    const id = randomUUID()
    await this.db.query(`INSERT INTO schedule_constraints(id,subject,project_id,template,scope,target_key,schedule_id,created_by_user,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT DO NOTHING`, [id, input.subject, input.project_id, input.template, input.scope, input.target_key, input.schedule_id, input.user, input.reason ?? null, isoNow()])
    return id
  }
  async liftConstraint(id: string, user: string) {
    const rows = await this.db.query('UPDATE schedule_constraints SET lifted_at=$2,lifted_by_user=$3 WHERE id=$1 AND lifted_at IS NULL RETURNING id,lifted_at', [id, isoNow(), user])
    return rows[0] as { id: string; lifted_at: string } | undefined
  }
  async listConstraints(limit: number, offset: number) {
    return this.db.query('SELECT id,subject,project_id,template,scope,target_key,schedule_id,reason,created_at,lifted_at FROM schedule_constraints ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset])
  }

  // --- events ------------------------------------------------------------------------------------------------------------------------------------
  /** Idempotent by (actor_ref, request_id): a replay returns the original event with `replayed` set. */
  async addEvent(input: { type: ScheduleEventType; schedule_id?: string | null; run_id?: string | null; actor_kind: Actor; actor_ref?: string | null; request_id?: string | null; payload?: Record<string, unknown> }) {
    const id = randomUUID()
    const rows = await this.db.query<{ seq: number }>(`INSERT INTO schedule_events(id,schedule_id,run_id,type,actor_kind,actor_ref,request_id,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT DO NOTHING RETURNING seq`, [id, input.schedule_id ?? null, input.run_id ?? null, input.type, input.actor_kind, input.actor_ref ?? null, input.request_id ?? null, json(input.payload ?? {}), isoNow()])
    if (rows[0]) return { seq: rows[0].seq, id, replayed: false }
    const existing = (await this.db.query<{ seq: number; id: string }>('SELECT seq,id FROM schedule_events WHERE actor_ref=$1 AND request_id=$2', [input.actor_ref, input.request_id]))[0]!
    return { seq: existing.seq, id: existing.id, replayed: true }
  }
  async lastEvent(scheduleId: string, type: ScheduleEventType): Promise<Row | undefined> {
    return (await this.db.query<Row>("SELECT * FROM schedule_events WHERE schedule_id=$1 AND type=$2 ORDER BY seq DESC LIMIT 1", [scheduleId, type]))[0]
  }
  async constraintExists(id: string): Promise<boolean> { return (await this.db.query("SELECT 1 FROM schedule_constraints WHERE id=$1", [id])).length > 0 }
  /** Runs that a cancellation at or after `since` skipped or aborted; a restore does not bring them back. */
  async runsStoppedByCancel(scheduleId: string, since: string): Promise<string[]> {
    return (await this.db.query<{ id: string }>(`SELECT id FROM schedule_runs WHERE schedule_id=$1 AND finished_at>=$2
      AND (skip_reason='schedule_cancelled' OR error_code='schedule_cancelled') ORDER BY scheduled_for`, [scheduleId, since])).map(row => row.id)
  }
  async eventByRequest(actorRef: string, requestId: string) { return (await this.db.query<Row>('SELECT * FROM schedule_events WHERE actor_ref=$1 AND request_id=$2', [actorRef, requestId]))[0] }
  async maxSeq(): Promise<number> { return Number((await this.db.query<{ seq: number | null }>('SELECT max(seq) AS seq FROM schedule_events'))[0]?.seq ?? 0) }
  async eventsAfter(after: number, limit = 200) {
    return this.db.query<Row>(`SELECT e.seq,e.type,e.actor_kind,e.schedule_id,e.run_id,e.payload,e.created_at,s.title,s.project_id,a.kind AS artifact_kind
      FROM schedule_events e LEFT JOIN schedules s ON s.id=e.schedule_id LEFT JOIN schedule_artifacts a ON a.run_id=e.run_id WHERE e.seq>$1 ORDER BY e.seq LIMIT $2`, [after, limit])
  }

  // --- runs --------------------------------------------------------------------------------------------------------------------------------------
  /** Inserts the logical occurrence; returns null when it already exists (UNIQUE(schedule_id,scheduled_for)). */
  async insertRun(input: { schedule_id: string; scheduled_for: string; schedule_revision: number; definition: RunRow['definition']; trigger: RunTrigger; state?: RunState; skip_reason?: string; error_code?: string }): Promise<string | null> {
    const id = randomUUID(), now = isoNow(), state = input.state ?? 'pending'
    const rows = await this.db.query<{ id: string }>(`INSERT INTO schedule_runs(id,schedule_id,scheduled_for,schedule_revision,definition,trigger,state,phase,skip_reason,error_code,created_at,updated_at,finished_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12) ON CONFLICT(schedule_id,scheduled_for) DO NOTHING RETURNING id`,
    [id, input.schedule_id, input.scheduled_for, input.schedule_revision, json(input.definition), input.trigger, state, state === 'skipped' ? 'done' : 'collect', input.skip_reason ?? null, input.error_code ?? null, now, state === 'skipped' ? now : null])
    return rows[0]?.id ?? null
  }
  async run(id: string): Promise<RunRow | undefined> { return (await this.db.query<RunRow>('SELECT * FROM schedule_runs WHERE id=$1', [id]))[0] }
  async lastRunOf(scheduleId: string): Promise<RunRow | undefined> { return (await this.db.query<RunRow>('SELECT * FROM schedule_runs WHERE schedule_id=$1 ORDER BY scheduled_for DESC LIMIT 1', [scheduleId]))[0] }
  async liveRunOf(scheduleId: string): Promise<RunRow | undefined> {
    return (await this.db.query<RunRow>(`SELECT * FROM schedule_runs WHERE schedule_id=$1 AND state IN ('pending','running','deferred','interrupted') ORDER BY scheduled_for LIMIT 1`, [scheduleId]))[0]
  }
  /** Takes over a run left in `running` by a previous process: the next generation fences the old one. */
  async reclaimRunning(id: string, generation: number): Promise<RunRow | undefined> {
    return (await this.db.query<RunRow>("UPDATE schedule_runs SET generation=generation+1,updated_at=$3 WHERE id=$1 AND generation=$2 AND state='running' RETURNING *", [id, generation, isoNow()]))[0]
  }
  async runningRuns() { return this.db.query<RunRow>("SELECT * FROM schedule_runs WHERE state='running' ORDER BY scheduled_for") }
  async deferredForQuota() { return this.db.query<RunRow>("SELECT * FROM schedule_runs WHERE state='deferred' AND deferred_reason='quota'") }
  /** Every run that has not started or is waiting; used when automations are switched off. Returns the ids that changed. */
  async cancelAllLiveRuns(skipReason: string): Promise<string[]> {
    const now = isoNow()
    return (await this.db.query<{ id: string }>(`UPDATE schedule_runs SET state='skipped',phase='done',skip_reason=$1,finished_at=$2,updated_at=$2,next_attempt_at=NULL,generation=generation+1
      WHERE state IN ('pending','deferred','interrupted') RETURNING id`, [skipReason, now])).map(row => row.id)
  }
  /**
   * Fleet members a previous Hub process owned and nobody reconciled yet: live ones, whose child may still run, and failed ones, whose exit a resume must prove.
   * A member already holding a restart incident for its generation is not visited again.
   */
  async fleetMembersToReconcile() {
    return this.db.query<{ id: string; team_id: string; session_id: string | null; generation: string | null; state: string; pid: number | null; process_started: string | null; cwd: string | null }>(
      `SELECT m.id,m.team_id,m.session_id,m.runtime->>'generation' AS generation,m.runtime->>'state' AS state,CAST(m.runtime->>'pid' AS INTEGER) AS pid,m.runtime->>'process_started' AS process_started,
         m.runtime->>'cwd' AS cwd
       FROM chat_team_members m WHERE m.runtime IS NOT NULL AND m.runtime->>'state' IN ('starting','busy','idle','waiting_input','failed','unknown')
       AND NOT EXISTS(SELECT 1 FROM process_incidents i WHERE i.subject_kind='fleet_member' AND i.subject_id=m.id AND i.generation IS m.runtime->>'generation' AND i.cause='hub_restart')`)
  }
  async failedPhaseCount(runId: string): Promise<number> {
    return Number((await this.db.query<{ n: number }>("SELECT count(DISTINCT generation) AS n FROM schedule_run_phases WHERE run_id=$1 AND state='failed'", [runId]))[0]!.n)
  }
  /** Runs ready to advance: pending, interrupted within their window, or deferred whose wake time has come. */
  async runnable(now: string) {
    return this.db.query<RunRow>(`SELECT * FROM schedule_runs WHERE state IN ('pending','interrupted') OR (state='deferred' AND (next_attempt_at IS NULL OR next_attempt_at<=$1)) ORDER BY scheduled_for`, [now])
  }
  /** Compare-and-set claim: only the caller that observed `generation` becomes the owner of the next one. */
  async claimRun(id: string, generation: number): Promise<RunRow | undefined> {
    const now = isoNow()
    const rows = await this.db.query<RunRow>(`UPDATE schedule_runs SET state='running',generation=generation+1,started_at=COALESCE(started_at,$3),deferred_reason=NULL,next_attempt_at=NULL,quota=NULL,updated_at=$3
      WHERE id=$1 AND generation=$2 AND state IN ('pending','interrupted','deferred') RETURNING *`, [id, generation, now])
    return rows[0]
  }
  /** Phase and state changes carry the generation: a stale process cannot move a run another generation owns. */
  async setRun(id: string, generation: number, patch: Partial<Pick<RunRow, 'state' | 'phase' | 'skip_reason' | 'deferred_reason' | 'next_attempt_at' | 'quota' | 'artifact_id' | 'continuity' | 'error_code' | 'finished_at'>>): Promise<boolean> {
    const entries = Object.entries(patch), sets = entries.map(([key], i) => `${key}=$${i + 3}`)
    const values = entries.map(([key, value]) => key === 'quota' && value ? json(value) : value)
    const rows = await this.db.query(`UPDATE schedule_runs SET ${sets.join(',')},updated_at=$${entries.length + 3} WHERE id=$1 AND generation=$2 RETURNING id`, [id, generation, ...values, isoNow()])
    return rows.length > 0
  }
  async cancelLiveRuns(scheduleId: string, skipReason: string): Promise<number> {
    const now = isoNow()
    return (await this.db.query(`UPDATE schedule_runs SET state='skipped',phase='done',skip_reason=$2,finished_at=$3,updated_at=$3,next_attempt_at=NULL,generation=generation+1
      WHERE schedule_id=$1 AND state IN ('pending','deferred','interrupted') RETURNING id`, [scheduleId, skipReason, now])).length
  }
  async listRuns(filter: { schedule_id?: string | undefined; project_id?: string | undefined; state?: RunState | undefined; unread?: boolean | undefined; kind?: string | undefined; limit: number; offset: number }) {
    const where = '($1 IS NULL OR r.schedule_id=$1) AND ($2 IS NULL OR s.project_id=$2) AND ($3 IS NULL OR r.state=$3) AND ($4=0 OR (a.id IS NOT NULL AND a.read_at IS NULL)) AND ($5 IS NULL OR a.kind=$5)'
    const params = [filter.schedule_id ?? null, filter.project_id ?? null, filter.state ?? null, filter.unread ? 1 : 0, filter.kind ?? null]
    const count = (await this.db.query<{ count: number }>(`SELECT count(*) AS count FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id LEFT JOIN schedule_artifacts a ON a.run_id=r.id WHERE ${where}`, params))[0]!.count
    const items = await this.db.query<Row>(`SELECT r.id,r.schedule_id,r.scheduled_for,r.trigger,r.state,r.phase,r.skip_reason,r.deferred_reason,r.next_attempt_at,r.error_code,r.continuity,r.started_at,r.finished_at,
      s.title AS schedule_title,s.project_id,s.template,a.id AS artifact_id,a.kind AS artifact_kind,a.title,a.read_at
      FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id LEFT JOIN schedule_artifacts a ON a.run_id=r.id WHERE ${where} ORDER BY r.scheduled_for DESC,r.id LIMIT $6 OFFSET $7`, [...params, filter.limit, filter.offset])
    return { items, total: count }
  }
  // --- batched reads for the run list (no per-run queries from the app) ---------------------------------------------------------------------------
  private placeholders(count: number, from = 1) { return Array.from({ length: count }, (_, i) => `$${i + from}`).join(',') }
  async deliveriesForRuns(runIds: string[]): Promise<Map<string, Row[]>> {
    const grouped = new Map<string, Row[]>()
    if (!runIds.length) return grouped
    for (const row of await this.db.query<Row>(`SELECT run_id,id,target,state,attempts,error_code,read_at FROM schedule_deliveries WHERE run_id IN (${this.placeholders(runIds.length)}) ORDER BY created_at`, runIds)) grouped.set(row.run_id, [...(grouped.get(row.run_id) ?? []), row])
    return grouped
  }
  /**
   * Public summary of the decision of each run, from the item states and the expiry recorded in the persist receipt; the private store is never read.
   * `state` is the most pressing one: uncertain, dispatching (approved items included), pending, expired (nothing left to approve) or done.
   */
  async decisionSummaries(runIds: string[]): Promise<Map<string, DecisionSummary>> {
    const summaries = new Map<string, DecisionSummary>()
    if (!runIds.length) return summaries
    const counts = new Map<string, Record<string, number>>()
    for (const row of await this.db.query<{ run_id: string; state: string; n: number }>(`SELECT run_id,state,count(*) AS n FROM schedule_item_states WHERE run_id IN (${this.placeholders(runIds.length)}) GROUP BY run_id,state`, runIds)) {
      counts.set(row.run_id, { ...(counts.get(row.run_id) ?? {}), [row.state]: Number(row.n) })
    }
    const expiries = new Map<string, string>()
    for (const row of await this.db.query<{ run_id: string; expires_at: string | null }>(`SELECT run_id,receipt->>'expires_at' AS expires_at FROM schedule_run_phases WHERE phase='persist' AND state='done' AND run_id IN (${this.placeholders(runIds.length)}) ORDER BY generation`, runIds)) {
      if (row.expires_at) expiries.set(row.run_id, row.expires_at)
    }
    for (const id of runIds) {
      const c = counts.get(id) ?? {}, total = Object.values(c).reduce((sum, n) => sum + n, 0), has = (...states: string[]) => states.some(state => (c[state] ?? 0) > 0)
      const state: DecisionSummary['state'] = !total ? 'none' : has('uncertain') ? 'uncertain' : has('dispatching', 'approved') ? 'dispatching' : has('proposed') ? 'pending'
        : !has('succeeded', 'rejected') ? 'expired' : 'done'
      summaries.set(id, { state, expires_at: expiries.get(id) ?? null, approved: (c.approved ?? 0) + (c.dispatching ?? 0) + (c.succeeded ?? 0) + (c.uncertain ?? 0), total })
    }
    return summaries
  }
  /** The parts of an hour estimate the app shows next to an item: value, basis, confidence and assumptions, with what was approved and sent. */
  async estimatesById(ids: string[]): Promise<Map<string, Row>> {
    const found = new Map<string, Row>()
    if (!ids.length) return found
    for (const row of await this.db.query<Row>(`SELECT id,estimated_seconds,basis,confidence,assumptions,approved_seconds,sent_seconds,state,method,model FROM hour_estimates WHERE id IN (${this.placeholders(ids.length)})`, ids)) found.set(row.id, row)
    return found
  }
  async activeRuns() {
    return this.db.query<{ run_id: string; phase: string; deadline_at: string | null }>(`SELECT r.id AS run_id,r.phase,(SELECT max(deadline_at) FROM schedule_run_attempts t WHERE t.run_id=r.id AND t.generation=r.generation) AS deadline_at
      FROM schedule_runs r WHERE r.state='running'`)
  }
  async runningSynthesisCount(): Promise<number> {
    return Number((await this.db.query<{ n: number }>("SELECT count(*) AS n FROM schedule_run_attempts WHERE profile='synthesis' AND state IN ('starting','running')"))[0]!.n)
  }

  // --- attempts, phases, deliveries, artifacts ------------------------------------------------------------------------------------------------------
  async startAttempt(input: { run_id: string; generation: number; phase: string; profile: 'notice' | 'synthesis'; cli?: string | null; model?: string | null; boot_id: string; deadline_at: string }) {
    await this.db.query(`INSERT INTO schedule_run_attempts(run_id,generation,phase,profile,cli,model,boot_id,state,deadline_at,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,'starting',$8,$9)
      ON CONFLICT(run_id,generation) DO NOTHING`, [input.run_id, input.generation, input.phase, input.profile, input.cli ?? null, input.model ?? null, input.boot_id, input.deadline_at, isoNow()])
  }
  async setAttempt(runId: string, generation: number, patch: Partial<{ state: AttemptState; host_pid: number; host_started: string | null; cli_pid: number; cli_started: string | null; exit_code: string; ended_at: string }>) {
    const entries = Object.entries(patch), sets = entries.map(([key], i) => `${key}=$${i + 3}`)
    await this.db.query(`UPDATE schedule_run_attempts SET ${sets.join(',')} WHERE run_id=$1 AND generation=$2`, [runId, generation, ...entries.map(([, value]) => value)])
  }
  async attemptsToReconcile(bootId: string) {
    return this.db.query<Row>("SELECT * FROM schedule_run_attempts WHERE state IN ('starting','running') AND (boot_id IS NULL OR boot_id<>$1)", [bootId])
  }
  async attemptsOf(runId: string) { return this.db.query<Row>('SELECT * FROM schedule_run_attempts WHERE run_id=$1 ORDER BY generation', [runId]) }

  async recordPhase(input: { run_id: string; phase: RunPhase; generation: number; state: 'started' | 'done' | 'failed' | 'uncertain' | 'skipped'; receipt?: Record<string, unknown> }) {
    const now = isoNow()
    await this.db.query(`INSERT INTO schedule_run_phases(run_id,phase,generation,state,receipt,started_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(run_id,phase,generation) DO UPDATE SET state=excluded.state,receipt=excluded.receipt,finished_at=excluded.finished_at`,
    [input.run_id, input.phase, input.generation, input.state, json(input.receipt ?? {}), now, input.state === 'started' ? null : now])
  }
  /** A phase with a `done` receipt in any generation is never repeated; the current receipt is the latest `done`, else the one of the live generation. */
  async currentPhase(runId: string, phase: RunPhase): Promise<{ state: string; generation: number; receipt: Record<string, unknown> } | undefined> {
    return (await this.db.query<{ state: string; generation: number; receipt: Record<string, unknown> }>(`SELECT state,generation,receipt FROM schedule_run_phases WHERE run_id=$1 AND phase=$2
      ORDER BY (state='done') DESC,generation DESC LIMIT 1`, [runId, phase]))[0]
  }
  async phasesOf(runId: string) { return this.db.query<Row>('SELECT phase,generation,state,receipt,started_at,finished_at FROM schedule_run_phases WHERE run_id=$1 ORDER BY started_at,generation', [runId]) }

  async ensureDelivery(runId: string, target: DeliveryTarget): Promise<Row> {
    await this.db.query('INSERT INTO schedule_deliveries(id,run_id,target,state,created_at,updated_at) VALUES($1,$2,$3,\'pending\',$4,$4) ON CONFLICT(run_id,target) DO NOTHING', [randomUUID(), runId, target, isoNow()])
    return (await this.db.query<Row>('SELECT * FROM schedule_deliveries WHERE run_id=$1 AND target=$2', [runId, target]))[0]!
  }
  async setDelivery(id: string, patch: Partial<{ state: string; outbox_ref: string | null; error_code: string | null; attempts: number }>) {
    const entries = Object.entries(patch), sets = entries.map(([key], i) => `${key}=$${i + 2}`)
    await this.db.query(`UPDATE schedule_deliveries SET ${sets.join(',')},updated_at=$${entries.length + 2} WHERE id=$1`, [id, ...entries.map(([, value]) => value), isoNow()])
  }
  async deliveriesOf(runId: string) { return this.db.query<Row>('SELECT id,target,state,attempts,error_code,read_at FROM schedule_deliveries WHERE run_id=$1', [runId]) }
  /** Runs past persist whose deliveries are not all settled: the durable scan that repairs every frontier after a crash. */
  async runsWithOpenDeliveries() {
    return this.db.query<RunRow>(`SELECT r.* FROM schedule_runs r WHERE r.state='running' AND r.phase IN ('deliver','persist') AND r.artifact_id IS NOT NULL`)
  }

  /** The artifact and its private effects are written together; `effects` never leaves this class through a read path. */
  async insertArtifact(input: { id: string; run_id: string; kind: string; title: string; body_md: string; items: unknown[]; snapshot_refs: unknown[]; effects: unknown[] }) {
    await this.db.query(`INSERT INTO schedule_artifacts(id,run_id,kind,title,body_md,items,snapshot_refs,effects,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(run_id) DO NOTHING`,
      [input.id, input.run_id, input.kind, input.title, input.body_md, json(input.items), json(input.snapshot_refs), json(input.effects), isoNow()])
  }
  async artifactOfRun(runId: string) {
    return (await this.db.query<Row>('SELECT id,run_id,kind,title,body_md,items,snapshot_refs,decision_request_ref,authority,created_at,read_at FROM schedule_artifacts WHERE run_id=$1', [runId]))[0]
  }
  /** Runtime-only: the validated effects awaiting prepareDecision, with the authority the artifact currently carries. */
  async pendingEffects(runId: string): Promise<{ id: string; effects: unknown[]; authority: string; decision_request_ref: string | null } | undefined> {
    return (await this.db.query<{ id: string; effects: unknown[]; authority: string; decision_request_ref: string | null }>('SELECT id,effects,authority,decision_request_ref FROM schedule_artifacts WHERE run_id=$1', [runId]))[0]
  }
  async setDecisionRef(artifactId: string, ref: string) {
    await this.db.query("UPDATE schedule_artifacts SET decision_request_ref=$2,effects='[]' WHERE id=$1 AND decision_request_ref IS NULL AND authority='live'", [artifactId, ref])
  }
  /** After a correction the artifact points to the new request; only while it still points to the one that was replaced and keeps its authority. */
  async replaceDecisionRef(runId: string, oldRef: string, newRef: string): Promise<boolean> {
    return (await this.db.query("UPDATE schedule_artifacts SET decision_request_ref=$3 WHERE run_id=$1 AND decision_request_ref=$2 AND authority='live' RETURNING id", [runId, oldRef, newRef])).length === 1
  }
  async markArtifactRead(runId: string) { await this.db.query('UPDATE schedule_artifacts SET read_at=COALESCE(read_at,$2) WHERE run_id=$1', [runId, isoNow()]) }
  async markDeliveriesRead(runId: string) { await this.db.query("UPDATE schedule_deliveries SET read_at=COALESCE(read_at,$2) WHERE run_id=$1 AND target IN ('hub_inbox','app_window')", [runId, isoNow()]) }

  /** Resolves by run; a reference that does not belong to that run's artifact is unknown. */
  async artifactAuthority(input: { run_id: string; decision_request_ref?: string }): Promise<'live' | 'unavailable' | 'unknown'> {
    const row = (await this.db.query<{ authority: string }>('SELECT authority FROM schedule_artifacts WHERE run_id=$1 AND ($2 IS NULL OR decision_request_ref=$2)', [input.run_id, input.decision_request_ref ?? null]))[0]
    return row ? row.authority as 'live' | 'unavailable' : 'unknown'
  }

  // --- public item states (PublicStateSink) --------------------------------------------------------------------------------------------------------
  async set(input: { run_id: string; ordinal: number; kind: string; effect_digest?: string; estimate_id?: string; state: ItemState }) {
    await this.db.query(`INSERT INTO schedule_item_states(run_id,ordinal,kind,effect_digest,estimate_id,state,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(run_id,ordinal) DO UPDATE SET state=excluded.state,effect_digest=COALESCE(excluded.effect_digest,effect_digest),estimate_id=COALESCE(excluded.estimate_id,estimate_id),updated_at=excluded.updated_at`,
    [input.run_id, input.ordinal, input.kind, input.effect_digest ?? null, input.estimate_id ?? null, input.state, isoNow()])
  }
  async itemStates(runId: string) { return this.db.query<Row>('SELECT ordinal,kind,effect_digest,estimate_id,state,updated_at FROM schedule_item_states WHERE run_id=$1 ORDER BY ordinal', [runId]) }

  // --- process incidents -------------------------------------------------------------------------------------------------------------------------
  /** One row per (subject, generation, cause); a repeat is ignored. */
  async addIncident(input: { subject_kind: 'schedule_run' | 'fleet_member'; subject_id: string; generation?: string | number | null; schedule_id?: string | null; run_id?: string | null; team_id?: string | null
    member_id?: string | null; session_id?: string | null; project_id?: string | null; cause: IncidentCause; action: IncidentAction; pid?: number | null; process_started?: string | null; boot_id?: string | null; detail?: Record<string, unknown> }) {
    await this.db.query(`INSERT INTO process_incidents(id,subject_kind,subject_id,generation,schedule_id,run_id,team_id,member_id,session_id,project_id,cause,action,pid,process_started,boot_id,observed_at,detail)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT DO NOTHING`,
    [randomUUID(), input.subject_kind, input.subject_id, input.generation === undefined || input.generation === null ? null : String(input.generation), input.schedule_id ?? null, input.run_id ?? null, input.team_id ?? null,
      input.member_id ?? null, input.session_id ?? null, input.project_id ?? null, input.cause, input.action, input.pid ?? null, input.process_started ?? null, input.boot_id ?? null, isoNow(), json(input.detail ?? {})])
  }
  async incidents(filter: { run_id?: string; schedule_id?: string; project_id?: string; sinceDays?: number }) {
    const since = new Date(Date.now() - (filter.sinceDays ?? 7) * 86_400_000).toISOString()
    return this.db.query<Row>(`SELECT subject_kind,subject_id,generation,schedule_id,run_id,team_id,member_id,project_id,cause,action,observed_at FROM process_incidents
      WHERE observed_at>=$4 AND ($1 IS NULL OR run_id=$1) AND ($2 IS NULL OR schedule_id=$2) AND ($3 IS NULL OR project_id=$3) ORDER BY observed_at DESC LIMIT 50`,
    [filter.run_id ?? null, filter.schedule_id ?? null, filter.project_id ?? null, since])
  }

  // --- readers for other areas -----------------------------------------------------------------------------------------------------------------
  async recentRuns(projectId: string, limit = 10) {
    return this.db.query<Row>(`SELECT r.id,r.scheduled_for,r.state,r.phase,r.trigger,s.template FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id WHERE s.project_id=$1 ORDER BY r.scheduled_for DESC LIMIT $2`, [projectId, limit])
  }
  async uncertainDeliveries(projectId?: string) {
    return this.db.query<Row>(`SELECT d.id,d.run_id,d.target,d.updated_at,s.project_id FROM schedule_deliveries d JOIN schedule_runs r ON r.id=d.run_id JOIN schedules s ON s.id=r.schedule_id
      WHERE d.state='uncertain' AND ($1 IS NULL OR s.project_id=$1) ORDER BY d.updated_at DESC`, [projectId ?? null])
  }
  /** End-of-day closes lost beyond their grace in the last days; the next brief reports them. */
  async overdueCloses(sinceDays = 3) {
    return this.db.query<Row>(`SELECT r.id,r.scheduled_for FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id
      WHERE s.template='daily_close' AND r.state='skipped' AND r.skip_reason='misfire_out_of_grace' AND r.scheduled_for>=$1 ORDER BY r.scheduled_for DESC`, [new Date(Date.now() - sinceDays * 86_400_000).toISOString()])
  }
  async unreadDeliveries(projectId?: string) {
    return this.db.query<Row>(`SELECT r.id AS run_id,a.id AS artifact_id,a.kind,a.title,r.scheduled_for FROM schedule_deliveries d JOIN schedule_runs r ON r.id=d.run_id JOIN schedule_artifacts a ON a.run_id=r.id
      JOIN schedules s ON s.id=r.schedule_id WHERE d.target='hub_inbox' AND d.state='sent' AND d.read_at IS NULL AND ($1 IS NULL OR s.project_id=$1 OR s.project_id IS NULL) ORDER BY r.scheduled_for DESC LIMIT 20`, [projectId ?? null])
  }
  /** Last run whose app delivery was sent: the lower bound of what the next owner-level brief must cover. */
  async lastDeliveredRun(scheduleId: string) {
    return (await this.db.query<{ scheduled_for: string }>(`SELECT r.scheduled_for FROM schedule_runs r JOIN schedule_deliveries d ON d.run_id=r.id AND d.target='app_window' AND d.state='sent'
      WHERE r.schedule_id=$1 ORDER BY r.scheduled_for DESC LIMIT 1`, [scheduleId]))[0]?.scheduled_for
  }
  /** Pre-delete guard of a project: dispatching or uncertain items block, everything else is cancelled by the caller. */
  async blockingItems(projectId: string): Promise<number> {
    return Number((await this.db.query<{ n: number }>(`SELECT count(*) AS n FROM schedule_item_states i JOIN schedule_runs r ON r.id=i.run_id JOIN schedules s ON s.id=r.schedule_id
      WHERE s.project_id=$1 AND i.state IN ('dispatching','uncertain')`, [projectId]))[0]!.n)
  }
}

/** HTTP-level error with a closed code, as returned to agents and the app (409 'schedule_constrained', 'automations_disabled', ...). */
export class ScheduleError extends MemoryError {
  constructor(status: number, override readonly code: string, message: string) { super(status, message, false, code) }
}
