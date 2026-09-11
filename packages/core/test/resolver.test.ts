import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Database } from '../src/db/database.js'
import { runMigrations } from '../src/db/migrations.js'
import { Store } from '../src/store.js'
import { computeSnapshot, explain, resolveResource, loadContext } from '../src/policy/resolver.js'
import { buildMatrix, computePropagation } from '../src/matrix.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string
let store: Store
let db: Database

interface Fixture {
  userId: string
  agentId: string
  serverId: string
  toolId: string
}

function seedOne(store: Store): Fixture {
  const org = store.insertOrganization('craftech', 'Craftech')
  const user = store.insertUser({ organization_id: org.id, email: 'dev@craftech.io', full_name: 'Dev', password_hash: '!', org_role: 'owner' })
  const machine = store.insertMachine({ user_id: user.id, hostname: 'laptop', os: 'macos', daemon_version: '0.2.0' })
  const agent = store.insertAgent({ machine_id: machine.id, cli_kind: 'codex_cli', cli_version: '1', config_path: '' })
  const server = store.insertServer({
    user_id: user.id, slug: 'ops', display_name: 'Ops', description: '', transport: 'stdio', command: 'node',
    args: ['-m', 'x'], env: {}, cwd: '', url: '', headers: {}, secret_refs: {}, requires_host_access: false,
    container_image: '', allow_hosts: [], allow_ports: [], read_mounts: [], write_mounts: [],
  })
  store.insertTool({ server_id: server.id, name: 'restart_service', exposed_name: 'ops_restart_service', title: '', description: 'destructiva', input_schema: {}, definition_hash: 'h1' })
  const tool = store.toolsOfServer(server.id)[0]!
  return { userId: user.id, agentId: agent.id, serverId: server.id, toolId: tool.id }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agenthub-res-'))
  db = new Database(join(dir, 'agenthub.db'))
  runMigrations(db, join(dir, 'agenthub.db'))
  store = new Store(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('resolver: precedencia', () => {
  it('default ON: un server propio se expone sin ninguna regla', () => {
    const f = seedOne(store)
    const ctx = loadContext(store, f.agentId)
    const dec = resolveResource(ctx, 'mcp_server', f.serverId)
    expect(dec.exposed).toBe(true)
    expect(dec.source).toBe('default_on')
  })

  it('la regla del cliente pisa la de la persona', () => {
    const f = seedOne(store)
    store.insertRule({ user_id: f.userId, agent_instance_id: null, resource_type: 'mcp_server', resource_id: f.serverId, state: 'off', reason: 'persona' })
    store.insertRule({ user_id: f.userId, agent_instance_id: f.agentId, resource_type: 'mcp_server', resource_id: f.serverId, state: 'on', reason: 'cliente' })
    const ctx = loadContext(store, f.agentId)
    const dec = resolveResource(ctx, 'mcp_server', f.serverId)
    expect(dec.exposed).toBe(true)
    expect(dec.source).toBe('client')
  })

  it('la cuarentena siempre deniega la tool, aunque el server esté prendido', () => {
    const f = seedOne(store)
    store.updateTool(f.toolId, { quarantined: true, quarantine_reason: 'cambió' })
    const decision = explain(store, f.agentId, 'mcp_tool', f.toolId)
    expect(decision.exposed).toBe(false)
    expect(decision.source).toBe('quarantine')
  })
})

describe('snapshot', () => {
  it('es determinista: el mismo estado produce el mismo snapshot_hash', () => {
    const f = seedOne(store)
    const a = computeSnapshot(store, f.agentId)
    const b = computeSnapshot(store, f.agentId)
    expect(a.snapshot_hash).toBe(b.snapshot_hash)
    expect(a.snapshot_hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('el hash excluye generated_at', () => {
    const f = seedOne(store)
    const a = computeSnapshot(store, f.agentId, undefined, '2020-01-01T00:00:00.000Z')
    const b = computeSnapshot(store, f.agentId, undefined, '2999-12-31T23:59:59.000Z')
    expect(a.snapshot_hash).toBe(b.snapshot_hash)
    expect(a.generated_at).not.toBe(b.generated_at)
  })

  it('apagar la tool la saca del snapshot y la lista en denied', () => {
    const f = seedOne(store)
    const before = computeSnapshot(store, f.agentId)
    expect(before.servers[0]!.tools).toHaveLength(1)

    store.insertRule({ user_id: f.userId, agent_instance_id: f.agentId, resource_type: 'mcp_tool', resource_id: f.toolId, state: 'off', reason: 'peligrosa' })
    const after = computeSnapshot(store, f.agentId)
    expect(after.servers[0]!.tools).toHaveLength(0)
    expect(after.denied.some((d) => d.resource_id === f.toolId)).toBe(true)
    expect(after.snapshot_hash).not.toBe(before.snapshot_hash)
  })
})

describe('matrix', () => {
  it('propagacion: applied_stale_list cuando el gateway ya deniega pero el CLI muestra la lista vieja', () => {
    expect(
      computePropagation({
        cliKind: 'codex_cli',
        lastConnectedAt: '2024-01-01T00:00:00.000Z',
        lastListedHash: 'viejo',
        machineSnapshotHash: 'nuevo',
        snapshotHash: 'nuevo',
        exposed: false,
      }),
    ).toBe('applied_stale_list')
  })

  it('propagacion: unknown cuando nunca se conectó', () => {
    expect(
      computePropagation({ cliKind: 'kiro', lastConnectedAt: null, lastListedHash: null, machineSnapshotHash: null, snapshotHash: 'x', exposed: true }),
    ).toBe('unknown')
  })

  it('construye una fila por recurso y una celda por agente', () => {
    const f = seedOne(store)
    const matrix = buildMatrix(store, store.user(f.userId)!)
    expect(matrix.agents).toHaveLength(1)
    // server + tool = 2 filas
    expect(matrix.rows).toHaveLength(2)
    const serverRow = matrix.rows.find((r) => r.resource_type === 'mcp_server')!
    expect(serverRow.cells[f.agentId]!.exposed).toBe(true)
  })
})
