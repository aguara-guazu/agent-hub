import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from './api'
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
  limits: { max_concurrent_plans: number; max_members: number; max_runtime_minutes: number }
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

export const DEFAULT_LIMITS = { max_concurrent_plans: 1, max_members: 2, max_runtime_minutes: 60 } as const

export const AUTOMATION_ERRORS: Record<string, string> = {
  stale_version: 'La configuración cambió desde que abriste esta pantalla; recárgala y vuelve a confirmar.',
  plan_active: 'Hay un plan en ejecución para este proyecto; espera a que termine para cambiar el equipo o desactivar.',
  invalid_document: 'La configuración no es válida; revisa los campos.',
  repository_unavailable: 'No se pudo resolver el repositorio o su remoto.',
  channel_not_authorized: 'El canal elegido no está autorizado para este proyecto.',
  remote_not_allowed: 'El remoto de ese repositorio no está permitido.',
  branch_invalid: 'Algún patrón de rama no es válido.',
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

export function useSaveRepositories(projectId: string) {
  const cache = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (repositories: { repo_path: string; remote_name?: string; allowed_branches: string[] }[]) =>
      api.put<{ repositories: ProjectRepositoryView[] }>(`/memory/projects/${encodeURIComponent(projectId)}/repositories`, { repositories }),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: automationKey(projectId) }) },
    onError: error => { toast.error('No se pudo guardar el repositorio', error instanceof ApiError && error.code && AUTOMATION_ERRORS[error.code] ? AUTOMATION_ERRORS[error.code]! : error.message) },
  })
}
