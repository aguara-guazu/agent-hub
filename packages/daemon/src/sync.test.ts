import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DaemonState } from './state.js'
import {
  AuthError,
  Backoff,
  SnapshotSync,
  SyncClient,
  ToolCallForwarder,
  type Fetcher,
  type FetchResponse,
} from './sync.js'

function jsonResponse(status: number, body: unknown): FetchResponse {
  return {
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agenthub-sync-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('Backoff', () => {
  it('crece exponencialmente hasta el tope y usa jitter completo', () => {
    const backoff = new Backoff(1, 2, 10, (min, max) => max) // rng = tope
    expect(backoff.delay(1)).toBe(1)
    expect(backoff.delay(2)).toBe(2)
    expect(backoff.delay(3)).toBe(4)
    expect(backoff.delay(10)).toBe(10) // recortado al máximo
  })

  it('el jitter recibe [0, tope]', () => {
    const spy = vi.fn((min: number, _max: number) => min)
    const backoff = new Backoff(1, 2, 60, spy)
    backoff.delay(3)
    expect(spy).toHaveBeenCalledWith(0, 4)
  })
})

describe('SyncClient', () => {
  it('pide el snapshot con known_hash y devuelve null en 304', async () => {
    const calls: string[] = []
    const fetcher: Fetcher = async (url) => {
      calls.push(url)
      return jsonResponse(304, {})
    }
    const client = new SyncClient('http://hub/api', 'ahd_x', { fetcher })
    const result = await client.fetchSnapshot('a1', { knownHash: 'h1', wait: 0 })
    expect(result).toBeNull()
    expect(calls[0]).toContain('known_hash=h1')
  })

  it('no reintenta un 4xx y lanza AuthError en 401', async () => {
    let attempts = 0
    const fetcher: Fetcher = async () => {
      attempts += 1
      return jsonResponse(401, { detail: 'sin permiso' })
    }
    const client = new SyncClient('http://hub/api', 'ahd_x', { fetcher, maxAttempts: 5, sleep: async () => {} })
    await expect(client.bootstrap()).rejects.toBeInstanceOf(AuthError)
    expect(attempts).toBe(1)
  })

  it('reintenta los 5xx hasta agotar los intentos', async () => {
    let attempts = 0
    const fetcher: Fetcher = async () => {
      attempts += 1
      return jsonResponse(503, {})
    }
    const client = new SyncClient('http://hub/api', 'ahd_x', { fetcher, maxAttempts: 3, sleep: async () => {} })
    await expect(client.bootstrap()).rejects.toThrow()
    expect(attempts).toBe(3)
  })

  it('el token viaja solo en el header Authorization', async () => {
    let seen: Record<string, string> = {}
    const fetcher: Fetcher = async (_url, init) => {
      seen = init.headers
      return jsonResponse(200, { ok: true })
    }
    const client = new SyncClient('http://hub/api', 'ahd_secreto', { fetcher })
    await client.bootstrap()
    expect(seen['Authorization']).toBe('Bearer ahd_secreto')
  })
})

describe('SnapshotSync — modo degradado fail-closed', () => {
  it('cuando el control plane no contesta, sirve el último snapshot en disco', async () => {
    const state = new DaemonState(dir)
    state.saveSnapshot({ agent_instance_id: 'a1', snapshot_hash: 'viejo', servers: [] })
    const fetcher: Fetcher = async () => {
      throw new Error('sin red')
    }
    const client = new SyncClient('http://hub/api', 'ahd_x', { fetcher, maxAttempts: 1, sleep: async () => {} })
    const sync = new SnapshotSync(client, state, { pollSeconds: 0 })
    const outcome = await sync.refresh('a1', { wait: 0 })
    expect(outcome.source).toBe('disk')
    expect(outcome.snapshot?.['snapshot_hash']).toBe('viejo')
    expect(sync.degradedAgents['a1']).toBeTruthy()
  })

  it('sin snapshot local y sin control plane, no inventa nada (missing, no fail-open)', async () => {
    const state = new DaemonState(dir)
    const fetcher: Fetcher = async () => {
      throw new Error('sin red')
    }
    const client = new SyncClient('http://hub/api', 'ahd_x', { fetcher, maxAttempts: 1, sleep: async () => {} })
    const sync = new SnapshotSync(client, state)
    const outcome = await sync.refresh('a1', { wait: 0 })
    expect(outcome.source).toBe('missing')
    expect(outcome.snapshot).toBeNull()
  })

  it('un snapshot nuevo se persiste antes de devolverse', async () => {
    const state = new DaemonState(dir)
    const fetcher: Fetcher = async () => jsonResponse(200, { agent_instance_id: 'a1', snapshot_hash: 'nuevo', servers: [] })
    const client = new SyncClient('http://hub/api', 'ahd_x', { fetcher })
    const sync = new SnapshotSync(client, state)
    const outcome = await sync.refresh('a1', { wait: 0 })
    expect(outcome.source).toBe('control_plane')
    expect(state.knownHash('a1')).toBe('nuevo')
  })
})

describe('ToolCallForwarder', () => {
  it('descarta el reporte más viejo cuando la cola se llena y no frena al llamador', async () => {
    const sent: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetcher: Fetcher = async (_url, init) => {
      await gate
      sent.push(JSON.parse(init.body ?? '{}').exposed_name)
      return jsonResponse(204, {})
    }
    const client = new SyncClient('http://hub/api', 'ahd_x', { fetcher })
    const forwarder = new ToolCallForwarder(client, 2)
    const rec = (name: string) => ({
      agent_id: 'a1',
      server_slug: 's',
      tool_name: 't',
      exposed_name: name,
      decision: 'allowed',
      denial_reason: '',
      args_digest: 'd',
      duration_ms: 1,
      error: '',
    })
    await forwarder.enqueue(rec('uno'))
    await forwarder.enqueue(rec('dos'))
    await forwarder.enqueue(rec('tres'))
    await forwarder.enqueue(rec('cuatro'))
    await forwarder.enqueue(rec('cinco'))
    expect(forwarder.dropped).toBeGreaterThanOrEqual(1)
    release()
    await forwarder.close(1)
  })
})
