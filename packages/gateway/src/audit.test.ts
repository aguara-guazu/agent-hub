import { describe, expect, it } from 'vitest'
import { collectingReporter, httpReporter } from './audit.js'
import type { ToolCallRecord } from './server.js'

function record(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    agent_id: 'a',
    server_slug: 'ops',
    tool_name: 'restart_service',
    exposed_name: 'ops_restart_service',
    decision: 'deny',
    args_digest: 'a'.repeat(64),
    duration_ms: 3,
    denial_reason: 'apagada',
    error: '',
    ...overrides,
  }
}

describe('httpReporter', () => {
  it('hace POST con Bearer y el cuerpo del ToolCallRequest, sin argumentos', async () => {
    let seenUrl = ''
    let seenInit: RequestInit | undefined
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url)
      seenInit = init
      return new Response(null, { status: 202 })
    }) as unknown as typeof fetch
    const reporter = httpReporter({ baseUrl: 'http://cp:8000/', token: 'ahd_xyz', fetchImpl: fakeFetch })
    await reporter(record())
    expect(seenUrl).toBe('http://cp:8000/sync/tool-call')
    expect((seenInit?.headers as Record<string, string>)['authorization']).toBe('Bearer ahd_xyz')
    const body = JSON.parse(String(seenInit?.body)) as Record<string, unknown>
    expect(body['decision']).toBe('deny')
    expect(body['args_digest']).toBe('a'.repeat(64))
    expect(JSON.stringify(body)).not.toContain('arguments')
  })
})

describe('collectingReporter', () => {
  it('acumula registros en el arreglo', async () => {
    const sink: ToolCallRecord[] = []
    const reporter = collectingReporter(sink)
    await reporter(record({ decision: 'allow' }))
    expect(sink).toHaveLength(1)
    expect(sink[0]?.decision).toBe('allow')
  })
})
