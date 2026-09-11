/**
 * Capa de acceso a datos: hidrata filas SQLite a los tipos de dominio y expone las
 * consultas que usan el resolver, la matriz, el ledger y los routers. Concentra el
 * parseo de JSON y la conversión de enteros SQLite (0/1) a booleanos en un solo lugar.
 */
import { newId, nowIso } from '@agenthub/shared'
import type { Database, Row } from './db/database.js'
import type {
  AgentInstance,
  ApiToken,
  AuditEventRow,
  ClientAccount,
  ExposureRule,
  Machine,
  McpServerRow,
  McpToolRow,
  Organization,
  SkillRow,
  Squad,
  SquadMembership,
  ToolCallLogRow,
  User,
} from './types.js'

function bool(value: unknown): boolean {
  return value === 1 || value === true || value === '1'
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function nullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

// ---------------------------------------------------------------- hidratación

function toOrganization(row: Row): Organization {
  return { id: str(row.id), slug: str(row.slug), name: str(row.name) }
}

function toUser(row: Row): User {
  return {
    id: str(row.id),
    organization_id: str(row.organization_id),
    email: str(row.email),
    full_name: str(row.full_name),
    password_hash: str(row.password_hash),
    org_role: str(row.org_role) as User['org_role'],
    is_active: bool(row.is_active),
    created_at: str(row.created_at),
  }
}

function toSquad(row: Row): Squad {
  return {
    id: str(row.id),
    organization_id: str(row.organization_id),
    slug: str(row.slug),
    name: str(row.name),
    client_account_id: nullableStr(row.client_account_id),
  }
}

function toClientAccount(row: Row): ClientAccount {
  return {
    id: str(row.id),
    organization_id: str(row.organization_id),
    slug: str(row.slug),
    name: str(row.name),
  }
}

function toMembership(row: Row): SquadMembership {
  return {
    id: str(row.id),
    squad_id: str(row.squad_id),
    user_id: str(row.user_id),
    role: str(row.role) as SquadMembership['role'],
    valid_from: nullableStr(row.valid_from),
    valid_to: nullableStr(row.valid_to),
  }
}

function toMachine(row: Row): Machine {
  return {
    id: str(row.id),
    user_id: str(row.user_id),
    hostname: str(row.hostname),
    os: str(row.os),
    daemon_version: str(row.daemon_version),
    last_seen_at: nullableStr(row.last_seen_at),
    last_snapshot_hash: nullableStr(row.last_snapshot_hash),
  }
}

function toAgent(row: Row): AgentInstance {
  return {
    id: str(row.id),
    machine_id: str(row.machine_id),
    cli_kind: str(row.cli_kind) as AgentInstance['cli_kind'],
    cli_version: str(row.cli_version),
    config_path: str(row.config_path),
    enabled: bool(row.enabled),
    last_connected_at: nullableStr(row.last_connected_at),
    last_listed_hash: nullableStr(row.last_listed_hash),
    drift_detected: bool(row.drift_detected),
    drift_detail: str(row.drift_detail),
  }
}

function toToken(row: Row): ApiToken {
  return {
    id: str(row.id),
    user_id: str(row.user_id),
    machine_id: nullableStr(row.machine_id),
    agent_instance_id: nullableStr(row.agent_instance_id),
    name: str(row.name),
    token_hash: str(row.token_hash),
    expires_at: nullableStr(row.expires_at),
    revoked_at: nullableStr(row.revoked_at),
    last_used_at: nullableStr(row.last_used_at),
  }
}

function toServer(row: Row): McpServerRow {
  return {
    id: str(row.id),
    user_id: str(row.user_id),
    slug: str(row.slug),
    display_name: str(row.display_name),
    description: str(row.description),
    transport: str(row.transport) as McpServerRow['transport'],
    command: str(row.command),
    args: json<string[]>(row.args, []),
    env: json<Record<string, string>>(row.env, {}),
    cwd: str(row.cwd),
    url: str(row.url),
    headers: json<Record<string, string>>(row.headers, {}),
    secret_refs: json<Record<string, string>>(row.secret_refs, {}),
    requires_host_access: bool(row.requires_host_access),
    container_image: str(row.container_image),
    allow_hosts: json<string[]>(row.allow_hosts, []),
    allow_ports: json<number[]>(row.allow_ports, []),
    read_mounts: json<string[]>(row.read_mounts, []),
    write_mounts: json<string[]>(row.write_mounts, []),
    definition_hash: str(row.definition_hash),
    last_probe_error: str(row.last_probe_error),
    auth: (str(row.auth) || 'none') as McpServerRow['auth'],
  }
}

function toTool(row: Row): McpToolRow {
  return {
    id: str(row.id),
    server_id: str(row.server_id),
    name: str(row.name),
    exposed_name: str(row.exposed_name),
    title: str(row.title),
    description: str(row.description),
    input_schema: json<Record<string, unknown>>(row.input_schema, {}),
    definition_hash: str(row.definition_hash),
    quarantined: bool(row.quarantined),
    quarantine_reason: str(row.quarantine_reason),
  }
}

function toSkill(row: Row): SkillRow {
  return {
    id: str(row.id),
    user_id: str(row.user_id),
    slug: str(row.slug),
    display_name: str(row.display_name),
    description: str(row.description),
    body: str(row.body),
    version: Number(row.version ?? 1),
    content_hash: str(row.content_hash),
  }
}

function toRule(row: Row): ExposureRule {
  return {
    id: str(row.id),
    user_id: str(row.user_id),
    agent_instance_id: nullableStr(row.agent_instance_id),
    resource_type: str(row.resource_type) as ExposureRule['resource_type'],
    resource_id: str(row.resource_id),
    state: str(row.state) as ExposureRule['state'],
    reason: str(row.reason),
  }
}

function toAuditEvent(row: Row): AuditEventRow {
  return {
    id: str(row.id),
    organization_id: str(row.organization_id),
    actor_user_id: nullableStr(row.actor_user_id),
    actor_label: str(row.actor_label),
    action: str(row.action),
    target_type: str(row.target_type),
    target_id: str(row.target_id),
    detail: json<Record<string, unknown>>(row.detail, {}),
    prev_hash: str(row.prev_hash),
    event_hash: str(row.event_hash),
    created_at: str(row.created_at),
  }
}

function toToolCall(row: Row): ToolCallLogRow {
  return {
    id: str(row.id),
    organization_id: str(row.organization_id),
    agent_instance_id: nullableStr(row.agent_instance_id),
    user_id: nullableStr(row.user_id),
    server_slug: str(row.server_slug),
    tool_name: str(row.tool_name),
    exposed_name: str(row.exposed_name),
    decision: str(row.decision),
    denial_reason: str(row.denial_reason),
    args_digest: str(row.args_digest),
    duration_ms: Number(row.duration_ms ?? 0),
    error: str(row.error),
    created_at: str(row.created_at),
  }
}

/** Comparación estable independiente de la colación del motor (byte a byte Unicode). */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Fachada de acceso a datos sobre una `Database`. */
export class Store {
  constructor(readonly db: Database) {}

  // ------------------------------------------------------------- organizaciones
  organizationBySlug(slug: string): Organization | undefined {
    const row = this.db.get('SELECT * FROM organizations WHERE slug = ?', slug)
    return row ? toOrganization(row) : undefined
  }

  organization(id: string): Organization | undefined {
    const row = this.db.get('SELECT * FROM organizations WHERE id = ?', id)
    return row ? toOrganization(row) : undefined
  }

  organizationsByIds(ids: string[]): Organization[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    return this.db.all(`SELECT * FROM organizations WHERE id IN (${placeholders})`, ...ids).map(toOrganization)
  }

  insertOrganization(slug: string, name: string): Organization {
    const id = newId()
    const at = nowIso()
    this.db.run(
      'INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      id, slug, name, at, at,
    )
    return { id, slug, name }
  }

  // ------------------------------------------------------------- usuarios
  user(id: string): User | undefined {
    const row = this.db.get('SELECT * FROM users WHERE id = ?', id)
    return row ? toUser(row) : undefined
  }

  usersByEmail(email: string): User[] {
    return this.db
      .all('SELECT * FROM users WHERE email = ? ORDER BY created_at, id', email)
      .map(toUser)
  }

  usersOfOrg(orgId: string): User[] {
    return this.db
      .all('SELECT * FROM users WHERE organization_id = ? ORDER BY email', orgId)
      .map(toUser)
  }

  firstUserOfOrg(orgId: string): User | undefined {
    const row = this.db.get(
      'SELECT * FROM users WHERE organization_id = ? ORDER BY created_at, id LIMIT 1',
      orgId,
    )
    return row ? toUser(row) : undefined
  }

  activeOwnersExcept(orgId: string, userId: string): User[] {
    return this.db
      .all(
        "SELECT * FROM users WHERE organization_id = ? AND org_role = 'owner' AND is_active = 1 AND id != ?",
        orgId, userId,
      )
      .map(toUser)
  }

  insertUser(input: {
    organization_id: string
    email: string
    full_name: string
    password_hash: string
    org_role: string
    is_active?: boolean
  }): User {
    const id = newId()
    const at = nowIso()
    this.db.run(
      `INSERT INTO users (id, organization_id, email, full_name, password_hash, org_role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.organization_id, input.email, input.full_name, input.password_hash,
      input.org_role, input.is_active === false ? 0 : 1, at, at,
    )
    return this.user(id)!
  }

  updateUser(id: string, fields: { full_name?: string; org_role?: string; is_active?: boolean }): void {
    const sets: string[] = []
    const params: (string | number)[] = []
    if (fields.full_name !== undefined) { sets.push('full_name = ?'); params.push(fields.full_name) }
    if (fields.org_role !== undefined) { sets.push('org_role = ?'); params.push(fields.org_role) }
    if (fields.is_active !== undefined) { sets.push('is_active = ?'); params.push(fields.is_active ? 1 : 0) }
    if (sets.length === 0) return
    sets.push('updated_at = ?'); params.push(nowIso())
    params.push(id)
    this.db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params)
  }

  // ------------------------------------------------------------- squads / membresías
  squad(id: string): Squad | undefined {
    const row = this.db.get('SELECT * FROM squads WHERE id = ?', id)
    return row ? toSquad(row) : undefined
  }

  squadsOfOrg(orgId: string): Squad[] {
    return this.db.all('SELECT * FROM squads WHERE organization_id = ? ORDER BY slug', orgId).map(toSquad)
  }

  squadBySlug(orgId: string, slug: string): Squad | undefined {
    const row = this.db.get('SELECT * FROM squads WHERE organization_id = ? AND slug = ?', orgId, slug)
    return row ? toSquad(row) : undefined
  }

  insertSquad(input: { organization_id: string; slug: string; name: string; client_account_id: string | null }): Squad {
    const id = newId()
    const at = nowIso()
    this.db.run(
      'INSERT INTO squads (id, organization_id, slug, name, client_account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, input.organization_id, input.slug, input.name, input.client_account_id, at, at,
    )
    return this.squad(id)!
  }

  membershipsOfSquad(squadId: string): SquadMembership[] {
    return this.db.all('SELECT * FROM squad_memberships WHERE squad_id = ?', squadId).map(toMembership)
  }

  membershipsOfSquads(squadIds: string[]): SquadMembership[] {
    if (squadIds.length === 0) return []
    const placeholders = squadIds.map(() => '?').join(',')
    return this.db
      .all(`SELECT * FROM squad_memberships WHERE squad_id IN (${placeholders})`, ...squadIds)
      .map(toMembership)
  }

  membershipsOfUsers(userIds: string[]): { membership: SquadMembership; squad: Squad }[] {
    if (userIds.length === 0) return []
    const placeholders = userIds.map(() => '?').join(',')
    const rows = this.db.all(
      `SELECT sm.*, s.slug AS s_slug, s.name AS s_name, s.organization_id AS s_org, s.client_account_id AS s_client
       FROM squad_memberships sm JOIN squads s ON s.id = sm.squad_id
       WHERE sm.user_id IN (${placeholders}) ORDER BY s.slug`,
      ...userIds,
    )
    return rows.map((row) => ({
      membership: toMembership(row),
      squad: {
        id: str(row.squad_id),
        organization_id: str(row.s_org),
        slug: str(row.s_slug),
        name: str(row.s_name),
        client_account_id: nullableStr(row.s_client),
      },
    }))
  }

  membershipOf(squadId: string, userId: string): SquadMembership | undefined {
    const row = this.db.get('SELECT * FROM squad_memberships WHERE squad_id = ? AND user_id = ?', squadId, userId)
    return row ? toMembership(row) : undefined
  }

  upsertMembership(input: { squad_id: string; user_id: string; role: string; valid_from: string | null; valid_to: string | null }): void {
    const existing = this.membershipOf(input.squad_id, input.user_id)
    const at = nowIso()
    if (existing) {
      this.db.run(
        'UPDATE squad_memberships SET role = ?, valid_from = ?, valid_to = ?, updated_at = ? WHERE id = ?',
        input.role, input.valid_from, input.valid_to, at, existing.id,
      )
    } else {
      this.db.run(
        'INSERT INTO squad_memberships (id, squad_id, user_id, role, valid_from, valid_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        newId(), input.squad_id, input.user_id, input.role, input.valid_from, input.valid_to, at, at,
      )
    }
  }

  deleteMembership(squadId: string, userId: string): boolean {
    const existing = this.membershipOf(squadId, userId)
    if (!existing) return false
    this.db.run('DELETE FROM squad_memberships WHERE id = ?', existing.id)
    return true
  }

  // ------------------------------------------------------------- cuentas de cliente
  clientAccount(id: string): ClientAccount | undefined {
    const row = this.db.get('SELECT * FROM client_accounts WHERE id = ?', id)
    return row ? toClientAccount(row) : undefined
  }

  clientAccountsOfOrg(orgId: string): ClientAccount[] {
    return this.db
      .all('SELECT * FROM client_accounts WHERE organization_id = ? ORDER BY slug', orgId)
      .map(toClientAccount)
  }

  clientAccountBySlug(orgId: string, slug: string): ClientAccount | undefined {
    const row = this.db.get('SELECT * FROM client_accounts WHERE organization_id = ? AND slug = ?', orgId, slug)
    return row ? toClientAccount(row) : undefined
  }

  insertClientAccount(orgId: string, slug: string, name: string): ClientAccount {
    const id = newId()
    const at = nowIso()
    this.db.run(
      'INSERT INTO client_accounts (id, organization_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, orgId, slug, name, at, at,
    )
    return { id, organization_id: orgId, slug, name }
  }

  // ------------------------------------------------------------- máquinas / agentes
  machine(id: string): Machine | undefined {
    const row = this.db.get('SELECT * FROM machines WHERE id = ?', id)
    return row ? toMachine(row) : undefined
  }

  machineByHostname(userId: string, hostname: string): Machine | undefined {
    const row = this.db.get('SELECT * FROM machines WHERE user_id = ? AND hostname = ?', userId, hostname)
    return row ? toMachine(row) : undefined
  }

  machinesOfUser(userId: string): Machine[] {
    return this.db.all('SELECT * FROM machines WHERE user_id = ? ORDER BY hostname', userId).map(toMachine)
  }

  machinesOfOrg(orgId: string): { machine: Machine; owner: User }[] {
    const rows = this.db.all(
      `SELECT m.* FROM machines m JOIN users u ON u.id = m.user_id
       WHERE u.organization_id = ? ORDER BY u.email, m.hostname`,
      orgId,
    )
    return rows.map((row) => ({ machine: toMachine(row), owner: this.user(str(row.user_id))! }))
  }

  insertMachine(input: { user_id: string; hostname: string; os: string; daemon_version: string }): Machine {
    const id = newId()
    const at = nowIso()
    this.db.run(
      'INSERT INTO machines (id, user_id, hostname, os, daemon_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, input.user_id, input.hostname, input.os, input.daemon_version, at, at,
    )
    return this.machine(id)!
  }

  updateMachine(id: string, fields: { os?: string; daemon_version?: string; last_seen_at?: string; last_snapshot_hash?: string }): void {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (fields.os !== undefined) { sets.push('os = ?'); params.push(fields.os) }
    if (fields.daemon_version !== undefined) { sets.push('daemon_version = ?'); params.push(fields.daemon_version) }
    if (fields.last_seen_at !== undefined) { sets.push('last_seen_at = ?'); params.push(fields.last_seen_at) }
    if (fields.last_snapshot_hash !== undefined) { sets.push('last_snapshot_hash = ?'); params.push(fields.last_snapshot_hash) }
    if (sets.length === 0) return
    sets.push('updated_at = ?'); params.push(nowIso())
    params.push(id)
    this.db.run(`UPDATE machines SET ${sets.join(', ')} WHERE id = ?`, ...params)
  }

  deleteMachine(id: string): void {
    this.db.run('DELETE FROM machines WHERE id = ?', id)
  }

  agent(id: string): AgentInstance | undefined {
    const row = this.db.get('SELECT * FROM agent_instances WHERE id = ?', id)
    return row ? toAgent(row) : undefined
  }

  agentsOfMachine(machineId: string): AgentInstance[] {
    return this.db
      .all('SELECT * FROM agent_instances WHERE machine_id = ? ORDER BY cli_kind', machineId)
      .map(toAgent)
  }

  agentsOfUser(userId: string): { agent: AgentInstance; machine: Machine }[] {
    const rows = this.db.all(
      `SELECT a.* FROM agent_instances a JOIN machines m ON m.id = a.machine_id WHERE m.user_id = ?`,
      userId,
    )
    return rows.map((row) => ({ agent: toAgent(row), machine: this.machine(str(row.machine_id))! }))
  }

  agentIdsOfUser(userId: string): string[] {
    return this.db
      .all<{ id: string }>(
        'SELECT a.id FROM agent_instances a JOIN machines m ON m.id = a.machine_id WHERE m.user_id = ?',
        userId,
      )
      .map((row) => row.id)
  }

  insertAgent(input: { machine_id: string; cli_kind: string; cli_version: string; config_path: string }): AgentInstance {
    const id = newId()
    const at = nowIso()
    this.db.run(
      'INSERT INTO agent_instances (id, machine_id, cli_kind, cli_version, config_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, input.machine_id, input.cli_kind, input.cli_version, input.config_path, at, at,
    )
    return this.agent(id)!
  }

  updateAgent(id: string, fields: Partial<Pick<AgentInstance, 'cli_version' | 'config_path' | 'enabled' | 'last_connected_at' | 'last_listed_hash' | 'drift_detected' | 'drift_detail'>>): void {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (fields.cli_version !== undefined) { sets.push('cli_version = ?'); params.push(fields.cli_version) }
    if (fields.config_path !== undefined) { sets.push('config_path = ?'); params.push(fields.config_path) }
    if (fields.enabled !== undefined) { sets.push('enabled = ?'); params.push(fields.enabled ? 1 : 0) }
    if (fields.last_connected_at !== undefined) { sets.push('last_connected_at = ?'); params.push(fields.last_connected_at) }
    if (fields.last_listed_hash !== undefined) { sets.push('last_listed_hash = ?'); params.push(fields.last_listed_hash) }
    if (fields.drift_detected !== undefined) { sets.push('drift_detected = ?'); params.push(fields.drift_detected ? 1 : 0) }
    if (fields.drift_detail !== undefined) { sets.push('drift_detail = ?'); params.push(fields.drift_detail) }
    if (sets.length === 0) return
    sets.push('updated_at = ?'); params.push(nowIso())
    params.push(id)
    this.db.run(`UPDATE agent_instances SET ${sets.join(', ')} WHERE id = ?`, ...params)
  }

  // ------------------------------------------------------------- tokens
  tokenByHash(hash: string): ApiToken | undefined {
    const row = this.db.get('SELECT * FROM api_tokens WHERE token_hash = ?', hash)
    return row ? toToken(row) : undefined
  }

  activeTokensOfMachine(machineId: string): ApiToken[] {
    return this.db
      .all('SELECT * FROM api_tokens WHERE machine_id = ? AND revoked_at IS NULL', machineId)
      .map(toToken)
  }

  insertToken(input: { user_id: string; machine_id: string; name: string; token_hash: string }): void {
    const at = nowIso()
    this.db.run(
      'INSERT INTO api_tokens (id, user_id, machine_id, name, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      newId(), input.user_id, input.machine_id, input.name, input.token_hash, at, at,
    )
  }

  revokeTokensOfMachine(machineId: string, at: string): number {
    const tokens = this.activeTokensOfMachine(machineId)
    for (const token of tokens) {
      this.db.run('UPDATE api_tokens SET revoked_at = ?, updated_at = ? WHERE id = ?', at, at, token.id)
    }
    return tokens.length
  }

  touchToken(tokenId: string, at: string): void {
    this.db.run('UPDATE api_tokens SET last_used_at = ?, updated_at = ? WHERE id = ?', at, at, tokenId)
  }

  // ------------------------------------------------------------- catálogo
  server(id: string): McpServerRow | undefined {
    const row = this.db.get('SELECT * FROM mcp_servers WHERE id = ?', id)
    return row ? toServer(row) : undefined
  }

  // ------------------------------------------------------------ ajustes internos

  setting(key: string): string | undefined {
    const row = this.db.get('SELECT value FROM app_settings WHERE key = ?', key)
    return row ? str(row.value) : undefined
  }

  setSetting(key: string, value: string): void {
    this.db.run(
      'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key, value, nowIso(),
    )
  }

  /** Todos los servers de todas las personas; lo usa el reintento de sondeo. */
  allServers(): McpServerRow[] {
    return this.db
      .all('SELECT * FROM mcp_servers ORDER BY user_id, slug, id')
      .map(toServer)
  }

  serversOfUser(userId: string): McpServerRow[] {
    return this.db
      .all('SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY slug', userId)
      .map(toServer)
      .sort((a, b) => cmp(a.slug, b.slug) || cmp(a.id, b.id))
  }

  serverBySlug(userId: string, slug: string): McpServerRow | undefined {
    const row = this.db.get('SELECT * FROM mcp_servers WHERE user_id = ? AND slug = ?', userId, slug)
    return row ? toServer(row) : undefined
  }

  insertServer(input: Omit<McpServerRow, 'id' | 'definition_hash' | 'last_probe_error' | 'auth'> & { definition_hash?: string; auth?: McpServerRow['auth'] }): McpServerRow {
    const id = newId()
    const at = nowIso()
    this.db.run(
      `INSERT INTO mcp_servers (id, user_id, slug, display_name, description, transport, command, args, env, cwd, url, headers, secret_refs,
        requires_host_access, container_image, allow_hosts, allow_ports, read_mounts, write_mounts, definition_hash, last_probe_error, auth, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.user_id, input.slug, input.display_name, input.description, input.transport, input.command,
      JSON.stringify(input.args), JSON.stringify(input.env), input.cwd, input.url, JSON.stringify(input.headers),
      JSON.stringify(input.secret_refs), input.requires_host_access ? 1 : 0, input.container_image,
      JSON.stringify(input.allow_hosts), JSON.stringify(input.allow_ports), JSON.stringify(input.read_mounts),
      JSON.stringify(input.write_mounts), input.definition_hash ?? '', '', input.auth ?? 'none', at, at,
    )
    return this.server(id)!
  }

  updateServer(id: string, fields: Partial<McpServerRow>): void {
    const jsonCols = new Set(['args', 'env', 'headers', 'secret_refs', 'allow_hosts', 'allow_ports', 'read_mounts', 'write_mounts'])
    const boolCols = new Set(['requires_host_access'])
    const cols = [
      'slug', 'display_name', 'description', 'transport', 'command', 'args', 'env', 'cwd', 'url', 'headers',
      'secret_refs', 'requires_host_access', 'container_image', 'allow_hosts', 'allow_ports', 'read_mounts',
      'write_mounts', 'definition_hash', 'last_probe_error', 'auth',
    ] as const
    const sets: string[] = []
    const params: (string | number)[] = []
    for (const col of cols) {
      const value = (fields as Record<string, unknown>)[col]
      if (value === undefined) continue
      sets.push(`${col} = ?`)
      if (jsonCols.has(col)) params.push(JSON.stringify(value))
      else if (boolCols.has(col)) params.push(value ? 1 : 0)
      else params.push(value as string)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?'); params.push(nowIso())
    params.push(id)
    this.db.run(`UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = ?`, ...params)
  }

  deleteServer(id: string): void {
    this.db.run('DELETE FROM mcp_servers WHERE id = ?', id)
  }

  toolsOfServer(serverId: string): McpToolRow[] {
    return this.db
      .all('SELECT * FROM mcp_tools WHERE server_id = ?', serverId)
      .map(toTool)
      .sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id))
  }

  toolsOfServers(serverIds: string[]): Map<string, McpToolRow[]> {
    const grouped = new Map<string, McpToolRow[]>()
    if (serverIds.length === 0) return grouped
    const placeholders = serverIds.map(() => '?').join(',')
    const rows = this.db.all(`SELECT * FROM mcp_tools WHERE server_id IN (${placeholders})`, ...serverIds)
    for (const row of rows.map(toTool)) {
      const list = grouped.get(row.server_id) ?? []
      list.push(row)
      grouped.set(row.server_id, list)
    }
    for (const list of grouped.values()) list.sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id))
    return grouped
  }

  tool(id: string): McpToolRow | undefined {
    const row = this.db.get('SELECT * FROM mcp_tools WHERE id = ?', id)
    return row ? toTool(row) : undefined
  }

  takenExposedNames(userId: string, excludeServerId: string): Set<string> {
    const rows = this.db.all<{ exposed_name: string }>(
      `SELECT t.exposed_name FROM mcp_tools t JOIN mcp_servers s ON s.id = t.server_id
       WHERE s.user_id = ? AND t.server_id != ?`,
      userId, excludeServerId,
    )
    return new Set(rows.map((row) => row.exposed_name).filter(Boolean))
  }

  insertTool(input: { server_id: string; name: string; exposed_name: string; title: string; description: string; input_schema: Record<string, unknown>; definition_hash: string }): void {
    const at = nowIso()
    this.db.run(
      `INSERT INTO mcp_tools (id, server_id, name, exposed_name, title, description, input_schema, definition_hash, quarantined, quarantine_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?, ?)`,
      newId(), input.server_id, input.name, input.exposed_name, input.title, input.description,
      JSON.stringify(input.input_schema), input.definition_hash, at, at,
    )
  }

  updateTool(id: string, fields: Partial<McpToolRow>): void {
    const sets: string[] = []
    const params: (string | number)[] = []
    const jsonCols = new Set(['input_schema'])
    const boolCols = new Set(['quarantined'])
    for (const col of ['exposed_name', 'title', 'description', 'input_schema', 'definition_hash', 'quarantined', 'quarantine_reason'] as const) {
      const value = (fields as Record<string, unknown>)[col]
      if (value === undefined) continue
      sets.push(`${col} = ?`)
      if (jsonCols.has(col)) params.push(JSON.stringify(value))
      else if (boolCols.has(col)) params.push(value ? 1 : 0)
      else params.push(value as string)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?'); params.push(nowIso())
    params.push(id)
    this.db.run(`UPDATE mcp_tools SET ${sets.join(', ')} WHERE id = ?`, ...params)
  }

  // ------------------------------------------------------------- skills
  skill(id: string): SkillRow | undefined {
    const row = this.db.get('SELECT * FROM skills WHERE id = ?', id)
    return row ? toSkill(row) : undefined
  }

  skillsOfUser(userId: string): SkillRow[] {
    return this.db
      .all('SELECT * FROM skills WHERE user_id = ? ORDER BY slug', userId)
      .map(toSkill)
      .sort((a, b) => cmp(a.slug, b.slug) || cmp(a.id, b.id))
  }

  skillBySlug(userId: string, slug: string): SkillRow | undefined {
    const row = this.db.get('SELECT * FROM skills WHERE user_id = ? AND slug = ?', userId, slug)
    return row ? toSkill(row) : undefined
  }

  insertSkill(input: { user_id: string; slug: string; display_name: string; description: string; body: string; content_hash: string }): SkillRow {
    const id = newId()
    const at = nowIso()
    this.db.run(
      'INSERT INTO skills (id, user_id, slug, display_name, description, body, version, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
      id, input.user_id, input.slug, input.display_name, input.description, input.body, input.content_hash, at, at,
    )
    return this.skill(id)!
  }

  updateSkill(id: string, fields: { display_name?: string; description?: string; body?: string; version?: number; content_hash?: string }): void {
    const sets: string[] = []
    const params: (string | number)[] = []
    if (fields.display_name !== undefined) { sets.push('display_name = ?'); params.push(fields.display_name) }
    if (fields.description !== undefined) { sets.push('description = ?'); params.push(fields.description) }
    if (fields.body !== undefined) { sets.push('body = ?'); params.push(fields.body) }
    if (fields.version !== undefined) { sets.push('version = ?'); params.push(fields.version) }
    if (fields.content_hash !== undefined) { sets.push('content_hash = ?'); params.push(fields.content_hash) }
    if (sets.length === 0) return
    sets.push('updated_at = ?'); params.push(nowIso())
    params.push(id)
    this.db.run(`UPDATE skills SET ${sets.join(', ')} WHERE id = ?`, ...params)
  }

  deleteSkill(id: string): void {
    this.db.run('DELETE FROM skills WHERE id = ?', id)
  }

  // ------------------------------------------------------------- reglas
  userRules(userId: string): ExposureRule[] {
    return this.db
      .all('SELECT * FROM exposure_rules WHERE user_id = ? AND agent_instance_id IS NULL', userId)
      .map(toRule)
  }

  clientRules(agentId: string): ExposureRule[] {
    return this.db
      .all('SELECT * FROM exposure_rules WHERE agent_instance_id = ?', agentId)
      .map(toRule)
  }

  findRule(userId: string, agentId: string | null, resourceType: string, resourceId: string): ExposureRule | undefined {
    const row = agentId
      ? this.db.get(
          'SELECT * FROM exposure_rules WHERE user_id = ? AND resource_type = ? AND resource_id = ? AND agent_instance_id = ?',
          userId, resourceType, resourceId, agentId,
        )
      : this.db.get(
          'SELECT * FROM exposure_rules WHERE user_id = ? AND resource_type = ? AND resource_id = ? AND agent_instance_id IS NULL',
          userId, resourceType, resourceId,
        )
    return row ? toRule(row) : undefined
  }

  insertRule(input: { user_id: string; agent_instance_id: string | null; resource_type: string; resource_id: string; state: string; reason: string }): void {
    const at = nowIso()
    this.db.run(
      'INSERT INTO exposure_rules (id, user_id, agent_instance_id, resource_type, resource_id, state, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId(), input.user_id, input.agent_instance_id, input.resource_type, input.resource_id, input.state, input.reason, at, at,
    )
  }

  updateRule(id: string, state: string, reason: string): void {
    this.db.run('UPDATE exposure_rules SET state = ?, reason = ?, updated_at = ? WHERE id = ?', state, reason, nowIso(), id)
  }

  deleteRule(id: string): void {
    this.db.run('DELETE FROM exposure_rules WHERE id = ?', id)
  }

  forgetResource(resourceType: string, resourceIds: string[]): void {
    if (resourceIds.length === 0) return
    const placeholders = resourceIds.map(() => '?').join(',')
    this.db.run(
      `DELETE FROM exposure_rules WHERE resource_type = ? AND resource_id IN (${placeholders})`,
      resourceType, ...resourceIds,
    )
  }

  // ------------------------------------------------------------- snapshots persistidos
  lastSnapshot(agentId: string): { snapshot_hash: string } | undefined {
    return this.db.get<{ snapshot_hash: string }>(
      'SELECT snapshot_hash FROM exposure_snapshots WHERE agent_instance_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      agentId,
    )
  }

  storeSnapshot(agentId: string, snapshotHash: string, payload: unknown): void {
    const last = this.lastSnapshot(agentId)
    if (last && last.snapshot_hash === snapshotHash) return
    const at = nowIso()
    this.db.run(
      'INSERT INTO exposure_snapshots (id, agent_instance_id, snapshot_hash, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      newId(), agentId, snapshotHash, JSON.stringify(payload), at, at,
    )
  }

  // ------------------------------------------------------------- auditoría
  lastAuditEvent(orgId: string): AuditEventRow | undefined {
    const row = this.db.get(
      'SELECT * FROM audit_events WHERE organization_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      orgId,
    )
    return row ? toAuditEvent(row) : undefined
  }

  auditEvents(orgId: string, opts: { action?: string; limit: number }): AuditEventRow[] {
    if (opts.action) {
      return this.db
        .all('SELECT * FROM audit_events WHERE organization_id = ? AND action = ? ORDER BY created_at DESC, id DESC LIMIT ?', orgId, opts.action, opts.limit)
        .map(toAuditEvent)
    }
    return this.db
      .all('SELECT * FROM audit_events WHERE organization_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', orgId, opts.limit)
      .map(toAuditEvent)
  }

  auditEventsChrono(orgId: string): AuditEventRow[] {
    return this.db
      .all('SELECT * FROM audit_events WHERE organization_id = ? ORDER BY created_at ASC, id ASC', orgId)
      .map(toAuditEvent)
  }

  insertAuditEvent(event: AuditEventRow): void {
    this.db.run(
      `INSERT INTO audit_events (id, organization_id, actor_user_id, actor_label, action, target_type, target_id, detail, prev_hash, event_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.id, event.organization_id, event.actor_user_id, event.actor_label, event.action, event.target_type,
      event.target_id, JSON.stringify(event.detail), event.prev_hash, event.event_hash, event.created_at, event.created_at,
    )
  }

  insertToolCall(input: Omit<ToolCallLogRow, 'id' | 'created_at'>): void {
    const at = nowIso()
    this.db.run(
      `INSERT INTO tool_call_logs (id, organization_id, agent_instance_id, user_id, server_slug, tool_name, exposed_name, decision, denial_reason, args_digest, duration_ms, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(), input.organization_id, input.agent_instance_id, input.user_id, input.server_slug, input.tool_name,
      input.exposed_name, input.decision, input.denial_reason, input.args_digest, input.duration_ms, input.error, at, at,
    )
  }

  toolCalls(opts: { orgId: string; userId?: string; agentId?: string; limit: number }): ToolCallLogRow[] {
    const clauses = ['organization_id = ?']
    const params: (string | number)[] = [opts.orgId]
    if (opts.userId) { clauses.push('user_id = ?'); params.push(opts.userId) }
    if (opts.agentId) { clauses.push('agent_instance_id = ?'); params.push(opts.agentId) }
    params.push(opts.limit)
    return this.db
      .all(`SELECT * FROM tool_call_logs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params)
      .map(toToolCall)
  }
}
