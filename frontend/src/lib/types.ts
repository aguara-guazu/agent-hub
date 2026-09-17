/** Tipos que reflejan los esquemas de `packages/core` y `@agenthub/shared`. */

export type OrgRole = 'owner' | 'admin' | 'member'
export type SquadRole = 'lead' | 'member'
export type CliKind = 'claude_code' | 'codex_cli' | 'gemini_cli' | 'kiro' | 'claude_desktop' | 'opencode'
export type Transport = 'stdio' | 'http'
export type ServerAuth = 'none' | 'oauth'
export type OAuthStatus = 'none' | 'required' | 'authorized'
export type ResourceType = 'mcp_server' | 'mcp_tool' | 'skill'
export type RuleState = 'on' | 'off' | 'inherit'
/** Los dos unicos niveles: lo que vale para todos mis clientes, y este cliente. */
export type RuleScope = 'user' | 'client'
export type PropagationState =
  | 'applied_live'
  | 'applied_stale_list'
  | 'pending_restart'
  | 'pending_sync'
  | 'unknown'

export const CLI_LABELS: Record<CliKind, string> = {
  claude_code: 'Claude Code',
  codex_cli: 'Codex CLI',
  gemini_cli: 'Gemini CLI',
  kiro: 'Kiro',
  claude_desktop: 'Claude Desktop',
  opencode: 'OpenCode',
}

/** Solo Claude Code refresca su lista de herramientas en caliente. Los demas la
 *  siguen mostrando hasta reiniciar, y el modelo recibe un error si la llama. */
export const CLI_HOT_RELOAD: Record<CliKind, boolean> = {
  claude_code: true,
  codex_cli: false,
  gemini_cli: false,
  kiro: false,
  claude_desktop: false,
  opencode: false,
}

/** Si el cliente carga skills desde el disco. Claude Desktop sólo las acepta subidas desde su interfaz. */
export const CLI_FILE_SKILLS: Record<CliKind, boolean> = {
  claude_code: true,
  codex_cli: true,
  gemini_cli: true,
  kiro: true,
  claude_desktop: false,
  opencode: true,
}

export interface User {
  id: string
  email: string
  full_name: string
  org_role: OrgRole
  is_active: boolean
  squads: { id: string; slug: string; name: string; role: SquadRole }[]
  /** Nombre de la organización, tal como lo devuelve el backend. En el hub local es
   *  «Local»; en una instalación de empresa, el nombre de esa empresa. */
  organization: string
}

export interface Squad {
  id: string
  slug: string
  name: string
  client_account_id: string | null
  member_count: number
}

export interface ClientAccount { id: string; slug: string; name: string }

export interface McpTool {
  id: string
  name: string
  exposed_name: string
  title: string
  description: string
  quarantined: boolean
  quarantine_reason: string
}

export interface McpServer {
  id: string
  slug: string
  display_name: string
  description: string
  transport: Transport
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  url: string
  headers: Record<string, string>
  secret_refs: Record<string, string>
  /** La excepción declarada: corre sin aislar porque necesita el filesystem o las
   *  credenciales de la persona (git, kubectl, terraform). */
  requires_host_access: boolean
  container_image: string
  allow_hosts: string[]
  allow_ports: number[]
  read_mounts: string[]
  write_mounts: string[]
  definition_hash: string
  last_probe_error: string
  /** `oauth`: la cuenta se autoriza en el navegador; el token nunca viaja por la API. */
  auth: ServerAuth
  oauth_status: OAuthStatus
  /** Hay un cliente OAuth (registrado solo o cargado a mano); el secreto nunca viaja. */
  oauth_client_configured: boolean
  tools: McpTool[]
}

export interface Skill {
  id: string
  slug: string
  display_name: string
  description: string
  body: string
  version: number
  content_hash: string
}

export interface AgentInstance {
  id: string
  machine_id: string
  machine_hostname: string
  cli_kind: CliKind
  cli_version: string
  enabled: boolean
  last_connected_at: string | null
  drift_detected: boolean
  drift_detail: string
  hot_reload: boolean
}

export interface Machine {
  id: string
  hostname: string
  os: string
  daemon_version: string
  last_seen_at: string | null
  last_snapshot_hash: string | null
  user_id: string
  user_email: string
  agents: AgentInstance[]
}

/** Una celda de la matriz: el estado efectivo de un recurso en un agente. */
export interface MatrixCell {
  agent_id: string
  exposed: boolean
  source: string
  detail: string
  /** Regla propia de ESTE cliente. `null` significa que hereda de la persona. */
  own_rule: RuleState | null
  propagation: PropagationState
}

export interface MatrixRow {
  resource_type: ResourceType
  resource_id: string
  slug: string
  label: string
  parent_id: string | null
  description: string
  /** Regla de la persona, la que vale para todos sus clientes. */
  user_rule: RuleState | null
  cells: Record<string, MatrixCell>
}

export interface MatrixResponse {
  user_id: string
  agents: AgentInstance[]
  rows: MatrixRow[]
}

export interface AuditEvent {
  id: string
  created_at: string
  actor_label: string
  action: string
  target_type: string
  target_id: string
  detail: Record<string, unknown>
}

export interface ToolCallLog {
  id: string
  created_at: string
  agent_instance_id: string | null
  server_slug: string
  tool_name: string
  exposed_name: string
  decision: string
  denial_reason: string
  duration_ms: number
  error: string
}

export interface Explanation {
  exposed: boolean
  source: string
  detail: string
}
