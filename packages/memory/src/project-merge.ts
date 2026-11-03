import { z } from "zod"
import { INTERHUB_CHANNEL_KIND } from "@agenthub/shared"
import { check, id, instant, parse, type Entity } from "./contracts.js"
import { audit, canonical, requireEntity, workFolder, type MemoryStore } from "./store.js"

export const mergeProjectsInput = z.object({
  from_id: id, into_id: id, expected_from_updated_at: instant, expected_into_updated_at: instant,
}).strict().refine(input => input.from_id !== input.into_id, "Elige dos proyectos distintos")

/** Explicit local consolidation. Signed sharing identities and project permissions never transfer. */
export async function mergeProjects(store: MemoryStore, raw: unknown, actor: string) {
  const input = parse(mergeProjectsInput, raw)
  return store.db.transaction(async sql => {
    const from = await requireEntity(sql, input.from_id, "project"), into = await requireEntity(sql, input.into_id, "project")
    check(from.updated_at === input.expected_from_updated_at && into.updated_at === input.expected_into_updated_at, "Un proyecto cambió; vuelve a leer ambos antes de unificar", 409)
    check(!from.data.merged_into && !into.data.merged_into, "Un proyecto ya fue unificado", 409)
    check(!(await sql.query("SELECT id FROM shared_projects WHERE id=$1", [from.id])).length, "El origen es compartido: conserva su identidad y úsalo como destino", 409)
    // An active delegation or schedule keeps its original scope; archiving cannot silently leave it running.
    check(!(await sql.query("SELECT project_id FROM project_automation WHERE project_id=$1 AND enabled=1 UNION ALL SELECT project_id FROM schedules WHERE project_id=$1 AND state='active'", [from.id])).length,
      "Pausa las automatizaciones y los horarios del origen antes de unificar; sus permisos no se transfieren", 409)
    const data = { ...into.data }, conflicts: string[] = []
    const protectedKeys = new Set(["remote_processing", "memory_state", "merged_into", "folders", "company_id", "jira_project_key", "jira_site_url"])
    for (const [key, value] of Object.entries(from.data)) {
      if (protectedKeys.has(key)) { if (canonical(value) !== canonical(data[key])) conflicts.push(key); continue }
      if (data[key] == null || data[key] === "") data[key] = value
      else if (canonical(data[key]) !== canonical(value)) conflicts.push(key)
    }
    if (from.data.remote_processing === false) data.remote_processing = false
    const folders = [...new Set([
      ...(Array.isArray(into.data.folders) ? into.data.folders : []),
      ...(Array.isArray(from.data.folders) ? from.data.folders : []),
      ...[into.data.local_path, from.data.local_path].filter(path => workFolder.safeParse(path).success),
    ].map(path => parse(workFolder, path).replace(/[\\/]+$/, "") || "/"))]
    check(folders.length <= 20, "La unión supera 20 carpetas; revisa las carpetas antes de unificar", 409)
    if (folders.length) data.folders = folders
    const retained: Array<{ table: string; count: number; reason: string }> = []
    const links = await sql.query("SELECT * FROM links WHERE from_id=$1 OR to_id=$1", [from.id])
    let movedLinks = 0
    for (const link of links) {
      const a = link.from_id === from.id ? into.id : link.from_id, b = link.to_id === from.id ? into.id : link.to_id
      const existing = a === b ? null : (await sql.query("SELECT id FROM links WHERE from_id=$1 AND to_id=$2 AND type=$3", [a, b, link.type]))[0]
      // A company's/Jira ownership and conflicting edge metadata require a separate explicit decision.
      if (a === b || existing || link.type === "company") {
        if (existing) await sql.query("INSERT OR IGNORE INTO link_evidence(link_id,fragment_id) SELECT $2,fragment_id FROM link_evidence WHERE link_id=$1", [link.id, existing.id])
        retained.push({ table: "links", count: 1, reason: `Enlace ${link.id}: autorreferencia, colisión o empresa; conservado en el origen` })
        continue
      }
      await sql.query("UPDATE links SET from_id=$2,to_id=$3 WHERE id=$1", [link.id, a, b]); movedLinks++
    }
    await sql.query("INSERT OR IGNORE INTO fragment_projects(fragment_id,project_id) SELECT fragment_id,$2 FROM fragment_projects WHERE project_id=$1", [from.id, into.id])
    await sql.query("DELETE FROM fragment_projects WHERE project_id=$1", [from.id])
    const moved: Record<string, number> = { links: movedLinks }
    for (const table of ["tasks", "agent_notes", "agent_sessions", "chat_channels"]) {
      const rows = await sql.query(`UPDATE ${table} SET project_id=$2 WHERE project_id=$1${table === "chat_channels" ? ` AND kind<>'${INTERHUB_CHANNEL_KIND}'` : ""} RETURNING id`, [from.id, into.id])
      moved[table] = rows.length
    }
    // Only declared project references change; text, signed payloads, originals and historical approvals stay intact.
    for (const table of ["connectors", "rules"]) {
      const rows = await sql.query(`SELECT id,project_ids FROM ${table} WHERE EXISTS(SELECT 1 FROM json_each(project_ids) WHERE value=$1)`, [from.id])
      for (const row of rows) await sql.query(`UPDATE ${table} SET project_ids=$2 WHERE id=$1`, [row.id, JSON.stringify([...new Set(row.project_ids.map((value: string) => value === from.id ? into.id : value))])])
      moved[table] = rows.length
    }
    const entities = await sql.query<Entity>(`SELECT * FROM entities WHERE id<>$1 AND id<>$2 AND
      (data->>'project_id'=$1 OR data->>'memory_project_id'=$1 OR data->>'candidate_project_id'=$1
        OR EXISTS(SELECT 1 FROM json_each(data->'project_ids') WHERE value=$1))`, [from.id, into.id])
    for (const entity of entities) {
      const next = { ...entity.data }
      for (const key of ["project_id", "memory_project_id", "candidate_project_id"]) if (next[key] === from.id) next[key] = into.id
      if (Array.isArray(next.project_ids)) next.project_ids = [...new Set(next.project_ids.map(value => value === from.id ? into.id : value))]
      await sql.query("UPDATE entities SET data=$2,updated_at=now() WHERE id=$1", [entity.id, JSON.stringify(next)])
      await audit(sql, entity.id, "project_merged_reference", actor, entity.data, next)
    }
    moved.entities = entities.length
    const records = await sql.query(`SELECT r.id,r.collection_id,r."values",c.data->'fields' AS "fields:json" FROM collection_records r JOIN entities c ON c.id=r.collection_id
      WHERE EXISTS(SELECT 1 FROM json_each(r."values") WHERE value=$1)`, [from.id])
    moved.collection_records = 0
    for (const row of records) {
      const values = { ...row.values }
      for (const field of row.fields ?? []) if (field.type === "entity" && values[field.key] === from.id) values[field.key] = into.id
      if (canonical(values) === canonical(row.values)) continue
      await sql.query("UPDATE collection_records SET \"values\"=$2,updated_at=now() WHERE id=$1", [row.id, JSON.stringify(values)])
      await audit(sql, row.collection_id, "project_merged_record", actor, { record_id: row.id, values: row.values }, { record_id: row.id, values })
      moved.collection_records++
    }
    // Report all remaining project columns, including permission/history tables, without widening their authority.
    const tables = await sql.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    for (const { name } of tables) {
      if (!/^[a-z_]+$/.test(name)) continue
      const columns = await sql.query(`SELECT name FROM pragma_table_info('${name}') WHERE name IN ('project_id','delegation_project_id','requester_project_id','target_project_id')`)
      for (const column of columns) {
        const count = Number((await sql.query(`SELECT count(*) AS n FROM ${name} WHERE ${column.name}=$1`, [from.id]))[0]!.n)
        if (count) retained.push({ table: `${name}.${column.name}`, count, reason: "Permiso, automatización o historial conservado con su alcance original" })
      }
    }
    const merged = { ...from.data, memory_state: "archived", merged_into: into.id }
    await sql.query("UPDATE entities SET data=$2,updated_at=now() WHERE id=$1", [into.id, JSON.stringify(data)])
    await sql.query("UPDATE entities SET data=$2,updated_at=now() WHERE id=$1", [from.id, JSON.stringify(merged)])
    await audit(sql, into.id, "project_merge_destination", actor, into, { data, from_id: from.id, moved, conflicts, retained })
    await audit(sql, from.id, "project_merged", actor, from, { data: merged, into_id: into.id, moved, conflicts, retained })
    return { project_id: into.id, archived_project_id: from.id, moved, conflicts, retained,
      guidance: "El origen y sus datos se conservan archivados. Los campos en conflicto y las referencias retenidas requieren revisión; no se transfirieron permisos ni automatizaciones." }
  })
}
