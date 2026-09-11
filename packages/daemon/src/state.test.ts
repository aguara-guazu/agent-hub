import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DaemonState, type Credentials } from './state.js'

let dir: string
let state: DaemonState
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agenthub-state-'))
  state = new DaemonState(dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('credenciales', () => {
  it('round trip: guardar, leer y verificar que los permisos sean 0600', () => {
    const credentials: Credentials = {
      controlPlaneUrl: 'http://hub',
      machineId: 'm1',
      userEmail: 'a@b',
      token: 'ahd_secret',
    }
    state.saveCredentials(credentials)
    expect(state.loadCredentials()).toEqual(credentials)
    const mode = statSync(state.credentialsPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('describe() nunca filtra el token', () => {
    expect(state.loadCredentials()).toBeNull()
    const desc = state.describe()
    expect(desc['credentials']).toBeNull()
  })
})

describe('snapshots y modo degradado', () => {
  it('round trip, y el hash conocido es lo que sostiene el 304', () => {
    state.saveSnapshot({ agent_instance_id: 'a1', snapshot_hash: 'h1', servers: [] })
    expect(state.loadSnapshot('a1')).toBeTruthy()
    expect(state.knownHash('a1')).toBe('h1')
    expect(state.knownHash('inexistente')).toBe('')
  })

  it('enumera los agentes de los snapshots guardados', () => {
    state.saveSnapshot({ agent_instance_id: 'a1', snapshot_hash: 'h1' })
    state.saveSnapshot({ agent_instance_id: 'a2', snapshot_hash: 'h2' })
    expect(state.snapshotAgentIds().sort()).toEqual(['a1', 'a2'])
  })

  it('dropSnapshot elimina un snapshot', () => {
    state.saveSnapshot({ agent_instance_id: 'a1', snapshot_hash: 'h1' })
    state.dropSnapshot('a1')
    expect(state.loadSnapshot('a1')).toBeNull()
  })
})

describe('agentes', () => {
  it('cachea y recupera la lista de agentes', () => {
    state.saveAgents([{ id: 'a1', cli_kind: 'kiro' }])
    const loaded = state.loadAgents()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.['id']).toBe('a1')
  })
})

describe('archivos gestionados', () => {
  it('registra y recupera entradas por agente', () => {
    state.recordManaged({
      agentId: 'a1',
      cliKind: 'kiro',
      home: '/h',
      written: ['/h/.kiro'],
      removed: [],
      drift: [],
    })
    const loaded = state.loadManaged()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.agentId).toBe('a1')
  })
})

describe('gateway tokens', () => {
  it('genera un token la primera vez y devuelve el mismo después', () => {
    const token1 = state.gatewayToken('a1')
    const token2 = state.gatewayToken('a1')
    expect(token1).toBe(token2)
    expect(token1.length).toBeGreaterThan(20)
    const mode = statSync(state.gatewayTokensPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('rotateGatewayToken genera un token nuevo', () => {
    const old = state.gatewayToken('a1')
    const fresh = state.rotateGatewayToken('a1')
    expect(fresh).not.toBe(old)
    expect(state.gatewayToken('a1')).toBe(fresh)
  })

  it('dropGatewayToken remueve la entrada', () => {
    state.gatewayToken('a1')
    state.dropGatewayToken('a1')
    const loaded = state.gatewayToken('a1') // regenera
    expect(loaded.length).toBeGreaterThan(0)
  })
})

describe('hub secret', () => {
  it('persiste entre lecturas: la sesión abierta sobrevive un reinicio', () => {
    const secret1 = state.hubSecret()
    const secret2 = state.hubSecret()
    expect(secret1).toBe(secret2)
    expect(state.hubPrepared()).toBe(true)
  })
})

describe('puertos', () => {
  it('asigna un puerto estable y no se repite entre agentes', () => {
    const port1 = state.portFor('a1', 8787)
    const port2 = state.portFor('a2', 8787)
    expect(port1).toBe(8787)
    expect(port2).not.toBe(port1)
    // Estable: la misma llamada devuelve el mismo puerto.
    expect(state.portFor('a1', 8787)).toBe(port1)
  })

  it('respeta el predicado isFree', () => {
    const port = state.portFor('a1', 8787, (p) => p !== 8787) // 8787 está ocupado
    expect(port).not.toBe(8787)
  })
})
