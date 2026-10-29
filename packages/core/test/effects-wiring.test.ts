import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Vault } from '@agenthub/memory'
import type { ConnectionPool } from '@agenthub/gateway'
import { buildApp, type CoreApp } from '../src/app.js'
import { ensureLocalOwner } from '../src/local.js'
import { createAccessToken } from '../src/security.js'
import { Database } from '../src/db/database.js'
import { runMigrations } from '../src/db/migrations.js'
import { Store } from '../src/store.js'
import { createCoreScheduleEffects } from '../src/effects/wiring.js'
import type { ActionAdapter } from '../src/effects/executor.js'

describe('efectos del scheduler cableados en el core', () => {
  let app: CoreApp, directory: string, headers: { authorization: string }
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'effects-wiring-'))
    vi.stubEnv('AGENTHUB_MEMORY_DIR', join(directory, 'memory'))
    vi.stubEnv('AGENTHUB_MEMORY_WORKER', '0')
    app = buildApp({ settings: { localMode: true, starterCatalog: false, databasePath: join(directory, 'hub.db') } })
    headers = { authorization: `Bearer ${await createAccessToken(app.settings, ensureLocalOwner(app.store).id)}` }
  })
  afterEach(async () => { await app?.fastify.close(); app?.db.close(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs() })

  it('las rutas de schedules consultan los adaptadores reales: sin Gmail ni Slack conectados no hay canales y el almacén de decisiones queda creado con su clave en el Vault', async () => {
    const list = await app.fastify.inject({ method: 'GET', url: '/api/memory/schedules', headers })
    expect(list.statusCode).toBe(200)
    expect(list.json().delivery_available).toEqual({ gmail_self: { available: false, reason: 'not_connected' }, slack_self: { available: false, reason: 'tool_off' } })
    const memory = join(directory, 'memory')
    expect(existsSync(join(memory, 'decisions.sqlite'))).toBe(true)
    const key = join(memory, 'secrets', 'decision-verifier.json')
    expect(existsSync(key)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(key).mode & 0o777).toBe(0o600)
    expect(new Vault(memory).read<{ key: string }>('decision-verifier')!.key.length).toBeGreaterThanOrEqual(43)
  })
})

describe('apagar las automatizaciones con una acción ya reclamada', () => {
  let dir: string, db: Database, store: Store, ownerId: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'effects-off-')); db = new Database(':memory:'); runMigrations(db, ':memory:'); store = new Store(db); ownerId = ensureLocalOwner(store).id
    store.insertMachine({ user_id: ownerId, hostname: 'test', os: 'test', daemon_version: 'test' })
    const server = store.insertServer({ user_id: ownerId, slug: 'atlassian_rovo', display_name: 'Atlassian', description: '', transport: 'http', auth: 'none', url: 'https://mcp.atlassian.com/v1/mcp', command: '', args: [], env: {}, cwd: '', headers: {},
      secret_refs: {}, requires_host_access: false, container_image: '', allow_hosts: [], allow_ports: [], read_mounts: [], write_mounts: [] })
    store.insertTool({ server_id: server.id, name: 'getJiraIssue', title: 'getJiraIssue', exposed_name: 'atl_getJiraIssue', description: '', input_schema: { type: 'object' }, definition_hash: 'h' })
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  function build(adapters: ActionAdapter<any>[], enabled: () => boolean = () => true) {
    const vault = new Vault(dir)
    const memoryDb = { query: async () => [] as any[] }
    const schedules = { set: async () => {}, artifactAuthority: async () => 'live' as const, artifactOfRun: async () => undefined }
    const effects = createCoreScheduleEffects({ store, pool: {} as ConnectionPool, ownerId, automationsEnabled: enabled, adapters,
      host: { directory: dir, vault, google: { granted: () => false } as never, load: async () => ({ db: memoryDb, schedules }) } })
    return effects
  }
  const adapter = (over: Partial<ActionAdapter<any>> = {}): ActionAdapter<any> & { readonly executed: number } => {
    const state = { executed: 0 }
    const base = ({ kind: 'jira_worklog' as const, tools: ['getJiraIssue'], effect: { parse: (raw: unknown) => raw }, prepare: async () => ({}), reconcile: async () => null,
      execute: async () => { state.executed++; return { state: 'succeeded' as const } }, ...over })
    return Object.defineProperty(base, 'executed', { get: () => state.executed }) as ActionAdapter<any> & { readonly executed: number }
  }
  async function approved(effects: ReturnType<typeof build>) {
    const prepared = await effects.decisions.prepareDecision({ run_id: 'run-1', artifact_id: 'art-1', owner_id: ownerId, project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z',
      items: [{ ordinal: 1, kind: 'jira_worklog', project_id: 'p1', summary: 'uno', effect: { n: 1 } }] })
    const { store: decisions } = await effects.ready()
    const reserved = await decisions.reserveDelivery({ request_id: prepared.decision_request_ref, integration: 'gmail', account: 'me@example.com', correlation: '<h@hub>', provenance: 'test' })
    decisions.beginSend(reserved.delivery_id)
    await decisions.recordNative(reserved.delivery_id, { native_id: 'n1', thread_id: 't1' })
    const outcome = decisions.consumeReply({ integration: 'gmail', account: 'me@example.com', native_message_id: 'm1', binding_id: reserved.binding_id,
      parsed: { kind: 'approve', code: decisions.codeFor(prepared.decision_request_ref).replace(/-/g, ''), items: 'all' } })
    return { decisions, intentId: outcome.approved![0]!.intent_id }
  }

  it('el efecto aprobado se despacha una vez con las automatizaciones encendidas', async () => {
    const wl = adapter()
    const effects = build([wl])
    const { intentId } = await approved(effects)
    expect(await effects.actions.executeApprovedAction({ intent_id: intentId, expected_generation: 0 })).toMatchObject({ state: 'succeeded' })
    expect(wl.executed).toBe(1)
  })

  it('OFF → revokeAll mientras el adaptador prepara → el gate de dispatch lo ve revocado y el adaptador no ejecuta', async () => {
    const holder: { effects?: ReturnType<typeof build> } = {}
    const wl = adapter({ prepare: async () => { expect(await (holder.effects!.decisions as { revokeAll(): Promise<number> }).revokeAll()).toBe(1); return {} } })
    const effects = holder.effects = build([wl])
    const { intentId, decisions } = await approved(effects)
    expect(await effects.actions.executeApprovedAction({ intent_id: intentId, expected_generation: 0 })).toMatchObject({ state: 'rejected_before_dispatch', error_code: 'revoked' })
    expect(wl.executed).toBe(0)
    expect(decisions.intent(intentId)).toMatchObject({ state: 'rejected_before_dispatch', error_code: 'revoked' })
  })

  it('con el interruptor apagado ni siquiera se reclama la intención', async () => {
    const wl = adapter()
    const effects = build([wl], () => false)
    const { intentId, decisions } = await approved(effects)
    expect(await effects.actions.executeApprovedAction({ intent_id: intentId, expected_generation: 0 })).toMatchObject({ error_code: 'automations_off' })
    expect(decisions.intent(intentId)).toMatchObject({ state: 'pending', generation: 0 })
  })

  it('reiniciar el core deja una intención en dispatching como incierta y no se vuelve a despachar', async () => {
    const wl = adapter({ execute: async () => { await new Promise(() => {}); return { state: 'succeeded' } } })
    const effects = build([wl])
    const { intentId, decisions } = await approved(effects)
    void effects.actions.executeApprovedAction({ intent_id: intentId, expected_generation: 0 })
    await vi.waitFor(() => expect(decisions.intent(intentId)?.state).toBe('dispatching'))
    const restarted = build([adapter()])
    await restarted.ready()
    expect(decisions.intent(intentId)).toMatchObject({ state: 'uncertain', error_code: 'interrupted' })
  })
})
