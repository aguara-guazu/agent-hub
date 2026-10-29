import type { Entity } from "../../../lib/types"
import { ProjectCollaboration } from "../../MemoryCollaboration"
import { ProjectForum, ProjectSharing } from "../../MemorySharing"

/**
 * Pestaña Colaboración de la ficha de proyecto (`?tab=colaboracion`); «Compartir» del encabezado abre esta pestaña.
 * Contrato estable con ProjectPage: export default, props `{ project: Entity }`, sin más props ni contexto.
 * ProjectPage la carga con React.lazy dentro de un Suspense y le pasa la entidad ya cargada con `get_entity`.
 * Provisoria: monta las vistas previas al rediseño (hilos, personas con acceso, foro) hasta que la tanda 2 sobrescriba este archivo.
 */
export default function Colaboracion({ project }: { project: Entity }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-5)", minWidth: 0 }}>
      <ProjectCollaboration projectId={project.id} />
      <ProjectSharing project={project} />
      <ProjectForum projectId={project.id} />
    </div>
  )
}
