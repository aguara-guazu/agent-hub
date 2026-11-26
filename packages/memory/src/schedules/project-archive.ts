import type { Sql } from '../database.js'
import type { RunRow } from './schedule-store.js'

export const scheduleArchiveMigration = `ALTER TABLE schedule_artifacts ADD COLUMN archive_revision TEXT NOT NULL DEFAULT '';
ALTER TABLE schedule_artifacts ADD COLUMN archive_scope JSON;
ALTER TABLE schedule_runs ADD COLUMN tracking_skip_reason TEXT CHECK(
 tracking_skip_reason IN ('overlap','misfire_out_of_grace','superseded','automations_off','schedule_cancelled','remote_processing_excluded','project_archived')
 OR tracking_skip_reason GLOB 'module_disabled:[a-z]*');
UPDATE schedule_runs SET tracking_skip_reason=skip_reason WHERE skip_reason IS NOT NULL;
ALTER TABLE schedule_runs DROP COLUMN skip_reason;
ALTER TABLE schedule_runs RENAME COLUMN tracking_skip_reason TO skip_reason;
`

export async function archiveRevision(db: Sql) {
  const [row] = await db.query("SELECT coalesce(group_concat(project_id||':'||version,',' ORDER BY project_id),'') AS revision FROM project_archive_state")
  return String(row!.revision)
}
export function scopedRevision(revision: string, projectIds: string[] | null) {
  if (!projectIds) return revision
  const scope = new Set(projectIds)
  return revision.split(',').filter(entry => scope.has(entry.split(':')[0]!)).join(',')
}
export function aggregateRun(run: RunRow) {
  return run.definition.template === 'daily_brief' || run.definition.template === 'daily_close'
}
export async function archivedOccurrence(db: Sql, run: RunRow) {
  if (!run.definition.project_id) return false
  const [row] = await db.query(`SELECT 1 FROM project_archive_state WHERE project_id=$1
    AND (archived_at IS NOT NULL OR resumed_at>$2)`, [run.definition.project_id, run.scheduled_for])
  return Boolean(row)
}
