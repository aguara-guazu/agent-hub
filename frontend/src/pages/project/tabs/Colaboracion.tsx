import type { Entity } from "../../../lib/types"
import { CollaborationTab } from "../collaboration/CollaborationTab"

/**
 * Pestaña Colaboración de la ficha de proyecto (`?tab=colaboracion`): tres columnas canales › hilos › debate.
 * Contrato estable con ProjectPage: export default, props `{ project: Entity }`.
 */
export default function Colaboracion({ project }: { project: Entity }) {
  return <CollaborationTab project={project} />
}
