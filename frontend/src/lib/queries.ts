/** Hooks de TanStack Query compartidos por toda la consola.
 *
 *  Este archivo es el unico dueno de las claves de cache. Si una pantalla necesita
 *  invalidar algo que toco, tiene que usar `queryKeys` de aca en vez de escribir el
 *  arreglo a mano: dos literales parecidos son dos entradas distintas y una de las
 *  dos queda vieja para siempre.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient, UseMutationResult, UseQueryResult } from '@tanstack/react-query'

import { errorMessage } from '../components/ErrorState'
import { useToast } from '../components/Toast'
import { api } from './api'
import type {
  AuditEvent,
  ClientAccount,
  Machine,
  MatrixCell,
  MatrixResponse,
  McpServer,
  RuleScope,
  ResourceType,
  RuleState,
  Skill,
  Squad,
  ToolCallLog,
  User,
} from './types'

/* -------------------------------------------------------------------------- */
/* Claves de cache                                                             */
/* -------------------------------------------------------------------------- */

export interface AuditEventFilters {
  limit?: number
  action?: string
}

export interface ToolCallFilters {
  limit?: number
  agent_id?: string
}

/** Claves de cache de la consola. Son la interfaz entre pantallas: cualquiera que
 *  mute datos invalida con estas y no con literales propios. */
export const queryKeys = {
  me: ['me'] as const,
  users: ['users'] as const,
  squads: ['squads'] as const,
  clientAccounts: ['client-accounts'] as const,
  machines: ['machines'] as const,
  servers: ['servers'] as const,
  skills: ['skills'] as const,
  /** Prefijo: invalida la matriz de todas las personas cargadas. */
  matrixAll: ['matrix'] as const,
  matrix: (userId?: string | null) => ['matrix', userId ?? 'self'] as const,
  /** Prefijo de todo lo de auditoria. */
  auditAll: ['audit'] as const,
  auditEvents: (filters: AuditEventFilters = {}) =>
    ['audit', 'events', filters.limit ?? null, filters.action ?? null] as const,
  toolCalls: (filters: ToolCallFilters = {}) =>
    ['audit', 'tool-calls', filters.limit ?? null, filters.agent_id ?? null] as const,
}

/** Clave de la mutacion de reglas. Sirve para contar cuantos toggles quedan en
 *  vuelo y refrescar la matriz una sola vez al final de la rafaga. */
export const SET_RULE_MUTATION_KEY = ['set-rule'] as const

/* -------------------------------------------------------------------------- */
/* Utilidades                                                                   */
/* -------------------------------------------------------------------------- */

function withSearch(path: string, params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `${path}?${query}` : path
}

/* -------------------------------------------------------------------------- */
/* Lecturas                                                                     */
/* -------------------------------------------------------------------------- */

/** GET /auth/me. La sesion la maneja lib/auth; esto es para pantallas que quieren
 *  el usuario ya cacheado sin depender del contexto. */
export function useMe(): UseQueryResult<User, Error> {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => api.get<User>('/auth/me'),
    staleTime: 60_000,
  })
}

export function useUsers(): UseQueryResult<User[], Error> {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: () => api.get<User[]>('/identity/users'),
  })
}

export function useSquads(): UseQueryResult<Squad[], Error> {
  return useQuery({
    queryKey: queryKeys.squads,
    queryFn: () => api.get<Squad[]>('/identity/squads'),
  })
}

const DAEMON_REFRESH_MS = 2_000

export function useMachines(): UseQueryResult<Machine[], Error> {
  return useQuery({
    queryKey: queryKeys.machines,
    queryFn: () => api.get<Machine[]>('/machines'),
    // El daemon corre en otro proceso y puede registrar agentes después de que la
    // consola hizo su primera lectura. Sin polling, esa respuesta vacía queda en
    // cache indefinidamente porque no existe una mutación React que la invalide.
    refetchInterval: DAEMON_REFRESH_MS,
  })
}

export function useClientAccounts(): UseQueryResult<ClientAccount[], Error> {
  return useQuery({
    queryKey: queryKeys.clientAccounts,
    queryFn: () => api.get<ClientAccount[]>('/identity/client-accounts'),
  })
}

export function useServers(): UseQueryResult<McpServer[], Error> {
  return useQuery({
    queryKey: queryKeys.servers,
    queryFn: () => api.get<McpServer[]>('/catalog/servers'),
    // El core reintenta solo los servers que no conectaron; la lista lo refleja sin tocar nada.
    refetchInterval: DAEMON_REFRESH_MS,
  })
}

export function useSkills(): UseQueryResult<Skill[], Error> {
  return useQuery({
    queryKey: queryKeys.skills,
    queryFn: () => api.get<Skill[]>('/catalog/skills'),
  })
}

/** GET /policy/matrix. Sin `userId` trae la del usuario de la sesion.
 *  Pasar el propio id crea una segunda entrada de cache con el mismo contenido:
 *  para la persona logueada, dejarlo en undefined. */
export function useMatrix(userId?: string): UseQueryResult<MatrixResponse, Error> {
  return useQuery({
    queryKey: queryKeys.matrix(userId),
    queryFn: () => api.get<MatrixResponse>(withSearch('/policy/matrix', { user_id: userId })),
    refetchInterval: DAEMON_REFRESH_MS,
  })
}

export function useAuditEvents(filters: AuditEventFilters = {}): UseQueryResult<AuditEvent[], Error> {
  return useQuery({
    queryKey: queryKeys.auditEvents(filters),
    queryFn: () =>
      api.get<AuditEvent[]>(withSearch('/audit/events', { limit: filters.limit, action: filters.action })),
  })
}

export function useToolCalls(filters: ToolCallFilters = {}): UseQueryResult<ToolCallLog[], Error> {
  return useQuery({
    queryKey: queryKeys.toolCalls(filters),
    refetchInterval: 2000,
    queryFn: () =>
      api.get<ToolCallLog[]>(
        withSearch('/audit/tool-calls', { limit: filters.limit, agent_id: filters.agent_id }),
      ),
  })
}

/* -------------------------------------------------------------------------- */
/* Reglas de exposicion con actualizacion optimista                             */
/* -------------------------------------------------------------------------- */

/** Cuerpo de PUT /policy/rules. */
export interface SetRuleVars {
  scope: RuleScope
  /** Id del `agent_instance` en scope `client`. Vacio en scope `user`: el backend
   *  usa a quien escribe, que es la unica persona cuya politica puede tocar. */
  scope_id: string
  resource_type: ResourceType
  resource_id: string
  state: RuleState
  reason?: string
}

/** Celdas que toca una escritura: solo la del cliente en scope `client`, todas las
 *  del recurso cuando la regla vale para todos los clientes de la persona. */
function targetAgentIds(cells: Record<string, MatrixCell>, vars: SetRuleVars): string[] {
  if (vars.scope === 'client') return vars.scope_id in cells ? [vars.scope_id] : []
  return Object.keys(cells)
}

/** Aplica una regla sobre la matriz en memoria, sin ir al servidor.
 *
 *  Es deliberadamente conservadora: solo afirma lo que se puede deducir en el
 *  cliente.
 *  - `inherit` no cambia `exposed`, porque el valor efectivo depende del otro
 *    nivel; queda como estaba hasta que responda el PUT.
 *  - `propagation` baja a `pending_sync` en toda celda que ya se haya conectado:
 *    el snapshot acaba de cambiar y el daemon todavia no lo bajo. Las celdas en
 *    `unknown` (nunca se conectaron) siguen en `unknown`.
 *  - `source` y `detail` no se tocan: la explicacion real la calcula el backend.
 *  - solo se pinta la fila del recurso. Apagar un server deja sus tools pintadas
 *    como estaban hasta que responde el refetch; una pantalla que quiera anticipar
 *    ese caso puede volver a llamar a esta funcion sobre cada fila hija, que es
 *    pura y no toca la cache.
 */
export function applyRuleToMatrix(matrix: MatrixResponse, vars: SetRuleVars): MatrixResponse {
  let matrixChanged = false
  const rows = matrix.rows.map((row) => {
    if (row.resource_type !== vars.resource_type || row.resource_id !== vars.resource_id) return row

    let rowChanged = false
    const cells: Record<string, MatrixCell> = { ...row.cells }
    for (const agentId of targetAgentIds(row.cells, vars)) {
      const cell = cells[agentId]
      if (cell === undefined) continue

      const exposed = vars.state === 'inherit' ? cell.exposed : vars.state === 'on'
      const ownRule =
        vars.scope === 'client' ? (vars.state === 'inherit' ? null : vars.state) : cell.own_rule
      const propagation = cell.propagation === 'unknown' ? cell.propagation : 'pending_sync'
      if (exposed === cell.exposed && ownRule === cell.own_rule && propagation === cell.propagation) continue

      cells[agentId] = { ...cell, exposed, own_rule: ownRule, propagation }
      rowChanged = true
    }
    const userRule =
      vars.scope === 'user' ? (vars.state === 'inherit' ? null : vars.state) : row.user_rule
    if (!rowChanged && userRule === row.user_rule) return row
    matrixChanged = true
    return { ...row, cells, user_rule: userRule }
  })

  return matrixChanged ? { ...matrix, rows } : matrix
}

/** Devuelve las celdas de un recurso tal como estan ahora, para poder revertirlas. */
export function snapshotCells(
  matrix: MatrixResponse,
  resourceType: ResourceType,
  resourceId: string,
): Record<string, MatrixCell> | null {
  const row = matrix.rows.find((r) => r.resource_type === resourceType && r.resource_id === resourceId)
  return row ? { ...row.cells } : null
}

/** Revierte solo las celdas de un recurso. No se restaura la matriz entera a
 *  proposito: mientras un PUT falla puede haber otros toggles ya aplicados sobre
 *  otras filas, y pisarlos seria peor que el error que estamos deshaciendo. */
export function restoreMatrixCells(
  matrix: MatrixResponse,
  resourceType: ResourceType,
  resourceId: string,
  cells: Record<string, MatrixCell>,
): MatrixResponse {
  return {
    ...matrix,
    rows: matrix.rows.map((row) =>
      row.resource_type === resourceType && row.resource_id === resourceId
        ? { ...row, cells: { ...row.cells, ...cells } }
        : row,
    ),
  }
}

interface SetRuleContext {
  previousCells: Record<string, MatrixCell> | null
}

/**
 * PUT /policy/rules con actualizacion optimista de la matriz.
 *
 * La matriz se opera a golpes rapidos: esperar el ida y vuelta por cada toggle la
 * vuelve inusable. La celda se pinta al instante y, si el PUT falla, vuelve sola a
 * su valor anterior y el error sale por un toast.
 *
 * El refresco desde el servidor se hace una sola vez, cuando termina el ultimo
 * toggle en vuelo, para no disparar una consulta de matriz por click.
 *
 * @param userId matriz sobre la que se pinta. El mismo valor que se le paso a
 *               `useMatrix`, o undefined para la del usuario de la sesion.
 */
export function useSetRule(userId?: string): UseMutationResult<void, Error, SetRuleVars, SetRuleContext> {
  const queryClient = useQueryClient()
  const toast = useToast()
  const key = queryKeys.matrix(userId)

  return useMutation<void, Error, SetRuleVars, SetRuleContext>({
    mutationKey: SET_RULE_MUTATION_KEY,
    mutationFn: (vars) => api.put<void>('/policy/rules', vars),

    onMutate: async (vars) => {
      // Un refetch en vuelo que llegue despues del optimismo lo pisaria con datos viejos.
      await queryClient.cancelQueries({ queryKey: key })
      const current = queryClient.getQueryData<MatrixResponse>(key)
      if (current === undefined) return { previousCells: null }

      const previousCells = snapshotCells(current, vars.resource_type, vars.resource_id)
      queryClient.setQueryData<MatrixResponse>(key, applyRuleToMatrix(current, vars))
      return { previousCells }
    },

    onError: (error, vars, context) => {
      if (context?.previousCells) {
        const current = queryClient.getQueryData<MatrixResponse>(key)
        if (current !== undefined) {
          queryClient.setQueryData<MatrixResponse>(
            key,
            restoreMatrixCells(current, vars.resource_type, vars.resource_id, context.previousCells),
          )
        }
      }
      toast.error('No se pudo aplicar el cambio', errorMessage(error))
    },

    onSettled: () => {
      // Durante onSettled esta mutacion todavia cuenta como en vuelo: 1 significa
      // que es la ultima de la rafaga.
      if (queryClient.isMutating({ mutationKey: SET_RULE_MUTATION_KEY }) > 1) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.matrixAll })
      void queryClient.invalidateQueries({ queryKey: queryKeys.auditAll })
    },
  })
}

/* -------------------------------------------------------------------------- */
/* Invalidaciones compartidas                                                   */
/* -------------------------------------------------------------------------- */

/** Alta, edicion, sondeo o aceptacion de definiciones de un MCP server o skill.
 *
 *  Refresca tambien la matriz: un server nuevo aparece prendido en todas las
 *  columnas, y uno borrado se lleva sus filas. Refrescar solo el catalogo dejaria
 *  la pantalla central mostrando un estado que ya no existe. */
export async function invalidateAfterCatalogChange(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.servers }),
    queryClient.invalidateQueries({ queryKey: queryKeys.skills }),
    queryClient.invalidateQueries({ queryKey: queryKeys.matrixAll }),
    queryClient.invalidateQueries({ queryKey: queryKeys.auditAll }),
  ])
}

/** Alta o edicion de personas y squads. Cambia quien ve que, asi que la matriz
 *  tambien queda vieja. */
export async function invalidateAfterIdentityChange(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.users }),
    queryClient.invalidateQueries({ queryKey: queryKeys.squads }),
    queryClient.invalidateQueries({ queryKey: queryKeys.me }),
    queryClient.invalidateQueries({ queryKey: queryKeys.matrixAll }),
    queryClient.invalidateQueries({ queryKey: queryKeys.auditAll }),
  ])
}

/** Enrolar, borrar una maquina o habilitar un agente. Cambian las columnas de la matriz. */
export async function invalidateAfterMachineChange(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.machines }),
    queryClient.invalidateQueries({ queryKey: queryKeys.matrixAll }),
    queryClient.invalidateQueries({ queryKey: queryKeys.auditAll }),
  ])
}
