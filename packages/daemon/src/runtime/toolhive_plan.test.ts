import type { SnapshotServer } from '@agenthub/shared'
import { describe, expect, it } from 'vitest'

import { fingerprint, specFromSnapshot, type UpstreamSpec } from './spec.js'
import {
  buildPermissionProfile,
  buildWorkloadRequest,
  containerOptionsOf,
  deriveContainerTarget,
  FINGERPRINT_ENV_VAR,
  isolatable,
  scopeSuffix,
  workloadName,
} from './toolhive_plan.js'

function server(overrides: Partial<SnapshotServer> = {}): SnapshotServer {
  return {
    id: 's1',
    slug: 'ops',
    display_name: 'Ops',
    transport: 'stdio',
    command: '',
    args: [],
    env: {},
    cwd: '',
    url: '',
    headers: {},
    secret_refs: {},
    tools: [],
    ...overrides,
  }
}

describe('deriveContainerTarget', () => {
  it('el container_image del catálogo gana siempre', () => {
    const spec = specFromSnapshot(server({ container_image: 'registro/imagen:1', command: 'node', args: ['-m', 'x'] }))
    expect(deriveContainerTarget(spec)).toEqual(['registro/imagen:1', ['-m', 'x']])
  })

  it('uvx/npx se traducen a esquema de ToolHive con el primer paquete', () => {
    const uvx = specFromSnapshot(server({ command: 'uvx', args: ['mcp-server-git', '--flag'] }))
    expect(deriveContainerTarget(uvx)).toEqual(['uvx://mcp-server-git', ['--flag']])
    const npx = specFromSnapshot(server({ command: 'npx', args: ['-y', 'pkg'] }))
    expect(deriveContainerTarget(npx)).toEqual(['npx://pkg', []])
  })

  it('un comando local sin imagen no es containerizable', () => {
    const spec = specFromSnapshot(server({ command: 'node', args: ['-m', 'ops'] }))
    expect(deriveContainerTarget(spec)).toEqual(['', []])
  })

  it('una referencia OCI se usa tal cual', () => {
    const spec = specFromSnapshot(server({ command: 'ghcr.io/org/img:tag' }))
    expect(deriveContainerTarget(spec)).toEqual(['ghcr.io/org/img:tag', []])
  })
})

describe('containerOptionsOf / isolatable', () => {
  it('no es aislable sin imagen o si pide el host', () => {
    expect(isolatable(containerOptionsOf(specFromSnapshot(server({ command: 'node' }))))).toBe(false)
    const hostSpec = specFromSnapshot(server({ command: 'uvx', args: ['git'], requires_host_access: true }))
    expect(isolatable(containerOptionsOf(hostSpec))).toBe(false)
  })

  it('es aislable con una imagen derivable y sin host', () => {
    const spec = specFromSnapshot(server({ command: 'uvx', args: ['mcp-git'] }))
    expect(isolatable(containerOptionsOf(spec))).toBe(true)
  })
})

describe('permission profile: el más cerrado por defecto', () => {
  it('sin allow_hosts/ports, sin egreso; con ellos, se abre solo eso', () => {
    const closed = buildPermissionProfile(containerOptionsOf(specFromSnapshot(server({ command: 'uvx', args: ['g'] }))))
    expect(closed['privileged']).toBe(false)
    expect((closed['network'] as { outbound: Record<string, unknown> }).outbound['insecure_allow_all']).toBe(false)

    const open = buildPermissionProfile(
      containerOptionsOf(specFromSnapshot(server({ command: 'uvx', args: ['g'], allow_hosts: ['api.x'], allow_ports: [443] }))),
    )
    const outbound = (open['network'] as { outbound: Record<string, unknown> }).outbound
    expect(outbound['allow_host']).toEqual(['api.x'])
    expect(outbound['allow_port']).toEqual([443])
  })
})

describe('workloadName / scopeSuffix', () => {
  it('es determinista y separa por alcance', () => {
    expect(workloadName('ops')).toBe(workloadName('ops'))
    expect(workloadName('ops', 'a1')).not.toBe(workloadName('ops', 'a2'))
    expect(workloadName('ops', 'a1')).toContain(scopeSuffix('a1'))
  })

  it('agrega un hash cuando el slug tiene caracteres que hay que limpiar', () => {
    expect(workloadName('Ops Server!')).toContain('h')
  })
})

describe('buildWorkloadRequest / fingerprint', () => {
  it('incluye la huella en el entorno del contenedor', () => {
    const spec = specFromSnapshot(server({ command: 'uvx', args: ['g'], env: { A: '1' } }))
    const req = buildWorkloadRequest(spec, containerOptionsOf(spec), { name: 'w' })
    const env = req['env_vars'] as Record<string, string>
    expect(env[FINGERPRINT_ENV_VAR]).toMatch(/^[a-f0-9]{64}$/)
    expect(env['A']).toBe('1')
  })
})

describe('spec fingerprint', () => {
  it('cambia si rota un secreto (valor de env) y es estable si no', () => {
    const base: UpstreamSpec = specFromSnapshot(server({ command: 'x', env: { TOKEN: 'a' } }))
    const rotated: UpstreamSpec = specFromSnapshot(server({ command: 'x', env: { TOKEN: 'b' } }))
    expect(fingerprint(base)).toBe(fingerprint(specFromSnapshot(server({ command: 'x', env: { TOKEN: 'a' } }))))
    expect(fingerprint(base)).not.toBe(fingerprint(rotated))
  })
})
