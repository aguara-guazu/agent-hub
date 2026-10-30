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

/** Clientes que el backend acepta en el equipo de la delegación (`agentSpec` en `packages/memory/src/project-automation.ts`). */
export const ROSTER_CLIS = ["claude_code", "codex_cli", "kiro"] as const
const MODEL_MAX = 300
const JIRA_KINDS: readonly DelegatedItemKind[] = ["jira_worklog", "jira_transition", "jira_comment"]

/** Campos del panel que pueden quedar marcados, en el orden en que aparecen (el primero recibe el foco). */
export const AUTOMATION_FIELDS = ["actions", "repositories", "channel", "coordinator.cli", "coordinator.model", "agent.cli", "agent.model"] as const
export type AutomationField = typeof AUTOMATION_FIELDS[number]
/** Motivo de cada campo: clave de `automations.project.validation`, o un código cerrado de `automations.project.errors`. */
export type FieldProblem =
  | { message: "actionsRequired" | "jiraKeyMissing" | "repositoriesNone" | "repositoriesRequired" | "repositoryBranches" | "repositoryMissing" | "cliUnsupported" | "modelRequired" | "modelTooLong" | "channel" | "invalid"; label?: "jiraKey" }
  | { code: AutomationErrorCode }
export type FieldProblems = Partial<Record<AutomationField, FieldProblem>>

/** Lo mismo que rechazaría el backend al activar, por campo, para marcarlo antes de enviar. */
export function validateDelegation(input: {
  kinds: DelegatedItemKind[]; repositories: string[]; coordinator: RosterEntry; agent: RosterEntry
  hasJira: boolean; available: ProjectRepositoryView[]
}): FieldProblems {
  const problems: FieldProblems = {}
  if (input.kinds.length === 0) problems.actions = { message: "actionsRequired" }
  else if (!input.hasJira && input.kinds.some(kind => JIRA_KINDS.includes(kind))) problems.actions = { message: "jiraKeyMissing", label: "jiraKey" }
  if (input.kinds.includes("git_push")) {
    const known = new Map(input.available.map(repo => [repo.id, repo]))
    if (input.repositories.length === 0) problems.repositories = { message: input.available.length === 0 ? "repositoriesNone" : "repositoriesRequired" }
    else if (input.repositories.some(id => !known.has(id))) problems.repositories = { message: "repositoryMissing" }
    else if (input.repositories.some(id => known.get(id)!.allowed_branches.length === 0)) problems.repositories = { message: "repositoryBranches" }
  }
  for (const [role, entry] of [["coordinator", input.coordinator], ["agent", input.agent]] as const) {
    if (!(ROSTER_CLIS as readonly string[]).includes(entry.cli)) problems[`${role}.cli`] = { message: "cliUnsupported" }
    const model = entry.model.trim()
    if (!model) problems[`${role}.model`] = { message: "modelRequired" }
    else if (model.length > MODEL_MAX) problems[`${role}.model`] = { message: "modelTooLong" }
  }
  return problems
}

/** Campo del panel al que apunta un rechazo del servidor (`field` del cuerpo de error), con su motivo; null si no se sabe. */
export function automationServerProblem(error: unknown): { field: AutomationField; problem: FieldProblem } | null {
  if (!(error instanceof ApiError) || !error.field) return null
  const field = error.field
  const code = automationErrorCode(error)
  const fallback: FieldProblem = code && code !== "invalid_document" ? { code } : { message: "invalid" }
  if (field.startsWith("document.item_kinds")) return { field: "actions", problem: { message: "actionsRequired" } }
  if (field.startsWith("document.repository_ids")) {
    const byReason: Record<string, FieldProblem> = { repositories_required: { message: "repositoriesRequired" }, branches_required: { message: "repositoryBranches" }, repository_missing: { message: "repositoryMissing" } }
    return { field: "repositories", problem: byReason[error.reason ?? ""] ?? fallback }
  }
  const roster = /^document\.roster\.(coordinator|project_agent)\.(cli|model|effort)/.exec(field)
  if (roster) {
    const role = roster[1] === "coordinator" ? "coordinator" : "agent"
    return roster[2] === "cli" ? { field: `${role}.cli`, problem: { message: "cliUnsupported" } } : { field: `${role}.model`, problem: fallback }
  }
  if (field === "channel_id") return { field: "channel", problem: { message: "channel" } }
  return null
}

export type RepositoryField = "repoPath" | "repoBranches"
export type RepositoryProblem =
  | { message: "repoPathRequired" | "repoPathAbsolute" | "repoPathNotFound" | "repoPathNotRoot" | "remoteAmbiguous" | "remoteInsecure" | "defaultBranchUnknown" | "branchesRequired" | "invalid" }
  | { message: "branchPatternInvalid" | "branchPatternDefault"; pattern: string }
  | { code: AutomationErrorCode }
export type RepositoryProblems = Partial<Record<RepositoryField, RepositoryProblem>>

const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/

/** Patrón de rama aceptado por el backend: una rama exacta o `prefijo/*`, sin comodín suelto. La rama principal solo la conoce el servidor. */
export function branchPatternValid(pattern: string): boolean {
  const exact = pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern
  return BRANCH.test(exact) && !exact.includes("..") && !exact.endsWith("/") && !exact.endsWith(".lock") && !exact.includes("*") && exact !== "HEAD"
}

export function parseBranches(text: string): string[] {
  return text.split(",").map(item => item.trim()).filter(Boolean)
}

export function validateRepository(path: string, branches: string[]): RepositoryProblems {
  const problems: RepositoryProblems = {}
  const trimmed = path.trim()
  if (!trimmed) problems.repoPath = { message: "repoPathRequired" }
  else if (!ABSOLUTE.test(trimmed)) problems.repoPath = { message: "repoPathAbsolute" }
  const invalid = branches.find(pattern => !branchPatternValid(pattern))
  if (branches.length === 0) problems.repoBranches = { message: "branchesRequired" }
  else if (invalid !== undefined) problems.repoBranches = { message: "branchPatternInvalid", pattern: invalid }
  return problems
}

/** Campo del formulario de repositorio al que apunta un rechazo del servidor; null si no se sabe. */
export function repositoryServerProblem(error: unknown, branches: string[]): { field: RepositoryField; problem: RepositoryProblem } | null {
  if (!(error instanceof ApiError) || !error.field) return null
  const code = automationErrorCode(error)
  const fallback: RepositoryProblem = code ? { code } : { message: "invalid" }
  if (error.field === "repo_path" || error.field === "remote_name") {
    const byReason: Record<string, RepositoryProblem> = {
      path_not_absolute: { message: "repoPathAbsolute" }, path_not_found: { message: "repoPathNotFound" }, path_not_repository_root: { message: "repoPathNotRoot" },
      remote_ambiguous: { message: "remoteAmbiguous" }, remote_insecure: { message: "remoteInsecure" }, default_branch_unknown: { message: "defaultBranchUnknown" },
    }
    return { field: "repoPath", problem: byReason[error.reason ?? ""] ?? fallback }
  }
  const branch = /^allowed_branches(?:\.(\d+))?/.exec(error.field)
  if (branch) {
    const pattern = branch[1] !== undefined ? branches[Number(branch[1])] : undefined
    if (error.reason === "branches_required") return { field: "repoBranches", problem: { message: "branchesRequired" } }
    if (pattern !== undefined && error.reason === "pattern_default_branch") return { field: "repoBranches", problem: { message: "branchPatternDefault", pattern } }
    if (pattern !== undefined) return { field: "repoBranches", problem: { message: "branchPatternInvalid", pattern } }
    return { field: "repoBranches", problem: fallback }
  }
  return null
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
