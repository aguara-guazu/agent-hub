import { assistants } from './assistants.js'
export { contractTrackingModules } from './assistants.js'
import { connections } from './connections.js'
import { agents } from './agents.js'
import { memory } from './memory.js'
import { mcp } from './mcp.js'
import { skills } from './skills.js'
import { transcriptions } from './transcriptions.js'
import { schedules } from './schedules.js'
import { sharing } from './sharing.js'
import type { ModuleDefinition } from './definition.js'

export const appModules = [connections, agents, memory, mcp, skills, transcriptions, schedules, sharing, assistants] as const
export type ModuleId = (typeof appModules)[number]['id']
export type ModuleEnabled = (id: ModuleId) => boolean
export type ModuleStates = Record<ModuleId, boolean>

export function moduleStates(enabled: ModuleEnabled): ModuleStates {
  return Object.fromEntries(appModules.map(({ id }) => [id, enabled(id)])) as ModuleStates
}
export function isModuleId(value: string): value is ModuleId {
  return appModules.some(module => module.id === value)
}
export function moduleDefinition(id: ModuleId) {
  return appModules.find(module => module.id === id)!
}
export function dependencies(id: ModuleId): readonly ModuleId[] {
  const definition = moduleDefinition(id)
  return 'requires' in definition ? definition.requires : []
}

function requirements(owners: readonly ModuleId[]): ModuleId[] {
  return [...new Set(owners.flatMap(id => [id, ...dependencies(id)]))]
}

function pathMatches(path: string, prefix: string) { return path === prefix || path.startsWith(prefix + '/') }

export function routeModules(path: string): ModuleId[] {
  const ids: ModuleId[] = appModules.filter(module => module.routes.some(prefix => pathMatches(path, prefix))).map(module => module.id)
  return requirements(ids)
}
export function destinationModule(path: string): ModuleId | undefined {
  return appModules.find(module => module.destinations.some(prefix => pathMatches(path, prefix)))?.id
}
export function operationModules(name: string): ModuleId[] {
  const owners = appModules.filter((module: ModuleDefinition) =>
    module.operations.includes(name) || module.operationPrefixes.some(prefix => name.startsWith(prefix))).map(module => module.id)
  return requirements(owners)
}
export function jobOwner(kind: string): ModuleId | undefined {
  return appModules.find((module: ModuleDefinition) => module.jobs.includes(kind))?.id
}
export function jobModules(kind: string): ModuleId[] {
  // Imports and inference write into project memory. A queued job keeps its place while a dependency is off.
  const owner = jobOwner(kind)
  return owner && owner !== 'memory' ? [owner, 'memory'] : ['memory']
}
