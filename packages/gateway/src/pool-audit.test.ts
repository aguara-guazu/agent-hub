import { describe, expect, it, vi } from 'vitest'
import { argsDigest } from '@agenthub/shared'
import { ConnectionPool, TRANSPORT_HTTP, TRANSPORT_STDIO, UpstreamSpec, type CallResult, type PoolCallRecord, type UpstreamConnection } from './runtime.js'

const spec = new UpstreamSpec({ slug: 'jira', transport: 'http', url: 'http://fixture.invalid/mcp' })

function poolWith(call: (name: string) => Promise<CallResult>, onCall?: (record: PoolCallRecord) => void | Promise<void>, connect?: () => Promise<UpstreamConnection>) {
  const connection: UpstreamConnection = { isAlive: true, listTools: async () => [], callTool: async name => call(name), close: async () => {} }
  const runtime = { connect: connect ?? (async () => connection) }
  return new ConnectionPool({ [TRANSPORT_STDIO]: runtime, [TRANSPORT_HTTP]: runtime }, { ...(onCall ? { onCall } : {}) })
}

describe('ConnectionPool.onCall', () => {
  it('reporta la huella de los argumentos y la correlación, nunca los argumentos', async () => {
    const records: PoolCallRecord[] = []
    const pool = poolWith(async () => ({ is_error: false, content: [] }), record => { records.push(record) })
    const args = { issueIdOrKey: 'ABC-1', timeSpentSeconds: 1800, secret: 'valor-sensible' }
    await pool.callTool('agent-1', spec, 'addWorklogToJiraIssue', args, undefined, { callId: 'c1', runId: 'r1', intentId: 'i1' })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ agentId: 'agent-1', serverSlug: 'jira', toolName: 'addWorklogToJiraIssue', argsDigest: argsDigest(args), isError: false, error: '', trace: { callId: 'c1', runId: 'r1', intentId: 'i1' } })
    expect(JSON.stringify(records[0])).not.toContain('valor-sensible')
  })

  it('marca el error del upstream y de la conexión, y relanza la excepción', async () => {
    const records: PoolCallRecord[] = []
    const failing = poolWith(async () => { throw new Error('conexión caída') }, record => { records.push(record) })
    await expect(failing.callTool('a', spec, 'x', {})).rejects.toThrow()
    expect(records[0]).toMatchObject({ isError: true })
    expect(records[0]!.error).toContain('conexión caída')
    const erroring = poolWith(async () => ({ is_error: true, content: [] }), record => { records.push(record) })
    await erroring.callTool('a', spec, 'x', {})
    expect(records[1]).toMatchObject({ isError: true, error: '' })
  })

  it('reporta también cuando no logra conectar', async () => {
    const records: PoolCallRecord[] = []
    const pool = poolWith(async () => ({ is_error: false, content: [] }), record => { records.push(record) }, async () => { throw new Error('sin red') })
    await expect(pool.callTool('a', spec, 'x', {})).rejects.toThrow()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ isError: true })
  })

  it('un observador que falla no cambia el resultado de la llamada', async () => {
    const pool = poolWith(async () => ({ is_error: false, content: [{ type: 'text', text: 'ok' }] }), vi.fn(async () => { throw new Error('auditoría caída') }))
    await expect(pool.callTool('a', spec, 'x', {})).resolves.toMatchObject({ is_error: false })
  })

  it('trunca el texto del error', async () => {
    const records: PoolCallRecord[] = []
    const pool = poolWith(async () => { throw new Error('x'.repeat(2000)) }, record => { records.push(record) })
    await expect(pool.callTool('a', spec, 'x', {})).rejects.toThrow()
    expect(records[0]!.error.length).toBeLessThanOrEqual(300)
  })
})
