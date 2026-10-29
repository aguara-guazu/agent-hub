import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from './api'
import { useMemory } from './memory'
import { useToast } from '../components/Toast'

/**
 * Activación por proyecto (área D). Formas provisorias según la propuesta de Tala; se alinean con
 * `packages/memory/src/project-automation.ts` (ProjectAutomationView, DelegationDocument, ProjectRepositoryView).
 */

export type DelegatedItemKind = 'jira_worklog' | 'jira_transition' | 'jira_comment' | 'git_push'
export interface RosterEntry { cli: string; model: string; effort?: string }

export interface DelegationDocument {
  schema_version: 1
  roster: { coordinator: RosterEntry; project_agent: RosterEntry }
  item_kinds: DelegatedItemKind[]
  repository_ids: string[]
  limits: { max_concurrent_plans: number; max_runtime_minutes: number }
}

export interface ProjectRepositoryView { id: string; repo_path: string; canonical_remote_url: string; remote_name: string; default_branch: string; allowed_branches: string[] }

export interface ProjectAutomationView {
  project_id: string
  enabled: boolean
  delegation: null | { version: number; digest: string; approval_source: 'owner_ui' | 'coordinator_declaration'; instruction: string | null; created_at: string; revoked_at: string | null; document: DelegationDocument }
  channel: { id: string; name: string } | null
  channel_candidates: { id: string; name: string }[]
  coordinator: 'ready' | 'no_channel' | 'disabled'
  repositories: ProjectRepositoryView[]
  history?: { version: number; digest: string; approval_source: string; created_at: string; revoked_at: string | null }[]
  /** Provisional: valores sugeridos para un proyecto sin delegación. */
  defaults?: { coordinator?: RosterEntry; project_agent?: RosterEntry }
}

/** Nombre en lenguaje claro de cada tipo de acción que una delegación permite proponer. */
export const ITEM_KIND_LABELS: Record<DelegatedItemKind, string> = {
  jira_worklog: 'Registrar horas en Jira',
  jira_transition: 'Cambiar el estado de tareas en Jira',
  jira_comment: 'Comentar tareas en Jira',
  git_push: 'Hacer push de ramas (nunca a la principal ni con force)',
}

export const DEFAULT_LIMITS = { max_concurrent_plans: 1, max_runtime_minutes: 60 } as const

/** Reconstruye el documento con solo los campos vigentes: el esquema estricto del backend rechaza con 422 cualquier campo retirado (p. ej. `max_members`). */
export function cleanDocument(document: DelegationDocument): DelegationDocument {
  const entry = (value: RosterEntry): RosterEntry => ({ cli: value.cli, model: value.model, ...(value.effort ? { effort: value.effort } : {}) })
  return {
    schema_version: 1,
    roster: { coordinator: entry(document.roster.coordinator), project_agent: entry(document.roster.project_agent) },
    item_kinds: [...document.item_kinds], repository_ids: [...document.repository_ids],
    limits: { max_concurrent_plans: document.limits.max_concurrent_plans, max_runtime_minutes: document.limits.max_runtime_minutes },
  }
}

export const AUTOMATION_ERRORS: Record<string, string> = {
  stale_version: 'La configuración cambió desde que abriste esta pantalla; recárgala y vuelve a confirmar.',
  plan_active: 'Hay un plan en ejecución para este proyecto; espera a que termine para cambiar el equipo o desactivar.',
  invalid_document: 'La configuración no es válida; revisa los campos.',
  repository_unavailable: 'No se pudo resolver el repositorio o su remoto.',
  channel_not_authorized: 'El canal elegido no está autorizado para este proyecto.',
  remote_not_allowed: 'El remoto de ese repositorio no está permitido.',
  branch_invalid: 'Algún patrón de rama no es válido.',
  repository_in_use: 'El repositorio está en uso por la delegación vigente; quítalo de ella antes de cambiarlo.',
  stale_repositories: 'La lista de repositorios cambió; recarga la pantalla y vuelve a intentarlo.',
}

export function automationKey(projectId: string) { return ['project-automation', projectId] as const }

export function useProjectAutomation(projectId: string) {
  return useQuery({ queryKey: automationKey(projectId), queryFn: () => api.get<ProjectAutomationView>(`/memory/projects/${encodeURIComponent(projectId)}/automation`) })
}

export function useSaveProjectAutomation(projectId: string) {
  const cache = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (body: { enabled: boolean; expected_version: number | null; channel_id: string | null; document: DelegationDocument }) =>
      api.put<ProjectAutomationView>(`/memory/projects/${encodeURIComponent(projectId)}/automation`, body),
    onSuccess: async view => {
      cache.setQueryData(automationKey(projectId), view)
      await Promise.all([cache.invalidateQueries({ queryKey: ['schedules'] }), cache.invalidateQueries({ queryKey: ['memory'] })])
    },
    onError: error => { toast.error('No se pudo guardar la activación', error instanceof ApiError && error.code && AUTOMATION_ERRORS[error.code] ? AUTOMATION_ERRORS[error.code]! : error.message) },
  })
}

/** Agrega o actualiza un repositorio (`POST …/repositories`); el backend resuelve el remoto y la rama principal. */
export function useAddRepository(projectId: string) {
  const cache = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (repository: { repo_path: string; remote_name?: string; allowed_branches: string[] }) =>
      api.post<{ repository: ProjectRepositoryView }>(`/memory/projects/${encodeURIComponent(projectId)}/repositories`, repository),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: automationKey(projectId) }) },
    onError: error => { toast.error('No se pudo guardar el repositorio', error instanceof ApiError && error.code && AUTOMATION_ERRORS[error.code] ? AUTOMATION_ERRORS[error.code]! : error.message) },
  })
}

/**
 * Fuente Google que recibe el envío: la de la cuenta `destination` (`account_email`); sin coincidencia solo se usa si es la única,
 * porque con varias cuentas conectadas elegir la primera podría autorizar el envío desde otra cuenta.
 */
export function pickGoogleSource<T extends { provider: string; account_email?: string | null }>(connectors: readonly T[] | undefined, destination?: string): T | undefined {
  const sources = (connectors ?? []).filter(connector => connector.provider === 'google')
  const wanted = destination?.trim().toLowerCase()
  const byAccount = wanted ? sources.filter(source => source.account_email?.toLowerCase() === wanted) : []
  if (byAccount.length === 1) return byAccount[0]
  return sources.length === 1 && byAccount.length === 0 ? sources[0] : undefined
}

/**
 * Abre la autorización completa (lectura y envío) de la fuente. `start` recibe `{ gmail_send: true }` para pedir el scope de envío en el mismo
 * consentimiento y el callback guarda `gmail_send_enabled` solo si Google lo concede: cancelar no deja la fuente a medio configurar.
 */
export function useAuthorizeGmailSend(destination?: string) {
  const toast = useToast()
  const cache = useQueryClient()
  const connectors = useMemory<any[]>('list_connectors', {})
  const google = pickGoogleSource(connectors.data, destination)
  const ambiguous = Boolean(connectors.data) && !google && (connectors.data?.filter(connector => connector.provider === 'google').length ?? 0) > 1
  const authorize = useMutation({
    mutationFn: async () => {
      if (!google) throw new Error('No se pudo determinar la fuente de Google de esa cuenta')
      const started = await api.post<{ authorization_url: string; gmail_send: boolean }>(`/memory/connectors/${encodeURIComponent(google.id)}/google/start`, { gmail_send: true })
      window.open(started.authorization_url, '_blank', 'noopener,noreferrer')
    },
    onSuccess: async () => { await Promise.all([cache.invalidateQueries({ queryKey: ['memory'] }), cache.invalidateQueries({ queryKey: ['delivery-channels'] })]) },
    onError: error => { toast.error('No se pudo iniciar la autorización', error.message) },
  })
  return { google, ambiguous, authorize }
}
