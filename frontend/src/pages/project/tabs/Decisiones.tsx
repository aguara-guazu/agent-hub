import type { Entity } from "../../../lib/types"
import { DecisionsTab } from "../decisions/DecisionsTab"

/**
 * Pestaña Decisiones de la ficha de proyecto (`?tab=decisiones`): segmentado por categoría en `?kind=`, panel en `?decision=`.
 * Contrato estable con ProjectPage: export default, props `{ project: Entity }`.
 */
export default function Decisiones({ project }: { project: Entity }) {
  return <DecisionsTab project={project} />
}
