import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EnvBackend,
  FileSecretBackend,
  KeychainBackend,
  SecretError,
  SecretResolver,
  parseRef,
} from './secrets.js'

describe('parseRef', () => {
  it('parsea <backend>://<ruta> y normaliza el esquema', () => {
    const ref = parseRef('Keychain://agenthub/github-token', 'GITHUB_TOKEN')
    expect(ref.scheme).toBe('keychain')
    expect(ref.path).toBe('agenthub/github-token')
    expect(ref.key).toBe('GITHUB_TOKEN')
  })

  it('rechaza un valor sin esquema sin repetir el texto pegado', () => {
    // Si alguien pego el token, la referencia ES el valor: el error no lo repite.
    try {
      parseRef('ghp_supersecreto', 'GITHUB_TOKEN')
      expect.unreachable('deberia haber lanzado')
    } catch (err) {
      expect(err).toBeInstanceOf(SecretError)
      expect((err as SecretError).message).not.toContain('ghp_supersecreto')
    }
  })
})

describe('EnvBackend', () => {
  it('resuelve una variable y falla claro cuando no esta', () => {
    const backend = new EnvBackend({ HUB_TOKEN: 'valor' })
    expect(backend.get(parseRef('env://HUB_TOKEN', 'T'))).toBe('valor')
    expect(() => backend.get(parseRef('env://AUSENTE', 'T'))).toThrow(/no esta definida/)
  })
})

describe('FileSecretBackend', () => {
  it('lee un archivo 0600 y rechaza permisos abiertos', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthub-secret-'))
    const ok = join(dir, 'ok.txt')
    writeFileSync(ok, 'contenido-secreto\n')
    chmodSync(ok, 0o600)
    const backend = new FileSecretBackend()
    expect(backend.get(parseRef(`file://${ok}`, 'T'))).toBe('contenido-secreto')

    const open = join(dir, 'open.txt')
    writeFileSync(open, 'x')
    chmodSync(open, 0o644)
    expect(() => backend.get(parseRef(`file://${open}`, 'T'))).toThrow(/permisos/)
  })
})

describe('KeychainBackend', () => {
  it('usa el lookup inyectado y separa servicio/cuenta', () => {
    const backend = new KeychainBackend({
      lookup: (service, account) => (service === 'agenthub' && account === 'github-token' ? 'tok' : null),
    })
    expect(backend.get(parseRef('keychain://github-token', 'T'))).toBe('tok')
    expect(backend.get(parseRef('keychain://agenthub/github-token', 'T'))).toBe('tok')
    expect(() => backend.get(parseRef('keychain://otro/x', 'T'))).toThrow(/no tiene una entrada/)
  })
})

describe('SecretResolver', () => {
  it('cachea con TTL y sirve una rafaga con una sola consulta', () => {
    let hits = 0
    const backend = new EnvBackend({ HUB: 'v' })
    const spied = {
      scheme: 'env',
      get: (ref: ReturnType<typeof parseRef>) => {
        hits += 1
        return backend.get(ref)
      },
    }
    let now = 0
    const resolver = new SecretResolver({ env: spied }, { ttlMs: 100, clock: () => now })
    resolver.resolve('env://HUB', 'A')
    resolver.resolve('env://HUB', 'B')
    expect(hits).toBe(1)
    now = 200
    resolver.resolve('env://HUB', 'C')
    expect(hits).toBe(2)
  })

  it('resolveEnv valida el nombre de destino y arma el mapa', () => {
    const resolver = new SecretResolver({ env: new EnvBackend({ HUB: 'v' }) })
    expect(resolver.resolveEnv({ TARGET: 'env://HUB' })).toEqual({ TARGET: 'v' })
    expect(() => resolver.resolveEnv({ 'mal=nombre': 'env://HUB' })).toThrow(/no es un nombre valido/)
  })

  it('resolveHeaders rechaza un valor con salto de linea', () => {
    const resolver = new SecretResolver({ env: new EnvBackend({ HUB: 'a\nb' }) })
    expect(() => resolver.resolveHeaders({ Authorization: 'env://HUB' })).toThrow(/saltos de linea/)
  })

  it('rechaza un esquema sin backend sin filtrar la ruta', () => {
    const resolver = new SecretResolver({ env: new EnvBackend({}) })
    try {
      resolver.resolve('https://hooks.example/secreto', 'HOOK')
      expect.unreachable('deberia haber lanzado')
    } catch (err) {
      expect((err as SecretError).message).not.toContain('hooks.example')
    }
  })
})
