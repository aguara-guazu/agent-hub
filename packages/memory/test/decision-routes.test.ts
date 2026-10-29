import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerDecisionRoutes } from '../src/decision-routes.js'
import { DecisionReviewError, type DecisionReview } from '../src/decisions/review.js'
import type { ScheduleEffects } from '../src/schedule-contract.js'

const RUN = '11111111-1111-4111-8111-111111111111', INTENT = '22222222-2222-4222-8222-222222222222'
const DIGEST = 'a'.repeat(64)
const view = { request_id: 'req', revision: 1, state: 'open', expires_at: '2099-01-01T00:00:00.000Z', digest: DIGEST, items: [] }

let app: FastifyInstance, review: { [K in keyof DecisionReview]: ReturnType<typeof vi.fn> }, authorized: boolean
let reconcile: ReturnType<typeof vi.fn>, available: ReturnType<typeof vi.fn>, executeDelivery: ReturnType<typeof vi.fn>
let deliveries: Array<{ id: string; run_id: string; target: string; state: string; attempts: number; artifact_id: string }>
let setDelivery: ReturnType<typeof vi.fn>, enabled: boolean
const DELIVERY = '33333333-3333-4333-8333-333333333333'

beforeEach(async () => {
  authorized = true
  review = { view: vi.fn(async () => ({ ...view, authority: 'verified' })), decide: vi.fn(async () => ({ ...view, approved: [1] })), revise: vi.fn(async () => view), repropose: vi.fn(async () => view), releaseDelivery: vi.fn(async () => 1) }
  enabled = true
  deliveries = [{ id: DELIVERY, run_id: RUN, target: 'gmail_self', state: 'uncertain', attempts: 1, artifact_id: 'art-1' }]
  executeDelivery = vi.fn(async () => ({ state: 'sent', outbox_ref: 'out-1' }))
  setDelivery = vi.fn(async () => undefined)
  reconcile = vi.fn(async (intent_id: string) => ({ intent_id, state: 'uncertain', error_code: 'no_conclusive_evidence' }))
  available = vi.fn(async () => ({ gmail_self: { available: true }, slack_self: { available: false, reason: 'tool_off' } }))
  const effects = { review, actions: { reconcile }, deliveries: { available, executeDelivery } } as unknown as ScheduleEffects
  const service = { get: async () => ({ db: { query: async (sql: string, params: unknown[]) => deliveries.filter(row => (sql.includes('d.id = $1') ? row.id === params[0] : row.run_id === params[0])) }, schedules: { store: { setDelivery } } }) } as never
  app = Fastify()
  registerDecisionRoutes(app, effects, async () => { if (!authorized) throw Object.assign(new Error('no'), { statusCode: 401 }); return { id: 'owner' } }, { service, automationsEnabled: () => enabled })
  await app.ready()
})
afterEach(() => app.close())
const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as never })

describe('rutas humanas de decisión', () => {
  it('exigen sesión del dueño', async () => {
    authorized = false
    for (const [method, url] of [['GET', `/api/memory/schedules/runs/${RUN}/decision`], ['POST', `/api/memory/schedules/runs/${RUN}/approve`], ['GET', '/api/memory/schedules/delivery-channels']] as const)
      expect((await app.inject({ method, url })).statusCode).toBe(401)
    expect(review.decide).not.toHaveBeenCalled()
  })

  it('devuelve la solicitud del run y 404 si no hay', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/memory/schedules/runs/${RUN}/decision` })).json()).toMatchObject({ request_id: 'req', authority: 'verified', digest: DIGEST })
    review.view.mockResolvedValueOnce(null)
    const missing = await app.inject({ method: 'GET', url: `/api/memory/schedules/runs/${RUN}/decision` })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'no_decision' })
  })

  it('aprobar exige ordinales válidos y el digest exacto; rechazar no lo pide', async () => {
    const url = `/api/memory/schedules/runs/${RUN}/approve`
    for (const payload of [{}, { ordinals: [1] }, { ordinals: [], digest: DIGEST }, { ordinals: [0], digest: DIGEST }, { ordinals: [1], digest: 'corto' }, { ordinals: [1], digest: DIGEST, otro: 1 }])
      expect((await post(url, payload)).statusCode).toBe(422)
    expect(review.decide).not.toHaveBeenCalled()
    expect((await post(url, { ordinals: [1, 3], digest: DIGEST })).json()).toMatchObject({ approved: [1] })
    expect(review.decide).toHaveBeenCalledWith(RUN, { kind: 'approve', ordinals: [1, 3], digest: DIGEST })
    await post(`/api/memory/schedules/runs/${RUN}/reject`, { ordinals: [2] })
    expect(review.decide).toHaveBeenLastCalledWith(RUN, { kind: 'reject', ordinals: [2] })
  })

  it('los rechazos del dominio salen como 409 con su código cerrado', async () => {
    for (const code of ['digest_mismatch', 'expired', 'revoked', 'superseded', 'locked', 'authority_unavailable', 'bad_selection']) {
      review.decide.mockRejectedValueOnce(new DecisionReviewError(409, code))
      const response = await post(`/api/memory/schedules/runs/${RUN}/approve`, { ordinals: [1], digest: DIGEST })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ code })
    }
  })

  it('corregir solo admite segundos positivos y múltiplos de 1800', async () => {
    const url = `/api/memory/schedules/runs/${RUN}/revise`
    for (const seconds of [0, 1799, 2700, -1800, 90_000, 1800.5]) expect((await post(url, { ordinal: 1, seconds })).statusCode).toBe(422)
    expect(review.revise).not.toHaveBeenCalled()
    expect((await post(url, { ordinal: 1, seconds: 5400 })).statusCode).toBe(200)
    expect(review.revise).toHaveBeenCalledWith(RUN, { ordinal: 1, seconds: 5400 })
  })

  it('reconciliar es solo lectura y devuelve el recibo sin resultado interno', async () => {
    const response = await post(`/api/memory/schedules/actions/${INTENT}/reconcile`, {})
    expect(response.json()).toEqual({ intent_id: INTENT, state: 'uncertain', error_code: 'no_conclusive_evidence' })
    expect((await post('/api/memory/schedules/actions/no-es-id/reconcile', {})).statusCode).toBe(422)
  })

  it('los canales reflejan la disponibilidad real y la app siempre está', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/memory/schedules/delivery-channels' })).json()).toEqual({ items: [
      { channel: 'app', available: true }, { channel: 'gmail', available: true }, { channel: 'slack', available: false, reason: 'tool_off' }] })
  })

  it('ninguna respuesta de estas rutas contiene un código ni una línea de respuesta', async () => {
    const bodies = [(await app.inject({ method: 'GET', url: `/api/memory/schedules/runs/${RUN}/decision` })).body, (await post(`/api/memory/schedules/runs/${RUN}/approve`, { ordinals: [1], digest: DIGEST })).body]
    for (const body of bodies) { expect(body).not.toMatch(/reply_line|aprobar |code_hmac|"code"/i) }
  })

  it('sin efectos inyectados responden 503 con código cerrado', async () => {
    const bare = Fastify()
    registerDecisionRoutes(bare, undefined, async () => ({ id: 'owner' }))
    await bare.ready()
    const response = await bare.inject({ method: 'GET', url: `/api/memory/schedules/runs/${RUN}/decision` })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ code: 'decisions_unavailable' })
    expect((await bare.inject({ method: 'GET', url: '/api/memory/schedules/delivery-channels' })).json().items[1]).toMatchObject({ channel: 'gmail', available: false })
    await bare.close()
  })

  it('reintentar una entrega incierta cierra la anterior, reenvía, actualiza la fila y avisa que puede llegar dos veces', async () => {
    const response = await post(`/api/memory/schedules/deliveries/${DELIVERY}/retry`, {})
    expect(response.json()).toEqual({ delivery_id: DELIVERY, state: 'sent', may_duplicate: true })
    expect(review.releaseDelivery).toHaveBeenCalledWith(RUN, 'gmail')
    expect(executeDelivery).toHaveBeenCalledWith({ delivery_id: DELIVERY, run_id: RUN, artifact_id: 'art-1', target: 'gmail_self', expected_generation: 1 })
    expect(setDelivery.mock.calls.map(call => call[1])).toEqual([{ state: 'sending', attempts: 2 }, { state: 'sent', outbox_ref: 'out-1', error_code: null }])
    expect(review.releaseDelivery.mock.invocationCallOrder[0]).toBeLessThan(executeDelivery.mock.invocationCallOrder[0]!)
  })

  it('una entrega fallida se reintenta sin advertir duplicado y un resultado ambiguo queda incierto', async () => {
    deliveries[0]!.state = 'failed'
    executeDelivery.mockResolvedValueOnce({ state: 'uncertain', error_code: 'network' })
    expect((await post(`/api/memory/schedules/deliveries/${DELIVERY}/retry`, {})).json()).toEqual({ delivery_id: DELIVERY, state: 'uncertain', error_code: 'network', may_duplicate: false })
    executeDelivery.mockRejectedValueOnce(new Error('boom'))
    expect((await post(`/api/memory/schedules/deliveries/${DELIVERY}/retry`, {})).json()).toMatchObject({ state: 'uncertain', error_code: 'retry_failed' })
  })

  it('solo se reintentan entregas fallidas o inciertas por canal propio, existentes y con las automatizaciones encendidas', async () => {
    const url = `/api/memory/schedules/deliveries/${DELIVERY}/retry`
    deliveries[0]!.state = 'sent'
    expect((await post(url, {})).json()).toMatchObject({ code: 'not_retryable' })
    deliveries[0]!.state = 'failed'; deliveries[0]!.target = 'app_window'
    expect((await post(url, {})).statusCode).toBe(409)
    deliveries[0]!.target = 'gmail_self'
    expect((await post('/api/memory/schedules/deliveries/44444444-4444-4444-8444-444444444444/retry', {})).statusCode).toBe(404)
    enabled = false
    expect((await post(url, {})).json()).toMatchObject({ code: 'automations_off' })
    expect(executeDelivery).not.toHaveBeenCalled()
  })

  it('reproponer reenvía solo por los canales que ya se habían enviado', async () => {
    deliveries = [{ id: DELIVERY, run_id: RUN, target: 'gmail_self', state: 'sent', attempts: 1, artifact_id: 'art-1' },
      { id: '55555555-5555-4555-8555-555555555555', run_id: RUN, target: 'slack_self', state: 'failed', attempts: 1, artifact_id: 'art-1' },
      { id: '66666666-6666-4666-8666-666666666666', run_id: RUN, target: 'app_window', state: 'sent', attempts: 1, artifact_id: 'art-1' }]
    const response = await post(`/api/memory/schedules/runs/${RUN}/repropose`, {})
    expect(response.json()).toMatchObject({ request_id: 'req', redelivered: [{ target: 'gmail_self', state: 'sent' }] })
    expect(executeDelivery).toHaveBeenCalledTimes(1)
    enabled = false
    expect((await post(`/api/memory/schedules/runs/${RUN}/repropose`, {})).json().redelivered).toEqual([])
  })
})
