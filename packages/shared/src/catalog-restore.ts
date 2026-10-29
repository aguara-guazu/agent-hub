/**
 * Deshacer de borrados y cancelaciones.
 *
 * Servers y skills: `DELETE /api/catalog/servers/:id` y `DELETE /api/catalog/skills/:id` hacen borrado suave (204, igual que antes).
 * `POST /api/catalog/servers/:id/restore` y `POST /api/catalog/skills/:id/restore`, sin cuerpo, devuelven 200 con la vista de siempre
 * (la de `GET /api/catalog/servers` o `/skills`) dentro de CATALOG_RESTORE_WINDOW_MS. Errores `{ detail }`: 404 inexistente o ya purgado;
 * 409 no está borrado, o su slug lo usa otro recurso vivo, o es una skill externa.
 *
 * Programaciones: `POST /api/memory/schedules/:id/restore` con `{ expected_revision }` deshace una cancelación hecha por la persona dentro
 * de SCHEDULE_RESTORE_WINDOW_MS. Devuelve la ScheduleView de siempre más `restore`. Errores `{ detail, code }`: 403 restore_human_only;
 * 404 schedule_not_found; 409 schedule_not_cancelled, stale_revision, schedule_not_restorable, restore_window_expired,
 * schedule_target_taken, automations_disabled.
 */

/** Igual a DELETE_RETENTION_MS del core: después el recurso se purga y su archivo OAuth se borra. */
export const CATALOG_RESTORE_WINDOW_MS = 30 * 60_000
/** Igual a SCHEDULE_RESTORE_WINDOW_MS de memory. */
export const SCHEDULE_RESTORE_WINDOW_MS = 10 * 60_000

export interface ScheduleRestoreInfo {
  previous_state: "active" | "paused"
  /** Se levantó la restricción de no recrear que había creado esa cancelación. */
  constraint_lifted: boolean
  /** Ejecuciones que la cancelación salteó o abortó; no se reanudan. */
  aborted_runs: string[]
  aborted_runs_resumed: false
}
