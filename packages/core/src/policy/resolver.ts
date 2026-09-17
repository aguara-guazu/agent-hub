/**
 * Motor de resolución de exposición y snapshots.
 *
 * Único lugar donde se decide qué ve un cliente MCP. Precedencia, de más general a más
 * específica:
 *
 *     default ON  ->  regla de la persona  ->  regla del cliente
 *
 * Desempates deterministas: default ON (el server es tuyo y corre en tu máquina);
 * `inherit` no opina; la regla del cliente pisa la de la persona; las tools heredan la
 * decisión de su server; la cuarentena siempre deniega.
 *
 * El orden del catálogo se fija en TypeScript (comparación byte a byte Unicode), no en
 * el `ORDER BY` del motor, porque de ese orden dependen el `snapshot_hash` y la
 * asignación de `exposed_name`.
 */
import { CLI_FILE_SKILLS, snapshotHash, type CliKind, type PolicySnapshot, type ResourceType } from '@agenthub/shared'
import { buildExposedName } from '../naming.js'
import type { Store } from '../store.js'
import { cmp } from '../store.js'
import type {
  AgentInstance,
  ExposureRule,
  Machine,
  McpServerRow,
  McpToolRow,
  SkillRow,
  User,
} from '../types.js'

const RESOURCE: Record<'server' | 'tool' | 'skill', ResourceType> = {
  server: 'mcp_server',
  tool: 'mcp_tool',
  skill: 'skill',
}
const LEVEL_ORDER = ['user', 'client'] as const

export interface Decision {
  exposed: boolean
  /** Nivel que fijó la decisión: default_on, user, client, o una compuerta. */
  source: string
  detail: string
}

function decision(exposed: boolean, source: string, detail = ''): Decision {
  return { exposed, source, detail }
}

/** Lo que comparten todos los clientes de una persona (catálogo + reglas de persona). */
export interface SharedResolution {
  user: User
  userRules: Map<string, ExposureRule>
  servers: McpServerRow[]
  toolsByServer: Map<string, McpToolRow[]>
  skills: SkillRow[]
}

function ruleKey(resourceType: string, resourceId: string): string {
  return `${resourceType}\u0000${resourceId}`
}

export function loadShared(store: Store, user: User): SharedResolution {
  const userRules = new Map<string, ExposureRule>()
  for (const rule of store.userRules(user.id)) {
    userRules.set(ruleKey(rule.resource_type, rule.resource_id), rule)
  }
  const servers = store.serversOfUser(user.id)
  const toolsByServer = store.toolsOfServers(servers.map((s) => s.id))
  const skills = store.skillsOfUser(user.id)
  return { user, userRules, servers, toolsByServer, skills }
}

export interface ResolutionContext {
  agent: AgentInstance
  machine: Machine
  user: User
  rulesByLevel: { user: Map<string, ExposureRule>; client: Map<string, ExposureRule> }
  servers: McpServerRow[]
  toolsByServer: Map<string, McpToolRow[]>
  skills: SkillRow[]
}

export function loadContext(store: Store, agentId: string, shared?: SharedResolution): ResolutionContext {
  const agent = store.agent(agentId)
  if (!agent) throw new Error(`agent_instance ${agentId} no existe`)
  const machine = store.machine(agent.machine_id)!
  const user = store.user(machine.user_id)!
  const base = shared ?? loadShared(store, user)

  const client = new Map<string, ExposureRule>()
  for (const rule of store.clientRules(agent.id)) {
    client.set(ruleKey(rule.resource_type, rule.resource_id), rule)
  }
  return {
    agent,
    machine,
    user,
    rulesByLevel: { user: base.userRules, client },
    servers: base.servers,
    toolsByServer: base.toolsByServer,
    skills: base.skills,
  }
}

export function resolveResource(
  ctx: ResolutionContext,
  resourceType: string,
  resourceId: string,
  base?: Decision,
): Decision {
  if (!ctx.agent.enabled) return decision(false, 'client_disabled', 'Este cliente está pausado en el hub')
  const key = ruleKey(resourceType, resourceId)
  let current = base
    ? { ...base }
    : decision(true, 'default_on', 'es tuyo y no lo apagaste en ningun nivel')

  for (const level of LEVEL_ORDER) {
    const rule = ctx.rulesByLevel[level].get(key)
    if (!rule || rule.state === 'inherit') continue
    current = {
      exposed: rule.state === 'on',
      source: level,
      detail:
        rule.reason ||
        (level === 'user' ? 'regla tuya para todos los clientes' : 'regla de este cliente'),
    }
  }
  return current
}

interface DeniedEntry {
  resource_type: ResourceType
  resource_id: string
  slug: string
  exposed: boolean
  source: string
  detail: string
}

export function computeSnapshot(
  store: Store,
  agentId: string,
  ctx?: ResolutionContext,
  nowIsoValue?: string,
): PolicySnapshot {
  const context = ctx ?? loadContext(store, agentId)
  if (context.agent.id !== agentId) throw new Error('el contexto recibido es de otro agent_instance')

  const servers: PolicySnapshot['servers'] = []
  const denied: DeniedEntry[] = []
  const takenNames = new Set<string>()

  for (const server of context.servers) {
    const serverDecision = resolveResource(context, RESOURCE.server, server.id)
    if (!serverDecision.exposed) {
      denied.push({ resource_type: RESOURCE.server, resource_id: server.id, slug: server.slug, ...serverDecision })
      continue
    }

    const tools: PolicySnapshot['servers'][number]['tools'] = []
    for (const tool of context.toolsByServer.get(server.id) ?? []) {
      if (tool.quarantined) {
        denied.push({
          resource_type: RESOURCE.tool,
          resource_id: tool.id,
          slug: `${server.slug}/${tool.name}`,
          exposed: false,
          source: 'quarantine',
          detail: tool.quarantine_reason || 'definicion cambiada, pendiente de revision',
        })
        continue
      }
      const toolDecision = resolveResource(context, RESOURCE.tool, tool.id, decision(true, 'inherited_from_server', `heredado de ${server.slug}`))
      if (!toolDecision.exposed) {
        denied.push({ resource_type: RESOURCE.tool, resource_id: tool.id, slug: `${server.slug}/${tool.name}`, ...toolDecision })
        continue
      }
      let exposedName = tool.exposed_name
      if (!exposedName || takenNames.has(exposedName)) {
        exposedName = buildExposedName(server.slug, tool.name, takenNames)
      }
      takenNames.add(exposedName)
      tools.push({
        id: tool.id,
        name: tool.name,
        exposed_name: exposedName,
        title: tool.title,
        description: tool.description,
        input_schema:
          tool.input_schema && Object.keys(tool.input_schema).length > 0
            ? tool.input_schema
            : { type: 'object', properties: {} },
        definition_hash: tool.definition_hash,
      })
    }

    servers.push({
      id: server.id,
      slug: server.slug,
      display_name: server.display_name,
      transport: server.transport,
      command: server.command,
      args: [...server.args],
      env: { ...server.env },
      cwd: server.cwd,
      url: server.url,
      headers: { ...server.headers },
      secret_refs: { ...server.secret_refs },
      auth: server.auth,
      requires_host_access: server.requires_host_access,
      container_image: server.container_image,
      allow_hosts: [...server.allow_hosts],
      allow_ports: [...server.allow_ports],
      read_mounts: [...server.read_mounts],
      write_mounts: [...server.write_mounts],
      tools,
    })
  }

  const skills: PolicySnapshot['skills'] = []
  // Un cliente sin skills en disco (Claude Desktop) no recibe skills ni las lista como denegadas:
  // el daemon no tendría dónde materializarlas.
  const fileSkills = CLI_FILE_SKILLS[context.agent.cli_kind as CliKind] ?? true
  for (const skill of fileSkills ? context.skills : []) {
    const skillDecision = resolveResource(context, RESOURCE.skill, skill.id)
    if (!skillDecision.exposed) {
      denied.push({ resource_type: RESOURCE.skill, resource_id: skill.id, slug: skill.slug, ...skillDecision })
      continue
    }
    skills.push({
      id: skill.id,
      slug: skill.slug,
      display_name: skill.display_name,
      description: skill.description,
      body: skill.body,
      version: skill.version,
      content_hash: skill.content_hash,
    })
  }

  denied.sort((a, b) => cmp(a.resource_type, b.resource_type) || cmp(a.slug, b.slug))

  // `SnapshotDenied.exposed` está declarado como string en el paquete shared, pero el
  // El valor de dominio es booleano y siempre false para una denegación.
  // denegación. Se conserva el booleano en runtime —es lo que entra al hash y lo que lee
  // el daemon— y se adapta el tipo al firmar el hash.
  const body = {
    agent_instance_id: context.agent.id,
    cli_kind: context.agent.cli_kind,
    user_id: context.user.id,
    user_email: context.user.email,
    machine_id: context.machine.id,
    servers,
    skills,
    denied,
  }
  const hash = snapshotHash(body as unknown as Omit<PolicySnapshot, 'snapshot_hash' | 'generated_at'>)
  return { ...body, snapshot_hash: hash, generated_at: nowIsoValue ?? new Date().toISOString() } as unknown as PolicySnapshot
}

export function explain(store: Store, agentId: string, resourceType: string, resourceId: string): Decision {
  const ctx = loadContext(store, agentId)

  if (resourceType === RESOURCE.server) {
    const server = store.server(resourceId)
    if (!server || server.user_id !== ctx.user.id) return decision(false, 'not_found', 'el recurso no existe')
    return resolveResource(ctx, resourceType, resourceId)
  }
  if (resourceType === RESOURCE.skill) {
    const skill = store.skill(resourceId)
    if (!skill || skill.user_id !== ctx.user.id) return decision(false, 'not_found', 'el recurso no existe')
    return resolveResource(ctx, resourceType, resourceId)
  }
  const tool = store.tool(resourceId)
  if (!tool) return decision(false, 'not_found', 'el recurso no existe')
  const server = store.server(tool.server_id)
  if (!server || server.user_id !== ctx.user.id) return decision(false, 'not_found', 'el recurso no existe')
  if (tool.quarantined) return decision(false, 'quarantine', tool.quarantine_reason)
  const parent = resolveResource(ctx, RESOURCE.server, server.id)
  if (!parent.exposed) return decision(false, 'server_off', `el server ${server.slug} no esta expuesto: ${parent.detail}`)
  return resolveResource(ctx, resourceType, resourceId, decision(true, 'inherited_from_server', `heredado de ${server.slug}`))
}

export { RESOURCE, ruleKey }
