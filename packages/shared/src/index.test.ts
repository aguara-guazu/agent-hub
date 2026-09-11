import { describe, expect, it } from 'vitest'
import { argsDigest, buildExposedName, canonicalJson, digestJson } from './index.js'

describe('contratos compartidos', () => {
  it('canoniza objetos sin depender del orden de inserción', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}')
    expect(digestJson({ b: 2, a: 1 })).toBe(digestJson({ a: 1, b: 2 }))
  })

  it('construye nombres MCP portables y acotados', () => {
    expect(buildExposedName('Óps server', 'Restart-Service')).toBe('ops_server_restart_service')
    expect(buildExposedName('s'.repeat(100), 't'.repeat(100))).toHaveLength(64)
  })

  it('el digest de argumentos es determinista y no contiene los argumentos', () => {
    const digest = argsDigest({ token: 'secreto', n: 2 })
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(digest).not.toContain('secreto')
  })
})
