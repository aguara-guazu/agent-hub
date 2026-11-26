import type { ComponentType, LazyExoticComponent } from 'react'
import type { ModuleId } from '@agenthub/shared/modules'
import agents from './agents'
import assistants from './assistants'
import connections from './connections'
import memory from './memory'
import mcp from './mcp'
import skills from './skills'
import schedules from './schedules'
import transcriptions from './transcriptions'
import sharing from './sharing'

interface ModuleViews {
  settings: LazyExoticComponent<ComponentType>
  routes: { path: string; Component: ComponentType }[]
}
export const moduleViews: Record<ModuleId, ModuleViews> = {
  agents, assistants, connections, memory, mcp, skills, schedules, transcriptions, sharing,
}
