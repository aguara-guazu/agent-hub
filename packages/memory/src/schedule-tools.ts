import { z } from 'zod'
import { check, id, instant, jsonObject, parse } from './contracts.js'
import type { AgentContext } from './agents.js'
import { deliveryTargets, recurrenceSchema, runStates, scheduleStates, scheduleTemplates } from './schedule-contract.js'
import type { ScheduleAdmin } from './schedule-admin.js'

// memory_schedule_* tools. They are not collaboration tools: they work in solo mode and depend only on the automations switch.

const page = { limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }
const target = z.enum(deliveryTargets), revision = z.number().int().min(1), reason = z.string().trim().max(300).optional()
const requestId = z.string().min(1).max(200)
const mutation = z.object({ schedule_id: id, expected_revision: revision, reason }).strict()

export const scheduleDefinitions = {
  schedule_create: ['Schedule a one-off or recurring Hub task. You pick when and how often; the person may view, pause, cancel or reschedule it but is never asked to approve. Times are system time. The template fixes what the run does (reminder: fixed notice, no model; custom_synthesis: no tools; project_status, daily_brief, daily_close: per scope) and delivery, always only to the person. Runs never create schedules. schedule_constrained means a person cancelled this goal: do not recreate. After creating, relay the announce text in your chat.',
    z.object({ project_id: id.optional(), template: z.enum(scheduleTemplates).exclude(['team_health']), title: z.string().trim().min(1).max(200), instructions: z.string().max(4000).default(''), params: jsonObject.default({}),
      recurrence: recurrenceSchema, delivery: z.array(target).min(1).max(4).default(['hub_inbox', 'app_window']), misfire: z.enum(['run_once', 'skip']).optional(), expires_at: instant.optional(), request_id: requestId }).strict()],
  schedule_list: ['Schedules: state, next run in local time, delivery availability. created_by_me: only yours.',
    z.object({ project_id: id.optional(), state: z.enum(scheduleStates).optional(), created_by_me: z.boolean().default(false), ...page }).strict()],
  schedule_get: ['Schedule with latest runs, interrupted-process incidents, last run artifact.', z.object({ schedule_id: id, runs: z.number().int().min(0).max(20).default(5) }).strict()],
  schedule_update: ['Edit title, instructions, params, recurrence, delivery, misfire, expiry. Needs expected_revision; changing goal-defining params re-runs admission and restrictions.',
    z.object({ schedule_id: id, expected_revision: revision, title: z.string().trim().min(1).max(200).optional(), instructions: z.string().max(4000).optional(), params: jsonObject.optional(), recurrence: recurrenceSchema.optional(),
      delivery: z.array(target).min(1).max(4).optional(), misfire: z.enum(['run_once', 'skip']).optional(), expires_at: instant.nullable().optional() }).strict()],
  schedule_pause: ['Pause your or the local owner\'s schedule. Only the person resumes a pause they made.', mutation],
  schedule_resume: ['Resume an agent-paused schedule. Missed occurrences are not recovered.', mutation],
  schedule_delete: ['Cancel a schedule. Leaves no restriction: only a person\'s cancel blocks re-creation.', mutation],
  schedule_run_now: ['Run an active schedule now. Idempotent per request_id; rejected if a run is in progress.', z.object({ schedule_id: id, request_id: requestId }).strict()],
  schedule_runs: ['Runs: state, phase, skip/defer reason, incidents. With run_id: full artifact, public items with state, deliveries; never approval codes.',
    z.object({ run_id: id.optional(), schedule_id: id.optional(), project_id: id.optional(), state: z.enum(runStates).optional(), ...page }).strict()],
} satisfies Record<string, [string, z.ZodType]>

export const scheduleReadOperations = ['schedule_list', 'schedule_get', 'schedule_runs']

export async function callScheduleTool(admin: ScheduleAdmin, operation: string, raw: unknown, agent: AgentContext | undefined) {
  const definition = scheduleDefinitions[operation as keyof typeof scheduleDefinitions]
  check(definition, 'Operación de schedule inexistente', 404)
  check(agent?.agent_id, 'Solo los agentes administran schedules', 403)
  const principal = { kind: 'agent' as const, agent: agent! }
  const input = parse(definition[1] as z.ZodType, raw ?? {}) as any
  switch (operation) {
    case 'schedule_create': return admin.create(principal, input)
    case 'schedule_list': return admin.list(principal, input)
    case 'schedule_get': return admin.get(input.schedule_id, input.runs)
    case 'schedule_update': { const { schedule_id, expected_revision, ...patch } = input; return admin.update(principal, schedule_id, expected_revision, patch) }
    case 'schedule_pause': return admin.pause(principal, input.schedule_id, input.expected_revision, input.reason)
    case 'schedule_resume': return admin.resume(principal, input.schedule_id, input.expected_revision, input.reason)
    case 'schedule_delete': return admin.cancel(principal, input.schedule_id, input.expected_revision, { reason: input.reason })
    case 'schedule_run_now': return admin.runNow(principal, input.schedule_id, input.request_id)
    default: return admin.runs(input)
  }
}
