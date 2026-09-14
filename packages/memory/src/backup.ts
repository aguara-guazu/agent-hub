import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { MemoryStore } from './store.js'
import { canonical, hash } from './store.js'
import { check, parse, id } from './contracts.js'

const tables = ['entities', 'connectors', 'sources', 'versions', 'identities', 'fragments', 'fragment_projects', 'links', 'evidence', 'link_evidence',
  'embeddings', 'collection_records', 'record_evidence', 'rules', 'rule_runs', 'changes'] as const
const backupSchema = z.object({ format: z.literal('agenthub-memory-v1'), schema_version: z.number().int(), exported_at: z.string(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.json()))), originals: z.record(z.string(), z.string()) }).strict()

export async function exportMemory(store: MemoryStore) {
  return store.db.withOriginals(() => exportOriginals(store))
}
async function exportOriginals(store: MemoryStore) {
  const backup = await store.db.transaction(async sql => {
    const data: Record<string, any[]> = {}
    for (const table of tables) data[table] = await sql.query(`SELECT * FROM ${table}`)
    const originals: Record<string, string> = {}
    for (const version of data.versions ?? []) {
      check(/^[a-f0-9]{64}\.json$/.test(version.original_path), 'Ruta de original inválida')
      const original = await readFile(join(store.directory, 'originals', version.original_path), 'utf8')
      check(hash(JSON.parse(original)) === version.content_hash, 'El original no coincide con su hash')
      originals[version.original_path] = original
    }
    const schema = (await sql.query('SELECT max(version) AS version FROM schema_versions'))[0]!.version
    return { format: 'agenthub-memory-v1', schema_version: schema, exported_at: new Date().toISOString(), tables: data, originals }
  }, 'ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const backupId = randomUUID(), dir = join(store.directory, 'backups')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, `${backupId}.json`), JSON.stringify(backup), { mode: 0o600 })
  return { id: backupId, exported_at: backup.exported_at, download_url: `/api/memory/backups/${backupId}`, includes_credentials: false }
}
export async function readBackup(store: MemoryStore, backupId: string) {
  return readFile(join(store.directory, 'backups', `${parse(id, backupId)}.json`), 'utf8')
}
export async function restoreMemory(store: MemoryStore, raw: unknown) {
  return store.db.withOriginals(() => restoreOriginals(store, raw))
}
async function restoreOriginals(store: MemoryStore, raw: unknown) {
  const backup = parse(backupSchema, raw)
  check(Object.keys(backup.tables).every(table => (tables as readonly string[]).includes(table)), 'El respaldo contiene tablas desconocidas')
  for (const table of tables) check(Array.isArray(backup.tables[table]), `Falta la tabla ${table}`)
  const schemas = await store.db.query('SELECT max(version)::int AS version FROM schema_versions')
  check(backup.schema_version === schemas[0]!.version, 'El respaldo requiere la misma versión de esquema')
  for (const version of backup.tables.versions ?? []) {
    const path = String(version.original_path), original = backup.originals[path]
    check(/^[a-f0-9]{64}\.json$/.test(path) && original !== undefined, 'El respaldo tiene un original faltante o inválido')
    check(hash(JSON.parse(original)) === version.content_hash, 'El respaldo tiene un original alterado')
  }
  await store.db.transaction(async sql => {
    await sql.query(`LOCK TABLE ${tables.join(',')} IN ACCESS EXCLUSIVE MODE`)
    check(!(await sql.query('SELECT id FROM entities LIMIT 1')).length, 'La restauración requiere una memoria vacía para preservar los datos existentes', 409)
    await sql.query('SET CONSTRAINTS ALL DEFERRED')
    const columns = await sql.query('SELECT table_name,column_name,is_generated FROM information_schema.columns WHERE table_schema=\'agenthub_memory\'')
    for (const table of tables) {
      const allowed = columns.filter(c => c.table_name === table && c.is_generated === 'NEVER').map(c => c.column_name as string)
      for (const row of backup.tables[table] ?? []) {
        const keys = Object.keys(row).filter(k => k !== 'search_text')
        check(keys.every(k => allowed.includes(k)), 'El respaldo contiene columnas desconocidas')
        // Connectors need their own authorization after restore; credentials never travel in a backup.
        if (table === 'connectors') row.enabled = false
        await sql.query(`INSERT INTO ${table}(${keys.map(k => `"${k}"`).join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map(k => row[k]))
      }
    }
    await mkdir(join(store.directory, 'originals'), { recursive: true, mode: 0o700 })
    for (const version of backup.tables.versions ?? []) {
      const path = String(version.original_path)
      await writeFile(join(store.directory, 'originals', path), backup.originals[path]!, { mode: 0o600 })
    }
    await sql.query("SELECT setval(pg_get_serial_sequence('changes','id'),COALESCE((SELECT max(id) FROM changes),1),(SELECT count(*)>0 FROM changes))")
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
    const before = (await sql.query('SELECT * FROM entities WHERE id=$1 FOR UPDATE', [entityId]))[0]
    check(before, 'Entidad inexistente', 404)
    // Remove derived facts if any of their supporting fragments is being erased, rather than leaving ungrounded assertions.
    await sql.query(`DELETE FROM entities WHERE kind='fact' AND id IN(SELECT ev.entity_id FROM evidence ev JOIN fragments f ON f.id=ev.fragment_id
      JOIN versions v ON v.id=f.version_id JOIN sources s ON s.id=v.source_id WHERE s.entity_id=$1)`, [entityId])
    await sql.query(`DELETE FROM collection_records WHERE id IN(SELECT re.record_id FROM record_evidence re JOIN fragments f ON f.id=re.fragment_id
      JOIN versions v ON v.id=f.version_id JOIN sources s ON s.id=v.source_id WHERE s.entity_id=$1)`, [entityId])
    const originals = await sql.query('SELECT v.original_path FROM versions v JOIN sources s ON s.id=v.source_id WHERE s.entity_id=$1', [entityId])
    await sql.query('DELETE FROM entities WHERE id=$1', [entityId])
    await sql.query("UPDATE entities SET data=data - 'company_id' WHERE data->>'company_id'=$1", [entityId])
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
