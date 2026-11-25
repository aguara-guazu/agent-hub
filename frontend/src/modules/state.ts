import { useQuery } from '@tanstack/react-query'
import { destinationModule, type ModuleStates } from '@agenthub/shared/modules'
import { api } from '../lib/api'

export type ModuleSettingsResponse = ModuleStates & { can_manage?: boolean }
export const modulesKey = ['app-modules'] as const
export function useModules() {
  return useQuery({ queryKey: modulesKey, queryFn: () => api.get<ModuleSettingsResponse>('/modules'), staleTime: 10_000, refetchInterval: 15_000 })
}
export function visibleDestination(path: string, states: ModuleStates | undefined) {
  const owner = destinationModule(path)
  return !owner || states?.[owner] !== false
}
