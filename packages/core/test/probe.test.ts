import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeServer } from '../src/catalog/probe.js'
import type { McpServerRow } from '../src/types.js'

afterEach(() => vi.unstubAllEnvs())

describe('local MCP probe', () => {
  it('resolves local credentials for the actual HTTP handshake and discovery', async () => {
    vi.stubEnv('AGENTHUB_PROBE_TEST_HEADER', 'test-value-for-local-fixture')
    const received: string[] = []
    const http = createServer(async (request, response) => {
      received.push(String(request.headers['x-fixture-key']))
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      let raw = ''
      for await (const part of request) raw += part
      const message = JSON.parse(raw)
      if (message.id === undefined) { response.writeHead(202).end(); return }
      const result = message.method === 'initialize'
        ? {protocolVersion:message.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'fixture',version:'1'}}
        : {tools:[{name:'read_fixture',inputSchema:{type:'object'}}]}
      response.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))
    }).listen(0,'127.0.0.1')
    await once(http,'listening')
    const address = http.address() as {port:number}
    try {
      const result = await probeServer({transport:'http',url:`http://127.0.0.1:${address.port}/mcp`,headers:{},secret_refs:{'X-Fixture-Key':'env://AGENTHUB_PROBE_TEST_HEADER'}} as unknown as McpServerRow)
      expect(result.ok, result.error).toBe(true)
      expect(result.tools.map(t=>t.name)).toEqual(['read_fixture'])
      expect(received.length).toBeGreaterThan(1)
      expect(received.every(value=>value==='test-value-for-local-fixture')).toBe(true)
    } finally { http.closeAllConnections(); await new Promise<void>(resolve=>http.close(()=>resolve())) }
  })
  it('returns a normal connection failure for invalid URLs and missing secrets', async () => {
    const invalid = await probeServer({transport:'http',url:'not a URL',headers:{},secret_refs:{}} as unknown as McpServerRow)
    expect(invalid.ok).toBe(false)
    const missing = await probeServer({transport:'http',url:'http://127.0.0.1/mcp',headers:{},secret_refs:{Authorization:'env://AGENTHUB_MISSING_PROBE_FIXTURE'}} as unknown as McpServerRow)
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('no esta definida')
  })
})
