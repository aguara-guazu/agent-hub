/**
 * Construcción de la matriz de la consola. Espeja `backend/agenthub/modules/policy/matrix.py`.
 *
 * Una fila por recurso de la persona y una columna por cliente MCP suyo. El contexto de
 * resolución se carga una sola vez por cliente y todas las celdas se resuelven en memoria.
 * La decisión de cada celda sale de `resolveResource`, nunca de una copia de la precedencia.
 */
import { CLI_HOT_RELOAD, type CliKind, type PropagationState, type RuleState } from '@agenthub/shared'
import type { Store } from './store.js'
import { cmp } from './store.js'
import {
  computeSnapshot,
  loadContext,
  loadShared,
  resolveResource,
  RESOURCE,
  ruleKey,
  type Decision,
  type ResolutionContext,
} from './policy/resolver.js'
import type { AgentInstance, Machine, McpServerRow, McpToolRow, User } from './types.js'

export function hotReload(cliKind: string): boolean {
  return CLI_HOT_RELOAD[cliKind as CliKind] ?? false
}

/**
 * Estado real de propagación de un cambio hacia un cliente. Sigue la sección
 * "Propagación" del contrato al pie de la letra.
 */
export function computePropagation(params: {
  cliKind: string
  lastConnectedAt: string | null
  lastListedHash: string | null
  machineSnapshotHash: string | null
  snapshotHash: string
  exposed: boolean
}): PropagationState {
  if (params.lastConnectedAt === null && params.lastListedHash === null) return 'unknown'
  if (params.lastListedHash === params.snapshotHash) return 'applied_live'
  if (hotReload(params.cliKind)) return 'pending_sync'
  if (params.machineSnapshotHash !== params.snapshotHash) return 'pending_sync'
  return params.exposed ? 'pending_restart' : 'applied_stale_list'
}

export interface MatrixCell {
  agent_id: string
  exposed: boolean
  source: string
  detail: string
  own_rule: RuleState | null
  propagation: PropagationState
}

export interface MatrixRow {
  resource_type: 'mcp_server' | 'mcp_tool' | 'skill'
  resource_id: string
  slug: string
  label: string
  parent_id: string | null
  description: string
  user_rule: RuleState | null
  cells: Record<string, MatrixCell>
}

export interface AgentSummary {
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

export interface MatrixResponse {
  user_id: string
  agents: AgentSummary[]
  rows: MatrixRow[]
}

interface Pair {
  agent: AgentInstance
  machine: Machine
}

function pairsOf(store: Store, user: User): Pair[] {
  return store
    .agentsOfUser(user.id)
    .map(({ agent, machine }) => ({ agent, machine }))
    .sort(
      (a, b) =>
        cmp(a.machine.hostname, b.machine.hostname) ||
        cmp(a.agent.cli_kind, b.agent.cli_kind) ||
        cmp(a.agent.id, b.agent.id),
    )
}

function toolDecision(ctx: ResolutionContext, server: McpServerRow, tool: McpToolRow): Decision {
  if (tool.quarantined) {
    return {
      exposed: false,
      source: 'quarantine',
      detail: tool.quarantine_reason || 'definicion cambiada, pendiente de revision',
    }
  }
  const parent = resolveResource(ctx, RESOURCE.server, server.id)
  if (!parent.exposed) {
    return { exposed: false, source: 'server_off', detail: `el server ${server.slug} no esta expuesto: ${parent.detail}` }
  }
  return resolveResource(ctx, RESOURCE.tool, tool.id, {
    exposed: true,
    source: 'inherited_from_server',
    detail: `heredado de ${server.slug}`,
  })
}

export function buildMatrix(store: Store, user: User): MatrixResponse {
  const pairs = pairsOf(store, user)
  const shared = loadShared(store, user)

  const contexts = new Map<string, ResolutionContext>()
  const hashes = new Map<string, string>()
  for (const pair of pairs) {
    const ctx = loadContext(store, pair.agent.id, shared)
    contexts.set(pair.agent.id, ctx)
    hashes.set(pair.agent.id, computeSnapshot(store, pair.agent.id, ctx).snapshot_hash)
  }

  const userRuleFor = (resourceType: string, resourceId: string): RuleState | null => {
    const rule = shared.userRules.get(ruleKey(resourceType, resourceId))
    return rule ? rule.state : null
  }

  const rows: MatrixRow[] = []

  const fila = (params: {
    resourceType: MatrixRow['resource_type']
    resourceId: string
    slug: string
    label: string
    parentId: string | null
    description: string
    decide: (ctx: ResolutionContext) => Decision
  }): MatrixRow => {
    const cells: Record<string, MatrixCell> = {}
    for (const pair of pairs) {
      const ctx = contexts.get(pair.agent.id)!
      const dec = params.decide(ctx)
      const own = ctx.rulesByLevel.client.get(ruleKey(params.resourceType, params.resourceId))
      cells[pair.agent.id] = {
        agent_id: pair.agent.id,
        exposed: dec.exposed,
        source: dec.source,
        detail: dec.detail,
        own_rule: own ? own.state : null,
        propagation: computePropagation({
          cliKind: pair.agent.cli_kind,
          lastConnectedAt: pair.agent.last_connected_at,
          lastListedHash: pair.agent.last_listed_hash,
          machineSnapshotHash: pair.machine.last_snapshot_hash,
          snapshotHash: hashes.get(pair.agent.id)!,
          exposed: dec.exposed,
        }),
      }
    }
    return {
      resource_type: params.resourceType,
      resource_id: params.resourceId,
      slug: params.slug,
      label: params.label,
      parent_id: params.parentId,
      description: params.description,
      user_rule: userRuleFor(params.resourceType, params.resourceId),
      cells,
    }
  }

  for (const server of shared.servers) {
    rows.push(
      fila({
        resourceType: 'mcp_server',
        resourceId: server.id,
        slug: server.slug,
        label: server.display_name,
        parentId: null,
        description: server.description,
        decide: (ctx) => resolveResource(ctx, RESOURCE.server, server.id),
      }),
    )
    for (const tool of shared.toolsByServer.get(server.id) ?? []) {
      rows.push(
        fila({
          resourceType: 'mcp_tool',
          resourceId: tool.id,
          slug: `${server.slug}/${tool.name}`,
          label: tool.title || tool.name,
          parentId: server.id,
          description: tool.description,
          decide: (ctx) => toolDecision(ctx, server, tool),
        }),
      )
    }
  }

  for (const skill of shared.skills) {
    rows.push(
      fila({
        resourceType: 'skill',
        resourceId: skill.id,
        slug: skill.slug,
        label: skill.display_name,
        parentId: null,
        description: skill.description,
        // Un cliente sin carpeta de skills (Claude Desktop) las recibe por la herramienta
        // `use_skill` del gateway, así que su celda se decide como las demás.
        decide: (ctx) => resolveResource(ctx, RESOURCE.skill, skill.id),
      }),
    )
  }

  const agents: AgentSummary[] = pairs.map((pair) => ({
    id: pair.agent.id,
    machine_id: pair.machine.id,
    machine_hostname: pair.machine.hostname,
    cli_kind: pair.agent.cli_kind,
    cli_version: pair.agent.cli_version,
    enabled: pair.agent.enabled,
    last_connected_at: pair.agent.last_connected_at,
    drift_detected: pair.agent.drift_detected,
    drift_detail: pair.agent.drift_detail,
    hot_reload: hotReload(pair.agent.cli_kind),
  }))

  return { user_id: user.id, agents, rows }
}
