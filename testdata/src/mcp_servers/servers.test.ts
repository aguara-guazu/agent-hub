import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createFlakyServer } from './flakyServer.js'
import { createNotesServer } from './notesServer.js'
import { createOpsServer } from './opsServer.js'
import type { TestServer } from './base.js'

async function connect(server: TestServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

describe('opsServer', () => {
  const original = process.env['OPS_AUDIT_FILE']
  afterEach(() => {
    if (original === undefined) delete process.env['OPS_AUDIT_FILE']
    else process.env['OPS_AUDIT_FILE'] = original
  })

  it('restart_service escribe en OPS_AUDIT_FILE y check_status no', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-'))
    const auditFile = join(dir, 'audit.jsonl')
    process.env['OPS_AUDIT_FILE'] = auditFile
    const client = await connect(createOpsServer())

    await client.callTool({ name: 'check_status', arguments: { service: 'api' } })
    expect(existsSync(auditFile)).toBe(false)

    await client.callTool({ name: 'restart_service', arguments: { service: 'api' } })
    const lines = readFileSync(auditFile, 'utf-8').trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ tool: 'restart_service', service: 'api', restarts: 1 })
    await client.close()
  })
})

describe('notesServer', () => {
  it('agrega una nota y devuelve su identificador', async () => {
    const client = await connect(createNotesServer())
    const added = await client.callTool({ name: 'add_note', arguments: { title: 'x' } })
    expect(String((added as { content: Array<{ text?: string }> }).content[0]?.text)).toContain('nota 1 agregada')
    await client.close()
  })
})

describe('flakyServer', () => {
  it('always_fails devuelve isError con el motivo', async () => {
    const client = await connect(createFlakyServer())
    const result = await client.callTool({ name: 'always_fails', arguments: { reason: 'boom' } })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(String((result as { content: Array<{ text?: string }> }).content[0]?.text)).toContain('boom')
    await client.close()
  })
})
