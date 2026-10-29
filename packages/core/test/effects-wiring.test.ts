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
import { createJiraAdapters } from '../src/effects/jira.js'
import { readJiraServerId } from '../src/effects/jira-server.js'
import type { ActionTickResult } from '@agenthub/memory'
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
  async function approved(effects: ReturnType<typeof build>, runId = 'run-1') {
    const prepared = await effects.decisions.prepareDecision({ run_id: runId, artifact_id: `art-${runId}`, owner_id: ownerId, project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z',
      items: [{ ordinal: 1, kind: 'jira_worklog', project_id: 'p1', summary: 'uno', effect: { run: runId } }] })
    const { store: decisions } = await effects.ready()
    const reserved = await decisions.reserveDelivery({ request_id: prepared.decision_request_ref, integration: 'gmail', account: 'me@example.com', correlation: `<h-${runId}@hub>`, provenance: 'test' })
    decisions.beginSend(reserved.delivery_id)
    await decisions.recordNative(reserved.delivery_id, { native_id: `n-${runId}`, thread_id: `t-${runId}` })
    const outcome = decisions.consumeReply({ integration: 'gmail', account: 'me@example.com', native_message_id: `m-${runId}`, binding_id: reserved.binding_id,
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

  it('si la primera resolución falla, el siguiente uso reintenta y funciona', async () => {
    let attempts = 0
    const vault = new Vault(dir)
    const effects = createCoreScheduleEffects({ store, pool: {} as ConnectionPool, ownerId, automationsEnabled: () => true, adapters: [],
      host: { directory: dir, vault, google: { granted: () => false } as never, load: async () => {
        if (++attempts === 1) throw new Error('memoria no abierta')
        return { db: { query: async () => [] as any[] }, schedules: { set: async () => {}, artifactAuthority: async () => 'live' as const, artifactOfRun: async () => undefined } }
      } } })
    await expect(effects.deliveries.available()).rejects.toThrow('memoria no abierta')
    expect(await effects.deliveries.available()).toMatchObject({ gmail_self: { available: false }, slack_self: { available: false } })
    expect(attempts).toBe(2)
  })

  it('la solicitud queda a nombre del dueño real aunque el runtime envíe su valor por defecto', async () => {
    const effects = build([adapter()])
    const { decision_request_ref } = await effects.decisions.prepareDecision({ run_id: 'run-9', artifact_id: 'a9', owner_id: 'owner', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z',
      items: [{ ordinal: 1, kind: 'jira_worklog', project_id: 'p1', summary: 'uno', effect: { n: 1 } }] })
    const { store: decisions } = await effects.ready()
    const row = (decisions as unknown as { db: { prepare(sql: string): { get(id: string): { owner_id: string } } } }).db.prepare('SELECT owner_id FROM decision_requests WHERE request_id = ?').get(decision_request_ref)
    expect(row.owner_id).toBe(ownerId)
  })

  it('actionTick despacha lo aprobado una sola vez, sin repetirlo en el ciclo siguiente', async () => {
    const wl = adapter()
    const effects = build([wl])
    const { intentId, decisions } = await approved(effects)
    const result: ActionTickResult = await effects.actionTick()
    expect(result).toEqual({ attempted: 1, succeeded: 1, rejected: 0, uncertain: 0 })
    expect(wl.executed).toBe(1)
    expect(decisions.intent(intentId)).toMatchObject({ state: 'succeeded' })
    expect(await effects.actionTick()).toEqual({ attempted: 0, succeeded: 0, rejected: 0, uncertain: 0 })
    expect(wl.executed).toBe(1)
  })

  it('actionTick con las automatizaciones apagadas no toca nada', async () => {
    const off = build([adapter()], () => false)
    const first = await approved(off)
    expect(await off.actionTick()).toEqual({ skipped: 'automations_off' })
    expect(first.decisions.intent(first.intentId)).toMatchObject({ state: 'pending', generation: 0 })
  })

  it('actionTick no reintenta solo un resultado incierto', async () => {
    const execute = vi.fn(async () => { throw new Error('timeout') })
    const flaky = build([adapter({ execute })])
    const second = await approved(flaky, 'run-2')
    expect(await flaky.actionTick()).toMatchObject({ attempted: 1, uncertain: 1 })
    expect(second.decisions.intent(second.intentId)).toMatchObject({ state: 'uncertain' })
    expect(await flaky.actionTick()).toMatchObject({ attempted: 0 })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('dos ciclos simultáneos no se solapan', async () => {
    let release!: () => void
    const wl = adapter({ execute: () => new Promise(resolve => { release = () => resolve({ state: 'succeeded' }) }) })
    const effects = build([wl])
    await approved(effects)
    const first = effects.actionTick()
    await vi.waitFor(() => expect(typeof release).toBe('function'))
    expect(await effects.actionTick()).toEqual({ skipped: 'in_flight' })
    release()
    expect(await first).toMatchObject({ attempted: 1, succeeded: 1 })
  })

  it('aprobar desde la app despacha enseguida, sin esperar al reloj', async () => {
    const wl = adapter()
    const effects = build([wl])
    const prepared = await effects.decisions.prepareDecision({ run_id: 'run-app', artifact_id: 'a-app', owner_id: ownerId, project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z',
      items: [{ ordinal: 1, kind: 'jira_worklog', project_id: 'p1', summary: 'uno', effect: { n: 1 } }] })
    const view = await effects.review!.view('run-app')
    await effects.review!.decide('run-app', { kind: 'approve', ordinals: [1], digest: view!.digest })
    await vi.waitFor(() => expect(wl.executed).toBe(1))
    const { store: decisions } = await effects.ready()
    expect(decisions.getApprovedItems(prepared.decision_request_ref)[0]).toMatchObject({ state: 'succeeded' })
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

describe('ciclo de sondeo (replyTick)', () => {
  let dir: string, db: Database, store: Store, ownerId: string, sets: unknown[]
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'effects-tick-')); db = new Database(':memory:'); runMigrations(db, ':memory:'); store = new Store(db); ownerId = ensureLocalOwner(store).id; sets = [] })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  function build(over: { enabled?: () => boolean; connectors?: any[]; google?: Record<string, unknown> } = {}) {
    const memoryDb = { query: async (sql: string) => (sql.includes('FROM connectors') ? over.connectors ?? [] : []) as any[] }
    return createCoreScheduleEffects({ store, pool: {} as ConnectionPool, ownerId, automationsEnabled: over.enabled ?? (() => true), adapters: [],
      host: { directory: dir, vault: new Vault(dir), google: { granted: () => true, token: async () => 'tok', ...over.google } as never,
        load: async () => ({ db: memoryDb, schedules: { set: async (entry: unknown) => { sets.push(entry) }, artifactAuthority: async () => 'live' as const, artifactOfRun: async () => undefined } }) } })
  }
  const request = async (effects: ReturnType<typeof build>, expiresAt: string, runId = 'run-1') => {
    const { decision_request_ref } = await effects.decisions.prepareDecision({ run_id: runId, artifact_id: `a-${runId}`, owner_id: ownerId, project_ids: ['p1'], expires_at: expiresAt,
      items: [{ ordinal: 1, kind: 'jira_worklog', project_id: 'p1', summary: 'uno', effect: { n: runId.length } }] })
    return decision_request_ref
  }

  it('los adaptadores dados como función se evalúan al resolver, una sola vez', async () => {
    let calls = 0
    const effects = createCoreScheduleEffects({ store, pool: {} as ConnectionPool, ownerId, automationsEnabled: () => true, adapters: () => { calls++; return [] },
      host: { directory: dir, vault: new Vault(dir), google: { granted: () => false } as never, load: async () => ({ db: { query: async () => [] as any[] }, schedules: { set: async () => {}, artifactAuthority: async () => 'live' as const, artifactOfRun: async () => undefined } }) } })
    expect(calls).toBe(0)
    await effects.deliveries.available(); await effects.replyTick()
    expect(calls).toBe(1)
  })

  it('adjunta los puertos de planes derivados y ofrece el despachador en cada ciclo cuando el host entrega la orquestación', async () => {
    const teams = { attachAutomation: vi.fn(), launchDerived: vi.fn(async () => ({})), expireDerived: vi.fn(async () => ({ closed: [] as string[], failed: [] as string[] })), derivedAvailable: vi.fn(() => false) }
    const effects = createCoreScheduleEffects({ store, pool: {} as ConnectionPool, ownerId, automationsEnabled: () => true, adapters: [],
      host: { directory: dir, vault: new Vault(dir), google: { granted: () => false } as never,
        load: async () => ({ db: { query: async () => [] as any[] }, schedules: { set: async () => {}, artifactAuthority: async () => 'live' as const, artifactOfRun: async () => undefined } as any, teams }) } })
    const first = await effects.replyTick(), second = await effects.replyTick()
    expect(teams.attachAutomation).toHaveBeenCalledTimes(1)
    const ports = teams.attachAutomation.mock.calls[0]![0] as Record<string, unknown>
    expect(Object.keys(ports).sort()).toEqual(['approved', 'automationsEnabled', 'claimFollowUp', 'live', 'ownerId'])
    expect(ports.ownerId).toBeInstanceOf(Function)
    expect((ports.ownerId as () => string)()).toBe(ownerId)
    expect(first.derived).toMatchObject({ skipped: 'unavailable', launched: [] })
    expect(second.derived).toMatchObject({ skipped: 'unavailable' })
    expect(teams.expireDerived).toHaveBeenCalledTimes(2)
    expect(teams.launchDerived).not.toHaveBeenCalled()
  })

  it('sin orquestación en el host no hay despachador y el resultado no lo menciona', async () => {
    const effects = build()
    expect(await effects.replyTick()).not.toHaveProperty('derived')
  })

  it('con las automatizaciones apagadas no hace nada', async () => {
    const effects = build({ enabled: () => false })
    expect(await effects.replyTick()).toEqual({ skipped: 'automations_off' })
    expect(sets).toEqual([])
  })

  it('vence las solicitudes y publica el espejo; sin conector de Gmail ni bindings no consulta a nadie', async () => {
    const effects = build()
    const ref = await request(effects, '2099-01-01T00:00:00.000Z', 'run-vivo')
    const old = await request(effects, '2000-01-01T00:00:00.000Z', 'run-viejo')
    const result = await effects.replyTick()
    expect(result).toMatchObject({ expired: 1, gmail: null, slack: { inspected: 0, consumed: 0 } })
    const { store: decisions } = await effects.ready()
    expect(decisions.publicRequest(old).state).toBe('expired')
    expect(decisions.publicRequest(ref).state).toBe('open')
    expect(sets.length).toBeGreaterThan(0)
  })

  it('un fallo de Gmail se informa sin detener Slack ni el vencimiento', async () => {
    const effects = build({ connectors: [{ id: 'conn-1', config: { gmail_send_enabled: true } }], google: { token: async () => { throw new Error('token revocado') } } })
    const ref = await request(effects, '2099-01-01T00:00:00.000Z')
    const { store: decisions } = await effects.ready()
    const reserved = await decisions.reserveDelivery({ request_id: ref, integration: 'gmail', account: 'me@example.com', correlation: '<h@hub>', provenance: 'test' })
    decisions.beginSend(reserved.delivery_id)
    await decisions.recordNative(reserved.delivery_id, { native_id: 'n1', thread_id: 't1' })
    const result = await effects.replyTick()
    expect(result.gmail).toEqual({ error: 'Error' })
    expect(result.slack).toMatchObject({ inspected: 0 })
    expect(result.expired).toBe(0)
  })
})

describe('revisión de decisiones cableada', () => {
  it('el objeto de efectos expone la revisión sobre el mismo almacén y reapunta el artefacto al corregir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'effects-review-'))
    const db = new Database(':memory:'); runMigrations(db, ':memory:')
    const store = new Store(db), ownerId = ensureLocalOwner(store).id
    const replaced: unknown[] = []
    try {
      const effects = createCoreScheduleEffects({ store, pool: {} as ConnectionPool, ownerId, automationsEnabled: () => true, adapters: [],
        host: { directory: dir, vault: new Vault(dir), google: { granted: () => false } as never, load: async () => ({ db: { query: async () => [] as any[] },
          schedules: { set: async () => {}, artifactAuthority: async () => 'live' as const, artifactOfRun: async () => undefined, replaceDecisionRef: async (...args: unknown[]) => { replaced.push(args); return true } } }) } })
      const { decision_request_ref } = await effects.decisions.prepareDecision({ run_id: 'run-r', artifact_id: 'a-r', owner_id: 'owner', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z',
        items: [{ ordinal: 1, kind: 'jira_worklog', project_id: 'p1', summary: 'uno', effect: { issue_key: 'ABC-1', seconds: 1800 } }] })
      const view = await effects.review!.view('run-r')
      expect(view).toMatchObject({ request_id: decision_request_ref, authority: 'verified' })
      const revised = await effects.review!.revise('run-r', { ordinal: 1, seconds: 3600 })
      expect(replaced).toEqual([['run-r', decision_request_ref, revised.request_id]])
      expect(await effects.review!.view('run-missing')).toBeNull()
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('adaptadores de Jira cableados con el servidor fijado por el dueño', () => {
  let dir: string, db: Database, store: Store, ownerId: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'effects-jira-')); db = new Database(':memory:'); runMigrations(db, ':memory:'); store = new Store(db); ownerId = ensureLocalOwner(store).id
    store.insertMachine({ user_id: ownerId, hostname: 'test', os: 'test', daemon_version: 'test' })
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  const worklog = { kind: 'jira_worklog', site: 'https://example.atlassian.net', account_id: '5b10ac8d82e05b22cc7d4ef5', issue_key: 'ABC-1', seconds: 1800, started: '2026-10-29T08:00:00.000Z', marker: 'cierre', estimate_id: 'est-1' }
  async function setup(pool: ConnectionPool) {
    const effects = createCoreScheduleEffects({ store, pool, ownerId, automationsEnabled: () => true, adapters: () => [...createJiraAdapters({ serverId: () => readJiraServerId(store, ownerId) })],
      host: { directory: dir, vault: new Vault(dir), google: { granted: () => false } as never, load: async () => ({ db: { query: async () => [] as any[] },
        schedules: { set: async () => {}, artifactAuthority: async () => 'live' as const, artifactOfRun: async () => undefined, replaceDecisionRef: async () => true } }) } })
    await effects.decisions.prepareDecision({ run_id: 'run-j', artifact_id: 'a-j', owner_id: ownerId, project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z',
      items: [{ ordinal: 1, kind: 'jira_worklog', project_id: 'p1', summary: 'ABC-1 0.5 h', effect: worklog }] })
    const view = await effects.review!.view('run-j')
    await effects.review!.decide('run-j', { kind: 'approve', ordinals: [1], digest: view!.digest })
    return effects
  }
  const calls: string[] = [], serverIds: string[] = []
  const pool = { callTool: async (_agent: string, spec: { id: string }, name: string) => { calls.push(name); serverIds.push(spec.id); return { is_error: false, content: [] } } } as unknown as ConnectionPool
  beforeEach(() => { calls.length = 0; serverIds.length = 0 })

  const errorCodes = (decisions: unknown) => (decisions as { db: { prepare(sql: string): { all(): Array<{ state: string; error_code: string | null }> } } }).db.prepare('SELECT state, error_code FROM action_intents').all()

  it('sin servidor de Jira en el catálogo la escritura se rechaza antes de salir a la red', async () => {
    const effects = await setup(pool)
    const { store: decisions } = await effects.ready()
    await vi.waitFor(() => expect(errorCodes(decisions)).toEqual([{ state: 'rejected_before_dispatch', error_code: 'tool_off' }]))
    expect(calls).toEqual([])
  })

  it('con dos servidores Atlassian y sin jira.server_id la intención queda rechazada por ambigüedad, sin llamadas', async () => {
    const base = { description: '', transport: 'http' as const, command: '', args: [], env: {}, cwd: '', headers: {}, secret_refs: {}, requires_host_access: false, container_image: '', allow_hosts: [], allow_ports: [], read_mounts: [], write_mounts: [], auth: 'none' as const }
    for (const slug of ['atlassian_rovo', 'atlassian_rovo_2']) {
      const server = store.insertServer({ ...base, user_id: ownerId, slug, display_name: slug, url: 'https://mcp.atlassian.com/v1/mcp' })
      for (const name of ['atlassianUserInfo', 'getAccessibleAtlassianResources', 'getJiraIssue', 'addWorklogToJiraIssue']) store.insertTool({ server_id: server.id, name, title: name, exposed_name: `${slug}_${name}`, description: '', input_schema: { type: 'object' }, definition_hash: `${slug}-${name}` })
    }
    const effects = await setup(pool)
    const { store: decisions } = await effects.ready()
    await vi.waitFor(() => expect(errorCodes(decisions)).toEqual([{ state: 'rejected_before_dispatch', error_code: 'ambiguous_server' }]))
    expect(calls).toEqual([])
  })

  it('con jira.server_id fijado, todas las llamadas de la intención salen por ese servidor y por ningún otro', async () => {
    const base = { description: '', transport: 'http' as const, command: '', args: [], env: {}, cwd: '', headers: {}, secret_refs: {}, requires_host_access: false, container_image: '', allow_hosts: [], allow_ports: [], read_mounts: [], write_mounts: [], auth: 'none' as const }
    const created = ['atlassian_rovo', 'atlassian_rovo_2'].map(slug => {
      const server = store.insertServer({ ...base, user_id: ownerId, slug, display_name: slug, url: 'https://mcp.atlassian.com/v1/mcp' })
      for (const name of ['atlassianUserInfo', 'getAccessibleAtlassianResources', 'getJiraIssue', 'addWorklogToJiraIssue']) store.insertTool({ server_id: server.id, name, title: name, exposed_name: `${slug}_${name}`, description: '', input_schema: { type: 'object' }, definition_hash: `${slug}-${name}` })
      return server
    })
    store.setSetting('jira.server_id', created[1]!.id)
    const effects = await setup(pool)
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0))
    await effects.ready()
    expect(new Set(serverIds)).toEqual(new Set([created[1]!.id]))
  })
})
