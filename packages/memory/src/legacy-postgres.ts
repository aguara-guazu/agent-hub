// One-way import of a PostgreSQL memory (schema versions 1–4) into the SQLite file.
// The PostgreSQL cluster, its data directory and the `database` credential are never modified;
// the SQLite file only appears at its final path after every table count and foreign key verifies.
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { MemoryDatabase, storageConverter } from './database.js'
import type { Vault } from './config.js'
import { startManagedDatabase, stopManagedDatabase } from './runtime.js'

export const DATABASE_FILE = 'memory.sqlite'
const MIGRATING_FILE = 'memory.sqlite.migrating'
const STATE_FILE = 'migration.json'
/** Insertion order satisfies foreign keys; checks are also deferred and verified at the end. */
const TABLES = ['entities', 'connectors', 'sources', 'versions', 'identities', 'fragments', 'fragment_projects', 'links', 'evidence', 'link_evidence',
  'embeddings', 'entity_embeddings', 'collection_records', 'record_evidence', 'rules', 'rule_runs', 'jobs', 'settings', 'changes',
  'tasks', 'task_evidence', 'task_events', 'agent_sessions', 'agent_notes'] as const
const BATCH = 2000
const introducedIn = (table: string) => table === 'entity_embeddings' ? 2
  : ['tasks', 'task_evidence', 'task_events', 'agent_sessions', 'agent_notes'].includes(table) ? 3 : 1

export interface MigrationState {
  state: 'running' | 'failed' | 'completed'
  started_at: string; updated_at: string; attempts: number
  table?: string; copied: number; total: number
  tables: Record<string, number>
  error?: string; detail?: string; next_attempt_at?: string
}

export function databaseFile(directory: string): string { return join(directory, DATABASE_FILE) }
export function legacyDatabaseUrl(vault: Vault): string | null {
  return process.env.AGENTHUB_MEMORY_DATABASE_URL || vault.read<{ url: string }>('database')?.url || null
}
/** The SQLite file only reaches its final path after a verified import; an empty file (opened too early) does not count. */
function hasDatabase(directory: string): boolean {
  try { return statSync(databaseFile(directory)).size > 0 } catch { return false }
}
export function needsMigration(directory: string, vault: Vault): boolean {
  return !hasDatabase(directory) && Boolean(legacyDatabaseUrl(vault))
}
export function migrationState(directory: string): MigrationState | null {
  try { return JSON.parse(readFileSync(join(directory, STATE_FILE), 'utf8')) as MigrationState } catch { return null }
}
function saveState(directory: string, state: MigrationState): void {
  const path = join(directory, STATE_FILE), temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify({ ...state, updated_at: new Date().toISOString() }), { mode: 0o600 })
  renameSync(temp, path)
}
/** Lets the next worker iteration retry a failed migration immediately. */
export function requestMigrationRetry(directory: string): void {
  const state = migrationState(directory)
  if (state?.state === 'failed') saveState(directory, { ...state, next_attempt_at: new Date().toISOString() })
}
export function migrationDue(directory: string): boolean {
  const state = migrationState(directory)
  return state?.state !== 'failed' || !state.next_attempt_at || Date.parse(state.next_attempt_at) <= Date.now()
}

/** Last FATAL line of the managed cluster log: the actionable reason when PostgreSQL does not start. */
async function postgresFailure(directory: string): Promise<string | undefined> {
  const path = join(directory, 'postgres.log')
  if (!existsSync(path)) return undefined
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const length = Math.min(size, 16_384), buffer = Buffer.alloc(length)
    await file.read(buffer, 0, length, size - length)
    return buffer.toString('utf8').split('\n').reverse().find(line => line.includes('FATAL:'))?.replace(/^.*FATAL:\s*/, '')
  } finally { await file.close() }
}

export async function migrateLegacyMemory(directory: string, vault: Vault, signal?: AbortSignal): Promise<MigrationState> {
  const previous = migrationState(directory)
  const state: MigrationState = { state: 'running', started_at: new Date().toISOString(), updated_at: '', attempts: (previous?.attempts ?? 0) + 1, copied: 0, total: 0, tables: {} }
  saveState(directory, state)
  const url = legacyDatabaseUrl(vault)
  const temp = join(directory, MIGRATING_FILE)
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${temp}${suffix}`, { force: true })
  let target: MemoryDatabase | null = null
  let source: pg.Client | null = null
  try {
    if (!url) throw new Error('No hay una base PostgreSQL configurada para migrar')
    try { await startManagedDatabase(directory, true) } catch { /* the connection attempt below reports the reason */ }
    source = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000, options: '-c search_path=agenthub_memory,public', application_name: 'agenthub-memory-migration' })
    source.on('error', () => undefined)
    try { await source.connect() } catch (error) {
      const fatal = await postgresFailure(directory)
      throw Object.assign(new Error('No se pudo iniciar o conectar el PostgreSQL anterior'), { detail: fatal ?? (error instanceof Error ? error.message : String(error)) })
    }
    // timestamptz as ISO-8601 UTC, the format SQLite stores and compares.
    const types = { getTypeParser: (oid: number, format?: any) => oid === 1184 ? (value: string) => new Date(value).toISOString() : pg.types.getTypeParser(oid, format) }
    const query = async <T = Record<string, any>>(text: string, values: unknown[] = []) => (await source!.query({ text, values, types })).rows as T[]
    await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const present = new Set((await query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='agenthub_memory' AND table_type='BASE TABLE'")).map(r => r.table_name))
    if (!present.has('schema_versions')) throw new Error('La base PostgreSQL no contiene el esquema de memoria esperado (agenthub_memory)')
    const versions = await query<{ version: number }>('SELECT version FROM agenthub_memory.schema_versions ORDER BY version')
    const schemaVersion = versions.at(-1)?.version ?? 0
    if (schemaVersion < 1 || schemaVersion > 4 || versions.length !== schemaVersion || versions.some((row, index) => row.version !== index + 1)) {
      throw new Error('La versión del esquema PostgreSQL no es compatible o su historial está incompleto (se admiten versiones 1–4)')
    }
    const tables = TABLES.filter(table => introducedIn(table) <= schemaVersion)
    const missing = tables.filter(table => !present.has(table))
    if (missing.length) throw new Error(`El esquema PostgreSQL está incompleto; faltan tablas: ${missing.join(', ')}`)
    const unexpected = [...present].filter(table => table !== 'schema_versions' && !tables.some(expected => expected === table))
    if (unexpected.length) throw new Error(`El esquema PostgreSQL contiene tablas incompatibles con su versión: ${unexpected.join(', ')}`)
    for (const table of tables) state.tables[table] = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n
    state.total = Object.values(state.tables).reduce((a, b) => a + b, 0)
    saveState(directory, state)

    target = new MemoryDatabase(temp, { readers: 1 })
    await target.migrate()
    await target.execute('PRAGMA foreign_keys=OFF')
    const sourceColumns = await query<{ table_name: string; column_name: string }>(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='agenthub_memory' AND is_generated='NEVER'")
    for (const table of tables) {
      signal?.throwIfAborted()
      const expected = (await target.query<{ name: string; type: string }>(`SELECT name,type FROM pragma_table_info('${table}') WHERE name<>'rid'`))
        .filter(column => !(table === 'tasks' && column.name === 'external_site' && schemaVersion < 4))
      const actual = sourceColumns.filter(column => column.table_name === table).map(column => column.column_name)
      const missingColumns = expected.filter(column => !actual.includes(column.name))
      const extraColumns = actual.filter(name => !expected.some(column => column.name === name))
      if (missingColumns.length || extraColumns.length) throw new Error(`Columnas incompatibles en la tabla PostgreSQL ${table}; faltan: ${missingColumns.map(c => c.name).join(', ') || 'ninguna'}; desconocidas: ${extraColumns.join(', ') || 'ninguna'}`)
      const targetColumns = expected
      const names = targetColumns.map(c => c.name), converters = targetColumns.map(c => storageConverter(c.type))
      const insert = `INSERT INTO ${table}(${names.map(n => `"${n}"`).join(',')}) VALUES(${names.map((_, i) => `$${i + 1}`).join(',')})`
      const select = `SELECT ${names.map(n => table.endsWith('embeddings') && n === 'embedding' ? 'embedding::text AS embedding' : `"${n}"`).join(',')} FROM ${table}`
      state.table = table
      await query(`DECLARE migration_rows NO SCROLL CURSOR FOR ${select}`)
      for (;;) {
        signal?.throwIfAborted()
        const rows = await query(`FETCH ${BATCH} FROM migration_rows`)
        if (!rows.length) break
        const values = rows.map(row => names.map((name, i) => converters[i]!(row[name])))
        await target.transaction(sql => sql.many(insert, values))
        state.copied += rows.length
        saveState(directory, state)
      }
      await query('CLOSE migration_rows')
    }
    await query('COMMIT')
    // Leases belonged to the PostgreSQL-era worker; the job runs again under the new one.
    await target.query("UPDATE jobs SET state='queued',lease_until=NULL,lease_owner=NULL,updated_at=now() WHERE state='running'")
    await target.execute('PRAGMA foreign_keys=ON')
    const violations = await target.query('SELECT * FROM pragma_foreign_key_check LIMIT 5')
    if (violations.length) throw Object.assign(new Error('La copia tiene referencias inconsistentes'), { detail: JSON.stringify(violations) })
    for (const table of tables) {
      const copied = (await target.query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))[0]!.n
      if (copied !== state.tables[table]) throw Object.assign(new Error('La copia no coincide con el origen'), { detail: `${table}: ${copied} de ${state.tables[table]} filas` })
    }
    const check = (await target.query<{ quick_check: string }>('PRAGMA quick_check'))[0]?.quick_check
    if (check !== 'ok') throw Object.assign(new Error('La verificación de integridad falló'), { detail: check })
    await target.query("INSERT INTO settings(key,value) VALUES('legacy_postgres',$1)", [JSON.stringify({ migrated_at: new Date().toISOString(), schema_version: schemaVersion, tables: state.tables })])
    await target.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    await target.close(); target = null
    await source.end().catch(() => undefined); source = null
    for (const suffix of ['-wal', '-shm']) rmSync(`${temp}${suffix}`, { force: true })
    if (hasDatabase(directory)) throw new Error('Ya existe una memoria SQLite; la migración no la reemplaza')
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${databaseFile(directory)}${suffix}`, { force: true })
    renameSync(temp, databaseFile(directory))
    await stopManagedDatabase(directory).catch(() => undefined)
    const completed: MigrationState = { ...state, state: 'completed' }
    delete completed.table
    saveState(directory, completed)
    return completed
  } catch (error) {
    const failed: MigrationState = { ...state, state: 'failed', error: error instanceof Error ? error.message : String(error),
      next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString() }
    const detail = (error as { detail?: string }).detail
    if (detail) failed.detail = detail
    saveState(directory, failed)
    return failed
  } finally {
    await target?.close().catch(() => undefined)
    if (source) await source.query('ROLLBACK').catch(() => undefined).finally(() => source!.end().catch(() => undefined))
    if (!hasDatabase(directory)) for (const suffix of ['', '-wal', '-shm']) rmSync(`${temp}${suffix}`, { force: true })
  }
}
