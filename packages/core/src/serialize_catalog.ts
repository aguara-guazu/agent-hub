/**
 * Serializadores de salida del catálogo, las máquinas y la auditoría. Las formas son
 * las de `frontend/src/lib/types.ts` y `backend/agenthub/api/schemas_*.py`.
 */
import { CLI_HOT_RELOAD, type CliKind } from '@agenthub/shared'
import type {
  AgentInstance,
  AuditEventRow,
  ClientAccount,
  Machine,
  McpServerRow,
  McpToolRow,
  SkillRow,
  ToolCallLogRow,
  User,
} from './types.js'
import { cmp } from './store.js'

function hotReload(cliKind: string): boolean {
  return CLI_HOT_RELOAD[cliKind as CliKind] ?? false
}

export function serializeTool(tool: McpToolRow) {
  return {
    id: tool.id,
    name: tool.name,
    exposed_name: tool.exposed_name,
    title: tool.title,
    description: tool.description,
    quarantined: tool.quarantined,
    quarantine_reason: tool.quarantine_reason,
  }
}

/**
 * `oauth_status` dice si hay una cuenta autorizada para un server `oauth`; el token en
 * sí nunca sale por la API.
 */
export interface OAuthView {
  authorized: boolean
  clientConfigured: boolean
}

export function serializeServer(server: McpServerRow, tools: McpToolRow[], oauth: OAuthView = { authorized: false, clientConfigured: false }) {
  return {
    id: server.id,
    slug: server.slug,
    display_name: server.display_name,
    description: server.description,
    transport: server.transport,
    command: server.command,
    args: [...server.args],
    env: { ...server.env },
    cwd: server.cwd,
    url: server.url,
    headers: { ...server.headers },
    secret_refs: { ...server.secret_refs },
    requires_host_access: server.requires_host_access,
    container_image: server.container_image,
    allow_hosts: [...server.allow_hosts],
    allow_ports: [...server.allow_ports],
    read_mounts: [...server.read_mounts],
    write_mounts: [...server.write_mounts],
    definition_hash: server.definition_hash,
    last_probe_error: server.last_probe_error,
    auth: server.auth,
    oauth_status: server.auth === 'oauth' ? (oauth.authorized ? 'authorized' : 'required') : 'none',
    oauth_client_configured: server.auth === 'oauth' && oauth.clientConfigured,
    tools: [...tools].sort((a, b) => cmp(a.name, b.name)).map(serializeTool),
  }
}

export function serializeSkill(skill: SkillRow) {
  return {
    id: skill.id,
    slug: skill.slug,
    display_name: skill.display_name,
    description: skill.description,
    body: skill.body,
    version: skill.version,
    content_hash: skill.content_hash,
    source: skill.source,
    source_path: skill.source_path,
    source_ref: skill.source_ref,
  }
}

export function serializeAgent(agent: AgentInstance, machine: Machine) {
  return {
    id: agent.id,
    machine_id: agent.machine_id,
    machine_hostname: machine.hostname,
    cli_kind: agent.cli_kind,
    cli_version: agent.cli_version,
    enabled: agent.enabled,
    last_connected_at: agent.last_connected_at,
    drift_detected: agent.drift_detected,
    drift_detail: agent.drift_detail,
    hot_reload: hotReload(agent.cli_kind),
    account_skills: agent.account_skills,
  }
}

export function serializeMachine(machine: Machine, owner: User, agents: AgentInstance[]) {
  return {
    id: machine.id,
    hostname: machine.hostname,
    os: machine.os,
    daemon_version: machine.daemon_version,
    last_seen_at: machine.last_seen_at,
    last_snapshot_hash: machine.last_snapshot_hash,
    user_id: machine.user_id,
    user_email: owner.email,
    agents: agents.map((agent) => serializeAgent(agent, machine)),
  }
}

export function serializeClientAccount(account: ClientAccount) {
  return { id: account.id, slug: account.slug, name: account.name }
}

export function serializeAuditEvent(event: AuditEventRow) {
  return {
    id: event.id,
    created_at: event.created_at,
    actor_label: event.actor_label,
    action: event.action,
    target_type: event.target_type,
    target_id: event.target_id,
    detail: event.detail,
  }
}

export function serializeToolCall(log: ToolCallLogRow) {
  return {
    id: log.id,
    created_at: log.created_at,
    agent_instance_id: log.agent_instance_id,
    server_slug: log.server_slug,
    tool_name: log.tool_name,
    exposed_name: log.exposed_name,
    decision: log.decision,
    denial_reason: log.denial_reason,
    duration_ms: log.duration_ms,
    error: log.error,
  }
}
