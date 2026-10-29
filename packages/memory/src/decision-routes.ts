import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { id, MemoryError, parse } from './contracts.js'
import { DecisionReviewError } from './decisions/review.js'
import type { ScheduleEffects } from './schedule-contract.js'

const ordinals = z.array(z.number().int().min(1).max(99)).min(1).max(99)
const BASE = '/api/memory/schedules'

/** El código de una refusal cerrada llega al cliente tal cual; nada de lo que estas rutas devuelven incluye el código de aprobación. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (error) {
    if (error instanceof DecisionReviewError) throw new MemoryError(error.status, error.code, false, error.code)
    throw error
  }
}

/**
 * Rutas humanas de decisión (solo el dueño): aprobar, rechazar y corregir por digest, ver la solicitud de un run, reconciliar una acción incierta y
 * consultar los canales de entrega. Las operaciones las implementa el core con el almacén privado; aquí solo se valida la forma y se traducen los errores.
 */
export function registerDecisionRoutes(app: FastifyInstance, effects: ScheduleEffects | undefined, authorize: (request: FastifyRequest) => Promise<{ id: string }>) {
  const auth = async (request: FastifyRequest) => { await authorize(request) }
  const review = () => {
    if (!effects?.review) throw new MemoryError(503, 'Las decisiones no están disponibles en este servicio.', false, 'decisions_unavailable')
    return effects.review
  }
  const runId = (request: FastifyRequest) => parse(z.object({ runId: id }).strict(), request.params).runId

  app.get(`${BASE}/runs/:runId/decision`, { preHandler: auth }, async request => {
    const view = await guarded(() => review().view(runId(request)))
    if (!view) throw new MemoryError(404, 'no_decision', false, 'no_decision')
    return view
  })
  app.post(`${BASE}/runs/:runId/approve`, { preHandler: auth, bodyLimit: 4096 }, async request => {
    const body = parse(z.object({ ordinals, digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(), request.body)
    return guarded(() => review().decide(runId(request), { kind: 'approve', ordinals: body.ordinals, digest: body.digest }))
  })
  app.post(`${BASE}/runs/:runId/reject`, { preHandler: auth, bodyLimit: 4096 }, async request => {
    const body = parse(z.object({ ordinals }).strict(), request.body)
    return guarded(() => review().decide(runId(request), { kind: 'reject', ordinals: body.ordinals }))
  })
  app.post(`${BASE}/runs/:runId/revise`, { preHandler: auth, bodyLimit: 4096 }, async request => {
    const body = parse(z.object({ ordinal: z.number().int().min(1).max(99), seconds: z.number().int().min(1800).max(86_400).refine(value => value % 1800 === 0, 'seconds debe ser múltiplo de 1800') }).strict(), request.body)
    return guarded(() => review().revise(runId(request), body))
  })
  app.post(`${BASE}/runs/:runId/repropose`, { preHandler: auth, bodyLimit: 1024 }, async request => {
    parse(z.object({}).strict(), request.body ?? {})
    return guarded(() => review().repropose(runId(request)))
  })

  /** Solo lectura contra el sistema remoto: no ejecuta nada ni cambia el estado de la intención. */
  app.post(`${BASE}/actions/:intentId/reconcile`, { preHandler: auth, bodyLimit: 1024 }, async request => {
    const { intentId } = parse(z.object({ intentId: id }).strict(), request.params)
    if (!effects) throw new MemoryError(503, 'Las acciones no están disponibles en este servicio.', false, 'actions_unavailable')
    const receipt = await effects.actions.reconcile(intentId)
    return { intent_id: receipt.intent_id, state: receipt.state, ...(receipt.remote_ref ? { remote_ref: receipt.remote_ref } : {}), ...(receipt.error_code ? { error_code: receipt.error_code } : {}) }
  })

  app.get(`${BASE}/delivery-channels`, { preHandler: auth }, async () => {
    const available = effects ? await effects.deliveries.available() : null
    const entry = (key: 'gmail_self' | 'slack_self') => ({ available: available?.[key].available ?? false, ...(available?.[key].reason ? { reason: available[key].reason } : { ...(available ? {} : { reason: 'not_connected' as const }) }) })
    return { items: [{ channel: 'app', available: true }, { channel: 'gmail', ...entry('gmail_self') }, { channel: 'slack', ...entry('slack_self') }] }
  })
}
