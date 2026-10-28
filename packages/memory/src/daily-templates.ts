import { z } from 'zod'
import type { CollectDeps, RunContext, RunPackage, RunTrigger, ScheduleTemplateDefinition } from './schedule-contract.js'
import type { DailyDeps, OwnerAttentionReaders } from './daily-types.js'
import { DEFAULT_WORKDAY_HOURS } from './daily-types.js'
import { collectBrief, projectBlock, renderBrief, type BriefPackage } from './daily-brief.js'
import { CLOSE_SYSTEM, closePayload, closeSynthesisSchema, collectClose, renderClose, type ClosePackage } from './daily-close.js'
import { collectStatusInputs, finishSnapshot, snapshotWriter, statusSynthesisSchema, STATUS_SYSTEM, type StatusInputs } from './project-status.js'

const noParams = z.object({}).strict() as z.ZodType<Record<string, never>>
const MAX_SYNTHESIS_INPUT = 60_000

/** What the owner-level templates need beyond CollectDeps: the projects with a live status and the readers of other areas. */
export type OwnerCollectDeps = CollectDeps & { statusProjects?: () => Promise<string[]>; attention?: OwnerAttentionReaders }
/** Run context fields the owner templates read; the runtime fills them when it has them. */
export type OwnerRunContext = RunContext & { trigger?: RunTrigger; deferred_until?: string | null; extend_from?: string | null }
/** A section the synthesis run must not receive is marked `model_visible: false`; the runtime sends the others. */
type Section = RunPackage['sections'][number] & { model_visible?: boolean }

const section = (id: string, title: string, data: unknown, as_of: string, model_visible = true): Section => ({ id, title, data, sources: [{ as_of }], model_visible })
const packageOf = (projectIds: string[], sections: Section[], remoteAllowed: boolean): RunPackage => ({ project_ids: projectIds, sections, remote_allowed: remoteAllowed,
  char_count: JSON.stringify(sections.filter(entry => entry.model_visible !== false).map(entry => entry.data)).length })

function dailyDeps(deps: OwnerCollectDeps): DailyDeps {
  const workday = Number(deps.options?.['workday_hours'])
  return { store: deps.store, now: () => deps.now(), statusProjects: deps.statusProjects ?? (async () => []), ...(deps.jira ? { jira: deps.jira } : {}),
    ...(deps.attention ? { attention: deps.attention } : {}), options: { workday_hours: Number.isFinite(workday) && workday > 0 ? workday : DEFAULT_WORKDAY_HOURS } }
}
const dataOf = <T>(pkg: RunPackage, id: string): T => pkg.sections.find(entry => entry.id === id)!.data as T

const projectStatus: ScheduleTemplateDefinition<Record<string, never>> = {
  id: 'project_status', version: 1, kind: 'synthesis', scope: 'project', params: noParams, identity: () => ({}),
  min_interval_minutes: 60, max_live_per_project: 1, max_runtime_ms: 600_000, allowed_targets: ['hub_inbox', 'app_window'], misfire: 'run_once', grace_minutes: 120, grace_policy: 'minutes',
  admission_note: 'plantilla status: síntesis sin herramientas del estado del proyecto; entrega solo a ti',
  async collect(ctx, deps) {
    // Facts are always filtered as for a remote model: the runtime decides the engine after collecting, and the project-level opt-out is reported in remote_allowed.
    const inputs = await collectStatusInputs(deps.store, ctx.project_id!, deps.now(), true, ctx.covered_since)
    return packageOf([inputs.project.id], [section('status_inputs', 'Estado del proyecto', inputs, inputs.now)], inputs.project.remote_processing)
  },
  synthesize: { system: STATUS_SYSTEM, output: z.toJSONSchema(statusSynthesisSchema) as Record<string, unknown>, max_input_chars: MAX_SYNTHESIS_INPUT },
  render(_ctx, pkg, synthesis) {
    const inputs = dataOf<StatusInputs>(pkg, 'status_inputs')
    const parsed = statusSynthesisSchema.safeParse(synthesis)
    const active = Boolean(inputs.tasks.length || inputs.closed.length || inputs.facts.length || inputs.notes.length)
    const draft = finishSnapshot(inputs, parsed.success ? parsed.data : null, { model: null, reason: !pkg.remote_allowed ? 'remote_excluded' : !active ? 'no_activity' : 'model_failed' })
    const block = projectBlock({ project_id: inputs.project.id, title: inputs.project.title, snapshot: { ...draft, version: 0 } }, inputs.now)
    return { kind: 'status', title: `Status · ${inputs.project.title}`, body_md: `# Status · ${inputs.project.title}\n\n${block}`, items: [], snapshot_refs: [], snapshots: [snapshotWriter(draft)] }
  },
}

const dailyBrief: ScheduleTemplateDefinition<Record<string, never>> = {
  id: 'daily_brief', version: 1, kind: 'notice', scope: 'owner', params: noParams, identity: () => ({}),
  min_interval_minutes: 5, max_live_per_project: 1, max_runtime_ms: 60_000, allowed_targets: ['hub_inbox', 'app_window', 'gmail_self', 'slack_self'], misfire: 'run_once', grace_minutes: 0,
  grace_policy: 'until_local_time', grace_until: '23:59', admission_note: 'plantilla brief: agrega el último status de cada proyecto activado, sin modelo; entrega solo a ti',
  async collect(rawCtx, deps) {
    const ctx = rawCtx as OwnerRunContext
    const pkg = await collectBrief(dailyDeps(deps), { scheduledFor: ctx.scheduled_for, coveredSince: ctx.covered_since, ...(ctx.trigger ? { trigger: ctx.trigger } : {}), deferredUntil: ctx.deferred_until ?? null })
    return packageOf(pkg.projects.map(project => project.project_id), [section('brief', 'Brief', pkg, pkg.generated_at)], true)
  },
  render(ctx, pkg) {
    const draft = renderBrief(dataOf<BriefPackage>(pkg, 'brief'), ctx.run_id)
    return { kind: 'brief', title: draft.title, body_md: draft.body_md, items: draft.items, snapshot_refs: draft.snapshot_refs, proposed_effects: draft.proposed_effects }
  },
}

const dailyClose: ScheduleTemplateDefinition<Record<string, never>> = {
  id: 'daily_close', version: 1, kind: 'synthesis', scope: 'owner', params: noParams, identity: () => ({}),
  min_interval_minutes: 60, max_live_per_project: 1, max_runtime_ms: 600_000, allowed_targets: ['hub_inbox', 'app_window', 'gmail_self', 'slack_self'], misfire: 'run_once', grace_minutes: 0,
  grace_policy: 'until_local_time', grace_until: '22:00', admission_note: 'plantilla cierre: propone horas, transiciones y comentarios para que los apruebes; síntesis sin herramientas, entrega solo a ti',
  async collect(rawCtx, deps) {
    const ctx = rawCtx as OwnerRunContext
    const pkg = await collectClose(dailyDeps(deps), { scheduledFor: ctx.scheduled_for, extendFrom: ctx.extend_from ?? null })
    // The model sees only the hour inputs of projects a remote model may receive; the full package stays out of its reach.
    const visible = closePayload(pkg, true)
    return packageOf(pkg.projects.map(project => project.project_id), [section('hours', 'Horas por proyecto', visible, pkg.window.until), section('close', 'Cierre', pkg, pkg.window.until, false)],
      visible.projects.some(project => project.tasks.length > 0))
  },
  synthesize: { system: CLOSE_SYSTEM, output: z.toJSONSchema(closeSynthesisSchema) as Record<string, unknown>, max_input_chars: MAX_SYNTHESIS_INPUT },
  render(ctx, pkg, synthesis) {
    const parsed = closeSynthesisSchema.safeParse(synthesis)
    const draft = renderClose(dataOf<ClosePackage>(pkg, 'close'), parsed.success ? parsed.data : null, null, ctx.run_id)
    return { kind: 'close', title: draft.title, body_md: draft.body_md, items: draft.items, snapshot_refs: [], proposed_effects: draft.proposed_effects, writers: draft.writers }
  },
}

/** Registered by the scheduler's template registry. */
export const dailyTemplates: ScheduleTemplateDefinition<any>[] = [projectStatus, dailyBrief, dailyClose]
