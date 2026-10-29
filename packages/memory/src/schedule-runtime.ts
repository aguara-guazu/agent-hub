import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { inspectNativeProcess } from '@agenthub/gateway'
import type { UsageQuotaAvailability } from '@agenthub/shared'
import type { MemoryDatabase } from './database.js'
import type { MemoryStore } from './store.js'
import type { ArtifactDraft, CollectDeps, DeliveryReceipt, PublicItem, RunContext, RunEvents, RunPackage, ScheduleAutomation, ScheduleTemplateDefinition } from './schedule-contract.js'
import { snapshotOf, TERMINAL_RUN_STATES, type RunRow, type ScheduleRow, type ScheduleStore } from './schedule-store.js'
import { scheduleTemplate } from './schedule-templates.js'
import { graceDeadline, lastOccurrenceUpTo, nextOccurrence, systemTimeZone } from './schedule-time.js'

const MINUTE = 60_000
const TICK_MS = 30_000
/** A run fired within this lateness of its occurrence is a clock run; later ones are lost occurrences recovered on wake. */
const LATE_TOLERANCE_MS = 90_000
const MAX_SYNTHESIS = 2
const MAX_FAILURES = 2
const CLOSE_WAIT_MS = 5_000
const SUPERSEDE_MS = 120 * MINUTE
const QUOTA_BACKOFF_MINUTES = [30, 60, 120]
const DECISION_TTL_MS = 36 * 60 * MINUTE

export interface SynthesisSpawn { host_pid?: number; host_started?: string | null; cli_pid?: number; cli_started?: string | null }
/** Model access of the synthesis phase: a process without tools or MCP over the package the Hub built. */
export interface Synthesizer {
  /** `cli` is null for a non-CLI engine; null result when no engine is configured or remote processing is off. */
  engine(): Promise<{ cli: string | null; model: string } | null>
  run(input: { system: string; content: unknown; schema: Record<string, unknown>; signal: AbortSignal; onSpawn(info: SynthesisSpawn): void }): Promise<{ value: unknown; usage: { model: string; input_tokens: number; output_tokens: number } }>
}
export interface ProcessControl {
  inspect(pid: number): Promise<{ started: string } | null | undefined>
  /** Signals the process group when `group` is set; resolves once the signal was sent. */
  signal(pid: number, signal: NodeJS.Signals, group: boolean): void
}
const defaultProcesses: ProcessControl = {
  inspect: pid => inspectNativeProcess(pid) as Promise<{ started: string } | null | undefined>,
  signal: (pid, signal, group) => { try { process.kill(group && process.platform !== 'win32' ? -pid : pid, signal) } catch { /* already gone */ } },
}

/** What `launch` knows about the run before claiming it, which the claim itself erases. */
interface RunMeta { deferredUntil: string | null; previousQuota: Record<string, unknown> | null; wasInterrupted: boolean }

export interface ScheduleRuntimeOptions {
  store: ScheduleStore; db: MemoryDatabase; memory: MemoryStore; automation: ScheduleAutomation
  usage?: { forCli(cli: string, model?: string): Promise<UsageQuotaAvailability> }
  synthesizer?: Synthesizer
  /** Optional readers of other areas, resolved on every collect so late registration works. */
  deps?: () => Omit<CollectDeps, 'store' | 'now'>
  /** Emits 'change' on quota transitions (LocalChat.events); a deferred run wakes on it. */
  signals?: { on(event: 'change', listener: () => void): unknown; off(event: 'change', listener: () => void): unknown }
  processes?: ProcessControl
  ownerId?: string
  now?(): Date
  zone?(): string
  tickMs?: number
  /** Longest wait for background periodic tasks when closing. */
  closeWaitMs?: number
}

/** Stable refusals of the decision module; matched by code or class name so the memory package does not import the core's error classes. */
function decisionRefusal(error: unknown): 'hub_restart' | 'delivery_unavailable' | null {
  const { name, code } = (error ?? {}) as { name?: string; code?: string }
  if (name === 'DecisionAuthorityUnavailable' || code === 'authority_unavailable') return 'hub_restart'
  if (name === 'NoActionableItems' || code === 'no_actionable_items') return 'delivery_unavailable'
  return null
}
const isoAt = (ms: number) => new Date(ms).toISOString()
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Clock and lifecycle of schedule runs. One instance per Hub process (the orchestration owner); it never depends on the collaboration switch. */
export class ScheduleRuntime {
  readonly events = new EventEmitter<RunEvents>()
  readonly bootId = randomUUID()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking: Promise<void> | undefined
  private stopped = true
  private automationsWere: boolean | undefined
  private inFlight = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private periodic = new Map<string, { task: () => Promise<unknown>; everyMs: number; last: number; running?: Promise<void> | undefined }>()
  private lastActive = ''
  constructor(private o: ScheduleRuntimeOptions) {}

  private now() { return (this.o.now?.() ?? new Date()).getTime() }
  private zone() { return this.o.zone?.() ?? systemTimeZone() }
  private get store() { return this.o.store }

  async start() {
    if (!this.stopped) return
    this.stopped = false
    await this.reconcileOrphans().catch(() => undefined)
    this.o.signals?.on('change', this.kick)
    this.timer = setInterval(this.kick, this.o.tickMs ?? TICK_MS); this.timer.unref()
    this.kick()
  }
  async close() {
    this.stopped = true; clearInterval(this.timer); this.o.signals?.off('change', this.kick)
    for (const entry of this.inFlight.values()) entry.controller.abort()
    await Promise.allSettled([...this.inFlight.values()].map(entry => entry.done)); await this.ticking
    // A periodic task stuck on the network must not hold the Hub's shutdown.
    await Promise.race([Promise.allSettled([...this.periodic.values()].map(entry => entry.running)), new Promise(resolve => setTimeout(resolve, this.o.closeWaitMs ?? CLOSE_WAIT_MS).unref())])
  }
  /** Resolves when no tick or run is in progress. */
  async idle() {
    for (let i = 0; i < 20 && (this.ticking || this.inFlight.size); i++) { await this.ticking; await Promise.allSettled([...this.inFlight.values()].map(entry => entry.done)) }
  }
  /** Other areas hook periodic maintenance (expiry of derived plans) into the same tick. */
  addPeriodic(name: string, task: () => Promise<unknown>, everyMs = 0) { this.periodic.set(name, { task, everyMs, last: 0 }) }
  kick = () => { if (!this.stopped && !this.ticking) this.ticking = this.tick().catch(() => undefined).finally(() => { this.ticking = undefined }) }
  activeRuns() { return this.store.activeRuns() }
  /** Aborts the in-flight run of a schedule; the run ends as cancelled. */
  async stopRun(scheduleId: string) {
    const stopping: Array<Promise<void>> = []
    for (const run of await this.store.runningRuns()) {
      const entry = run.schedule_id === scheduleId ? this.inFlight.get(run.id) : undefined
      if (entry) { entry.controller.abort(new Error('schedule_cancelled')); stopping.push(entry.done) }
    }
    await Promise.allSettled(stopping)
  }

  /** One pass: switch handling, time zone, expiry, due occurrences, runnable runs and the durable delivery scan. */
  async tick() {
    const enabled = this.o.automation.enabled()
    if (!enabled) { await this.suspend(); return }
    this.automationsWere = true
    await this.checkZone()
    const now = this.now()
    for (const schedule of await this.store.expiredSchedules(isoAt(now))) { await this.store.touchSchedule(schedule.id, { state: 'expired', next_run_at: null }); this.events.emit('schedule.changed', { schedule_id: schedule.id, type: 'schedule.cancelled' }) }
    for (const schedule of await this.store.dueSchedules(isoAt(now))) await this.fire(schedule, now)
    // Periodic tasks may wait on the network: they run in the background, never overlap themselves and never delay launching a due run.
    for (const entry of this.periodic.values()) {
      if (entry.running || now - entry.last < entry.everyMs) continue
      entry.last = now
      entry.running = entry.task().then(() => undefined, () => undefined).finally(() => { entry.running = undefined })
    }
    await this.wakeDeferred(now)
    for (const run of await this.store.runnable(isoAt(now))) this.launch(run)
    for (const run of await this.store.runningRuns()) if (!this.inFlight.has(run.id) && run.artifact_id) this.launch(run, true)
    await this.publishActive()
  }

  // --- automations switch --------------------------------------------------------------------------------------------------------------------------
  /** Cancels what has not started, aborts what is running and records why; deliveries and effects already accepted are not reverted. */
  private async suspend() {
    if (this.automationsWere === false) return
    this.automationsWere = false
    // Revoke first: an action already preparing must find its request revoked at the dispatch gate.
    const revoked = await this.o.automation.effects?.decisions.revokeAll?.().catch(() => -1)
    if (revoked !== undefined) await this.store.addEvent({ type: 'decisions.revoked', actor_kind: 'system', payload: { count: revoked, cause: 'automations_off' } })
    await this.store.cancelAllLiveRuns('automations_off')
    for (const [runId, entry] of this.inFlight) {
      const run = await this.store.run(runId)
      await this.store.addIncident({ subject_kind: 'schedule_run', subject_id: runId, generation: run?.generation ?? 0, schedule_id: run?.schedule_id ?? null, run_id: runId, cause: 'automations_off', action: 'terminated' })
      entry.controller.abort(new Error('automations_off'))
    }
    await Promise.allSettled([...this.inFlight.values()].map(entry => entry.done))
    await this.publishActive()
  }

  // --- time zone ---------------------------------------------------------------------------------------------------------------------------------
  private async checkZone() {
    const zone = this.zone()
    const stored = (await this.o.db.query<{ value: unknown }>("SELECT value FROM settings WHERE key='schedule_timezone'"))[0]?.value
    if (stored === zone) return
    await this.o.db.transaction(async () => {
      if (stored !== undefined) for (const schedule of await this.store.dailySchedules()) {
        const next = nextOccurrence(schedule.recurrence, this.now(), zone)
        await this.store.touchSchedule(schedule.id, { next_run_at: next === null ? null : isoAt(next) })
      }
      await this.o.db.query("INSERT INTO settings(key,value) VALUES('schedule_timezone',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(zone)])
    })
  }

  // --- clock and misfire ---------------------------------------------------------------------------------------------------------------------------
  /** Creates at most one occurrence for a due schedule: the latest one missed, coalescing the rest. */
  private async fire(schedule: ScheduleRow, now: number) {
    const zone = this.zone(), due = Date.parse(schedule.next_run_at!)
    const scheduledFor = lastOccurrenceUpTo(schedule.recurrence, due, now, zone) ?? due
    const following = nextOccurrence(schedule.recurrence, Math.max(now, scheduledFor), zone, scheduledFor)
    const late = now - scheduledFor > LATE_TOLERANCE_MS
    const trigger: RunRow['trigger'] = late ? 'misfire' : 'clock'
    let state: RunRow['state'] = 'pending', skip: string | undefined
    if (late) {
      const deadline = graceDeadline(scheduledFor, { policy: schedule.grace_policy, minutes: schedule.grace_minutes, until: schedule.grace_until }, zone, following)
      if (schedule.misfire === 'skip' || now > deadline) { state = 'skipped'; skip = 'misfire_out_of_grace' }
      else if (schedule.grace_policy === 'until_next' && following !== null && following - now <= SUPERSEDE_MS) { state = 'skipped'; skip = 'superseded' }
    }
    if (state === 'pending' && await this.store.liveRunOf(schedule.id)) { state = 'skipped'; skip = 'overlap' }
    const previous = await this.store.lastRunOf(schedule.id)
    const definition = { ...snapshotOf(schedule), covered_since: (await this.store.lastDeliveredRun(schedule.id)) ?? null,
      extend_from: previous?.state === 'skipped' && ['misfire_out_of_grace', 'superseded'].includes(previous.skip_reason ?? '') ? previous.scheduled_for : null }
    await this.o.db.transaction(async () => {
      await this.store.insertRun({ schedule_id: schedule.id, scheduled_for: isoAt(scheduledFor), schedule_revision: schedule.revision, definition, trigger, state, ...(skip ? { skip_reason: skip } : {}) })
      await this.store.touchSchedule(schedule.id, { next_run_at: following === null ? null : isoAt(following), ...(following === null && state === 'skipped' && schedule.recurrence.type === 'once' ? { state: 'expired' as const } : {}) })
    })
  }

  // --- execution ---------------------------------------------------------------------------------------------------------------------------------
  private launch(run: RunRow, resumeRunning = false) {
    if (this.stopped || this.inFlight.has(run.id) || !this.o.automation.enabled()) return
    const controller = new AbortController()
    const done = (async () => {
      const claimed = resumeRunning ? await this.store.reclaimRunning(run.id, run.generation) : await this.store.claimRun(run.id, run.generation)
      if (!claimed) return
      await this.execute(claimed, controller, { deferredUntil: resumeRunning || run.state !== 'deferred' ? null : run.next_attempt_at, previousQuota: run.quota, wasInterrupted: run.state === 'interrupted' })
      const final = await this.store.run(run.id)
      if (final && TERMINAL_RUN_STATES.includes(final.state)) this.events.emit('run.finished', { run_id: run.id, state: final.state })
    })().catch(() => undefined).finally(() => { this.inFlight.delete(run.id); void this.publishActive() })
    this.inFlight.set(run.id, { controller, done })
  }

  private async execute(run: RunRow, controller: AbortController, meta: RunMeta) {
    const generation = run.generation
    const schedule = await this.store.schedule(run.schedule_id)
    if (!schedule || ['cancelled', 'expired'].includes(schedule.state)) return this.finish(run, 'skipped', { skip_reason: 'schedule_cancelled' })
    const template = scheduleTemplate(run.definition.template)
    if (!template) return this.finish(run, 'failed', { error_code: 'collect_failed' })
    if (meta.wasInterrupted && this.pastGrace(run)) return this.finish(run, 'skipped', { skip_reason: 'misfire_out_of_grace' })
    await this.store.addEvent({ type: 'run.started', schedule_id: run.schedule_id, run_id: run.id, actor_kind: 'system', payload: { generation } })
    try {
      if (!await this.store.pendingEffects(run.id) && await this.produce(run, template, controller, meta) === 'stop') return
      if (await this.decide(run) === 'blocked') return
      await this.deliver(run)
    } catch (error) {
      const reason = controller.signal.aborted ? String((controller.signal.reason as Error | undefined)?.message ?? '') : ''
      if (reason === 'automations_off') return void await this.store.setRun(run.id, generation, { state: 'skipped', phase: 'done', skip_reason: 'automations_off', finished_at: isoAt(this.now()) })
      if (reason === 'schedule_cancelled') return void await this.store.setRun(run.id, generation, { state: 'cancelled', phase: 'done', error_code: 'schedule_cancelled', finished_at: isoAt(this.now()) })
      if (controller.signal.aborted) return void await this.store.setRun(run.id, generation, { state: 'interrupted' })
      const hasArtifact = !!(await this.store.pendingEffects(run.id))
      if (!(error as { recorded?: boolean }).recorded) await this.store.recordPhase({ run_id: run.id, phase: hasArtifact ? 'deliver' : 'persist', generation, state: 'failed', receipt: { error_code: this.errorCode(error) } })
      // A failure is retried with a new generation: from collect before the artifact exists, from the artifact's own boundary after it.
      if (await this.store.failedPhaseCount(run.id) < MAX_FAILURES) return void await this.store.setRun(run.id, generation, { state: hasArtifact ? 'running' : 'pending' })
      await this.finish(run, 'failed', { error_code: this.errorCode(error) })
    }
  }
  private pastGrace(run: RunRow) {
    const zone = this.zone(), d = run.definition, at = Date.parse(run.scheduled_for)
    return this.now() > graceDeadline(at, { policy: d.grace_policy, minutes: d.grace_minutes, until: d.grace_until }, zone, nextOccurrence(d.recurrence, at, zone, at))
  }

  private errorCode(error: unknown): RunRow['error_code'] & string {
    const code = (error as { code?: string } | null)?.code
    if (code === 'quota_exhausted') return 'quota_exhausted'
    if (code === 'deadline_exceeded') return 'deadline_exceeded'
    return (error as { phase?: string } | null)?.phase === 'collect' ? 'collect_failed' : 'synthesis_failed'
  }

  private context(run: RunRow, controller: AbortController, deferredUntil: string | null): RunContext {
    const d = run.definition
    return { run_id: run.id, schedule_id: run.schedule_id, generation: run.generation, scheduled_for: run.scheduled_for, scope: d.scope, project_id: d.project_id, template: d.template, template_version: d.template_version, title: d.title,
      params: d.params, instructions: d.instructions, covered_since: d.covered_since ?? null, trigger: run.trigger, deferred_until: deferredUntil, extend_from: d.extend_from ?? null, signal: controller.signal }
  }

  /** collect → synthesize → persist. Nothing before persist leaves a trace beyond receipts, so a crash recomputes from collect. */
  private async produce(run: RunRow, template: ScheduleTemplateDefinition<any>, controller: AbortController, meta: RunMeta): Promise<'persisted' | 'stop'> {
    const generation = run.generation, ctx = this.context(run, controller, meta.deferredUntil)
    await this.store.recordPhase({ run_id: run.id, phase: 'collect', generation, state: 'started' })
    let pkg: RunPackage
    try { pkg = await template.collect(ctx, { store: this.o.memory, now: () => new Date(this.now()), statusProjects: () => this.store.statusProjects(), ...this.o.deps?.() } as CollectDeps) }
    catch (error) { await this.store.recordPhase({ run_id: run.id, phase: 'collect', generation, state: 'failed', receipt: { error_code: 'collect_failed' } }); throw Object.assign(error as object, { phase: 'collect', recorded: true }) }
    await this.store.recordPhase({ run_id: run.id, phase: 'collect', generation, state: 'done', receipt: { digest: digest(pkg.sections.map(section => section.data)), counts: Object.fromEntries(pkg.sections.map(section => [section.id, Array.isArray(section.data) ? section.data.length : 1])),
      remote_allowed: pkg.remote_allowed, covered_since: ctx.covered_since } })
    await this.store.setRun(run.id, generation, { phase: 'synthesize' })

    let synthesis: unknown = null, model: string | undefined, receipt: Record<string, unknown> = { generation }
    const wanted = template.kind === 'synthesis' && template.synthesize && (template.synthesize.when?.(pkg) ?? true)
    if (wanted) {
      if (!pkg.remote_allowed) receipt = { error_code: 'remote_processing_excluded' }
      else {
        const result = await this.synthesize(run, template, pkg, controller, meta)
        if (result === 'stop') return 'stop'
        if (result) { synthesis = result.value; model = result.usage.model; receipt = { cli: result.cli, model, usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens } } }
        else receipt = { error_code: 'synthesis_unavailable' }
      }
    }
    const draft = template.render(ctx, pkg, synthesis, { ...(model ? { model } : {}) })
    await this.persist(run, pkg, draft, { ...receipt, generation })
    return 'persisted'
  }

  /** Returns the synthesis, null when no engine can run it, or 'stop' when the run was deferred or returned to the queue. */
  private async synthesize(run: RunRow, template: ScheduleTemplateDefinition<any>, pkg: RunPackage, controller: AbortController, meta: RunMeta): Promise<{ value: unknown; usage: { model: string; input_tokens: number; output_tokens: number }; cli: string } | null | 'stop'> {
    const generation = run.generation, synthesizer = this.o.synthesizer
    const engine = synthesizer ? await synthesizer.engine() : null
    if (!synthesizer || !engine) return null
    if (engine.cli && this.o.usage && await this.deferForQuota(run, engine.cli, engine.model, meta)) return 'stop'
    if (await this.store.runningSynthesisCount() >= MAX_SYNTHESIS) { await this.store.setRun(run.id, generation, { state: 'pending' }); return 'stop' }
    const deadline = this.now() + template.max_runtime_ms
    await this.store.startAttempt({ run_id: run.id, generation, phase: 'synthesize', profile: 'synthesis', cli: engine.cli, model: engine.model, boot_id: this.bootId, deadline_at: isoAt(deadline) })
    await this.store.recordPhase({ run_id: run.id, phase: 'synthesize', generation, state: 'started' })
    const visible = pkg.sections.filter(section => section.model_visible !== false).map(({ id, title, data }) => ({ id, title, data }))
    const limit = template.synthesize!.max_input_chars
    const content = JSON.stringify(visible).length > limit ? visible.map(section => ({ ...section, data: JSON.stringify(section.data).slice(0, Math.floor(limit / visible.length)) })) : visible
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(template.max_runtime_ms)])
    try {
      const result = await synthesizer.run({ system: template.synthesize!.system, content, schema: template.synthesize!.output, signal, onSpawn: info => { void this.store.setAttempt(run.id, generation, { state: 'running', ...info }) } })
      await this.store.setAttempt(run.id, generation, { state: 'exited', ended_at: isoAt(this.now()) })
      return { ...result, cli: engine.cli ?? 'engine' }
    } catch (error) {
      const timedOut = signal.aborted && !controller.signal.aborted
      await this.store.setAttempt(run.id, generation, { state: timedOut ? 'deadline_exceeded' : controller.signal.aborted ? 'terminated' : 'exited', ended_at: isoAt(this.now()) })
      if (controller.signal.aborted) throw error
      const code = timedOut ? 'deadline_exceeded' : (error as { code?: string }).code
      await this.store.recordPhase({ run_id: run.id, phase: 'synthesize', generation, state: 'failed', receipt: { error_code: code === 'quota_exhausted' ? 'quota_exhausted' : timedOut ? 'deadline_exceeded' : 'synthesis_failed' } })
      if (code === 'quota_exhausted') { await this.deferRun(run, engine.cli, engine.model, null, meta, true); return 'stop' }
      throw Object.assign(error as object, { code, recorded: true })
    }
  }

  // --- quota ---------------------------------------------------------------------------------------------------------------------------------
  /** Defers the run when the pool is exhausted; unknown never blocks unless the run was already deferred for this window. */
  private async deferForQuota(run: RunRow, cli: string, model: string, meta: RunMeta): Promise<boolean> {
    const availability = await this.o.usage!.forCli(cli, model)
    if (availability.status !== 'exhausted' && availability.status !== 'cooldown') return false
    await this.deferRun(run, cli, model, availability, meta, false)
    return true
  }
  private async deferRun(run: RunRow, cli: string | null, model: string, availability: UsageQuotaAvailability | null, meta: RunMeta, afterLimit: boolean) {
    const now = this.now()
    const resets = (availability?.pools ?? []).flatMap(pool => pool.observation.windows.map(window => window.resets_at).filter((value): value is string => !!value && Date.parse(value) > now)).sort()
    const previous = (meta.previousQuota ?? {}) as { backoff_index?: number }
    const index = afterLimit ? Math.min((previous.backoff_index ?? -1) + 1, QUOTA_BACKOFF_MINUTES.length - 1) : 0
    const next = resets.length ? Math.max(Date.parse(resets[0]!), now + MINUTE) : now + (afterLimit ? QUOTA_BACKOFF_MINUTES[index]! : 30) * MINUTE
    const pools = availability?.pools ?? []
    await this.store.setRun(run.id, run.generation, { state: 'deferred', deferred_reason: 'quota', next_attempt_at: isoAt(next), quota: { cli, model, binding_ids: [...new Set(pools.flatMap(pool => pool.binding_ids))], pool_ids: pools.map(pool => pool.pool_id),
      status: availability?.status ?? 'unknown', ...(resets[0] ? { resets_at: resets[0] } : {}), observed_at: isoAt(now), source_adapter: pools[0]?.observation.source.adapter ?? 'cli', backoff_index: index } })
    await this.store.addEvent({ type: 'run.deferred', schedule_id: run.schedule_id, run_id: run.id, actor_kind: 'system', payload: { reason: 'quota', next_attempt_at: isoAt(next) } })
  }
  /** A deferred run wakes early when its pool is no longer exhausted, without waiting for the observed reset time. */
  private async wakeDeferred(now: number) {
    if (!this.o.usage) return
    for (const run of await this.store.deferredForQuota()) {
      if (!run.next_attempt_at || Date.parse(run.next_attempt_at) <= now) continue
      const quota = run.quota as { cli?: string; model?: string } | null
      // Only a pool observed as exhausted can be observed as recovered; a limit reported by the CLI waits out its backoff.
      if (!quota?.cli || !['exhausted', 'cooldown'].includes(String((run.quota as { status?: string } | null)?.status))) continue
      const status = (await this.o.usage.forCli(quota.cli, quota.model)).status
      if (status === 'available' || status === 'low') await this.store.setRun(run.id, run.generation, { next_attempt_at: isoAt(now) })
    }
  }

  // --- persist, decision and delivery ------------------------------------------------------------------------------------------------------
  /** Artifact, snapshots, writers and the synthesize receipt commit together; the artifact then exists whatever happens next. */
  private async persist(run: RunRow, pkg: RunPackage, draft: ArtifactDraft, receipt: Record<string, unknown>) {
    const generation = run.generation, artifactId = randomUUID()
    await this.o.db.transaction(async sql => {
      const refs = [...draft.snapshot_refs]
      for (const snapshot of draft.snapshots ?? []) refs.push({ project_id: snapshot.project_id, version: await snapshot.write(sql) })
      for (const writer of draft.writers ?? []) await writer.write(sql)
      await this.store.insertArtifact({ id: artifactId, run_id: run.id, kind: draft.kind, title: draft.title, body_md: draft.body_md, items: draft.items, snapshot_refs: refs, effects: draft.proposed_effects ?? [] })
      await this.store.recordPhase({ run_id: run.id, phase: 'synthesize', generation, state: receipt.error_code ? 'skipped' : 'done', receipt })
      await this.store.recordPhase({ run_id: run.id, phase: 'persist', generation, state: 'started', receipt: { items: draft.items.length, project_ids: pkg.project_ids } })
      await this.store.setRun(run.id, generation, { artifact_id: artifactId, phase: 'persist' })
    })
    await this.store.addEvent({ type: 'run.persisted', schedule_id: run.schedule_id, run_id: run.id, actor_kind: 'system', payload: { artifact_kind: draft.kind } })
    this.events.emit('run.persisted', { run_id: run.id, artifact_id: artifactId, has_items: draft.items.length > 0 })
  }

  /** Executable items need a confirmed request before delivery; a restored artifact has no authority and never creates one. */
  private async decide(run: RunRow): Promise<'ready' | 'blocked'> {
    const generation = run.generation, artifact = await this.store.pendingEffects(run.id)
    if (!artifact) throw new Error('missing_artifact')
    if (artifact.effects.length && !artifact.decision_request_ref) {
      const decisions = this.o.automation.effects?.decisions
      if (artifact.authority !== 'live' || !decisions) { await this.finish(run, 'failed', { error_code: artifact.authority !== 'live' ? 'hub_restart' : 'delivery_unavailable' }); return 'blocked' }
      const full = await this.store.artifactOfRun(run.id)
      const effects = artifact.effects as Array<{ ordinal: number; effect: unknown }>
      const items = (full!.items as Array<{ ordinal: number; kind: PublicItem['kind']; project_id: string; summary: string }>).map(item => ({ ...item, effect: effects.find(entry => entry.ordinal === item.ordinal)?.effect }))
      let decision_request_ref: string
      try {
        ({ decision_request_ref } = await decisions.prepareDecision({ run_id: run.id, artifact_id: artifact.id, owner_id: this.o.ownerId ?? 'owner',
          project_ids: [...new Set(items.map(item => item.project_id))], items, expires_at: isoAt(this.now() + DECISION_TTL_MS) }))
      } catch (error) {
        // A refusal by the decision module is final for this artifact: retrying cannot make it live again.
        const refusal = decisionRefusal(error)
        if (!refusal) throw error
        await this.finish(run, 'failed', { error_code: refusal })
        return 'blocked'
      }
      await this.o.db.transaction(async () => {
        await this.store.setDecisionRef(artifact.id, decision_request_ref)
        await this.store.recordPhase({ run_id: run.id, phase: 'persist', generation, state: 'done', receipt: { decision_request: 'set' } })
        await this.store.setRun(run.id, generation, { phase: 'deliver' })
      })
      return 'ready'
    }
    await this.o.db.transaction(async () => {
      await this.store.recordPhase({ run_id: run.id, phase: 'persist', generation, state: 'done', receipt: {} })
      await this.store.setRun(run.id, generation, { phase: 'deliver' })
    })
    return 'ready'
  }

  private async deliver(run: RunRow) {
    const generation = run.generation, artifact = (await this.store.artifactOfRun(run.id))!, adapters = this.o.automation.effects?.deliveries
    await this.store.recordPhase({ run_id: run.id, phase: 'deliver', generation, state: 'started' })
    const targets = run.definition.delivery
    for (const target of targets) {
      const delivery = await this.store.ensureDelivery(run.id, target)
      if (delivery.state === 'sent' || delivery.state === 'skipped' || delivery.state === 'failed' || delivery.state === 'uncertain') continue
      if (delivery.state === 'sending') { await this.store.setDelivery(delivery.id, { state: 'uncertain', error_code: 'delivery_uncertain' }); continue }
      if (target === 'hub_inbox' || target === 'app_window') { await this.store.setDelivery(delivery.id, { state: 'sent', attempts: 1 }); continue }
      const available = adapters ? (await adapters.available())[target] : undefined
      if (!adapters || !available?.available) { await this.store.setDelivery(delivery.id, { state: 'failed', error_code: 'delivery_unavailable' }); continue }
      await this.store.setDelivery(delivery.id, { state: 'sending', attempts: delivery.attempts + 1 })
      const receipt = await adapters.executeDelivery({ delivery_id: delivery.id, run_id: run.id, artifact_id: artifact.id, target, expected_generation: generation }).catch((): DeliveryReceipt => ({ state: 'uncertain', error_code: 'delivery_uncertain' }))
      await this.store.setDelivery(delivery.id, { state: receipt.state, outbox_ref: receipt.outbox_ref ?? null, error_code: receipt.error_code ?? null })
    }
    const states = (await this.store.deliveriesOf(run.id)).map(row => String(row.state))
    const state = states.includes('uncertain') ? 'uncertain' : states.some(value => value === 'failed') ? 'partial' : 'succeeded'
    await this.store.recordPhase({ run_id: run.id, phase: 'deliver', generation, state: state === 'succeeded' ? 'done' : state === 'uncertain' ? 'uncertain' : 'failed', receipt: { targets: states } })
    await this.finish(run, state, state === 'succeeded' ? {} : { error_code: state === 'uncertain' ? 'delivery_uncertain' : 'delivery_failed' })
  }

  private async finish(run: RunRow, state: RunRow['state'], patch: Partial<Pick<RunRow, 'skip_reason' | 'error_code'>> = {}) {
    const ok = await this.store.setRun(run.id, run.generation, { state, phase: 'done', finished_at: isoAt(this.now()), ...patch })
    if (!ok) return
    await this.store.addEvent({ type: 'run.finished', schedule_id: run.schedule_id, run_id: run.id, actor_kind: 'system', payload: { state } })
    const schedule = await this.store.schedule(run.schedule_id)
    // A one-shot closes only when its occurrence reaches a terminal state, so a deferred run keeps it active.
    if (schedule?.recurrence.type === 'once' && schedule.state === 'active' && TERMINAL_RUN_STATES.includes(state)) await this.store.touchSchedule(schedule.id, { state: state === 'skipped' ? 'expired' : 'completed', next_run_at: null })
  }

  private async publishActive() {
    const active = await this.store.activeRuns(), key = JSON.stringify(active.map(row => [row.run_id, row.phase]))
    if (key === this.lastActive) return
    this.lastActive = key
    this.events.emit('runs.changed', { active: active.map(row => ({ run_id: row.run_id, phase: row.phase })) })
  }

  // --- orphans after a restart ---------------------------------------------------------------------------------------------------------------------
  /**
   * Terminates the processes a previous Hub start left behind, only when the recorded birth time proves they are ours, and records what was found.
   * An attempt that never recorded a process identity cannot have outlived the restart with effects (synthesis has no tools), so its run is retried.
   */
  async reconcileOrphans() {
    const processes = this.o.processes ?? defaultProcesses
    const blocked = new Set<string>()
    for (const attempt of await this.store.attemptsToReconcile(this.bootId)) {
      const identities = [{ pid: attempt.cli_pid as number | null, started: attempt.cli_started as string | null, group: true }, { pid: attempt.host_pid as number | null, started: attempt.host_started as string | null, group: false }].filter(item => item.pid)
      let action: 'terminated' | 'already_exited' | 'unverified_left_running' | 'termination_unknown' | 'none' = identities.length ? 'already_exited' : 'none'
      for (const identity of identities) {
        const live = await processes.inspect(identity.pid!).catch(() => undefined)
        if (live === undefined) { action = 'termination_unknown'; break }
        if (live === null) continue
        if (!identity.started || live.started !== identity.started) { action = 'unverified_left_running'; continue }
        processes.signal(identity.pid!, 'SIGTERM', identity.group)
        await new Promise(resolve => setTimeout(resolve, 200))
        if (await processes.inspect(identity.pid!).catch(() => undefined)) { processes.signal(identity.pid!, 'SIGKILL', identity.group); await new Promise(resolve => setTimeout(resolve, 200)) }
        const after = await processes.inspect(identity.pid!).catch(() => undefined)
        if (after === null && action !== 'unverified_left_running') action = 'terminated'
        else if (after !== null) { action = 'termination_unknown'; break }
      }
      const run = await this.store.run(attempt.run_id as string)
      await this.store.setAttempt(attempt.run_id as string, attempt.generation as number, { state: action === 'termination_unknown' ? 'termination_unknown' : action === 'unverified_left_running' ? 'orphan_unverified' : action === 'none' ? 'orphan_unverified' : 'orphan_terminated', ended_at: isoAt(this.now()) })
      await this.store.addIncident({ subject_kind: 'schedule_run', subject_id: attempt.run_id as string, generation: attempt.generation as number, schedule_id: run?.schedule_id ?? null, run_id: attempt.run_id as string,
        project_id: run?.definition.project_id ?? null, cause: 'hub_restart', action, pid: (attempt.cli_pid ?? attempt.host_pid) as number | null, process_started: (attempt.cli_started ?? attempt.host_started) as string | null, boot_id: attempt.boot_id as string | null })
      // Only a tool-less synthesis may be retried without proof about its process; any profile with tools stays blocked.
      if (action === 'termination_unknown' || action === 'unverified_left_running' || (action === 'none' && attempt.profile !== 'synthesis' && attempt.profile !== 'notice')) blocked.add(attempt.run_id as string)
    }
    for (const run of await this.store.runningRuns()) {
      if (this.inFlight.has(run.id)) continue
      const artifact = await this.store.pendingEffects(run.id)
      if (artifact) { await this.o.db.query("UPDATE schedule_deliveries SET state='uncertain',error_code='hub_restart',updated_at=$2 WHERE run_id=$1 AND state='sending'", [run.id, isoAt(this.now())]); continue }
      // A process that may still be alive keeps its run from being replaced automatically.
      if (blocked.has(run.id)) await this.store.setRun(run.id, run.generation, { state: 'failed', phase: 'done', error_code: 'hub_restart', finished_at: isoAt(this.now()) })
      else await this.store.setRun(run.id, run.generation, { state: 'interrupted' })
    }
    // Fleet members have no persisted process identity yet, so nothing can be terminated here; the incident is the evidence that they ended with the restart.
    for (const member of await this.store.fleetMembersInFlight()) {
      await this.store.addIncident({ subject_kind: 'fleet_member', subject_id: member.id, generation: member.generation, team_id: member.team_id, member_id: member.id, session_id: member.session_id,
        cause: 'hub_restart', action: 'none', boot_id: this.bootId, detail: { reason: 'no_persisted_process_identity', last_state: member.state } })
    }
    await this.publishActive()
  }
}
