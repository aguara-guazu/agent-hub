import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PolicyStore } from './policy.js'
import { ConnectionPool, HostProcessRuntime, RemoteHttpRuntime, TRANSPORT_HTTP, TRANSPORT_STDIO } from './runtime.js'
import { GatewayServer, type ToolCallRecord } from './server.js'
import { collectingReporter } from './audit.js'

const AGENT = 'agent-ops'
const here = dirname(fileURLToPath(import.meta.url))
// dist compilado del paquete testdata (se construye antes de correr las pruebas).
const OPS_ENTRY = resolve(here, '../../../testdata/dist/mcp_servers/opsServer.js')

interface SnapOptions {
  hash: string
  restartOn: boolean
  restartDenied?: boolean
  auditFile?: string
}

function snapshot(opts: SnapOptions): Record<string, unknown> {
  const tools: Array<Record<string, unknown>> = [
    {
      id: 'check',
      name: 'check_status',
      exposed_name: 'ops_check_status',
      title: 'Estado',
      description: 'inofensiva',
      input_schema: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] },
      definition_hash: 'hc',
    },
  ]
  if (opts.restartOn) {
    tools.push({
      id: 'restart',
      name: 'restart_service',
      exposed_name: 'ops_restart_service',
      title: 'Reinicio',
      description: 'destructiva',
      input_schema: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] },
      definition_hash: 'hr',
    })
  }
  const denied: Array<Record<string, unknown>> = []
  if (opts.restartDenied) {
    denied.push({
      resource_type: 'mcp_tool',
      resource_id: 'restart',
      slug: 'ops',
      exposed: 'ops_restart_service',
      source: 'client',
      detail: 'herramienta destructiva apagada por el panel',
    })
  }
  return {
    agent_instance_id: AGENT,
    cli_kind: 'claude_code',
    snapshot_hash: opts.hash,
    generated_at: '2026-01-01T00:00:00Z',
    user_email: 'dev@craftech.io',
    servers: [
      {
        id: 'ops',
        slug: 'ops',
        display_name: 'Ops',
        transport: 'stdio',
        command: process.execPath,
        args: [OPS_ENTRY],
        env: opts.auditFile ? { OPS_AUDIT_FILE: opts.auditFile } : {},
        cwd: '',
        url: '',
        headers: {},
        secret_refs: {},
        tools,
      },
    ],
    skills: [],
    denied,
  }
}

describe('GatewayServer — invariante del producto', () => {
  let pool: ConnectionPool
  let client: Client
  let gateway: GatewayServer

  beforeEach(() => {
    expect(existsSync(OPS_ENTRY), `falta el dist del ops server en ${OPS_ENTRY}; corre el build de testdata`).toBe(true)
  })

  afterEach(async () => {
    await client?.close()
    await gateway?.close()
    await pool?.close()
  })

  async function wire(store: PolicyStore, records: ToolCallRecord[]): Promise<Client> {
    pool = new ConnectionPool({ [TRANSPORT_STDIO]: new HostProcessRuntime(), [TRANSPORT_HTTP]: new RemoteHttpRuntime() })
    gateway = new GatewayServer(AGENT, store, pool, { reporter: collectingReporter(records) })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'cli-de-prueba', version: '0.0.0' })
    await Promise.all([gateway.connect(serverTransport), client.connect(clientTransport)])
    return client
  }

  it(
    'apaga restart_service en la MISMA sesion: la llamada siguiente se deniega y el upstream no crece',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agenthub-ops-'))
      const auditFile = join(dir, 'ops-audit.jsonl')
      const store = new PolicyStore(AGENT)
      store.apply(snapshot({ hash: 'on', restartOn: true, auditFile }))
      const records: ToolCallRecord[] = []
      const c = await wire(store, records)

      // 1) Con la tool prendida, la llamada llega al upstream y el archivo crece.
      const allowed = await c.callTool({ name: 'ops_restart_service', arguments: { service: 'api' } })
      expect((allowed as { isError?: boolean }).isError ?? false).toBe(false)
      expect(existsSync(auditFile)).toBe(true)
      const linesAfterAllow = readFileSync(auditFile, 'utf-8').trim().split('\n').filter(Boolean)
      expect(linesAfterAllow).toHaveLength(1)

      // 2) El panel apaga la tool EN LA MISMA sesion abierta.
      store.apply(snapshot({ hash: 'off', restartOn: false, restartDenied: true, auditFile }))

      // 3) La llamada siguiente se DENIEGA (isError) con un motivo legible...
      const denied = await c.callTool({ name: 'ops_restart_service', arguments: { service: 'api' } })
      expect((denied as { isError?: boolean }).isError).toBe(true)
      const text = ((denied as { content: Array<{ text?: string }> }).content[0]?.text ?? '')
      expect(text).toContain('apagada')

      // 4) ...y el archivo de auditoria del upstream NO crecio: la llamada nunca llego.
      const linesAfterDeny = readFileSync(auditFile, 'utf-8').trim().split('\n').filter(Boolean)
      expect(linesAfterDeny).toHaveLength(1)

      // 5) La auditoria del gateway registro allow y luego deny, con digest y sin argumentos.
      expect(records.map((r) => r.decision)).toEqual(['allow', 'deny'])
      expect(records[1]?.args_digest).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.stringify(records)).not.toContain('"service":"api"')
    },
    30_000,
  )

  it(
    'check_status sigue funcionando cuando restart_service esta apagada',
    async () => {
      const store = new PolicyStore(AGENT)
      store.apply(snapshot({ hash: 'off', restartOn: false, restartDenied: true }))
      const records: ToolCallRecord[] = []
      const c = await wire(store, records)

      const tools = await c.listTools()
      expect(tools.tools.map((t) => t.name)).toEqual(['ops_check_status'])

      const status = await c.callTool({ name: 'ops_check_status', arguments: { service: 'api' } })
      expect((status as { isError?: boolean }).isError ?? false).toBe(false)

      // Una tool que no esta expuesta se deniega aunque el CLI la pida.
      const denied = await c.callTool({ name: 'ops_restart_service', arguments: { service: 'api' } })
      expect((denied as { isError?: boolean }).isError).toBe(true)
    },
    30_000,
  )
})
