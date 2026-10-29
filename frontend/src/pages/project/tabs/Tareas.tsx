import type { Entity } from "../../../lib/types"
import { TasksTab } from "../tasks/TasksTab"

/**
 * Pestaña Tareas de la ficha de proyecto (`?tab=tareas`): segmentado por estado en `?view=`, tipo en `?kind=`, panel en `?task=`, `?jira=` o `?stats=`.
 * Contrato estable con ProjectPage: export default, props `{ project: Entity }`.
 */
export default function Tareas({ project }: { project: Entity }) {
  return <TasksTab project={project} />
}
