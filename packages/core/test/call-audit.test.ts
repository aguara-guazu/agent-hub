import { afterEach, beforeEach, expect, it } from 'vitest'
import { Database } from '../src/db/database.js'
import { runMigrations } from '../src/db/migrations.js'
import { Store } from '../src/store.js'
import { ensureLocalOwner } from '../src/local.js'
import { createPoolCallAudit } from '../src/effects/call-audit.js'
import type { PoolCallRecord } from '@agenthub/gateway'

let db: Database, store: Store, ownerId: string
beforeEach(() => { db = new Database(':memory:'); runMigrations(db, ':memory:'); store = new Store(db); ownerId = ensureLocalOwner(store).id })
afterEach(() => db.close())
const record = (agentId: string, trace: PoolCallRecord['trace'] = {}): PoolCallRecord =>
  ({ agentId, serverSlug: 'jira', toolName: 'getJiraIssue', argsDigest: 'abc', durationMs: 7, isError: false, error: '', trace })
const rows = () => store.toolCalls({ orgId: store.user(ownerId)!.organization_id, limit: 50 })

it('registra las llamadas de la UI sin agent_instance y con la identidad en principal', () => {
  createPoolCallAudit(store, ownerId)(record(`memory-ui:${ownerId}`))
  expect(rows()).toHaveLength(1)
  expect(rows()[0]).toMatchObject({ agent_instance_id: null, user_id: ownerId, principal: 'memory-ui', server_slug: 'jira', tool_name: 'getJiraIssue', args_digest: 'abc', duration_ms: 7, run_id: null })
})

it('registra la identidad de servicio con su agent_instance y la correlación del run', () => {
  const machine = store.insertMachine({ user_id: ownerId, hostname: 'test', os: 'test', daemon_version: 'test' })
  const agent = store.insertAgent({ machine_id: machine.id, cli_kind: 'hub_effects', cli_version: '1', config_path: '' })
  createPoolCallAudit(store, ownerId)(record(agent.id, { callId: 'c1', runId: 'r1', intentId: 'i1' }))
  expect(rows()[0]).toMatchObject({ agent_instance_id: agent.id, principal: 'hub_effects', call_id: 'c1', run_id: 'r1', intent_id: 'i1' })
})

it('marca el error de una herramienta sin texto propio', () => {
  createPoolCallAudit(store, ownerId)({ ...record('desconocido'), isError: true })
  expect(rows()[0]).toMatchObject({ agent_instance_id: null, principal: 'desconocido', error: 'tool_error' })
})

it('las filas escritas por el gateway siguen sin columnas de correlación', () => {
  store.insertToolCall({ organization_id: store.user(ownerId)!.organization_id, agent_instance_id: null, user_id: ownerId, server_slug: 's', tool_name: 't', exposed_name: 'e',
    decision: 'allow', denial_reason: '', args_digest: 'd', duration_ms: 1, error: '' })
  expect(rows()[0]).toMatchObject({ principal: null, run_id: null, intent_id: null, call_id: null })
})
