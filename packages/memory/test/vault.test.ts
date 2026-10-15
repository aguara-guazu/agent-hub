import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { Vault } from '../src/config.js'
import { SecretResolver } from '@agenthub/gateway'
import { FileSecretBackend, parseRef } from '../../daemon/src/secrets/index.js'

it('crea, reabre y reemplaza credenciales en rutas nativas con espacios, Unicode, # y %', () => {
  const dir = mkdtempSync(join(tmpdir(), 'Agent Hub Pérez #%20 '))
  try {
    const vault = new Vault(dir)
    vault.save('google', { token: 'first' })
    expect(vault.read('google')).toEqual({ token: 'first' })
    vault.save('google', { token: 'second' })
    expect(new Vault(dir).read('google')).toEqual({ token: 'second' })
    const credential = vault.mcpCredential()
    expect(fileURLToPath(credential.reference)).toBe(join(dir, 'secrets', 'memory-mcp'))
    expect(new Vault(dir).mcpCredential()).toEqual(credential)
    expect(new SecretResolver().resolve(credential.reference)).toBe(credential.token)
    expect(new FileSecretBackend().get(parseRef(credential.reference))).toBe(credential.token)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
