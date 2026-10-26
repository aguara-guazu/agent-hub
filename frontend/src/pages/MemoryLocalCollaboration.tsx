import { MemoryFrame } from '../lib/memory'
import { ProjectCollaboration } from './MemoryCollaboration'

export function MemoryLocalCollaboration() {
  return <MemoryFrame>
    <ProjectCollaboration unassigned />
  </MemoryFrame>
}
