import { scheduleContext } from './schedules/context.js'
import { mediaCapabilities } from './transcriptions/context.js'
import { ConnectionOperations, connectionDefinitions, connectionReadOperations } from './connectors/operations.js'
import { callSharing, sharingDefinitions, sharingReadOperations } from './sharing/operations.js'
import { moduleDefinition, operationModules, type ModuleEnabled } from '@agenthub/shared/modules'
import { isCollaborationTool } from './collaboration.js'
import { UsageQuotas } from './agents/usage-quotas.js'
import { UsageNotices } from './agents/usage-notices.js'
import { consumptionDefinitions, consumptionReadOperations } from './agents/usage-consumption/tools.js'
import { LocalChat, chatDefinitions, chatReadOperations } from './agents/local-chat.js'
import { createInterhubServices } from './interhub/services.js'
import { InterhubTools, interhubDefinitions, interhubReadOperations, isInterhubOperation, type InterhubServices } from './interhub/tools.js'
import { TeamOrchestration, teamDefinitions, teamReadOperations } from './agents/team-orchestration.js'
import { callScheduleTool, scheduleDefinitions, scheduleReadOperations } from './schedules/schedule-tools.js'
import { callProjectAutomationTool, projectAutomationDefinitions, projectAutomationReadOperations } from './schedules/project-automation-tools.js'
import { ProjectAutomationService } from './schedules/project-automation-service.js'
import type { ScheduleAdmin } from './schedules/schedule-admin.js'
import type { TeamCatalog } from './agents/team-catalog.js'
import type { TeamOrca } from './agents/team-orca.js'
import { SharedPublications } from './sharing/publications.js'
import { z } from 'zod'
import { MemoryError, check, parse } from './contracts.js'
import { MemoryStore, assertWritableEntityTargets } from "./store.js"
import type { MemoryAI } from './ai.js'
import { exportMemory } from './backup.js'
import type { AdmissionGate } from "./admission-gate.js"
import { type GoogleAuth } from './connectors/google-auth.js'
import type { Vault } from './config.js'
import { touchSession, type AgentContext } from './agents.js'

import type { HubStopCoordinator } from "./hub-stop.js"
import { projectDefinitions, projectReadOperations, callProjectOperation, type ProjectServices } from './projects/operations.js'
import { referenceDefinitions, referenceReadOperations, skillReference } from './skills/reference.js'
import { usageDefinitions, quotaReadOperations, callUsageTool } from './agents/usage-tools.js'
import { systemDefinitions, systemReadOperations, callSystemOperation } from './system/operations.js'
import {
  transcriptionDefinitions, transcriptionReadOperations, callTranscription, rebuildMediaEmbeddings,
} from './transcriptions/operations.js'

const definitions = {
  ...referenceDefinitions, ...usageDefinitions, ...systemDefinitions, ...transcriptionDefinitions,
  ...projectDefinitions, ...connectionDefinitions, ...sharingDefinitions,
  ...chatDefinitions, ...interhubDefinitions, ...teamDefinitions, ...consumptionDefinitions,
  ...scheduleDefinitions, ...projectAutomationDefinitions,
} satisfies Record<string, [string, z.ZodType]>

// MCP requires an object at the root, including for discriminated unions (which Zod emits as oneOf).
export const memoryTools = Object.entries(definitions).map(([name, [description, schema]]) => ({ name, description, inputSchema: { ...z.toJSONSchema(schema), type: 'object' } as Record<string, unknown> }))
export const READ_OPERATIONS = new Set<string>([
  ...projectReadOperations, ...connectionReadOperations, ...transcriptionReadOperations, ...sharingReadOperations,
  ...systemReadOperations, ...referenceReadOperations, ...quotaReadOperations, ...consumptionReadOperations,
  ...chatReadOperations, ...interhubReadOperations, ...teamReadOperations, ...scheduleReadOperations, ...projectAutomationReadOperations,
])

export class MemoryOperations {
  private readonly projects: ProjectServices
  private readonly connections: ConnectionOperations
  moduleEnabled: ModuleEnabled = () => true
  readonly usage: UsageQuotas
  readonly usageNotices: UsageNotices
  readonly chat: LocalChat
  /** Set once the P2P replica and the inter-hub chat model exist; absent where they do not run. */
  private interhubServices: InterhubServices | undefined
  get interhub(): InterhubServices { return this.interhubServices ??= createInterhubServices(this.store, { events: this.chat.events, enabled: () => this.sharingEnabled() }) }
  sharingEnabled() { return this.moduleEnabled('sharing') && this.moduleEnabled('memory') }
  set interhub(value: InterhubServices | undefined) { this.interhubServices = value }
  /** Stops the timers of the inter-hub service without creating it when it was never used. */
  closeInterhub() { this.interhubServices?.dispose() }
  readonly interhubTools: InterhubTools
  readonly teams: TeamOrchestration | undefined
  readonly fleet: TeamOrca | undefined
  /** Set by the service once the schedule runtime exists; absent in worker processes, where schedule tools are unavailable. */
  schedules: ScheduleAdmin | undefined
  setSharedPaused: ((projectId: string, paused: boolean) => Promise<{ paused: boolean }>) | undefined
  /** Set by the service: backups run inside it so a stop never cuts one. */
  admission: AdmissionGate | undefined
  /** Set by the core service; absent in worker-only memory processes. */
  hubStop: HubStopCoordinator | undefined
  readonly projectAutomation: ProjectAutomationService
  get sharing() { return new SharedPublications(this.store) }
  constructor(readonly store: MemoryStore, ai: MemoryAI, google?: GoogleAuth, private vault?: Vault, fetcher: typeof fetch = fetch,
    jiraMcp?: import('./projects/tasks.js').JiraTaskReader, private media?: import('./transcriptions/media-runtime.js').MediaRuntime,
    teamRuntime?: { catalog: TeamCatalog; orca: TeamOrca | ((chat:LocalChat)=>TeamOrca) }, readonly collaborationEnabled: () => boolean = () => true) {
    this.connections = new ConnectionOperations(store, google, vault)
    this.projects = {
      store, ai, fetcher, jiraMcp,
      scheduleContext: id => this.moduleEnabled('schedules') ? scheduleContext(store.db, id) : Promise.resolve({}),
      mediaCapabilities: () => this.moduleEnabled('transcriptions') ? mediaCapabilities(store) : Promise.resolve({}),
      requireVault: () => this.requireVault(),
      reprocess: actor => this.call('reprocess', {}, actor),
      rebuildMedia: model => this.moduleEnabled('transcriptions') ? rebuildMediaEmbeddings(store, this.media, model) : Promise.resolve({ queued: 0 }),
      hasSharedContext: async id => this.sharingEnabled() && this.collaborationEnabled() && this.isSharedProject(id),
      publishNote: async (id, text, agent) => {
        if (this.sharingEnabled() && await this.isSharedProject(id)) {
          await this.sharing.message(id, text, new Date(Date.now() + 86_400_000).toISOString(), undefined, undefined, undefined, agent)
        }
      },
      backup: () => this.admission ? this.admission.track('backup', () => exportMemory(store)) : exportMemory(store),
      beforeProjectDelete: id => this.schedules?.beforeProjectDelete(id),
      changed: () => { this.chat.events.emit('change') },
    }
    this.chat = new LocalChat(store)
    this.interhubTools = new InterhubTools(this.chat, () => this.interhub)
    this.chat.interhubSweep = async () => { if (this.sharingEnabled()) await this.interhub.sweepEscalations() }
    this.usage = new UsageQuotas(store.db)
    this.usageNotices = new UsageNotices(this.chat)
    this.fleet = typeof teamRuntime?.orca === 'function' ? teamRuntime.orca(this.chat) : teamRuntime?.orca
    this.teams = teamRuntime && this.fleet ? new TeamOrchestration(this.chat, teamRuntime.catalog, this.fleet, this.usage, () => this.collaborationEnabled()) : undefined
    this.projectAutomation = new ProjectAutomationService({ db: store.db, chat: this.chat, teams: () => this.teams, schedules: () => this.schedules })
  }
  private async isSharedProject(id: string) {
    return (await this.store.db.query('SELECT id FROM shared_projects WHERE id=$1', [id])).length > 0
  }
  async collaborationNotice(operation: string, raw: unknown, result: any, agent?: AgentContext) {
    if (!this.collaborationEnabled() || !this.sharingEnabled()) return null
    if (!agent || !READ_OPERATIONS.has(operation) || operation === 'read_messages') return null
    const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    let project = typeof input.project_id === 'string' ? input.project_id : operation === 'context' ? result?.project?.id
      : operation === 'get_entity' && result?.entity?.kind === 'project' ? result.entity.id : null
    if (!project && operation === 'get_entity') {
      const projects = result?.links?.filter((l: any) => l.type === 'project' && l.entity?.kind === 'project') ?? []
      if (projects.length === 1) project = projects[0].entity.id
    }
    if (!project) {
      let entityId = typeof input.entity_id === 'string' ? input.entity_id : typeof input.collection_id === 'string' ? input.collection_id : null
      if (!entityId && typeof input.version_id === 'string') entityId = (await this.store.db.query('SELECT entity_id FROM sources WHERE id IN(SELECT source_id FROM versions WHERE id=$1)', [input.version_id]))[0]?.entity_id ?? null
      if (!entityId && typeof input.fragment_id === 'string') entityId = (await this.store.db.query('SELECT s.entity_id FROM sources s JOIN versions v ON v.source_id=s.id JOIN fragments f ON f.version_id=v.id WHERE f.id=$1', [input.fragment_id]))[0]?.entity_id ?? null
      if (operation === 'get_task' && typeof input.id === 'string') project = (await this.store.db.query('SELECT project_id FROM tasks WHERE id=$1', [input.id]))[0]?.project_id
      if (entityId) {
        const projects = await this.store.db.query("SELECT to_id FROM links WHERE from_id=$1 AND type='project'", [entityId])
        if (projects.length === 1) project = projects[0]!.to_id
      }
    }
    if (!project || !(await this.store.db.query('SELECT id FROM shared_projects WHERE id=$1', [project])).length) return null
    try { return await this.sharing.notice(project, agent) } catch { return null }
  }
  /** `agent` identifies the calling agent session (from the gateway); it attributes notes and keeps the session alive for the notes board. */
  async call(operation: string, raw: unknown, actor = 'user', agent?: AgentContext, signal?: AbortSignal): Promise<any> {
    const required = operationModules(operation)
    if (operation === 'save_task' && (raw as { jira?: unknown } | null)?.jira) required.push('connections')
    const disabled = required.find(id => !this.moduleEnabled(id))
    if (disabled) throw new MemoryError(409, 'El módulo «' + moduleDefinition(disabled).label + '» está desactivado en Ajustes', false, 'module_disabled')
    // Cleanup remains allowed and deletion keeps its original lifecycle lock ordering.
    if (!READ_OPERATIONS.has(operation) && !["delete_entity", "unlink_entities"].includes(operation)) await assertWritableEntityTargets(this.store.db, raw)
    if (isCollaborationTool(operation) || (operation === 'skill_reference' && (raw as { section?: unknown } | null)?.section !== 'memory-tools'))
      check(this.collaborationEnabled(), 'La colaboración está desactivada en Ajustes', 403)
    if (isInterhubOperation(operation)) {
      check(actor !== 'mcp' || agent, 'La colaboración por MCP requiere la identidad de agente que agrega el gateway.', 403)
      return this.interhubTools.call(operation, raw, agent)
    }
    if (operation.startsWith('chat_')) {
      // The MCP endpoint only serves agents through the gateway, which always attaches their identity. A call without it
      // would run unscoped like the person's authenticated /api/memory/call, so it is refused.
      check(actor !== 'mcp' || agent, 'La colaboración por MCP requiere la identidad de agente que agrega el gateway.', 403)
      const result=await this.chat.call(operation,raw,agent)
      if(operation==='chat_delete_channel')return {...result,...await this.teams?.stopTransferredPlans(result.affected_plans)}
      if(operation==='chat_take_leadership' && result.affected_plans?.length)return {...result,...await this.teams?.stopTransferredPlans(result.affected_plans)}
      return result
    }
    if (operation.startsWith('team_')) {
      check(this.teams, 'La orquestación de equipos no está disponible en este servicio.', 503)
      return this.teams.call(operation, raw, agent)
    }
    if (operation.startsWith('schedule_')) {
      check(this.schedules, 'Los schedules no están disponibles en este servicio.', 503)
      return callScheduleTool(this.schedules, operation, raw, agent)
    }
    if (operation in projectAutomationDefinitions) return callProjectAutomationTool(this.projectAutomation, operation, raw, agent)
    const definition = definitions[operation as keyof typeof definitions]
    check(definition, 'Operación de memoria inexistente', 404)
    const input = parse(definition[1] as z.ZodType, raw ?? {}) as any
    const { store } = this
    if (agent && this.moduleEnabled('agents') && !['context', 'write_note', 'finish_notes'].includes(operation)) await touchSession(store, agent)
    const author = agent ? `agent:${agent.cli_kind || 'mcp'}:${agent.session_id.slice(0, 8)}` : actor
    if (Object.hasOwn(connectionDefinitions, operation)) return this.connections.call(operation, input, raw)
    if (Object.hasOwn(sharingDefinitions, operation)) return callSharing(this.sharing, this.setSharedPaused, operation, input, author, agent)
    if (Object.hasOwn(projectDefinitions, operation)) return callProjectOperation(this.projects, operation, input, actor, author, agent, signal)
    if (Object.hasOwn(transcriptionDefinitions, operation)) return callTranscription(store, this.media, operation, input, actor)
    if (Object.hasOwn(systemDefinitions, operation)) return callSystemOperation(store, this.hubStop, operation, input, agent)
    if (operation === 'skill_reference') return skillReference(input.section)
    if (Object.hasOwn(usageDefinitions, operation) || Object.hasOwn(consumptionDefinitions, operation)) return callUsageTool(this, operation, input, agent)
    throw new Error('Operación no implementada')
  }

  private requireVault(): Vault {
    check(this.vault, 'Las credenciales locales no están disponibles en este contexto', 503)
    return this.vault
  }
}
