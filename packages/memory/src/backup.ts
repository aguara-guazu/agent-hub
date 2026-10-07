import { mkdir, open, readFile, rename, rm, writeFile, unlink } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { MemoryStore } from './store.js'
import { canonical, hash } from './store.js'
import { check, parse, id } from './contracts.js'
import { storageConverter, vectorValues } from './database.js'

const requiredTables = ['entities', 'connectors', 'sources', 'versions', 'identities', 'fragments', 'fragment_projects', 'links', 'evidence', 'link_evidence',
  'embeddings', 'collection_records', 'record_evidence', 'rules', 'rule_runs', 'changes'] as const
// Added by schema version 3; backups taken before it restore without them.
const laterTables = ['tasks', 'task_evidence', 'task_events', 'agent_sessions', 'agent_notes'] as const
const tables = [...requiredTables, ...laterTables] as const
/** Data-model version of agenthub-memory-v1 (tables and columns of PostgreSQL schema 4); backups from 1–4 restore. */
const BACKUP_SCHEMA_VERSION = 4
const backupSchema = z.object({ format: z.literal('agenthub-memory-v1'), schema_version: z.number().int(), exported_at: z.string(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.json()))), originals: z.record(z.string(), z.string()) }).strict()

export async function exportMemory(store: MemoryStore) {
  return store.db.withOriginals(() => exportOriginals(store))
}
async function exportOriginals(store: MemoryStore) {
  const backupId = randomUUID(), dir = join(store.directory, 'backups')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${backupId}.json`), temp = `${path}.tmp`, exportedAt = new Date().toISOString()
  const file = await open(temp, 'wx', 0o600)
  try {
    // A real memory can contain gigabytes of vectors. Keep one cursor batch in memory,
    // while the same read snapshot and originals lock cover the whole export.
    await store.db.transaction(async sql => {
      await file.writeFile(`{"format":"agenthub-memory-v1","schema_version":${BACKUP_SCHEMA_VERSION},"exported_at":${JSON.stringify(exportedAt)},"tables":{`)
      for (const [index, table] of tables.entries()) {
        await file.writeFile(`${index ? ',' : ''}${JSON.stringify(table)}:[`)
        let first = true
        for await (const rows of sql.batches(`SELECT * FROM ${table}`)) {
          for (const row of rows) {
            // Vectors keep the pgvector text form so backups stay interchangeable with earlier versions.
            if (row.embedding instanceof Uint8Array) row.embedding = `[${vectorValues(row.embedding).join(',')}]`
            await file.writeFile(`${first ? '' : ','}${JSON.stringify(row)}`); first = false
          }
        }
        await file.writeFile(']')
      }
      await file.writeFile('},"originals":{')
      let first = true
      for await (const versions of sql.batches('SELECT DISTINCT original_path,content_hash FROM versions')) {
        for (const version of versions) {
          check(/^[a-f0-9]{64}\.json$/.test(version.original_path), 'Ruta de original inválida')
          const original = await readFile(join(store.directory, 'originals', version.original_path), 'utf8')
          check(hash(JSON.parse(original)) === version.content_hash, 'El original no coincide con su hash')
          await file.writeFile(`${first ? '' : ','}${JSON.stringify(version.original_path)}:${JSON.stringify(original)}`); first = false
        }
      }
      await file.writeFile('}}')
    }, 'read')
    await file.sync(); await file.close(); await rename(temp, path)
    return { id: backupId, exported_at: exportedAt, download_url: `/api/memory/backups/${backupId}`, includes_credentials: false }
  } catch (error) { await file.close().catch(() => undefined); await rm(temp, { force: true }); throw error }
}
export function streamBackup(store: MemoryStore, backupId: string) { return createReadStream(join(store.directory, 'backups', `${parse(id, backupId)}.json`)) }
export async function readBackup(store: MemoryStore, backupId: string) {
  return readFile(join(store.directory, 'backups', `${parse(id, backupId)}.json`), 'utf8')
}
export async function restoreMemory(store: MemoryStore, raw: unknown) {
  return store.db.withOriginals(() => restoreOriginals(store, raw))
}
async function restoreOriginals(store: MemoryStore, raw: unknown) {
  const backup = parse(backupSchema, raw)
  check(Object.keys(backup.tables).every(table => (tables as readonly string[]).includes(table)), 'El respaldo contiene tablas desconocidas')
  for (const table of requiredTables) check(Array.isArray(backup.tables[table]), `Falta la tabla ${table}`)
  check(backup.schema_version >= 1 && backup.schema_version <= BACKUP_SCHEMA_VERSION, 'El respaldo requiere una versión de esquema compatible')
  for (const version of backup.tables.versions ?? []) {
    const path = String(version.original_path), original = backup.originals[path]
    check(/^[a-f0-9]{64}\.json$/.test(path) && original !== undefined, 'El respaldo tiene un original faltante o inválido')
    check(hash(JSON.parse(original)) === version.content_hash, 'El respaldo tiene un original alterado')
  }
  await store.db.transaction(async sql => {
    check(!(await sql.query('SELECT id FROM entities LIMIT 1')).length, 'La restauración requiere una memoria vacía para preservar los datos existentes', 409)
    await sql.query('PRAGMA defer_foreign_keys=ON')
    for (const table of tables) {
      const columns = await sql.query<{ name: string; type: string }>(`SELECT name,type FROM pragma_table_info('${table}') WHERE name<>'rid'`)
      const rows = backup.tables[table] ?? []
      const keys = [...new Set(rows.flatMap(row => Object.keys(row)))].filter(k => k !== 'search_text')
      check(keys.every(k => columns.some(c => c.name === k)), 'El respaldo contiene columnas desconocidas')
      if (!rows.length) continue
      const converters = keys.map(k => storageConverter(columns.find(c => c.name === k)!.type))
      const insert = `INSERT INTO ${table}(${keys.map(k => `"${k}"`).join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')})`
      // Connectors need their own authorization after restore; credentials never travel in a backup.
      await sql.many(insert, rows.map(row => keys.map((k, i) => converters[i]!(table === 'connectors' && k === 'enabled' ? false : row[k]))))
    }
    await mkdir(join(store.directory, 'originals'), { recursive: true, mode: 0o700 })
    for (const version of backup.tables.versions ?? []) {
      const path = String(version.original_path)
      await writeFile(join(store.directory, 'originals', path), backup.originals[path]!, { mode: 0o600 })
    }
  })
  return { restored: true, entities: backup.tables.entities!.length, credentials_required: true }
}
export async function deleteEntity(store: MemoryStore, entityId: string) {
  return store.db.withOriginals(async () => {
    const result = await deleteEntityRows(store, entityId)
    for (const path of result.original_files) await unlink(join(store.directory, 'originals', path)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    return result
  })
}
async function deleteEntityRows(store: MemoryStore, entityId: string) {
  parse(id, entityId)
  return store.db.transaction(async sql => {
    const before = (await sql.query('SELECT * FROM entities WHERE id=$1', [entityId]))[0]
    check(before, 'Entidad inexistente', 404)
    // Remove derived facts if any of their supporting fragments is being erased, rather than leaving ungrounded assertions.
    await sql.query(`DELETE FROM entities WHERE kind='fact' AND id IN(SELECT ev.entity_id FROM evidence ev JOIN fragments f ON f.id=ev.fragment_id
      JOIN versions v ON v.id=f.version_id JOIN sources s ON s.id=v.source_id WHERE s.entity_id=$1)`, [entityId])
    await sql.query(`DELETE FROM collection_records WHERE id IN(SELECT re.record_id FROM record_evidence re JOIN fragments f ON f.id=re.fragment_id
      JOIN versions v ON v.id=f.version_id JOIN sources s ON s.id=v.source_id WHERE s.entity_id=$1)`, [entityId])
    const originals = await sql.query('SELECT v.original_path FROM versions v JOIN sources s ON s.id=v.source_id WHERE s.entity_id=$1', [entityId])
    await sql.query('DELETE FROM entities WHERE id=$1', [entityId])
    await sql.query("UPDATE entities SET data=json_remove(data,'$.company_id') WHERE data->>'company_id'=$1", [entityId])
    await sql.query('DELETE FROM changes WHERE entity_id=$1', [entityId])
    // Content-addressed originals are only removed if no remaining source version references the file.
    const removed: string[] = []
    for (const row of originals) {
      const referenced = await sql.query('SELECT id FROM versions WHERE original_path=$1 LIMIT 1', [row.original_path])
      if (!referenced.length && /^[a-f0-9]{64}\.json$/.test(row.original_path)) removed.push(row.original_path)
    }
    return { deleted: true, original_files: removed }
  })
}
export function exportFormatDescription() { return canonical({ format: 'agenthub-memory-v1', tables }) }
