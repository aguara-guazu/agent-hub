import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OAuthStore } from '@agenthub/gateway'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProbeRetryScheduler, isConfigured, needsRetry } from '../src/catalog/retry.js'
import type { ProbeResult } from '../src/catalog/probe.js'
import { ensureLocalOwner } from '../src/local.js'
import type { McpServerRow, User } from '../src/types.js'
import { makeApp, type TestHarness } from './helpers.js'

let app: TestHarness
let owner: User

beforeEach(() => {
  app = makeApp()
  owner = ensureLocalOwner(app.store)
})
afterEach(() => app.cleanup())

function server(overrides: Partial<McpServerRow> = {}): McpServerRow {
  const row = app.store.insertServer({
    user_id: owner.id,
    slug: overrides.slug ?? 'notes',
    display_name: 'Notes',
    description: '',
    transport: 'http',
    command: '',
    args: [],
    env: {},
    cwd: '',
    url: 'http://127.0.0.1:1/mcp',
    headers: {},
    secret_refs: {},
    requires_host_access: false,
    container_image: '',
    allow_hosts: [],
    allow_ports: [],
    read_mounts: [],
    write_mounts: [],
    ...overrides,
  })
  const patch: Partial<McpServerRow> = {}
  if (overrides.last_probe_error !== undefined) patch.last_probe_error = overrides.last_probe_error
  if (Object.keys(patch).length) app.store.updateServer(row.id, patch)
  return app.store.server(row.id)!
}

const connected: ProbeResult = {
  ok: true,
  error: '',
  server_name: 'notes',
  server_version: '1',
  tools: [{ name: 'read_note', title: '', description: 'lee', input_schema: { type: 'object' } }],
}
const down: ProbeResult = { ok: false, error: 'TypeError: fetch failed', server_name: '', server_version: '', tools: [] }

describe('reintento automático del sondeo', () => {
  it('reintenta un server habilitado y configurado cuyo sondeo falló, y al conectar limpia el error y descubre tools', async () => {
    const failing = server({ last_probe_error: 'TypeError: fetch failed' })
    const probed: string[] = []
    const changed: string[] = []
    const scheduler = new ProbeRetryScheduler({
      store: app.store,
      probe: async (row) => { probed.push(row.id); return connected },
      onChange: (userId) => changed.push(userId),
      intervalMs: 30_000,
    })

    expect(scheduler.pending().map((s) => s.id)).toEqual([failing.id])
    expect(await scheduler.tick()).toEqual([failing.id])
    expect(probed).toEqual([failing.id])
    expect(changed).toEqual([owner.id])

    const fresh = app.store.server(failing.id)!
    expect(fresh.last_probe_error).toBe('')
    expect(app.store.toolsOfServer(failing.id).map((t) => t.name)).toEqual(['read_note'])
    // Ya conectó: no hay nada que reintentar.
    expect(scheduler.pending()).toEqual([])
  })

  it('mientras siga sin conectar, mantiene el error y sigue pendiente para el próximo ciclo', async () => {
    const failing = server({ last_probe_error: 'ECONNREFUSED' })
    const scheduler = new ProbeRetryScheduler({ store: app.store, probe: async () => down })
    await scheduler.tick()
    expect(app.store.server(failing.id)!.last_probe_error).toBe('TypeError: fetch failed')
    expect(scheduler.pending().map((s) => s.id)).toEqual([failing.id])
  })

  it('no reintenta lo que su dueño apagó, lo que nunca falló ni lo que no está configurado', async () => {
    const off = server({ slug: 'off', last_probe_error: 'fetch failed' })
    app.store.insertRule({ user_id: owner.id, agent_instance_id: null, resource_type: 'mcp_server', resource_id: off.id, state: 'off', reason: '' })
    const healthy = server({ slug: 'healthy' })
    const unconfigured = server({ slug: 'bare', transport: 'stdio', command: '', url: '', last_probe_error: 'el server stdio no tiene comando configurado' })
    const failing = server({ slug: 'failing', last_probe_error: 'fetch failed' })

    expect(needsRetry(app.store, off)).toBe(false)
    expect(needsRetry(app.store, healthy)).toBe(false)
    expect(isConfigured(unconfigured)).toBe(false)
    expect(needsRetry(app.store, failing)).toBe(true)

    const probed: string[] = []
    const scheduler = new ProbeRetryScheduler({ store: app.store, probe: async (row) => { probed.push(row.slug); return connected } })
    await scheduler.tick()
    expect(probed).toEqual(['failing'])
  })

  it('una regla de usuario en `on` o `inherit` no bloquea el reintento', async () => {
    const failing = server({ last_probe_error: 'fetch failed' })
    app.store.insertRule({ user_id: owner.id, agent_instance_id: null, resource_type: 'mcp_server', resource_id: failing.id, state: 'on', reason: '' })
    expect(needsRetry(app.store, failing)).toBe(true)
  })

  it('si el dueño apaga o borra el server mientras se sondea, el resultado se descarta', async () => {
    const toDelete = server({ slug: 'gone', last_probe_error: 'fetch failed' })
    const toDisable = server({ slug: 'paused', last_probe_error: 'fetch failed' })
    const changed: string[] = []
    const scheduler = new ProbeRetryScheduler({
      store: app.store,
      probe: async (row) => {
        if (row.id === toDelete.id) app.store.deleteServer(row.id)
        else app.store.insertRule({ user_id: owner.id, agent_instance_id: null, resource_type: 'mcp_server', resource_id: row.id, state: 'off', reason: '' })
        return connected
      },
      onChange: (userId) => changed.push(userId),
    })
    await scheduler.tick()
    expect(changed).toEqual([])
    expect(app.store.server(toDelete.id)).toBeUndefined()
    expect(app.store.toolsOfServer(toDisable.id)).toEqual([])
    expect(app.store.server(toDisable.id)!.last_probe_error).toBe('fetch failed')
  })

  it('un sondeo inyectado que lanza no tumba el ciclo ni deja el server trabado', async () => {
    const failing = server({ last_probe_error: 'fetch failed' })
    let calls = 0
    const scheduler = new ProbeRetryScheduler({
      store: app.store,
      probe: async () => { calls += 1; if (calls === 1) throw new Error('boom'); return connected },
    })
    await scheduler.tick()
    expect(scheduler.pending().map((s) => s.id)).toEqual([failing.id])
    await scheduler.tick()
    expect(app.store.server(failing.id)!.last_probe_error).toBe('')
  })

  it('un server OAuth sin cuenta autorizada no se reintenta; con cuenta, sí', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthub-retry-oauth-'))
    try {
      const oauthStore = new OAuthStore(dir)
      const failing = server({ slug: 'notion', auth: 'oauth', url: 'https://mcp.notion.com/mcp', last_probe_error: 'requiere autorizar la cuenta' })
      const scheduler = new ProbeRetryScheduler({ store: app.store, oauthStore, probe: async () => connected })
      expect(needsRetry(app.store, failing, oauthStore)).toBe(false)
      expect(scheduler.pending()).toEqual([])
      oauthStore.write(failing.id, { version: 1, server_url: failing.url, tokens: { access_token: 't', token_type: 'bearer' }, updated_at: '' })
      expect(scheduler.pending().map((s) => s.id)).toEqual([failing.id])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('start/stop administran un único temporizador y un intervalo 0 lo desactiva', () => {
    const scheduler = new ProbeRetryScheduler({ store: app.store, probe: async () => connected, intervalMs: 30_000 })
    expect(scheduler.running).toBe(false)
    scheduler.start()
    scheduler.start()
    expect(scheduler.running).toBe(true)
    scheduler.stop()
    expect(scheduler.running).toBe(false)

    const disabled = new ProbeRetryScheduler({ store: app.store, probe: async () => connected, intervalMs: 0 })
    disabled.start()
    expect(disabled.running).toBe(false)
  })

  it('buildApp expone el planificador con el intervalo de la configuración, sin arrancarlo', () => {
    expect(app.probeRetry.running).toBe(false)
    expect(app.probeRetry.intervalMs).toBe(app.settings.probeRetrySeconds * 1000)
    expect(app.settings.probeRetrySeconds).toBe(30)
  })
})
