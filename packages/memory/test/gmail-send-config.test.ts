import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryOperations } from '../src/operations.js'
import { MemoryAI } from '../src/ai.js'
import { Vault, defaultAI } from '../src/config.js'
import { GMAIL_SCOPE, GMAIL_SEND_SCOPE, type GoogleAuth } from '../src/google-auth.js'
import { ensureGoogleSource } from '../src/google-setup.js'

describe('configuración de gmail.send en la fuente Google', () => {
  let db: MemoryDatabase, store: MemoryStore, directory: string, ops: MemoryOperations
  const granted = new Set<string>()
  const google = { granted: (_id: string, scope: string) => granted.has(scope), redirectUrl: 'http://127.0.0.1/cb' } as unknown as GoogleAuth
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memory-gmail-send-'))
    db = new MemoryDatabase(join(directory, 'memory.sqlite')); await db.migrate()
    store = new MemoryStore(db, directory)
    ops = new MemoryOperations(store, new MemoryAI(async () => defaultAI, new Vault(directory)), google, new Vault(directory))
  })
  afterAll(async () => { await db?.close(); if (directory) await rm(directory, { recursive: true, force: true }) })

  it('acepta gmail_send_enabled y lo rechaza si la lectura de Gmail está apagada', async () => {
    const saved = await ops.call('save_connector', { provider: 'google', name: 'G', enabled: false, config: { gmail_send_enabled: true } })
    expect(saved.config).toMatchObject({ gmail_send_enabled: true })
    await expect(ops.call('save_connector', { provider: 'google', name: 'G2', enabled: false, config: { gmail_enabled: false, gmail_send_enabled: true } })).rejects.toThrow(/lectura de Gmail/)
    await expect(ops.call('save_connector', { provider: 'google', name: 'G3', enabled: false, config: { gmail_send_enabled: 'sí' } })).rejects.toThrow()
  })

  it('el listado informa si el scope de envío está concedido solo cuando el envío está habilitado', async () => {
    const withSend = (await ops.call('list_connectors', {})).find((row: any) => row.name === 'G')
    expect(withSend).toMatchObject({ gmail_authorized: false, gmail_send_authorized: false })
    granted.add(GMAIL_SCOPE); granted.add(GMAIL_SEND_SCOPE)
    expect((await ops.call('list_connectors', {})).find((row: any) => row.name === 'G')).toMatchObject({ gmail_authorized: true, gmail_send_authorized: true })
    await ops.call('save_connector', { id: withSend.id, provider: 'google', name: 'G', enabled: false, config: {} })
    expect((await ops.call('list_connectors', {})).find((row: any) => row.name === 'G')).not.toHaveProperty('gmail_send_authorized')
  })

  it('una fuente existente conserva su configuración y una nueva nace con el envío habilitado', async () => {
    const existing = await ensureGoogleSource(store)
    expect(existing.config).not.toHaveProperty('gmail_send_enabled')
    await db.execute('DELETE FROM connectors')
    const created = await ensureGoogleSource(store)
    expect(created.config).toMatchObject({ gmail_send_enabled: true })
    expect((await ensureGoogleSource(store)).id).toBe(created.id)
  })
})
