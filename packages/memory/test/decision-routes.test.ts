import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerDecisionRoutes } from '../src/decision-routes.js'
import { DecisionReviewError, type DecisionReview } from '../src/decisions/review.js'
import type { ScheduleEffects } from '../src/schedule-contract.js'

const RUN = '11111111-1111-4111-8111-111111111111', INTENT = '22222222-2222-4222-8222-222222222222'
const DIGEST = 'a'.repeat(64)
const view = { request_id: 'req', revision: 1, state: 'open', expires_at: '2099-01-01T00:00:00.000Z', digest: DIGEST, items: [] }

let app: FastifyInstance, review: { [K in keyof DecisionReview]: ReturnType<typeof vi.fn> }, authorized: boolean
let reconcile: ReturnType<typeof vi.fn>, available: ReturnType<typeof vi.fn>

beforeEach(async () => {
  authorized = true
  review = { view: vi.fn(async () => ({ ...view, authority: 'verified' })), decide: vi.fn(async () => ({ ...view, approved: [1] })), revise: vi.fn(async () => view), repropose: vi.fn(async () => view) }
  reconcile = vi.fn(async (intent_id: string) => ({ intent_id, state: 'uncertain', error_code: 'no_conclusive_evidence' }))
  available = vi.fn(async () => ({ gmail_self: { available: true }, slack_self: { available: false, reason: 'tool_off' } }))
  const effects = { review, actions: { reconcile }, deliveries: { available } } as unknown as ScheduleEffects
  app = Fastify()
  registerDecisionRoutes(app, effects, async () => { if (!authorized) throw Object.assign(new Error('no'), { statusCode: 401 }); return { id: 'owner' } })
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
})
