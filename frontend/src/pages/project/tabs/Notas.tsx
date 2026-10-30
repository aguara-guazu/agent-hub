import type { Entity } from "../../../lib/types"
import { NotesTab } from "../notes/NotesTab"

/** Pestaña Notas de la ficha de proyecto (`?tab=notas`): notas de trabajo de los agentes, solo lectura. Contrato igual al de las otras pestañas. */
export default function Notas({ project }: { project: Entity }) {
  return <NotesTab project={project} />
}
