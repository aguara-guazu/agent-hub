import type { Entity } from "../../../lib/types"
import { ProjectTasks } from "../../MemoryTasks"

/**
 * Pestaña Tareas de la ficha de proyecto (`?tab=tareas`).
 * Contrato estable con ProjectPage: export default, props `{ project: Entity }`, sin más props ni contexto.
 * ProjectPage la carga con React.lazy dentro de un Suspense y le pasa la entidad ya cargada con `get_entity`.
 * Provisoria: monta la vista previa al rediseño hasta que la tanda 2 sobrescriba este archivo.
 */
export default function Tareas({ project }: { project: Entity }) {
  return <ProjectTasks project={project} />
}
