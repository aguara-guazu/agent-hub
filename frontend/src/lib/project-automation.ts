import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, ApiError } from "./api"

/**
 * Activación por proyecto del brief y el cierre. Formas alineadas con `packages/memory/src/project-automation.ts`
 * (ProjectAutomationView, DelegationDocument, ProjectRepositoryView). Los errores los muestra quien llama.
 */

export type DelegatedItemKind = "jira_worklog" | "jira_transition" | "jira_comment" | "git_push"
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
  delegation: null | { version: number; digest: string; approval_source: "owner_ui" | "coordinator_declaration"; instruction: string | null; created_at: string; revoked_at: string | null; document: DelegationDocument }
  channel: { id: string; name: string } | null
  channel_candidates: { id: string; name: string }[]
  coordinator: "ready" | "no_channel" | "disabled"
  repositories: ProjectRepositoryView[]
  history?: { version: number; digest: string; approval_source: string; created_at: string; revoked_at: string | null }[]
  /** Provisional: valores sugeridos para un proyecto sin delegación. */
  defaults?: { coordinator?: RosterEntry; project_agent?: RosterEntry }
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

/** Códigos cerrados de las rutas de activación y repositorios; el texto vive en i18n (`automations.project.errors`). */
export const AUTOMATION_ERROR_CODES = [
  "stale_version", "plan_active", "invalid_document", "repository_unavailable", "channel_not_authorized",
  "remote_not_allowed", "branch_invalid", "repository_in_use", "stale_repositories",
] as const
export type AutomationErrorCode = typeof AUTOMATION_ERROR_CODES[number]

export function automationErrorCode(error: unknown): AutomationErrorCode | null {
  const code = error instanceof ApiError ? error.code : undefined
  return (AUTOMATION_ERROR_CODES as readonly string[]).includes(code ?? "") ? code as AutomationErrorCode : null
}

export function automationKey(projectId: string) { return ["project-automation", projectId] as const }

export function useProjectAutomation(projectId: string) {
  return useQuery({ queryKey: automationKey(projectId), queryFn: () => api.get<ProjectAutomationView>(`/memory/projects/${encodeURIComponent(projectId)}/automation`) })
}

export function useSaveProjectAutomation(projectId: string) {
  const cache = useQueryClient()
  return useMutation({
    mutationFn: (body: { enabled: boolean; expected_version: number | null; channel_id: string | null; document: DelegationDocument }) =>
      api.put<ProjectAutomationView>(`/memory/projects/${encodeURIComponent(projectId)}/automation`, body),
    onSuccess: async view => {
      cache.setQueryData(automationKey(projectId), view)
      await Promise.all([cache.invalidateQueries({ queryKey: ["schedules"] }), cache.invalidateQueries({ queryKey: ["memory"] })])
    },
  })
}

/** Agrega o actualiza un repositorio (`POST …/repositories`, un elemento por llamada); el backend resuelve el remoto y la rama principal. */
export function useAddRepository(projectId: string) {
  const cache = useQueryClient()
  return useMutation({
    mutationFn: (repository: { repo_path: string; remote_name?: string; allowed_branches: string[] }) =>
      api.post<{ repository: ProjectRepositoryView }>(`/memory/projects/${encodeURIComponent(projectId)}/repositories`, repository),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: automationKey(projectId) }) },
  })
}
