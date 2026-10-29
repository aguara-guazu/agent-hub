import type { LocalUnmanaged } from "@agenthub/shared"
import { useQuery } from "@tanstack/react-query"
import { api } from './api'
import type { AgentInstance, MatrixRow } from "./types"

/** Qué difiere entre lo que el cliente listó al abrirse y el snapshot vigente. */
export interface PendingChanges {
  skills: { added: string[]; removed: string[]; changed: string[]; auto: string[] }
  servers: { added: string[]; removed: string[] }
}
export interface LocalClient extends AgentInstance {
  config_path: string
  synced_at: string | null
  synchronized: boolean
  server_count: number
  skill_count: number
  /** El cliente no recarga en caliente y sigue con una lista vieja: hace falta reiniciarlo. */
  restart_pending: boolean
  pending: PendingChanges | null
  /** Instalado por fuera del hub; `null` o ausente con un daemon que todavía no reporta inventario. */
  unmanaged?: LocalUnmanaged | null
}
export interface LocalOverview { hostname: string; clients: LocalClient[]; rows: MatrixRow[] }
export const LOCAL_KEY = ['local-overview'] as const
export function useOverview() {
  return useQuery({ queryKey: LOCAL_KEY, queryFn: () => api.get<LocalOverview>('/local/overview'), refetchInterval: 1500 })
}
export function resourceEnabled(row?: MatrixRow): boolean {
  if (!row) return true
  const cells = Object.values(row.cells).filter(cell => cell.source !== 'client_disabled')
  return cells.length > 0 ? cells.some(cell => cell.exposed) : row.user_rule !== 'off'
}
