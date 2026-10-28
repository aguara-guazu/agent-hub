import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp, type CoreApp } from '../src/app.js'
import { ensureLocalOwner } from '../src/local.js'
import { createAccessToken } from '../src/security.js'

describe('automatizaciones y programaciones por HTTP', () => {
  let app: CoreApp, directory: string, headers: { authorization: string }
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'automations-core-'))
    vi.stubEnv('AGENTHUB_MEMORY_DIR', join(directory, 'memory'))
    vi.stubEnv('AGENTHUB_MEMORY_WORKER', '0')
    app = buildApp({ settings: { localMode: true, starterCatalog: false, databasePath: join(directory, 'hub.db') } })
    headers = { authorization: `Bearer ${await createAccessToken(app.settings, ensureLocalOwner(app.store).id)}` }
  })
  afterEach(async () => { await app?.fastify.close(); app?.db.close(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs() })

  it('exige sesión, devuelve los valores por defecto, valida y conserva los ajustes parciales', async () => {
    const url = '/api/automations'
    expect((await app.fastify.inject({ method: 'GET', url })).statusCode).toBe(401)
    expect((await app.fastify.inject({ method: 'GET', url, headers })).json()).toEqual({ automations_enabled: true, notify_schedule_created: true, notify_delivery: true, workday_hours: 8, keep_awake: true })
    for (const payload of [{}, { automations_enabled: 'no' }, { workday_hours: 30 }, { otro: true }]) expect((await app.fastify.inject({ method: 'PUT', url, headers, payload })).statusCode).toBe(422)
    const saved = await app.fastify.inject({ method: 'PUT', url, headers, payload: { notify_delivery: false, workday_hours: 6.5, automations_enabled: false } })
    expect(saved.json()).toEqual({ automations_enabled: false, notify_schedule_created: true, notify_delivery: false, workday_hours: 6.5, keep_awake: true })
    expect((await app.fastify.inject({ method: 'GET', url, headers })).json()).toMatchObject({ automations_enabled: false, workday_hours: 6.5 })
  })

  it('las rutas humanas de schedules requieren sesión y devuelven el código cerrado del error', async () => {
    expect((await app.fastify.inject({ method: 'GET', url: '/api/memory/schedules' })).statusCode).toBe(401)
    const list = await app.fastify.inject({ method: 'GET', url: '/api/memory/schedules', headers })
    expect(list.json()).toMatchObject({ items: [], total: 0, delivery_available: { gmail_self: { available: false }, slack_self: { available: false } } })
    const missing = await app.fastify.inject({ method: 'POST', url: '/api/memory/schedules/00000000-0000-4000-8000-000000000000/pause', headers, payload: { expected_revision: 1 } })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'schedule_not_found' })
    expect((await app.fastify.inject({ method: 'GET', url: '/api/memory/schedules/feed', headers })).json()).toMatchObject({ events: [], cursor: 0, active_runs: [] })
  })
})
