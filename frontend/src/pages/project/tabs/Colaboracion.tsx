import type { Entity } from "../../../lib/types"
import { CollaborationTab } from "../collaboration/CollaborationTab"

/**
 * Pestaña Colaboración de la ficha de proyecto (`?tab=colaboracion`); «Compartir» del encabezado abre esta pestaña.
 * Paneles en `?message=` (foro) e `?invite=` (nuevo participante). Contrato estable con ProjectPage: export default, props `{ project: Entity }`.
 */
export default function Colaboracion({ project }: { project: Entity }) {
  return <CollaborationTab project={project} />
}
