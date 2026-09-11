import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DiskPolicyStore, PolicyStore, SnapshotView } from './policy.js'

const AGENT = 'agent-1'

function snapshot(hash: string, opts: { toolOn?: boolean; toolDenied?: boolean } = {}): Record<string, unknown> {
  const exposed = opts.toolOn !== false && !opts.toolDenied
  const tools = exposed
    ? [
        {
          id: 't1',
          name: 'restart_service',
          exposed_name: 'ops_restart_service',
          title: 'Restart',
          description: 'destructiva',
          input_schema: { type: 'object', properties: {} },
          definition_hash: 'h',
        },
      ]
    : []
  return {
    agent_instance_id: AGENT,
    cli_kind: 'claude_code',
    snapshot_hash: hash,
    generated_at: '2026-01-01T00:00:00Z',
    user_email: 'dev@craftech.io',
    servers: [
      {
        id: 's1',
        slug: 'ops',
        display_name: 'Ops',
        transport: 'stdio',
        command: 'node',
        args: ['ops.js'],
        env: {},
        cwd: '',
        url: '',
        headers: {},
        secret_refs: {},
        tools,
      },
    ],
    skills: [],
    denied: opts.toolDenied
      ? [
          {
            resource_type: 'mcp_tool',
            resource_id: 't1',
            slug: 'ops',
            exposed: 'ops_restart_service',
            source: 'client',
            detail: 'herramienta peligrosa',
          },
        ]
      : [],
  }
}

describe('SnapshotView', () => {
  it('indexa herramientas por nombre expuesto y ordena', () => {
    const view = SnapshotView.fromSnapshot(snapshot('h1'))
    expect(view.tools.map((t) => t.exposedName)).toEqual(['ops_restart_service'])
    expect(view.tool('ops_restart_service')?.toolName).toBe('restart_service')
    expect(view.specFor('ops')?.command).toBe('node')
  })

  it('empty no expone nada (no fail-open)', () => {
    expect(SnapshotView.empty(AGENT).tools).toHaveLength(0)
  })

  it('explica una herramienta denegada con el motivo', () => {
    const view = SnapshotView.fromSnapshot(snapshot('h1', { toolDenied: true }))
    const msg = view.explain('ops_restart_service')
    expect(msg).toContain('apagada')
    expect(msg).toContain('herramienta peligrosa')
  })
})

describe('PolicyStore', () => {
  it('notifica solo cuando cambia el hash', () => {
    const store = new PolicyStore(AGENT)
    let calls = 0
    store.subscribe(() => (calls += 1))
    expect(store.apply(snapshot('h1'))).toBe(true)
    expect(store.apply(snapshot('h1'))).toBe(false)
    expect(store.apply(snapshot('h2'))).toBe(true)
    expect(calls).toBe(2)
  })
})

describe('DiskPolicyStore', () => {
  it('sigue varios reemplazos atómicos y observa un snapshot creado después del gateway', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-watch-'))
    const path = join(dir, 'snapshot.json')
    const store = new DiskPolicyStore(AGENT, path)
    store.watch()
    try {
      for (const [index, on] of [true, false, true, false].entries()) {
        const hash = `atomic-${index}`
        writeFileSync(path + '.tmp', JSON.stringify(snapshot(hash, { toolOn: on })))
        renameSync(path + '.tmp', path)
        await expect.poll(() => store.current.snapshotHash, { timeout: 2500 }).toBe(hash)
        expect(Boolean(store.current.tool('ops_restart_service'))).toBe(on)
      }
      store.stopWatching()
      writeFileSync(path, JSON.stringify(snapshot('no-event', { toolOn: true })))
      store.refresh()
      expect(store.current.tool('ops_restart_service')).toBeDefined()
    } finally { store.stopWatching(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('lee el snapshot del disco y recarga en modo degradado sin fail-open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthub-snap-'))
    const path = join(dir, 'snapshot.json')
    writeFileSync(path, JSON.stringify(snapshot('h1')))
    const store = new DiskPolicyStore(AGENT, path)
    expect(store.current.snapshotHash).toBe('h1')
    expect(store.current.tool('ops_restart_service')).toBeDefined()

    // Reescribir el archivo apagando la tool: reload la aplica.
    writeFileSync(path, JSON.stringify(snapshot('h2', { toolOn: false })))
    expect(store.reload()).toBe(true)
    expect(store.current.tool('ops_restart_service')).toBeUndefined()

    // Un archivo corrupto no borra el ultimo snapshot valido.
    writeFileSync(path, 'no-es-json')
    expect(store.reload()).toBe(false)
    expect(store.current.snapshotHash).toBe('h2')
  })

  it('ignora un snapshot de otro agente', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthub-snap-'))
    const path = join(dir, 'snapshot.json')
    writeFileSync(path, JSON.stringify({ ...snapshot('h1'), agent_instance_id: 'otro-agente' }))
    const store = new DiskPolicyStore(AGENT, path)
    expect(store.current.snapshotHash).toBe('')
  })
})
