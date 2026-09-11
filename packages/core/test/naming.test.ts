import { describe, expect, it } from 'vitest'
import { buildExposedName, MAX_EXPOSED_LEN, slugifySegment, nameFitsEverywhere } from '../src/naming.js'
import { definitionHash, skillContentHash, toolsHash } from '../src/hashing.js'

describe('naming', () => {
  it('normaliza y construye nombres portables y acotados', () => {
    // Espeja naming.py: no hay normalización NFKD, así que un acento se colapsa a `_`
    // igual que cualquier carácter fuera de [a-z0-9]. Es lo que asegura que el
    // exposed_name coincida con el que calculaba la versión Python.
    expect(slugifySegment('ops server')).toBe('ops_server')
    expect(slugifySegment('Restart-Service')).toBe('restart_service')
    expect(buildExposedName('ops', 'Restart-Service')).toBe('ops_restart_service')
  })

  it('trunca con sufijo estable cuando no entra en el presupuesto', () => {
    const name = buildExposedName('s'.repeat(60), 't'.repeat(60))
    expect(name.length).toBeLessThanOrEqual(MAX_EXPOSED_LEN)
    expect(name).toBe(buildExposedName('s'.repeat(60), 't'.repeat(60)))
    expect(nameFitsEverywhere(name)).toBe(true)
  })

  it('desambigua contra los nombres ya tomados', () => {
    const taken = new Set<string>(['ops_restart'])
    const name = buildExposedName('ops', 'restart', taken)
    expect(name).not.toBe('ops_restart')
    expect(name.startsWith('ops_restart')).toBe(true)
  })
})

describe('hashing', () => {
  it('el hash de definicion ignora el orden de claves del esquema', () => {
    const a = definitionHash('t', 'desc', { a: 1, b: { c: 2, d: 3 } })
    const b = definitionHash('t', 'desc', { b: { d: 3, c: 2 }, a: 1 })
    expect(a).toBe(b)
  })

  it('el hash de definicion excluye el title (no es argumento)', () => {
    // title no entra: dos definiciones con el mismo name/description/schema colisionan.
    expect(definitionHash('t', 'x', {})).toBe(definitionHash('t', 'x', {}))
  })

  it('tools_hash es insensible al orden', () => {
    expect(toolsHash(['a', 'b', 'c'])).toBe(toolsHash(['c', 'a', 'b']))
  })

  it('skill_content_hash cambia con el cuerpo', () => {
    expect(skillContentHash('n', 'd', 'x')).not.toBe(skillContentHash('n', 'd', 'y'))
  })
})
