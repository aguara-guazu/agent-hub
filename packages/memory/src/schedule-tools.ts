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
  schedule_create: ['Programar una tarea recurrente o única del Hub. Vos decidís cuándo y cada cuánto; la persona puede verla, pausarla, cancelarla o cambiar el horario, pero nunca se le pide aprobar. Las horas son las del sistema. La plantilla fija qué hace el run (reminder: aviso fijo sin modelo; custom_synthesis: síntesis sin herramientas; project_status, daily_brief y daily_close: según su alcance) y a dónde se entrega, siempre solo a la persona. Un run nunca crea schedules. Si una persona canceló el mismo objetivo, la respuesta es schedule_constrained y no se debe recrear. Al crear, decí en tu chat el texto de announce.',
    z.object({ project_id: id.optional(), template: z.enum(scheduleTemplates).exclude(['team_health']), title: z.string().trim().min(1).max(200), instructions: z.string().max(4000).default(''), params: jsonObject.default({}),
      recurrence: recurrenceSchema, delivery: z.array(target).min(1).max(4).default(['hub_inbox', 'app_window']), misfire: z.enum(['run_once', 'skip']).optional(), expires_at: instant.optional(), request_id: requestId }).strict()],
  schedule_list: ['Listar schedules con su estado, próxima ejecución en hora local y disponibilidad de destinos. created_by_me limita a los propios.',
    z.object({ project_id: id.optional(), state: z.enum(scheduleStates).optional(), created_by_me: z.boolean().default(false), ...page }).strict()],
  schedule_get: ['Leer un schedule con sus últimas ejecuciones, incidentes de procesos interrumpidos y el artefacto del último run.', z.object({ schedule_id: id, runs: z.number().int().min(0).max(20).default(5) }).strict()],
  schedule_update: ['Cambiar título, instrucciones, parámetros, recurrencia, destinos, misfire o vencimiento. Requiere expected_revision; cambiar los parámetros que definen el objetivo vuelve a pasar la admisión y las restricciones.',
    z.object({ schedule_id: id, expected_revision: revision, title: z.string().trim().min(1).max(200).optional(), instructions: z.string().max(4000).optional(), params: jsonObject.optional(), recurrence: recurrenceSchema.optional(),
      delivery: z.array(target).min(1).max(4).optional(), misfire: z.enum(['run_once', 'skip']).optional(), expires_at: instant.nullable().optional() }).strict()],
  schedule_pause: ['Pausar un schedule propio o de la persona dueña local. Solo la persona reanuda una pausa que ella hizo.', mutation],
  schedule_resume: ['Reanudar un schedule pausado por un agente. No hay recuperación de ocurrencias perdidas durante la pausa.', mutation],
  schedule_delete: ['Cancelar un schedule. No deja restricción: solo la cancelación de una persona impide volver a crearlo.', mutation],
  schedule_run_now: ['Ejecutar ahora un schedule activo. Es idempotente por request_id y se rechaza si ya hay una ejecución en curso.', z.object({ schedule_id: id, request_id: requestId }).strict()],
  schedule_runs: ['Ver ejecuciones con estado, fase, motivo de omisión o diferimiento e incidentes. Con run_id devuelve el artefacto completo, sus ítems públicos con estado y las entregas; nunca códigos de aprobación.',
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
