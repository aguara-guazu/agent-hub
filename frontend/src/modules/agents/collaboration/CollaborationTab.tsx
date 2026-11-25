import type { MemoryEntity } from "../../../lib/memory"
import { CollaborationBoard } from "./Board"

/** Colaboración del proyecto: canales › hilos › debate entre agentes, solo para ver. */
export function CollaborationTab({ project }: { project: MemoryEntity }) {
  return <CollaborationBoard project={project} />
}
