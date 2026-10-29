import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { id, MemoryError, parse } from './contracts.js'
import { DecisionReviewError } from './decisions/review.js'
import type { MemoryService } from './service.js'
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
export function registerDecisionRoutes(app: FastifyInstance, effects: ScheduleEffects | undefined, authorize: (request: FastifyRequest) => Promise<{ id: string }>,
  extras: { service?: MemoryService; automationsEnabled?: () => boolean } = {}) {
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
    const run = runId(request)
    const proposed = await guarded(() => review().repropose(run))
    // La solicitud nueva tiene código propio: se reenvía por los canales que ya se habían usado para este run.
    return { ...proposed, redelivered: await redeliver(run, ['sent']) }
  })

  const CHANNEL_TARGETS = ['gmail_self', 'slack_self'] as const
  type ChannelTarget = typeof CHANNEL_TARGETS[number]
  interface DeliveryRow { id: string; run_id: string; target: string; state: string; attempts: number; artifact_id: string }
  const deliveryRows = async (where: string, params: unknown[]) => {
    const current = await extras.service?.get()
    if (!current) throw new MemoryError(503, 'Las entregas no están disponibles en este servicio.', false, 'deliveries_unavailable')
    const rows = await current.db.query<DeliveryRow>(`SELECT d.id, d.run_id, d.target, d.state, d.attempts, a.id AS artifact_id FROM schedule_deliveries d JOIN schedule_artifacts a ON a.run_id = d.run_id WHERE ${where}`, params)
    return { rows, store: current.schedules?.store }
  }
  /** Una nueva entrega por canal propio; el resultado de cada una queda en su fila. Un fallo de un canal no impide los demás. */
  async function sendAgain(row: DeliveryRow, store: { setDelivery(id: string, patch: Record<string, unknown>): Promise<void> } | undefined): Promise<{ target: string; state: string; error_code?: string }> {
    const attempts = row.attempts + 1
    await store?.setDelivery(row.id, { state: 'sending', attempts })
    let receipt
    try { receipt = await effects!.deliveries.executeDelivery({ delivery_id: row.id, run_id: row.run_id, artifact_id: row.artifact_id, target: row.target as ChannelTarget, expected_generation: row.attempts }) } catch {
      await store?.setDelivery(row.id, { state: 'uncertain', error_code: 'retry_failed' })
      return { target: row.target, state: 'uncertain', error_code: 'retry_failed' }
    }
    await store?.setDelivery(row.id, { state: receipt.state, outbox_ref: receipt.outbox_ref ?? null, error_code: receipt.error_code ?? null })
    return { target: row.target, state: receipt.state, ...(receipt.error_code ? { error_code: receipt.error_code } : {}) }
  }
  async function redeliver(run: string, states: string[]) {
    if (!effects || extras.automationsEnabled?.() === false) return []
    const { rows, store } = await deliveryRows('d.run_id = $1', [run]).catch(() => ({ rows: [] as DeliveryRow[], store: undefined }))
    const results = []
    for (const row of rows.filter(candidate => (CHANNEL_TARGETS as readonly string[]).includes(candidate.target) && states.includes(candidate.state))) results.push(await sendAgain(row, store))
    return results
  }

  /** Reintento humano de una entrega fallida o incierta. Una incierta pudo haber llegado: la respuesta lo advierte con `may_duplicate`. */
  app.post(`${BASE}/deliveries/:id/retry`, { preHandler: auth, bodyLimit: 1024 }, async request => {
    const { id: deliveryId } = parse(z.object({ id }).strict(), request.params)
    parse(z.object({}).strict(), request.body ?? {})
    if (!effects) throw new MemoryError(503, 'Las entregas no están disponibles en este servicio.', false, 'deliveries_unavailable')
    if (extras.automationsEnabled?.() === false) throw new MemoryError(409, 'automations_off', false, 'automations_off')
    const { rows, store } = await deliveryRows('d.id = $1', [deliveryId])
    const row = rows[0]
    if (!row) throw new MemoryError(404, 'delivery_not_found', false, 'delivery_not_found')
    if (!(CHANNEL_TARGETS as readonly string[]).includes(row.target) || (row.state !== 'failed' && row.state !== 'uncertain')) throw new MemoryError(409, 'not_retryable', false, 'not_retryable')
    const mayDuplicate = row.state === 'uncertain'
    await guarded(async () => { await effects.review?.releaseDelivery(row.run_id, row.target === 'gmail_self' ? 'gmail' : 'slack') })
    const result = await sendAgain(row, store)
    return { delivery_id: row.id, state: result.state, ...(result.error_code ? { error_code: result.error_code } : {}), may_duplicate: mayDuplicate }
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
