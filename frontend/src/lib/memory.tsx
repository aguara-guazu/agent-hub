import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import { useToast } from '../components/Toast'

export interface MemoryEntity { id: string; kind: string; title: string; data: Record<string, any>; created_at: string; updated_at: string }
export interface Page<T = any> { items: T[]; total: number; limit: number; offset: number }
export const memoryCall = <T = any,>(operation: string, input: unknown = {}) => api.post<T>('/memory/call', { operation, input })
export const MEMORY_REFRESH_MS = 5000
export function useMemory<T = any>(operation: string, input: unknown = {}, enabled = true) {
  return useQuery({ queryKey: ['memory', operation, input], queryFn: () => memoryCall<T>(operation, input), enabled,
    // MCP clients and the worker can write while this screen stays open. Only mounted, visible queries poll.
    refetchInterval: MEMORY_REFRESH_MS, refetchIntervalInBackground: false, refetchOnWindowFocus: 'always' })
}
export function useMemoryMutation<T = any>(operation: string, onSuccess?: (data: T) => void) {
  const cache = useQueryClient(), toast = useToast()
  return useMutation({ mutationFn: (input: unknown) => memoryCall<T>(operation, input), onSuccess: data => {
    void cache.invalidateQueries({ queryKey: ['memory'] }); void cache.invalidateQueries({ queryKey: ['memory-status'] }); onSuccess?.(data)
  }, onError: error => toast.error('No se pudo completar', error.message) })
}
export function useMemoryStatus() {
  return useQuery({ queryKey: ['memory-status'], queryFn: () => api.get<any>('/memory/status'),
    refetchInterval: query => query.state.data?.state === 'migrating' ? 2_000 : 10_000 })
}
export function entityPath(entity: { id: string; kind: string }) { return entity.kind === 'project' ? `/projects/${entity.id}` : `/memory/entities/${entity.id}` }
