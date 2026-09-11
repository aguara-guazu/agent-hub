import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import type { AgentInstance, MatrixRow, ResourceType } from './types'
import { useToast } from '../components/Toast'

export interface LocalClient extends AgentInstance {
  config_path: string
  synced_at: string | null
  synchronized: boolean
  server_count: number
  skill_count: number
}
export interface LocalOverview { hostname: string; clients: LocalClient[]; rows: MatrixRow[] }
export const LOCAL_KEY = ['local-overview'] as const
export function useOverview() {
  return useQuery({ queryKey: LOCAL_KEY, queryFn: () => api.get<LocalOverview>('/local/overview'), refetchInterval: 1500 })
}
export function useLocalRule() {
  const cache = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: ({ type, id, enabled, client }: { type: ResourceType; id: string; enabled: boolean; client?: string }) =>
      api.put('/policy/rules', { scope: client ? 'client' : 'user', scope_id: client ?? '', resource_type: type,
        resource_id: id, state: enabled ? 'on' : 'off', reset_clients: !client }),
    onSuccess: () => cache.invalidateQueries({ queryKey: LOCAL_KEY }),
    onError: error => toast.error('No se guardó el cambio', error.message),
  })
}
export function resourceEnabled(row?: MatrixRow): boolean {
  if (!row) return true
  const cells = Object.values(row.cells).filter(cell => cell.source !== 'client_disabled')
  return cells.length > 0 ? cells.some(cell => cell.exposed) : row.user_rule !== 'off'
}
