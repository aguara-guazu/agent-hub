import type { MemoryEntity } from "../lib/memory"
import { ProjectAutomationPanel } from "./automations/ProjectAutomationPanel"

/** API previa para `Memory.tsx` (sin ruta propia) hasta la limpieza; la vista vive en `automations/ProjectAutomationPanel`. */
export function ProjectAutomation({ project }: { project: MemoryEntity }) {
  return <ProjectAutomationPanel project={project} onClose={() => undefined} />
}
