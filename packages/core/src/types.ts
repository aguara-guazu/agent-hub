/**
 * Tipos de dominio del control plane, deshidratados desde las filas SQLite.
 *
 * Espejan los modelos SQLAlchemy de `backend/agenthub/models/`. Los campos JSON ya
 * vienen parseados (args, env, headers, secret_refs, input_schema, detail, payload) y
 * los timestamps como texto ISO-8601 UTC.
 */
import type { CliKind, ResourceType, RuleState, ServerAuth, Transport } from '@agenthub/shared'

export type OrgRole = 'owner' | 'admin' | 'member'
export type SquadRole = 'lead' | 'member'

export interface Organization {
  id: string
  slug: string
  name: string
}

export interface ClientAccount {
  id: string
  organization_id: string
  slug: string
  name: string
}

export interface Squad {
  id: string
  organization_id: string
  slug: string
  name: string
  client_account_id: string | null
}

export interface User {
  id: string
  organization_id: string
  email: string
  full_name: string
  password_hash: string
  org_role: OrgRole
  is_active: boolean
  created_at: string
}

export interface SquadMembership {
  id: string
  squad_id: string
  user_id: string
  role: SquadRole
  valid_from: string | null
  valid_to: string | null
}

export interface Machine {
  id: string
  user_id: string
  hostname: string
  os: string
  daemon_version: string
  last_seen_at: string | null
  last_snapshot_hash: string | null
}

export interface AgentInstance {
  id: string
  machine_id: string
  cli_kind: CliKind
  cli_version: string
  config_path: string
  enabled: boolean
  last_connected_at: string | null
  last_listed_hash: string | null
  drift_detected: boolean
  drift_detail: string
}

export interface ApiToken {
  id: string
  user_id: string
  machine_id: string | null
  agent_instance_id: string | null
  name: string
  token_hash: string
  expires_at: string | null
  revoked_at: string | null
  last_used_at: string | null
}

export interface McpServerRow {
  id: string
  user_id: string
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
  requires_host_access: boolean
  container_image: string
  allow_hosts: string[]
  allow_ports: number[]
  read_mounts: string[]
  write_mounts: string[]
  definition_hash: string
  last_probe_error: string
  /** `none` (encabezados estáticos o nada) u `oauth` (cuenta autorizada en el navegador). */
  auth: ServerAuth
}

export interface McpToolRow {
  id: string
  server_id: string
  name: string
  exposed_name: string
  title: string
  description: string
  input_schema: Record<string, unknown>
  definition_hash: string
  quarantined: boolean
  quarantine_reason: string
}

export interface SkillRow {
  id: string
  user_id: string
  slug: string
  display_name: string
  description: string
  body: string
  version: number
  content_hash: string
}

export interface ExposureRule {
  id: string
  user_id: string
  agent_instance_id: string | null
  resource_type: ResourceType
  resource_id: string
  state: RuleState
  reason: string
}

export interface AuditEventRow {
  id: string
  organization_id: string
  actor_user_id: string | null
  actor_label: string
  action: string
  target_type: string
  target_id: string
  detail: Record<string, unknown>
  prev_hash: string
  event_hash: string
  created_at: string
}

export interface ToolCallLogRow {
  id: string
  organization_id: string
  agent_instance_id: string | null
  user_id: string | null
  server_slug: string
  tool_name: string
  exposed_name: string
  decision: string
  denial_reason: string
  args_digest: string
  duration_ms: number
  error: string
  created_at: string
}
