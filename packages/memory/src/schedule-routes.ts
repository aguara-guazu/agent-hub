import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { check, id, parse } from './contracts.js'
import type { MemoryService } from './service.js'
import { deliveryTargets, recurrenceSchema, runStates, scheduleStates } from './schedule-contract.js'

const revision = z.number().int().min(1)
const page = { limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }

/** Human routes of the scheduler. Owner authorization only: none of them is an agent operation. */
export function registerScheduleRoutes(app: FastifyInstance, service: MemoryService, authorize: (request: FastifyRequest) => Promise<{ id: string }>) {
  const auth = async (request: FastifyRequest) => { await authorize(request) }
  const scheduler = async () => {
    const schedules = (await service.get()).schedules
    check(schedules, 'Los schedules no están disponibles en este servicio.', 503)
    return schedules
  }
  const human = async (request: FastifyRequest) => ({ kind: 'human' as const, ref: (await authorize(request)).id })
  const scheduleId = (request: FastifyRequest) => parse(z.object({ id }).strict(), request.params).id

  app.get('/api/memory/schedules', { preHandler: auth }, async request => {
    const query = parse(z.object({ project_id: id.optional(), state: z.enum(scheduleStates).optional(), ...page }).strict(), request.query)
    return (await scheduler()).admin.list({ kind: 'human', ref: 'owner' }, query)
  })
  app.get('/api/memory/schedules/runs', { preHandler: auth }, async request => {
    const query = parse(z.object({ kind: z.enum(['notice', 'brief', 'close', 'status', 'report']).optional(), project_id: id.optional(), schedule_id: id.optional(), state: z.enum(runStates).optional(),
      unread: z.enum(['true', 'false']).optional(), ...page }).strict(), request.query)
    const { unread, ...rest } = query
    return (await scheduler()).admin.runList({ ...rest, unread: unread === 'true' })
  })
  app.get('/api/memory/schedules/runs/:runId', { preHandler: auth }, async request => {
    const { runId } = parse(z.object({ runId: id }).strict(), request.params)
    return (await scheduler()).admin.runDetail(runId)
  })
  app.put('/api/memory/schedules/runs/:runId/read', { preHandler: auth }, async request => {
    const { runId } = parse(z.object({ runId: id }).strict(), request.params), { store } = await scheduler()
    await store.markArtifactRead(runId); await store.markDeliveriesRead(runId)
    return { run_id: runId, read: true }
  })
  app.get('/api/memory/schedules/feed', { preHandler: auth }, async request => {
    const { after } = parse(z.object({ after: z.coerce.number().int().min(0).optional() }).strict(), request.query), { store } = await scheduler()
    const active_runs = await store.activeRuns()
    if (after === undefined) return { events: [], cursor: await store.maxSeq(), active_runs }
    const rows = await store.eventsAfter(after)
    return { events: rows.map(row => ({ seq: row.seq, type: row.type, actor_kind: row.actor_kind, schedule_id: row.schedule_id, run_id: row.run_id, title: row.title ?? null, project_id: row.project_id ?? null,
      ...(row.artifact_kind ? { artifact_kind: row.artifact_kind } : {}) })), cursor: rows.at(-1)?.seq ?? after, active_runs }
  })
  /** Wake after resume or unlock: the clock recovers a lost occurrence without waiting for the next tick. */
  app.post('/api/memory/schedules/kick', { preHandler: auth }, async (_request, reply) => { (await scheduler()).runtime.kick(); return reply.code(202).send({ kicked: true }) })

  app.post('/api/memory/schedules/:id/pause', { preHandler: auth, bodyLimit: 4096 }, async request => {
    const principal = await human(request), { expected_revision, reason } = parse(z.object({ expected_revision: revision, reason: z.string().trim().max(300).optional() }).strict(), request.body)
    return (await (await scheduler()).admin.pause(principal, scheduleId(request), expected_revision, reason)).schedule
  })
  app.post('/api/memory/schedules/:id/resume', { preHandler: auth, bodyLimit: 4096 }, async request => {
    const principal = await human(request), { expected_revision, reason } = parse(z.object({ expected_revision: revision, reason: z.string().trim().max(300).optional() }).strict(), request.body)
    return (await (await scheduler()).admin.resume(principal, scheduleId(request), expected_revision, reason)).schedule
  })
  app.put('/api/memory/schedules/:id/recurrence', { preHandler: auth, bodyLimit: 4096 }, async request => {
    const principal = await human(request), { expected_revision, recurrence } = parse(z.object({ expected_revision: revision, recurrence: recurrenceSchema }).strict(), request.body)
    return (await (await scheduler()).admin.update(principal, scheduleId(request), expected_revision, { recurrence })).schedule
  })
  app.put('/api/memory/schedules/:id/delivery', { preHandler: auth, bodyLimit: 4096 }, async request => {
    const principal = await human(request), { expected_revision, delivery } = parse(z.object({ expected_revision: revision, delivery: z.array(z.enum(deliveryTargets)).min(1).max(4) }).strict(), request.body)
    return (await (await scheduler()).admin.update(principal, scheduleId(request), expected_revision, { delivery })).schedule
  })
  app.post('/api/memory/schedules/:id/cancel', { preHandler: auth, bodyLimit: 4096 }, async request => {
    const principal = await human(request), body = parse(z.object({ expected_revision: revision, scope: z.enum(['target', 'template_project']).optional(), reason: z.string().trim().max(300).optional() }).strict(), request.body)
    return (await (await scheduler()).admin.cancel(principal, scheduleId(request), body.expected_revision, { scope: body.scope, reason: body.reason })).schedule
  })
  app.post('/api/memory/schedules/:id/run_now', { preHandler: auth, bodyLimit: 4096 }, async request => {
    const principal = await human(request), { request_id } = parse(z.object({ request_id: z.string().min(1).max(200).default(() => randomUUID()) }).strict(), request.body ?? {})
    const { run_id } = await (await scheduler()).admin.runNow(principal, scheduleId(request), request_id)
    return { run_id }
  })
  app.get('/api/memory/schedule-constraints', { preHandler: auth }, async request => {
    const query = parse(z.object(page).strict(), request.query)
    return { items: await (await scheduler()).store.listConstraints(query.limit, query.offset) }
  })
  app.post('/api/memory/schedule-constraints/:id/lift', { preHandler: auth, bodyLimit: 1024 }, async request => {
    const user = (await authorize(request)).id
    const lifted = await (await scheduler()).store.liftConstraint(scheduleId(request), user)
    check(lifted, 'La restricción no existe o ya se levantó.', 404)
    return { id: lifted!.id, lifted_at: lifted!.lifted_at }
  })
}
