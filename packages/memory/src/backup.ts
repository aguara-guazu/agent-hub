import { mkdir, open, readFile, rm, writeFile, unlink } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { renameRetry } from '@agenthub/gateway/platform'
import { z } from 'zod'
import type { MemoryStore } from './store.js'
import { canonical, hash } from './store.js'
import { check, parse, id } from './contracts.js'
import { storageConverter, vectorValues } from './database.js'

const requiredTables = ['entities', 'connectors', 'sources', 'versions', 'identities', 'fragments', 'fragment_projects', 'links', 'evidence', 'link_evidence',
  'embeddings', 'collection_records', 'record_evidence', 'rules', 'rule_runs', 'changes'] as const
// Added by schema version 3; backups taken before it restore without them.
const laterTables = ['tasks', 'task_evidence', 'task_events', 'agent_sessions', 'agent_notes', 'chat_channels', 'chat_sessions', 'chat_threads', 'chat_messages', 'chat_deliveries', 'chat_read_receipts',
  'chat_team_plans', 'chat_team_members', 'chat_team_events', 'chat_work_state', 'chat_work_events', 'chat_watchdog_observations', 'chat_watchdog_events', 'chat_turn_state', 'chat_turn_alerts', 'chat_turns', 'chat_status_notices', 'usage_quota_bindings', 'usage_quota_pools', 'usage_quota_memberships', 'usage_quota_transitions', 'usage_quota_notices',
  'schedules', 'schedule_constraints', 'schedule_runs', 'schedule_run_attempts', 'schedule_run_phases', 'schedule_deliveries', 'schedule_artifacts', 'schedule_item_states', 'schedule_events', 'process_incidents',
  'decision_exclusions', 'liveness_incidents', 'progress_checkpoints', 'project_automation', 'project_delegations', 'project_repositories', 'push_candidates', 'project_status_snapshots', 'hour_estimates'] as const
const tables = [...requiredTables, ...laterTables] as const
/** Data-model version of agenthub-memory-v1; backups from 1–22 restore. */
const BACKUP_SCHEMA_VERSION = 23
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
            // Session routing keys and process bindings are local credentials, not portable history.
            if (table === 'chat_sessions') Object.assign(row, { key_hash: `restored:${randomUUID()}`, native_id: null, gateway_session_id:null, process_id: null, process_started: null, lease_until: null, state: 'offline', closed_at: exportedAt, capability: 'next_turn', orca_terminal: null, team_seen:false, bootstrap_sent_at:null, bootstrap_attempts:0 })
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
    await file.sync(); await file.close(); await renameRetry(temp, path)
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
      const rows = (backup.tables[table] ?? []).map(row => {
        const value = table === 'chat_channels' && backup.schema_version < 7 ? {...row,scope_key:`git:${row.path}`,orca_workspace_id:null} : row
        // Restored sessions cannot authenticate as the former virtual leader. Preserve history and release the folder for explicit recreation.
        if (table === 'usage_quota_notices') return {...value,read_at:backup.exported_at,notified_at:backup.exported_at}
        if (table === 'usage_quota_pools') return {...value,active:false}
        if (table === 'usage_quota_bindings') return {...value,active:false,binding_version:Number(value.binding_version)+1}
        if (table === 'chat_channels' && value.kind === 'virtual' && !value.closed_at) return {...value,closed_at:backup.exported_at,virtual_path:null}
        if (table === 'chat_team_plans' && !['completed','cancelled'].includes(String(value.state))) return {...value,state:'paused'}
        if (table === 'chat_team_members') return {...value,runtime:null,invitation_hash:null,invitation_expires_at:null,
          ...(['prepared','workspace_intent','workspace_created','launch_intent','accepted','unknown'].includes(String(value.state)) ? {state:'paused'} : {})}
        return value
      })
      const keys = [...new Set(rows.flatMap(row => Object.keys(row)))].filter(k => k !== 'search_text')
      check(keys.every(k => columns.some(c => c.name === k)), 'El respaldo contiene columnas desconocidas')
      if (!rows.length) continue
      const converters = keys.map(k => storageConverter(columns.find(c => c.name === k)!.type))
      const insert = `INSERT INTO ${table}(${keys.map(k => `"${k}"`).join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')})`
      // Connectors need their own authorization after restore; credentials never travel in a backup.
      await sql.many(insert, rows.map(row => keys.map((k, i) => converters[i]!(table === 'connectors' && k === 'enabled' ? false : row[k]))))
    }
    // Backups from before per-session receipts represented a read chat message through its mention delivery.
    await sql.query(`INSERT OR IGNORE INTO chat_read_receipts(session_id,message_id,read_at)
      SELECT recipient_id,message_id,read_at FROM chat_deliveries WHERE read_at IS NOT NULL`)
    // Hook timestamps are not portable session activity; restored history must never create a new alert.
    await sql.query('UPDATE chat_turn_state SET alerted_at=COALESCE(alerted_at,$1)',[backup.exported_at])
    await sql.query('UPDATE chat_turns SET alerted_at=COALESCE(alerted_at,$1)',[backup.exported_at])
    await sql.query(`UPDATE chat_deliveries SET cancelled_at=COALESCE(cancelled_at,$1),error='Aviso histórico restaurado'
      WHERE handled_at IS NULL AND message_id IN (SELECT message_id FROM chat_turn_alerts)`,[backup.exported_at])
    await sql.query(`UPDATE chat_threads SET archived_notice=1 WHERE id IN (
      SELECT m.thread_id FROM chat_turn_alerts a JOIN chat_messages m ON m.id=a.message_id
      JOIN chat_sessions s ON s.id=m.author_id WHERE s.agent_id='agenthub-system' AND s.cli_kind='hub'
      ) AND NOT EXISTS (SELECT 1 FROM chat_messages m JOIN chat_sessions s ON s.id=m.author_id
        WHERE m.thread_id=chat_threads.id AND (s.agent_id<>'agenthub-system' OR s.cli_kind<>'hub'))`)
    await sql.query('UPDATE chat_status_notices SET cancelled_at=COALESCE(cancelled_at,$1),error=\'Aviso histórico restaurado\'', [backup.exported_at])
    await sql.query("UPDATE chat_sessions SET label='Sin nick todavía' WHERE nickname IS NULL AND cli_kind<>'hub'")
    // A copy proves no ownership of processes, grants or decision requests on this host: schedules wait for a human, no occurrence is caught up,
    // imported PIDs are never signalled, and items without verifiable authority stay blocked.
    await sql.query("UPDATE schedules SET state='paused',paused_by='system',next_run_at=NULL WHERE state='active'")
    await sql.query("UPDATE schedule_runs SET state='interrupted',error_code='hub_restart',finished_at=COALESCE(finished_at,$1),next_attempt_at=NULL WHERE state IN ('pending','running','deferred')", [backup.exported_at])
    await sql.query(`UPDATE schedule_run_attempts SET host_pid=NULL,host_started=NULL,cli_pid=NULL,cli_started=NULL,boot_id=NULL,
      state=CASE WHEN state IN ('starting','running') THEN 'orphan_unverified' ELSE state END`)
    await sql.query("UPDATE schedule_deliveries SET state='uncertain' WHERE state='sending'")
    await sql.query("UPDATE schedule_artifacts SET proposed_effects='[]',decision_authority=CASE WHEN decision_request_ref IS NULL THEN NULL ELSE 'unavailable' END")
    await sql.query("UPDATE schedule_item_states SET state=CASE WHEN state='dispatching' THEN 'uncertain' ELSE 'unverifiable' END WHERE state IN ('proposed','approved','dispatching')")
    await sql.query("UPDATE liveness_incidents SET status='resolved',resolved_at=COALESCE(resolved_at,$1),resolution='restored' WHERE status='open'", [backup.exported_at])
    await sql.query("UPDATE progress_checkpoints SET status='closed',closed_at=$1,closed_reason='restored' WHERE closed_at IS NULL", [backup.exported_at])
    await sql.query('UPDATE project_automation SET enabled=0,coordinator_session_id=NULL')
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
    // Duplicate and identity proposals reference people by id inside their data, not through links, so no cascade reaches them.
    if (before.kind === 'person') await sql.query(`DELETE FROM entities WHERE kind='fact' AND ((data->>'category'='person_duplicate' AND $1 IN (data->>'from_id',data->>'into_id'))
      OR (data->>'category'='identity_match' AND data->>'speaker_id'=$1))`, [entityId])
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
