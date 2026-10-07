import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { searchMemory } from '../src/search.js'
import { globalSearch } from '../src/global-search.js'
import { MemoryError } from '../src/contracts.js'
import type { MemoryAI } from '../src/ai.js'
import { migrations } from '../src/migrations.js'
import { deleteEntity } from '../src/backup.js'

describe('motor SQLite y semántica de búsqueda', () => {
  let directory: string, db: MemoryDatabase, store: MemoryStore
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memory-engine-'))
    db = new MemoryDatabase(join(directory, 'memory.sqlite')); await db.migrate()
    store = new MemoryStore(db, directory)
  })
  afterEach(async () => { await db.close(); await rm(directory, { recursive: true, force: true }) })
  const ai = { embedQuery: async () => { throw new MemoryError(409, 'disabled') } } as unknown as MemoryAI

  it('vincula parámetros repetidos, desordenados y salteados sin modificar texto SQL', async () => {
    expect(await db.query("SELECT $3 AS third,$1 AS first,$3 AS repeated,'$2' AS literal", ['one', 'unused', 'three']))
      .toEqual([{ third: 'three', first: 'one', repeated: 'three', literal: '$2' }])
  })

  it('actualiza el índice de subcadenas al editar o borrar una fuente', async () => {
    const source = await store.ingest({ external_id: 'substring', kind: 'document', title: 'Fixture', text: 'Microservicios' })
    const search = (query: string) => searchMemory(db, ai, { query, mode: 'text' })
    expect((await search('servic')).total).toBe(1)
    await db.query("UPDATE fragments SET text='Plataforma' WHERE version_id=$1", [source.version_id])
    expect((await search('servic')).total).toBe(0)
    expect((await search('tafor')).total).toBe(1)
    await deleteEntity(store, source.entity_id)
    expect((await search('tafor')).total).toBe(0)
  })

  it.each([
    ['Microservicios', 'micro%serv'], ['Microservicios', 'micro_serv'],
    ['literal%value', 'literal\\%value'], ['literal_value', 'literal\\_value'],
    ['aliteral%', 'literal\\'], ['aliteral\\', 'literal\\'],
    ['İSTANBUL', 'i\u0307stan'], ['Élida', 'ÉLI'], ['abcdef', 'cd'],
  ])('conserva subcadenas Unicode y comodines: %s / %s', async (text, query) => {
    await store.ingest({ external_id: 'substring', kind: 'document', title: 'Fixture', text })
    // The residual LIKE predicate determines whether the mandatory trigram candidate is a match.
    const expected = (await db.query('SELECT ilike($1,$2) AS matched', [text, `%${query}%`]))[0]!.matched
    expect((await searchMemory(db, ai, { query, mode: 'text' })).total).toBe(expected)
  })

  it('agrega el índice a una base SQLite anterior sin reimportar las fuentes', async () => {
    const previous = new MemoryDatabase(join(directory, 'previous.sqlite'))
    try {
      await previous.execute(migrations[0]!)
      await previous.execute('CREATE TABLE schema_versions(version INTEGER PRIMARY KEY); INSERT INTO schema_versions VALUES(1)')
      const previousStore = new MemoryStore(previous, directory)
      const source = await previousStore.ingest({ external_id: 'existing', kind: 'document', title: 'Fixture', text: 'Microservicios' })
      await previous.migrate()
      const result = await searchMemory(previous, ai, { query: 'servic', mode: 'text' })
      expect(result.items[0]!.entity_id).toBe(source.entity_id)
      expect((await previous.query('SELECT count(*) AS n FROM versions'))[0]!.n).toBe(1)
    } finally { await previous.close() }
  })

  it.each([
    ['uno -dos tres', ['uno tres']],
    ['-dos tres', ['uno tres']],
    ['uno OR -dos', ['uno', 'uno dos', 'uno dos tres', 'uno tres']],
    ['-dos', ['uno', 'uno tres']],
    ['-dos OR -tres', ['uno', 'uno dos', 'uno tres']],
    ['uno -dos OR tres', ['uno', 'uno dos tres', 'uno tres']],
    ['"uno tres"', ['uno tres']],
    ['uno dos', ['uno dos', 'uno dos tres']],
    ['uno OR tres', ['uno', 'uno dos', 'uno dos tres', 'uno tres']],
    ['!!!', []],
  ])('conserva operadores en %s en ambas búsquedas', async (query, expected) => {
    for (const text of ['uno', 'uno tres', 'uno dos', 'uno dos tres']) await store.ingest({ external_id: text, kind: 'document', title: text, text })
    const fragments = await searchMemory(db, ai, { query, mode: 'text' })
    expect(fragments.items.map(r => r.text).sort()).toEqual([...expected].sort())
    const global = await globalSearch(db, ai, { query })
    expect(global.items.map(r => r.title).sort()).toEqual([...expected].sort())
  })

  it.each([
    ['Élida', '%ÉLI%', 1], ['uno\ndos', '%\n%', 1], ['😀', '_', 1],
    ['a%b', 'a\\%b', 1], ['a_b', 'a\\_b', 1], ['a\\b', 'a\\\\b', 1],
    ['ab', 'a%b', 1], ['axxb', 'a_b', 0], ['ab', 'a%%b', 1],
    ['', '%', 1], ['', '_', 0], ['', '', 1], ['abc', 'ab', 0],
    ['abc', 'ab%', 1], ['abc', '%bc', 1], ['abc', '%ab', 0],
    [null, '%', null], ['abc', null, null],
    ['a'.repeat(40), '%a'.repeat(15) + 'b%', 0],
  ])('LIKE sin retroceso exponencial: %j / %j', async (value, pattern, expected) => {
    expect((await db.query('SELECT ilike($1,$2) AS matched', [value, pattern]))[0]!.matched).toBe(expected)
  })

  it('serializa conexiones independientes y revierte solamente el savepoint fallido', async () => {
    const other = new MemoryDatabase(db.file), second = new MemoryStore(other, directory)
    try {
      const input = { external_id: 'same', kind: 'document', title: 'Reunión', text: 'Contenido' }
      const imported = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? store : second).ingest(input)))
      expect(imported.filter(r => !r.duplicate)).toHaveLength(1)
      await db.transaction(async sql => {
        await sql.query("INSERT INTO settings VALUES('outer','1')")
        await expect(db.transaction(async nested => {
          await nested.query("INSERT INTO settings VALUES('inner','2')")
          throw new Error('rollback')
        })).rejects.toThrow('rollback')
        expect(await other.query("SELECT key FROM settings WHERE key='outer'")).toEqual([])
      })
      expect(await other.query('SELECT key FROM settings')).toEqual([{ key: 'outer' }])
    } finally { await other.close() }
  })
})
