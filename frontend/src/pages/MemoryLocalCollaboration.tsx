import { MemoryFrame, PageHeading } from '../lib/memory'
import { ProjectCollaboration } from './MemoryCollaboration'

export function MemoryLocalCollaboration() {
  return <MemoryFrame>
    <PageHeading title="Colaboración sin proyecto" description="Equipos locales para tareas en una carpeta, sin crear un proyecto ni un repositorio." />
    <ProjectCollaboration unassigned />
  </MemoryFrame>
}
