import { randomUUID } from 'node:crypto'
import type { MemoryDatabase } from './database.js'
import { MemoryError } from './contracts.js'
import type { AgentContext } from './agents.js'
import { isRunProfileAgent, type Actor, type DeliveryTarget, type Recurrence, type ScheduleState, type ScheduleView } from './schedule-contract.js'
import { ScheduleError, ScheduleStore, snapshotOf, targetKey, type RunRow, type ScheduleRow } from './schedule-store.js'
import { scheduleTemplate } from './schedule-templates.js'
import { localIso, nextOccurrence, systemTimeZone } from './schedule-time.js'
import { SCHEDULE_RESTORE_WINDOW_MS, type ScheduleRestoreInfo } from "@agenthub/shared"

const MAX_PER_AGENT = 20, MAX_PER_OWNER = 100, MAX_ONCE_DAYS = 366

/** Who performs a mutation: an agent session through the MCP tools, or the owner through the app. */
export type Principal = { kind: 'agent'; agent: AgentContext } | { kind: 'human'; ref: string }
const actorOf = (principal: Principal): { kind: Actor; ref: string } => principal.kind === 'agent' ? { kind: 'agent', ref: principal.agent.agent_id } : { kind: 'human', ref: principal.ref }

export interface ScheduleAdminOptions {
  store: ScheduleStore; db: MemoryDatabase
  automationsEnabled(): boolean
  /** Adapter availability reported by the effects module; absent adapters make gmail_self and slack_self unavailable. */
  deliveryAvailability(): Promise<Record<'gmail_self' | 'slack_self', { available: boolean; reason?: string }>>
  isRunProfile?(agent: AgentContext): boolean
  zone?(): string
  now?(): Date
  /** Wakes the runtime after a change that may leave work due. */
  wake?(): void
  /** Aborts the in-flight run of a schedule that was cancelled or paused by a person. */
  stopRun?(scheduleId: string): Promise<void>
}

export interface CreateInput { project_id?: string | null | undefined; template: string; title: string; instructions: string; params: Record<string, unknown>; recurrence: Recurrence
  delivery: DeliveryTarget[]; misfire?: 'run_once' | 'skip' | undefined; expires_at?: string | undefined; request_id: string }
export interface UpdateInput { title?: string | undefined; instructions?: string | undefined; params?: Record<string, unknown> | undefined; recurrence?: Recurrence | undefined; delivery?: DeliveryTarget[] | undefined
  misfire?: 'run_once' | 'skip' | undefined; expires_at?: string | null | undefined }

/** Admission and mutation of schedules. The invariants never read instructions or titles; they are properties of the request. */
export class ScheduleAdmin {
  constructor(private o: ScheduleAdminOptions) {}
  private zone() { return this.o.zone?.() ?? systemTimeZone() }
  private now() { return (this.o.now?.() ?? new Date()).getTime() }
  private get store() { return this.o.store }
  private fail(status: number, code: string, message: string): never { throw new ScheduleError(status, code, `${code}: ${message}`) }

  private requireAutomations() { if (!this.o.automationsEnabled()) this.fail(409, 'automations_disabled', 'Las automatizaciones están desactivadas en Ajustes.') }
  private requireAgent(principal: Principal): void {
    if (principal.kind === 'human') return
    if ((this.o.isRunProfile ?? isRunProfileAgent)(principal.agent)) this.fail(403, 'run_cannot_schedule', 'Un run no administra schedules.')
  }

  private checkRecurrence(recurrence: Recurrence, minInterval: number) {
    const now = this.now()
    if (recurrence.type === 'interval' && recurrence.minutes < minInterval) this.fail(400, 'interval_too_short', `El intervalo mínimo de esta plantilla es de ${minInterval} minutos.`)
    if (recurrence.type === 'once') {
      const at = Date.parse(recurrence.at)
      if (!(at > now)) this.fail(400, 'once_in_past', 'La ejecución única debe ser en el futuro.')
      if (at - now > MAX_ONCE_DAYS * 86_400_000) this.fail(400, 'once_too_far', `La ejecución única debe ser dentro de ${MAX_ONCE_DAYS} días.`)
    }
  }
  private firstRun(recurrence: Recurrence): string | null {
    const next = nextOccurrence(recurrence, this.now(), this.zone())
    return next === null ? null : new Date(next).toISOString()
  }
  private async checkDelivery(delivery: DeliveryTarget[], allowed: DeliveryTarget[]) {
    for (const target of delivery) if (!allowed.includes(target)) this.fail(400, 'delivery_not_allowed', `La plantilla no admite el destino ${target}.`)
    const external = delivery.filter(target => target === 'gmail_self' || target === 'slack_self')
    if (!external.length) return
    const availability = await this.o.deliveryAvailability()
    for (const target of external as Array<'gmail_self' | 'slack_self'>) if (!availability[target]?.available) this.fail(409, 'delivery_unavailable', `El destino ${target} no está disponible${availability[target]?.reason ? ` (${availability[target]!.reason})` : ''}.`)
  }
  private async checkProject(projectId: string) {
    const row = (await this.o.db.query<{ kind: string }>('SELECT kind FROM entities WHERE id=$1', [projectId]))[0]
    if (!row || row.kind !== 'project') this.fail(404, 'project_not_found', 'El proyecto no existe.')
  }

  async create(principal: Principal, input: CreateInput): Promise<{ schedule: ScheduleView; announce: string }> {
    this.requireAgent(principal); this.requireAutomations()
    const template = scheduleTemplate(input.template)
    if (!template || input.template === 'team_health') this.fail(400, 'template_unknown', 'Plantilla no admitida.')
    const actor = actorOf(principal)
    const replay = await this.store.eventByRequest(actor.ref, input.request_id)
    if (replay?.schedule_id) { const existing = await this.store.schedule(replay.schedule_id); if (existing) return { schedule: await this.view(existing), announce: await this.announce('Ya estaba programado', existing) } }
    const parsed = template.params.safeParse(input.params)
    if (!parsed.success) this.fail(400, 'params_invalid', 'Los parámetros no cumplen la plantilla.')
    const projectId = template.scope === 'project' ? input.project_id ?? null : null
    if (template.scope === 'project') { if (!projectId) this.fail(400, 'project_required', 'La plantilla requiere un proyecto.'); await this.checkProject(projectId) }
    this.checkRecurrence(input.recurrence, template.min_interval_minutes)
    if (input.expires_at && !(Date.parse(input.expires_at) > this.now())) this.fail(400, 'expires_in_past', 'expires_at debe ser futuro.')
    await this.checkDelivery(input.delivery, template.allowed_targets)
    const key = targetKey({ scope: template.scope, project_id: projectId, template: template.id, identity: template.identity(parsed.data) })
    const agentId = principal.kind === 'agent' ? principal.agent.agent_id : null
    const id = randomUUID()
    return this.o.db.transaction(async () => {
      const counts = await this.store.liveCounts(agentId, projectId, template.id)
      if (agentId && counts.agent >= MAX_PER_AGENT) this.fail(409, 'quota_agent', `Un agente puede tener hasta ${MAX_PER_AGENT} schedules vivos.`)
      if (counts.owner >= MAX_PER_OWNER) this.fail(409, 'quota_owner', `Hay ${MAX_PER_OWNER} schedules vivos en total.`)
      if (counts.project_template >= template.max_live_per_project) this.fail(409, 'quota_template', 'Se alcanzó el máximo de schedules vivos de esta plantilla.')
      const constraint = await this.store.constraintFor(projectId, template.id, key)
      if (constraint) this.fail(409, 'schedule_constrained', `Una persona canceló este schedule${constraint.reason ? ` (${constraint.reason})` : ''}; no lo vuelvas a crear.`)
      const duplicate = await this.store.liveByTarget(key)
      if (duplicate) this.fail(409, 'duplicate_target', `Ya existe un schedule vivo para este objetivo (${duplicate.id}).`)
      const row = await this.store.insertSchedule({ id, scope: template.scope, project_id: projectId, template: template.id, template_version: template.version, kind: template.kind, title: input.title,
        instructions: input.instructions, params: parsed.data as Record<string, unknown>, recurrence: input.recurrence, delivery: input.delivery, misfire: input.misfire ?? template.misfire,
        grace_minutes: template.grace_minutes, grace_policy: template.grace_policy, grace_until: template.grace_until ?? null, target_key: key, next_run_at: this.firstRun(input.recurrence), expires_at: input.expires_at ?? null,
        created_by_kind: actor.kind, created_by_agent: agentId, created_by_session: principal.kind === 'agent' ? principal.agent.session_id : null,
        origin: principal.kind === 'agent' ? { cli_kind: principal.agent.cli_kind, cwd: principal.agent.cwd } : {} })
      await this.store.addEvent({ type: 'schedule.created', schedule_id: id, actor_kind: actor.kind, actor_ref: actor.ref, request_id: input.request_id, payload: { template: template.id } })
      return { schedule: await this.view(row), announce: await this.announce('Programé', row) }
    }).then(result => { this.o.wake?.(); return result })
  }

  private async mutable(id: string, expectedRevision?: number): Promise<ScheduleRow> {
    const row = await this.store.schedule(id)
    if (!row) this.fail(404, 'schedule_not_found', 'El schedule no existe.')
    if (!['active', 'paused'].includes(row.state)) this.fail(409, 'schedule_closed', `El schedule está ${row.state}.`)
    if (expectedRevision !== undefined && row.revision !== expectedRevision) this.fail(409, 'stale_revision', 'El schedule cambió; leelo de nuevo.')
    return row
  }

  async update(principal: Principal, id: string, expectedRevision: number, patch: UpdateInput): Promise<{ schedule: ScheduleView; announce: string }> {
    this.requireAgent(principal); this.requireAutomations()
    const actor = actorOf(principal), current = await this.mutable(id, expectedRevision)
    const template = scheduleTemplate(current.template)
    if (!template) this.fail(409, 'template_unknown', 'La plantilla del schedule ya no está registrada.')
    const changes: Parameters<ScheduleStore['updateSchedule']>[2] = {}
    // A field the person changed from the app stays theirs: an agent update that touches it is refused, and a person's change protects it.
    const touched = (['recurrence', 'delivery'] as const).filter(field => patch[field] !== undefined)
    if (principal.kind === 'agent' && touched.some(field => current.human_override.includes(field))) this.fail(409, 'human_override', 'La persona cambió este campo desde la app; solo ella puede volver a modificarlo.')
    if (principal.kind === 'human' && touched.length) changes.human_override = [...new Set([...current.human_override, ...touched])]
    if (patch.title !== undefined) changes.title = patch.title
    if (patch.instructions !== undefined) changes.instructions = patch.instructions
    if (patch.misfire !== undefined) changes.misfire = patch.misfire
    if (patch.expires_at !== undefined) {
      if (patch.expires_at && !(Date.parse(patch.expires_at) > this.now())) this.fail(400, 'expires_in_past', 'expires_at debe ser futuro.')
      changes.expires_at = patch.expires_at
    }
    if (patch.delivery) { await this.checkDelivery(patch.delivery, template.allowed_targets); changes.delivery = patch.delivery }
    if (patch.recurrence) {
      this.checkRecurrence(patch.recurrence, template.min_interval_minutes)
      changes.recurrence = patch.recurrence
      if (current.state === 'active') changes.next_run_at = this.firstRun(patch.recurrence)
    }
    if (patch.params) {
      const parsed = template.params.safeParse(patch.params)
      if (!parsed.success) this.fail(400, 'params_invalid', 'Los parámetros no cumplen la plantilla.')
      changes.params = parsed.data as Record<string, unknown>
      const key = targetKey({ scope: current.scope, project_id: current.project_id, template: current.template, identity: template.identity(parsed.data) })
      changes.target_key = key
    }
    const updated = await this.o.db.transaction(async () => {
      // A new identity goes through the same checks as a new schedule, so a topic change cannot slip past a person's cancellation.
      if (changes.target_key && changes.target_key !== current.target_key) {
        const constraint = await this.store.constraintFor(current.project_id, current.template, changes.target_key)
        if (constraint) this.fail(409, 'schedule_constrained', 'Una persona canceló este schedule; no lo vuelvas a crear.')
        const duplicate = await this.store.liveByTarget(changes.target_key)
        if (duplicate && duplicate.id !== id) this.fail(409, 'duplicate_target', `Ya existe un schedule vivo para este objetivo (${duplicate.id}).`)
      }
      const row = await this.store.updateSchedule(id, expectedRevision, changes)
      if (!row) this.fail(409, 'stale_revision', 'El schedule cambió; leelo de nuevo.')
      await this.store.addEvent({ type: 'schedule.updated', schedule_id: id, actor_kind: actor.kind, actor_ref: actor.ref, payload: { fields: Object.keys(changes) } })
      return row
    })
    this.o.wake?.()
    return { schedule: await this.view(updated), announce: await this.announce('Actualicé', updated) }
  }

  async pause(principal: Principal, id: string, expectedRevision: number, reason?: string) {
    this.requireAgent(principal)
    const actor = actorOf(principal), current = await this.mutable(id, expectedRevision)
    if (current.state === 'paused') return { schedule: await this.view(current), announce: await this.announce('Ya estaba en pausa', current) }
    const row = await this.o.db.transaction(async () => {
      const updated = await this.store.updateSchedule(id, expectedRevision, { state: 'paused', paused_by: actor.kind, next_run_at: null })
      if (!updated) this.fail(409, 'stale_revision', 'El schedule cambió; leelo de nuevo.')
      await this.store.addEvent({ type: 'schedule.paused', schedule_id: id, actor_kind: actor.kind, actor_ref: actor.ref, payload: { ...(reason ? { reason } : {}) } })
      return updated
    })
    return { schedule: await this.view(row), announce: await this.announce('Pausé', row) }
  }

  async resume(principal: Principal, id: string, expectedRevision: number, reason?: string) {
    this.requireAgent(principal); this.requireAutomations()
    const actor = actorOf(principal), current = await this.mutable(id, expectedRevision)
    if (current.state === 'active') return { schedule: await this.view(current), announce: await this.announce('Ya estaba activo', current) }
    // A pause by a person or by a restore is lifted only from the app.
    if (principal.kind === 'agent' && current.paused_by && current.paused_by !== 'agent') this.fail(409, 'paused_by_human', 'Solo la persona puede reanudar este schedule desde la app.')
    const row = await this.o.db.transaction(async () => {
      const updated = await this.store.updateSchedule(id, expectedRevision, { state: 'active', paused_by: null, next_run_at: this.firstRun(current.recurrence) })
      if (!updated) this.fail(409, 'stale_revision', 'El schedule cambió; leelo de nuevo.')
      await this.store.addEvent({ type: 'schedule.resumed', schedule_id: id, actor_kind: actor.kind, actor_ref: actor.ref, payload: { ...(reason ? { reason } : {}) } })
      return updated
    })
    this.o.wake?.()
    return { schedule: await this.view(row), announce: await this.announce('Reanudé', row) }
  }

  /** `scope` is only honored for a person: it persists the constraint that stops the schedule from being recreated. */
  async cancel(principal: Principal, id: string, expectedRevision: number, options: { reason?: string | undefined; scope?: 'target' | 'template_project' | undefined } = {}) {
    this.requireAgent(principal)
    const actor = actorOf(principal), current = await this.mutable(id, expectedRevision)
    const row = await this.o.db.transaction(async () => {
      const updated = await this.store.updateSchedule(id, expectedRevision, { state: 'cancelled', next_run_at: null, cancelled_at: new Date(this.now()).toISOString(), cancelled_by: actor.kind, cancel_reason: options.reason ?? null })
      if (!updated) this.fail(409, 'stale_revision', 'El schedule cambió; leelo de nuevo.')
      await this.store.cancelLiveRuns(id, 'schedule_cancelled')
      let constraintId: string | null = null
      if (principal.kind === 'human' && options.scope) {
        const created = await this.store.addConstraint({ subject: current.scope, project_id: current.project_id, template: current.template, scope: options.scope, target_key: options.scope === 'target' ? current.target_key : null,
          schedule_id: id, user: principal.ref, ...(options.reason ? { reason: options.reason } : {}) })
        // ON CONFLICT DO NOTHING: an equivalent constraint that already existed is not this cancel's to lift on restore.
        if (await this.store.constraintExists(created)) constraintId = created
        await this.store.addEvent({ type: 'schedule.constrained', schedule_id: id, actor_kind: 'human', actor_ref: principal.ref, payload: { scope: options.scope } })
      }
      // previous_* lets restoreCancelled return to the exact pre-cancel state.
      await this.store.addEvent({ type: 'schedule.cancelled', schedule_id: id, actor_kind: actor.kind, actor_ref: actor.ref, payload: { ...(options.reason ? { reason: options.reason } : {}),
        previous_state: current.state, previous_paused_by: current.paused_by, previous_next_run_at: current.next_run_at, constraint_id: constraintId } })
      return updated
    })
    await this.o.stopRun?.(id)
    return { schedule: await this.view(row), announce: await this.announce('Cancelé', row) }
  }

  /**
   * Undo of a person's cancel within SCHEDULE_RESTORE_WINDOW_MS: back to the pre-cancel state (active or paused, same pause author), lifting
   * only the constraint that cancel created. Runs the cancel skipped or aborted stay stopped and are listed in `aborted_runs`.
   */
  async restoreCancelled(principal: Principal, id: string, expectedRevision: number): Promise<{ schedule: ScheduleView; restore: ScheduleRestoreInfo; announce: string }> {
    if (principal.kind !== 'human') this.fail(403, 'restore_human_only', 'Solo la persona puede deshacer una cancelación, desde la app.')
    const row = await this.store.schedule(id)
    if (!row) this.fail(404, 'schedule_not_found', 'El schedule no existe.')
    if (row.state !== 'cancelled') this.fail(409, 'schedule_not_cancelled', `El schedule está ${row.state}.`)
    if (row.revision !== expectedRevision) this.fail(409, 'stale_revision', 'El schedule cambió; leelo de nuevo.')
    if (row.cancelled_by !== 'human' || !row.cancelled_at) this.fail(409, 'schedule_not_restorable', 'Solo se deshace una cancelación hecha por la persona.')
    if (this.now() - Date.parse(row.cancelled_at) > SCHEDULE_RESTORE_WINDOW_MS) this.fail(409, 'restore_window_expired', 'Venció el plazo para deshacer la cancelación.')
    const event = await this.store.lastEvent(id, 'schedule.cancelled')
    const payload = (event?.payload ?? {}) as Record<string, unknown>
    const previous = payload.previous_state
    if (previous !== 'active' && previous !== 'paused') this.fail(409, 'schedule_not_restorable', 'La cancelación no guardó el estado anterior.')
    if (previous === 'active') this.requireAutomations()
    const taken = await this.store.liveByTarget(row.target_key)
    if (taken && taken.id !== id) this.fail(409, 'schedule_target_taken', 'Ya hay otro schedule activo para el mismo objetivo.')
    const pausedBy = previous === 'paused' && ['agent', 'human', 'system'].includes(String(payload.previous_paused_by)) ? payload.previous_paused_by as Actor : previous === 'paused' ? 'human' : null
    const kept = typeof payload.previous_next_run_at === 'string' && Date.parse(payload.previous_next_run_at) > this.now() ? payload.previous_next_run_at : null
    const constraintId = typeof payload.constraint_id === 'string' ? payload.constraint_id : null
    const abortedRuns = await this.store.runsStoppedByCancel(id, row.cancelled_at)
    let constraintLifted = false
    const restored = await this.o.db.transaction(async () => {
      const updated = await this.store.updateSchedule(id, expectedRevision, { state: previous, paused_by: pausedBy,
        next_run_at: previous === 'active' ? kept ?? this.firstRun(row.recurrence) : null, cancelled_at: null, cancelled_by: null, cancel_reason: null })
      if (!updated) this.fail(409, 'stale_revision', 'El schedule cambió; leelo de nuevo.')
      if (constraintId) constraintLifted = Boolean(await this.store.liftConstraint(constraintId, principal.ref))
      await this.store.addEvent({ type: 'schedule.restored', schedule_id: id, actor_kind: 'human', actor_ref: principal.ref,
        payload: { previous_state: previous, constraint_lifted: constraintLifted, aborted_runs: abortedRuns.length } })
      return updated
    })
    if (previous === 'active') this.o.wake?.()
    const restore: ScheduleRestoreInfo = { previous_state: previous, constraint_lifted: constraintLifted, aborted_runs: abortedRuns, aborted_runs_resumed: false }
    return { schedule: await this.view(restored), restore, announce: await this.announce('Restauré', restored) }
  }

  async runNow(principal: Principal, id: string, requestId: string): Promise<{ run_id: string; schedule: ScheduleView }> {
    this.requireAgent(principal); this.requireAutomations()
    const actor = actorOf(principal), current = await this.mutable(id)
    if (current.state !== 'active') this.fail(409, 'schedule_paused', 'Reanudá el schedule antes de ejecutarlo.')
    const replay = await this.store.eventByRequest(actor.ref, requestId)
    if (replay?.run_id) return { run_id: replay.run_id, schedule: await this.view(current) }
    const runId = await this.o.db.transaction(async () => {
      // Checked inside the insert transaction: two requests with different ids cannot both see no live run.
      if (await this.store.liveRunOf(id)) this.fail(409, 'run_in_progress', 'Ya hay una ejecución en curso o pendiente.')
      const created = await this.store.insertRun({ schedule_id: id, scheduled_for: new Date(this.now()).toISOString(), schedule_revision: current.revision, definition: snapshotOf(current), trigger: 'run_now' })
      if (!created) this.fail(409, 'run_in_progress', 'Ya hay una ejecución en este instante.')
      await this.store.addEvent({ type: 'run.started', schedule_id: id, run_id: created, actor_kind: actor.kind, actor_ref: actor.ref, request_id: requestId, payload: { trigger: 'run_now' } })
      return created
    })
    this.o.wake?.()
    return { run_id: runId, schedule: await this.view(current) }
  }

  // --- views -----------------------------------------------------------------------------------------------------------------------------------
  async view(row: ScheduleRow, availability?: Awaited<ReturnType<ScheduleAdminOptions['deliveryAvailability']>>): Promise<ScheduleView> {
    const zone = this.zone(), last = await this.store.lastRunOf(row.id), template = scheduleTemplate(row.template)
    const available = availability ?? (row.delivery.some(target => target === 'gmail_self' || target === 'slack_self') ? await this.o.deliveryAvailability() : undefined)
    const label = row.created_by_session ? (await this.o.db.query<{ agent_label: string }>('SELECT agent_label FROM agent_sessions WHERE id=$1', [row.created_by_session]))[0]?.agent_label : undefined
    const quota = last?.state === 'deferred' ? last.quota as { resets_at?: string } | null : null
    return { id: row.id, scope: row.scope, project_id: row.project_id, template: row.template, template_version: row.template_version, kind: row.kind, title: row.title, recurrence: row.recurrence, timezone: zone,
      next_run_at: row.next_run_at, next_run_local: row.next_run_at ? localIso(Date.parse(row.next_run_at), zone) : null, delivery: row.delivery,
      delivery_unavailable: row.delivery.filter(target => (target === 'gmail_self' || target === 'slack_self') && !available?.[target]?.available), delivery_allowed: template?.allowed_targets ?? ['hub_inbox', 'app_window'], state: row.state as ScheduleState, paused_by: row.paused_by, revision: row.revision, human_override: row.human_override,
      created_by: { kind: row.created_by_kind, agent_id: row.created_by_agent, label: label ?? (row.created_by_kind === 'human' ? 'Persona' : row.created_by_kind === 'system' ? 'Hub' : 'Agente') },
      admission_note: template?.admission_note ?? '',
      ...(last ? { last_run: { id: last.id, state: last.state, scheduled_for: last.scheduled_for, trigger: last.trigger, ...(last.skip_reason ? { skip_reason: last.skip_reason } : {}), ...(last.deferred_reason ? { deferred_reason: last.deferred_reason } : {}) } } : {}),
      ...(last?.state === 'deferred' ? { deferred: { reason: last.deferred_reason ?? 'quota', resets_at: quota?.resets_at ?? null, next_attempt_at: last.next_attempt_at } } : {}) }
  }
  /** Fixed sentence the agent repeats in its chat so the person always learns about a change. */
  private async announce(verb: string, row: ScheduleRow): Promise<string> {
    const zone = this.zone(), when = row.next_run_at ? `próxima ejecución ${localIso(Date.parse(row.next_run_at), zone)} (${zone})` : 'sin próxima ejecución'
    return `${verb} «${row.title}» (${row.template}): ${when}; entrega en ${row.delivery.join(', ')}. Se puede ver, pausar o cancelar en Programaciones.`
  }

  async list(principal: Principal, filter: { project_id?: string | undefined; state?: ScheduleState | undefined; created_by_me?: boolean | undefined; limit: number; offset: number }) {
    const result = await this.store.listSchedules({ project_id: filter.project_id, state: filter.state, created_by_agent: filter.created_by_me && principal.kind === 'agent' ? principal.agent.agent_id : undefined, limit: filter.limit, offset: filter.offset })
    const availability = await this.o.deliveryAvailability()
    return { items: await Promise.all(result.items.map(row => this.view(row, availability))), total: result.total, limit: filter.limit, offset: filter.offset, delivery_available: availability }
  }
  async get(id: string, runs: number) {
    const row = await this.store.schedule(id)
    if (!row) this.fail(404, 'schedule_not_found', 'El schedule no existe.')
    const recent = runs ? (await this.store.listRuns({ schedule_id: id, limit: runs, offset: 0 })).items : []
    const last = recent[0]
    return { schedule: await this.view(row), runs: recent, incidents: await this.store.incidents({ schedule_id: id }), ...(last?.artifact_id ? { last_artifact: await this.runDetail(String(last.id)) } : {}) }
  }
  /** Artifact, deliveries and public item states of a run; never decision codes or private effects. */
  async runDetail(runId: string) {
    const run = await this.store.run(runId)
    if (!run) this.fail(404, 'run_not_found', 'La ejecución no existe.')
    const artifact = await this.store.artifactOfRun(runId)
    const artifactItems = (artifact?.items ?? []) as Array<{ estimate_id?: string }>
    const estimates = await this.store.estimatesById(artifactItems.flatMap(item => item.estimate_id ? [item.estimate_id] : []))
    // The estimate parts travel inside each item so the app needs no further request; a missing row leaves the item without them.
    const items = artifactItems.map(item => item.estimate_id && estimates.has(item.estimate_id) ? { ...item, estimate: { ...estimates.get(item.estimate_id)!, label: 'estimación' } } : item)
    return { run: this.publicRun(run), project_id: run.definition.project_id,
      artifact: artifact ? { id: artifact.id, kind: artifact.kind, title: artifact.title, body_md: artifact.body_md, items, read_at: artifact.read_at } : null,
      items: await this.store.itemStates(runId), decision: (await this.store.decisionSummaries([runId])).get(runId), deliveries: await this.store.deliveriesOf(runId), incidents: await this.store.incidents({ run_id: runId }) }
  }
  private publicRun(run: RunRow) {
    return { id: run.id, schedule_id: run.schedule_id, scheduled_for: run.scheduled_for, trigger: run.trigger, state: run.state, phase: run.phase, skip_reason: run.skip_reason, deferred_reason: run.deferred_reason,
      next_attempt_at: run.next_attempt_at, error_code: run.error_code, continuity: run.continuity, started_at: run.started_at, finished_at: run.finished_at }
  }
  /** The page of runs with each run's deliveries and decision summary, read in batches. */
  async runList(filter: Parameters<ScheduleStore['listRuns']>[0]) {
    const page = await this.store.listRuns(filter), ids = page.items.map(row => String(row.id))
    const [deliveries, decisions] = await Promise.all([this.store.deliveriesForRuns(ids), this.store.decisionSummaries(ids)])
    return { total: page.total, items: page.items.map(row => ({ ...row, deliveries: deliveries.get(String(row.id)) ?? [], decision: decisions.get(String(row.id)) })) }
  }
  async runs(filter: { schedule_id?: string | undefined; project_id?: string | undefined; state?: RunRow['state'] | undefined; run_id?: string | undefined; unread?: boolean | undefined; limit: number; offset: number }) {
    if (filter.run_id) return this.runDetail(filter.run_id)
    const result = await this.runList(filter)
    return { ...result, limit: filter.limit, offset: filter.offset, incidents: await this.store.incidents({ ...(filter.schedule_id ? { schedule_id: filter.schedule_id } : {}), ...(filter.project_id ? { project_id: filter.project_id } : {}) }) }
  }
  /**
   * Guard before a project is deleted: actions in flight or uncertain block the deletion; everything else is cancelled and stopped
   * first, so the cascade never removes the evidence of a run that is still advancing.
   */
  async beforeProjectDelete(entityId: string) {
    const entity = (await this.o.db.query<{ kind: string }>('SELECT kind FROM entities WHERE id=$1', [entityId]))[0]
    if (entity?.kind !== 'project') return
    if (await this.store.blockingItems(entityId)) this.fail(409, 'project_has_inflight_actions', 'El proyecto tiene acciones en curso o inciertas; resolvelas antes de eliminarlo.')
    const live = await this.store.listSchedules({ project_id: entityId, limit: 200, offset: 0 })
    for (const schedule of live.items.filter(row => ['active', 'paused'].includes(row.state))) {
      await this.o.db.transaction(async () => {
        await this.store.touchSchedule(schedule.id, { state: 'cancelled', next_run_at: null, cancelled_at: new Date(this.now()).toISOString(), cancelled_by: 'system', cancel_reason: 'project_deleted' })
        await this.store.cancelLiveRuns(schedule.id, 'schedule_cancelled')
      })
      await this.o.stopRun?.(schedule.id)
    }
  }
  isScheduleError(error: unknown): error is MemoryError { return error instanceof ScheduleError }
}
