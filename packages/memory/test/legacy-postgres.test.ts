import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { migrations as postgresMigrations } from './fixtures/postgres-schema.js'
import { MemoryDatabase, vectorValues } from '../src/database.js'
import { Vault } from '../src/config.js'
import { databaseFile, migrateLegacyMemory, needsMigration } from '../src/legacy-postgres.js'

const url = process.env.AGENTHUB_MEMORY_TEST_URL
// A disposable database per test, never the database named in the connection URL.
// CI provides PostgreSQL+pgvector for this suite on both supported Node versions.
describe.skipIf(!url)('migración de PostgreSQL real a SQLite', () => {
  let admin: pg.Client, source: pg.Client, directory: string, name: string, vault: Vault
  beforeAll(async () => { admin = new pg.Client({ connectionString: url! }); await admin.connect() })
  beforeEach(async () => {
    name = `migration_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE ${name}`)
    const connection = new URL(url!); connection.pathname = `/${name}`
    source = new pg.Client({ connectionString: connection.href }); await source.connect()
    directory = await mkdtemp(join(tmpdir(), 'memory-migration-')); vault = new Vault(directory)
    vault.save('database', { url: connection.href })
  })
  afterEach(async () => {
    await source.end(); await admin.query(`DROP DATABASE ${name}`)
    await rm(directory, { recursive: true, force: true })
  })
  afterAll(async () => { await admin?.end() })

  async function schema(version = 4) {
    await source.query('CREATE EXTENSION vector; CREATE SCHEMA agenthub_memory; SET search_path=agenthub_memory,public; CREATE TABLE schema_versions(version integer PRIMARY KEY)')
    for (let i = 0; i < version; i++) {
      await source.query(postgresMigrations[i]!); await source.query('INSERT INTO schema_versions VALUES($1)', [i + 1])
    }
  }
  async function expectFailure(pattern: RegExp) {
    const result = await migrateLegacyMemory(directory, vault)
    expect(result.state).toBe('failed'); expect(result.error).toMatch(pattern)
    expect(existsSync(databaseFile(directory))).toBe(false)
    expect(existsSync(databaseFile(directory) + '.migrating')).toBe(false)
    expect(needsMigration(directory, vault)).toBe(true)
  }

  it('rechaza una base sin esquema en lugar de activar una copia de cero filas', async () => {
    await expectFailure(/esquema de memoria/)
  })
  it('rechaza tablas faltantes', async () => {
    await schema(); await source.query('DROP TABLE agent_notes')
    await expectFailure(/faltan tablas: agent_notes/)
  })
  it('rechaza columnas faltantes aunque tengan un valor predeterminado en SQLite', async () => {
    await schema(); await source.query('ALTER TABLE connectors DROP COLUMN cursor')
    await expectFailure(/Columnas incompatibles.*connectors/)
  })
  it('rechaza tablas ajenas a la versión declarada en lugar de omitir sus datos', async () => {
    await schema(); await source.query('DELETE FROM schema_versions WHERE version>1')
    await expectFailure(/tablas incompatibles/)
  })
  it('rechaza versiones desconocidas y un historial con huecos', async () => {
    await schema(); await source.query('INSERT INTO schema_versions VALUES(5)')
    await expectFailure(/versión del esquema/)
    await source.query('DELETE FROM schema_versions WHERE version IN (2,5)')
    await expectFailure(/historial está incompleto/)
  })
  it.each([1, 2, 3, 4])('importa el esquema %i preservando datos, vectores, relaciones y originales', async version => {
    await schema(version)
    const entity = randomUUID(), src = randomUUID(), ver = randomUUID(), fragment = randomUUID(), connector = randomUUID()
    await source.query('BEGIN')
    await source.query("INSERT INTO entities(id,kind,title,data,created_at) VALUES($1,'document','Reunión',$2,'2026-09-12T10:00:00-03:00')", [entity, { flag: false, nullable: null, text: 'Información' }])
    await source.query("INSERT INTO connectors(id,provider,name,enabled,project_ids) VALUES($1,'google','Google',true,'{}')", [connector])
    await source.query("INSERT INTO sources(id,entity_id,provider,account,external_id,connector_id) VALUES($1,$2,'google','account','fixture',$3)", [src, entity, connector])
    await source.query("INSERT INTO versions(id,source_id,content_hash,original_path) VALUES($1,$2,'fixture-hash','retained.json')", [ver, src])
    await source.query('UPDATE sources SET current_version_id=$2 WHERE id=$1', [src, ver])
    await source.query("INSERT INTO fragments(id,version_id,ordinal,text,start_time,offset_ms) VALUES($1,$2,0,'Información','2026-09-12T10:00:00-03:00',123)", [fragment, ver])
    await source.query("INSERT INTO embeddings(fragment_id,model,dimension,embedding) VALUES($1,'fixture',3,'[3,4,0]')", [fragment])
    await source.query("INSERT INTO changes(entity_id,action,actor) VALUES($1,'imported','fixture')", [entity])
    await source.query("INSERT INTO jobs(id,kind,dedupe_key,state,lease_owner,lease_until) VALUES($1,'process','fixture','running','old-worker',now()+interval '1 minute')", [randomUUID()])
    await source.query('COMMIT')
    await writeFile(join(directory, 'retained-original'), 'untouched')
    const result = await migrateLegacyMemory(directory, vault)
    expect(result.state, result.error).toBe('completed'); expect(needsMigration(directory, vault)).toBe(false)
    const db = new MemoryDatabase(databaseFile(directory))
    try {
      expect((await db.query('SELECT title,data,created_at FROM entities'))[0]).toEqual({ title: 'Reunión', data: { flag: false, nullable: null, text: 'Información' }, created_at: '2026-09-12T13:00:00.000Z' })
      expect((await db.query('SELECT enabled,project_ids FROM connectors'))[0]).toEqual({ enabled: true, project_ids: [] })
      const [embedding] = await db.query('SELECT embedding FROM embeddings')
      expect(vectorValues(embedding!.embedding)[0]).toBeCloseTo(0.6)
      expect(vectorValues(embedding!.embedding)[1]).toBeCloseTo(0.8)
      expect(await db.query('SELECT * FROM pragma_foreign_key_check')).toEqual([])
      expect((await db.query('PRAGMA integrity_check'))[0]!.integrity_check).toBe('ok')
      expect((await db.query('SELECT state,lease_owner FROM jobs'))[0]).toEqual({ state: 'queued', lease_owner: null })
      expect((await db.query("INSERT INTO changes(action,actor) VALUES('next','fixture') RETURNING id"))[0]!.id).toBe(2)
      expect((await source.query('SELECT state FROM jobs')).rows[0].state).toBe('running')
      expect(existsSync(join(directory, 'retained-original'))).toBe(true)
    } finally { await db.close() }
  })
  it('reanuda desde cero después de una interrupción sin activar datos parciales', async () => {
    await schema()
    const controller = new AbortController(); controller.abort()
    const failed = await migrateLegacyMemory(directory, vault, controller.signal)
    expect(failed.state).toBe('failed'); expect(existsSync(databaseFile(directory))).toBe(false)
    const retried = await migrateLegacyMemory(directory, vault)
    expect(retried.state).toBe('completed'); expect(retried.attempts).toBe(2)
  })
})
