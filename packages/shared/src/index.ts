import { createHash, randomUUID } from 'node:crypto'

export type OrgRole = 'owner' | 'admin' | 'member'
export type SquadRole = 'lead' | 'member'
export type CliKind = 'claude_code' | 'codex_cli' | 'gemini_cli' | 'kiro'
export type Transport = 'stdio' | 'http'
/** Cómo se autentica el hub ante un MCP server http: nada/encabezados, u OAuth 2.1 en el navegador. */
export type ServerAuth = 'none' | 'oauth'
export type ResourceType = 'mcp_server' | 'mcp_tool' | 'skill'
export type RuleState = 'on' | 'off' | 'inherit'
export type RuleScope = 'user' | 'client'
export type PropagationState = 'applied_live' | 'applied_stale_list' | 'pending_restart' | 'pending_sync' | 'unknown'

export const CLI_KINDS: readonly CliKind[] = ['claude_code', 'codex_cli', 'gemini_cli', 'kiro']
export const CLI_HOT_RELOAD: Readonly<Record<CliKind, boolean>> = {
  claude_code: true,
  codex_cli: false,
  gemini_cli: false,
  kiro: false,
}

export interface SnapshotTool {
  id: string
  name: string
  exposed_name: string
  title: string
  description: string
  input_schema: Record<string, unknown>
  definition_hash: string
}

export interface SnapshotServer {
  id: string
  slug: string
  display_name: string
  transport: Transport
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  url: string
  headers: Record<string, string>
  secret_refs: Record<string, string>
  /** Ausente en snapshots viejos: equivale a `none`. */
  auth?: ServerAuth
  requires_host_access?: boolean
  container_image?: string
  allow_hosts?: string[]
  allow_ports?: number[]
  read_mounts?: string[]
  write_mounts?: string[]
  tools: SnapshotTool[]
}

export interface SnapshotSkill {
  id: string
  slug: string
  display_name: string
  description: string
  body: string
  version: number
  content_hash: string
}

export interface SnapshotDenied {
  resource_type: ResourceType
  resource_id: string
  slug: string
  exposed: string
  source: string
  detail: string
}

export interface PolicySnapshot {
  agent_instance_id: string
  cli_kind: CliKind
  user_id: string
  user_email: string
  machine_id: string
  servers: SnapshotServer[]
  skills: SnapshotSkill[]
  denied: SnapshotDenied[]
  snapshot_hash: string
  generated_at: string
}

export interface AgentInstance {
  id: string
  machine_id: string
  machine_hostname: string
  cli_kind: CliKind
  cli_version: string
  config_path?: string
  enabled: boolean
  last_connected_at: string | null
  last_snapshot_hash?: string | null
  last_listed_hash?: string | null
  drift_detected: boolean
  drift_detail: string
  hot_reload: boolean
}

export interface ToolCallReport {
  agent_id: string
  server_slug: string
  tool_name: string
  exposed_name: string
  decision: 'allowed' | 'denied' | 'error'
  denial_reason: string
  args_digest: string
  duration_ms: number
  error: string
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function digestJson(value: unknown): string {
  return sha256(canonicalJson(value))
}

export function newId(): string {
  return randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function slugifySegment(value: string): string {
  const normalized = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const slug = normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_')
  return slug || 'tool'
}

export function buildExposedName(serverSlug: string, toolName: string): string {
  const base = `${slugifySegment(serverSlug)}_${slugifySegment(toolName)}`
  if (base.length <= 64) return base
  return `${base.slice(0, 55).replace(/_+$/g, '')}_${sha256(base).slice(0, 8)}`
}

export function snapshotHash(snapshot: Omit<PolicySnapshot, 'snapshot_hash' | 'generated_at'>): string {
  return digestJson(snapshot)
}

export function argsDigest(args: unknown): string {
  return digestJson(args)
}
