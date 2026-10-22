import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { registerMemory } from './routes.js'

it('allows the human owner activity route, rejects agent credentials and invalid cursors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-observer-route-'))
  const app = Fastify()
  const { service } = registerMemory(app, { directory, baseUrl: 'http://localhost', authorize: async request => {
    if (request.headers.authorization !== 'Bearer human-owner') throw Object.assign(new Error('Owner required'), { statusCode: 401 })
    return { id: 'owner' }
  } })
  const activity = vi.spyOn(service, 'fleetActivity').mockResolvedValue({ supported: true, generation: 'synthetic', state: 'busy', items: [{ seq: 1, at: '2026-01-01T00:00:00Z', kind: 'tool', text: 'synthetic output' }], next_cursor: 1 })
  try {
    const rejected = await app.inject({ url: '/api/memory/chat/agents/session/activity', headers: { authorization: 'Bearer agent-key' } })
    expect(rejected.statusCode).toBe(401)
    expect(activity).not.toHaveBeenCalled()
    const accepted = await app.inject({ url: '/api/memory/chat/agents/session/activity?after=2', headers: { authorization: 'Bearer human-owner' } })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.headers['cache-control']).toBe('no-store')
    expect(activity).toHaveBeenCalledWith('session', 2)
    expect(accepted.json().items[0].text).toBe('synthetic output')
    activity.mockClear()
    const invalid = await app.inject({ url: '/api/memory/chat/agents/session/activity?after=-1', headers: { authorization: 'Bearer human-owner' } })
    expect(invalid.statusCode).toBe(422)
    expect(activity).not.toHaveBeenCalled()
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
