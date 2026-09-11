import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  EnvBackend,
  FileSecretBackend,
  KeychainBackend,
  NO_SCHEME_REASON,
  parseRef,
  SecretBackendError,
  SecretNotFoundError,
  SecretRefError,
  SecretResolver,
  defaultBackends,
  type KeychainReader,
} from './index.js'

describe('parseRef', () => {
  it('parsea backend y ruta y normaliza el esquema', () => {
    const ref = parseRef('Keychain://agenthub/github-token', 'GITHUB_TOKEN')
    expect(ref.scheme).toBe('keychain')
    expect(ref.path).toBe('agenthub/github-token')
    expect(ref.key).toBe('GITHUB_TOKEN')
    expect(ref.toString()).toBe('keychain://agenthub/github-token')
  })

  it('rechaza un valor sin esquema sin repetir el valor pegado', () => {
    expect(() => parseRef('ghp_secretovalor', 'GITHUB_TOKEN')).toThrowError(SecretRefError)
    try {
      parseRef('ghp_secretovalor', 'GITHUB_TOKEN')
    } catch (exc) {
      const err = exc as SecretRefError
      expect(err.message).toContain(NO_SCHEME_REASON)
      expect(err.message).not.toContain('ghp_secretovalor')
    }
  })

  it('rechaza una referencia sin ruta', () => {
    expect(() => parseRef('env://')).toThrowError(SecretRefError)
  })
})

describe('EnvBackend', () => {
  it('lee la variable indicada por la ruta, no la clave', () => {
    const backend = new EnvBackend({ HUB_TOKEN: 'valor-secreto' })
    expect(backend.get(parseRef('env://HUB_TOKEN', 'GITHUB_TOKEN'))).toBe('valor-secreto')
  })

  it('distingue ausente de vacía', () => {
    const backend = new EnvBackend({ VACIA: '' })
    expect(() => backend.get(parseRef('env://VACIA'))).toThrowError(SecretNotFoundError)
    expect(() => backend.get(parseRef('env://NO_EXISTE'))).toThrowError(SecretNotFoundError)
  })

  it('rechaza un nombre de variable inválido', () => {
    const backend = new EnvBackend({})
    expect(() => backend.get(parseRef('env://no valido'))).toThrowError(SecretRefError)
  })
})

describe('FileSecretBackend', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenthub-secrets-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('lee el contenido recortado de un archivo 0600', () => {
    const path = join(dir, 'token.txt')
    writeFileSync(path, 'el-token\n')
    chmodSync(path, 0o600)
    const backend = new FileSecretBackend()
    expect(backend.get(parseRef(`file://${path}`))).toBe('el-token')
  })

  it('se niega a leer un archivo con permisos más abiertos que 0600', () => {
    const path = join(dir, 'abierto.txt')
    writeFileSync(path, 'el-token')
    chmodSync(path, 0o644)
    const backend = new FileSecretBackend()
    try {
      backend.get(parseRef(`file://${path}`))
      throw new Error('debería haber fallado')
    } catch (exc) {
      expect(exc).toBeInstanceOf(SecretBackendError)
      expect((exc as Error).message).toContain('chmod 600')
      expect((exc as Error).message).not.toContain('el-token')
    }
  })

  it('exige ruta absoluta con tres barras', () => {
    const backend = new FileSecretBackend()
    expect(() => backend.get(parseRef('file://relativo/x'))).toThrowError(SecretRefError)
  })

  it('reporta el archivo inexistente como no encontrado', () => {
    const backend = new FileSecretBackend()
    expect(() => backend.get(parseRef(`file://${join(dir, 'no.txt')}`))).toThrowError(SecretNotFoundError)
  })
})

describe('KeychainBackend', () => {
  it('resuelve contra un lector inyectado y separa servicio/cuenta', () => {
    const store: Record<string, string> = { 'agenthub/github-token': 'tok', 'otro/x': 'y' }
    const reader: KeychainReader = { read: (service, account) => store[`${service}/${account}`] ?? null }
    const backend = new KeychainBackend({ reader })
    expect(backend.get(parseRef('keychain://agenthub/github-token'))).toBe('tok')
    expect(backend.get(parseRef('keychain://github-token'))).toBe('tok') // servicio por defecto
  })

  it('reporta no encontrado sin filtrar', () => {
    const reader: KeychainReader = { read: () => null }
    const backend = new KeychainBackend({ reader })
    expect(() => backend.get(parseRef('keychain://agenthub/falta'))).toThrowError(SecretNotFoundError)
  })

  it('normaliza un fallo del llavero a SecretBackendError', () => {
    const reader: KeychainReader = {
      read: () => {
        throw new Error('llavero bloqueado')
      },
    }
    const backend = new KeychainBackend({ reader })
    expect(() => backend.get(parseRef('keychain://agenthub/x'))).toThrowError(SecretBackendError)
  })
})

describe('SecretResolver', () => {
  it('cachea con TTL: una ráfaga golpea el backend una sola vez', async () => {
    let clock = 0
    let calls = 0
    const backend = {
      scheme: 'env',
      get(): string {
        calls += 1
        return 'v'
      },
    }
    const resolver = new SecretResolver({ env: backend }, { ttlSeconds: 60, clock: () => clock })
    await resolver.resolve('env://X')
    await resolver.resolve('env://X')
    expect(calls).toBe(1)
    clock += 61_000
    await resolver.resolve('env://X')
    expect(calls).toBe(2)
  })

  it('oculta la ruta cuando el esquema es desconocido (posible URL-secreto)', async () => {
    const resolver = new SecretResolver({})
    try {
      await resolver.resolve('https://hooks.example/servicios/XXXX', 'WEBHOOK')
      throw new Error('debería fallar')
    } catch (exc) {
      expect(exc).toBeInstanceOf(SecretRefError)
      expect((exc as Error).message).toContain('https://...')
      expect((exc as Error).message).not.toContain('XXXX')
    }
  })

  it('resolveEnv valida el nombre de destino', async () => {
    const resolver = new SecretResolver({ env: new EnvBackend({ A: '1' }) })
    await expect(resolver.resolveEnv({ 'mal nombre': 'env://A' })).rejects.toBeInstanceOf(SecretRefError)
    expect(await resolver.resolveEnv({ TARGET: 'env://A' })).toEqual({ TARGET: '1' })
  })

  it('resolveHeaders rechaza un valor con salto de línea sin mostrarlo', async () => {
    const resolver = new SecretResolver({ env: new EnvBackend({ A: 'con\nsalto' }) })
    try {
      await resolver.resolveHeaders({ Authorization: 'env://A' })
      throw new Error('debería fallar')
    } catch (exc) {
      expect(exc).toBeInstanceOf(SecretBackendError)
      expect((exc as Error).message).not.toContain('con')
    }
  })

  it('trae los tres backends de fábrica', () => {
    expect(Object.keys(defaultBackends()).sort()).toEqual(['env', 'file', 'keychain'])
  })
})
