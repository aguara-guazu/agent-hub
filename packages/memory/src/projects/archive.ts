import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { check, id, parse } from '../contracts.js'
import type { Sql } from '../database.js'
import type { MemoryStore } from '../store.js'

export const projectState = z.enum(['active', 'archived'])
export type ProjectState = z.infer<typeof projectState>
export const archiveInput = z.object({ state: projectState, version: z.number().int().nonnegative() }).strict()

export const archiveMigration = `
CREATE TABLE project_archive_state (
  project_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  archived_at TIMESTAMP, resumed_at TIMESTAMP, version INTEGER NOT NULL
);
INSERT INTO project_archive_state SELECT id,updated_at,NULL,1 FROM entities
  WHERE kind='project' AND data->>'memory_state'='archived' AND data->>'merged_into' IS NULL;
UPDATE entities SET data=json_remove(data,'$.memory_state') WHERE id IN (SELECT project_id FROM project_archive_state);
CREATE INDEX project_archive_candidates ON entities((data->>'candidate_project_id')) WHERE kind='fact' AND data->>'category'='project_match';
CREATE VIEW archived_projects AS SELECT a.project_id FROM project_archive_state a JOIN entities e ON e.id=a.project_id
  WHERE a.archived_at IS NOT NULL AND e.data->>'merged_into' IS NULL;
CREATE VIEW archived_only_entities AS
  SELECT project_id AS id FROM archived_projects
  UNION SELECT l.from_id FROM archived_projects a JOIN links l ON l.to_id=a.project_id AND l.type='project'
    WHERE NOT EXISTS (SELECT 1 FROM links other WHERE other.from_id=l.from_id AND other.type='project'
      AND other.to_id NOT IN (SELECT project_id FROM archived_projects))
  UNION SELECT e.id FROM archived_projects a CROSS JOIN entities e ON e.data->>'candidate_project_id'=a.project_id
    WHERE e.kind='fact' AND e.data->>'category'='project_match';
CREATE VIEW archived_only_fragments AS
  SELECT DISTINCT fp.fragment_id AS id FROM archived_projects a JOIN fragment_projects fp ON fp.project_id=a.project_id
    WHERE NOT EXISTS (SELECT 1 FROM fragment_projects other WHERE other.fragment_id=fp.fragment_id
      AND other.project_id NOT IN (SELECT project_id FROM archived_projects));
`

// An explicit archive lookup affects only this asynchronous read and one project. Ingestion always uses the underlying records.
const archiveRead = new AsyncLocalStorage<string>()
export const withArchivedProject = <T>(project: string, fn: () => T) => archiveRead.run(id.parse(project), fn)
function includeSelected(predicate: string, selected: (project: string) => string) {
  const scope = archiveRead.getStore()
  return scope ? `(${predicate} OR ${selected("'" + scope + "'")})` : predicate
}
export function visibleProject(column: string) {
  return includeSelected(`(${column} IS NULL OR ${column} NOT IN (SELECT project_id FROM archived_projects))`, p => `${column}=${p}`)
}
export function visibleEntity(column: string) {
  return includeSelected(`${column} NOT IN (SELECT id FROM archived_only_entities)`, p =>
    `${column}=${p} OR EXISTS(SELECT 1 FROM links va WHERE va.from_id=${column} AND va.type='project' AND va.to_id=${p})`)
}
export function visibleFragment(column: string) {
  return includeSelected(`${column} NOT IN (SELECT id FROM archived_only_fragments)`, p =>
    `EXISTS(SELECT 1 FROM fragment_projects va WHERE va.fragment_id=${column} AND va.project_id=${p})`)
}
/** Whole-source metadata can contain the original transcript of a source with differently assigned fragments. */
export function containsHiddenFragments(version: string) {
  const project = archiveRead.getStore()
  const outsideScope = project ? ` AND NOT EXISTS(SELECT 1 FROM fragment_projects fp WHERE fp.fragment_id=hf.id AND fp.project_id='${project}')` : ''
  return `EXISTS(SELECT 1 FROM archived_only_fragments h JOIN fragments hf ON hf.id=h.id WHERE hf.version_id=${version}${outsideScope})`
}
export async function projectReadEntities<T extends { id: string; data: Record<string, any> }>(sql: Sql, rows: T[]): Promise<T[]> {
  if (!rows.length) return rows
  const mixed = await sql.query(`SELECT s.entity_id FROM sources s WHERE s.entity_id IN (SELECT value FROM json_each($1))
    AND ${containsHiddenFragments('s.current_version_id')}`, [rows.map(row => row.id)])
  if (!mixed.length) return rows
  const ids = new Set(mixed.map(row => row.entity_id))
  return rows.map(row => {
    if (!ids.has(row.id)) return row
    const data = Object.fromEntries(['provider','occurred_at','timezone','mime_type'].filter(key => key in row.data).map(key => [key,row.data[key]]))
    return { ...row, data }
  })
}
export async function isArchived(sql: Sql, project: string) {
  return (await sql.query('SELECT 1 FROM archived_projects WHERE project_id=$1', [project])).length > 0
}
export async function setProjectArchive(store: MemoryStore, project: string, raw: unknown, changed?: (id: string) => Promise<void>) {
  const { state, version } = parse(archiveInput, raw)
  const transition = await store.db.transaction(async sql => {
    const [row] = await sql.query(`SELECT e.data->>'merged_into' AS merged,a.archived_at,a.resumed_at,coalesce(a.version,0) AS version
      FROM entities e LEFT JOIN project_archive_state a ON a.project_id=e.id WHERE e.id=$1 AND e.kind='project'`, [parse(id, project)])
    check(row, 'Proyecto inexistente', 404)
    check(!row.merged, 'Este proyecto fue unificado', 409)
    const result = { state, version: Number(row.version), archived_at: row.archived_at, resumed_at: row.resumed_at }
    if (Boolean(row.archived_at) === (state === 'archived')) return { result, changed: false }
    check(row.version === version, 'El seguimiento del proyecto cambió. Recargá la ficha.', 409)
    const [saved] = await sql.query(`INSERT INTO project_archive_state(project_id,archived_at,resumed_at,version)
      VALUES($1,CASE WHEN $2='archived' THEN now() END,CASE WHEN $2='active' THEN now() END,1)
      ON CONFLICT(project_id) DO UPDATE SET archived_at=excluded.archived_at,resumed_at=coalesce(excluded.resumed_at,project_archive_state.resumed_at),
      version=project_archive_state.version+1 RETURNING version,archived_at,resumed_at`, [project, state])
    await sql.query('INSERT INTO changes(entity_id,action,actor,after_value) VALUES($1,$2,$3,$4)', [project, 'project.' + state, 'owner', { state, version: saved!.version }])
    return { result: { state, version: Number(saved!.version), archived_at: saved!.archived_at, resumed_at: saved!.resumed_at }, changed: true }
  })
  if (transition.changed) await changed?.(project)
  return transition.result
}

// The owner may open a specific project in the console. Agents opt in by naming an archived project and its scope.
export async function projectReadScope<T>(sql: Sql, operation: string, raw: unknown, owner: boolean,
  read: (input: Record<string, unknown>) => Promise<T>) {
  const input = (raw ?? {}) as Record<string, unknown>
  const { project_state, archive_project_id, ...args } = input
  const state = project_state === undefined ? 'active' : parse(projectState, project_state)
  if (operation === 'list_entities' && args.kind === 'project' && !args.project_id) {
    return read({ ...args, project_state: state })
  }
  const target = archive_project_id ?? args.project_id ?? (operation === 'get_entity' ? args.id : undefined)
  let scope = typeof target === 'string' && id.safeParse(target).success && await isArchived(sql, target) ? target : null
  // A link from the owner console may point straight to a note, a task or a source version.
  if (owner && !scope && !archive_project_id) {
    const entity = args.entity_id ?? args.collection_id ?? (operation === 'get_entity' ? args.id : undefined)
    let linked: string | undefined, value: unknown
    if (typeof entity === 'string') {
      linked = "SELECT l.to_id AS project_id FROM links l JOIN archived_only_entities h ON h.id=l.from_id WHERE l.type='project' AND l.from_id=$1"
      value = entity
    } else if (typeof args.version_id === 'string') {
      linked = "SELECT l.to_id AS project_id FROM versions v JOIN sources s ON s.id=v.source_id JOIN archived_only_entities h ON h.id=s.entity_id JOIN links l ON l.from_id=h.id AND l.type='project' WHERE v.id=$1"
      value = args.version_id
    } else if (typeof args.fragment_id === 'string') {
      linked = 'SELECT fp.project_id FROM fragment_projects fp JOIN archived_only_fragments h ON h.id=fp.fragment_id WHERE fp.fragment_id=$1'
      value = args.fragment_id
    } else if (operation === 'get_task') {
      linked = 'SELECT project_id FROM tasks WHERE id=$1'
      value = args.id
    }
    if (linked) {
      const [match] = await sql.query(`SELECT a.project_id FROM archived_projects a JOIN (${linked}) linked ON linked.project_id=a.project_id ORDER BY a.project_id LIMIT 1`, [value])
      scope = match?.project_id ?? null
    }
  }
  if (state === 'archived') check(scope, 'Elegí un proyecto archivado', 404)
  if (scope && !owner && state !== 'archived') check(false, 'Proyecto inexistente', 404)
  const perform = async () => {
    const entity = args.entity_id ?? args.collection_id ?? (operation === 'get_entity' ? args.id : undefined)
    if (typeof entity === 'string') {
      const [row] = await sql.query(`SELECT 1 FROM entities e WHERE e.id=$1 AND ${visibleEntity('e.id')}`, [entity])
      check(row, 'Entidad inexistente', 404)
    }
    if (typeof args.project_id === 'string') {
      const [row] = await sql.query(`SELECT 1 FROM entities p WHERE p.id=$1 AND ${visibleProject('p.id')}`, [args.project_id])
      check(row, 'Proyecto inexistente', 404)
    }
    if (typeof args.schedule_id === 'string' || typeof args.run_id === 'string') {
      const schedule = typeof args.run_id === 'string' ? '(SELECT schedule_id FROM schedule_runs WHERE id=$1)' : '$1'
      const [row] = await sql.query(`SELECT 1 FROM schedules s WHERE s.id=${schedule} AND ${visibleProject('s.project_id')}`, [args.run_id ?? args.schedule_id])
      check(row, 'Programación inexistente', 404)
    }
    if (operation === 'get_task') {
      const [row] = await sql.query(`SELECT 1 FROM tasks t WHERE t.id=$1 AND ${visibleProject('t.project_id')}`, [args.id])
      check(row, 'Tarea inexistente', 404)
    }
    if (typeof args.version_id === 'string') {
      const [row] = await sql.query(`SELECT v.id FROM versions v JOIN sources s ON s.id=v.source_id
        WHERE v.id=$1 AND ${visibleEntity('s.entity_id')} AND ($2<>'get_file' OR NOT EXISTS
        (SELECT 1 FROM fragments f WHERE f.version_id=v.id AND NOT (${visibleFragment('f.id')})))`, [args.version_id, operation])
      check(row, 'Versión inexistente', 404)
    }
    return read(args)
  }
  return scope && (owner || state === 'archived') ? withArchivedProject(scope, perform) : perform()
}
