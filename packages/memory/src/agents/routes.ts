import type { ModuleEnabled } from '@agenthub/shared/modules'
import { hubLog } from "../report.js"
import { orcaWorkspaceSchema } from '../agents.js'
import { registerUsageRoutes } from './usage-routes.js'
import { registerConsumptionRoutes } from './usage-consumption/routes.js'
import { chatKickInput, chatCoordinatorInput, chatDeleteChannelInput } from './local-chat.js'
import { LocalChatRuntime } from './local-chat-runtime.js'
import { listAuthorityEvents } from './chat-access.js'
import { LocalWatchdog } from './local-watchdog.js'
import { nativeSession } from '@agenthub/gateway'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { MemoryService } from '../service.js'
import { check, id, parse } from '../contracts.js'
import type { MemoryRouteOptions, OwnerGuard } from '../http.js'

export function registerAgentRuntime(app: FastifyInstance, service: MemoryService, auth: OwnerGuard, options: MemoryRouteOptions, enabled: ModuleEnabled, collaborationEnabled: () => boolean, requireCollaboration: () => void) {
  service.usageEnabled=options.usageAgentEnabled ?? (()=>true)
  registerUsageRoutes(app,service,options)
  const consumption = registerConsumptionRoutes(app, service, { authorizeUsageAgent: options.authorizeUsageAgent, authorizeOwner: request => options.authorize(request) })
  let chatRuntime: LocalChatRuntime | undefined
  let watchdog: LocalWatchdog | undefined
  const runtime = async () => {
    const { operations } = await service.get()
    const agentEnabled = (agentId: string) => collaborationEnabled() && (options.chatAgentEnabled?.(agentId) ?? true)
    if (!chatRuntime) {
      chatRuntime = new LocalChatRuntime(operations.chat, undefined, agentEnabled, undefined, collaborationEnabled, {
        wake: (id, text) => service.wakeFleet(id, text),
        connected: id => service.fleetConnected(id),
        readiness: id => service.fleetReadiness(id),
        activityAt: id => service.fleetActivityAt(id),
      })
      const history = hubLog(options.directory)
      chatRuntime.observer = ({ event, step, ...fields }) => history.event('chat', event, { step, ...fields })
      chatRuntime.start()
    }
    if (!watchdog) {
      watchdog = new LocalWatchdog(operations.chat, agentEnabled, Date.now,
        () => app.log.warn('No se pudo registrar la observación del watchdog local'), collaborationEnabled)
      watchdog.start()
    }
    return chatRuntime
  }
  if (options.authorizeChatAgent) app.post('/api/memory/chat/native', { bodyLimit: 16384 }, async (request, reply) => {
    const input = parse(z.object({ agent_id: z.string().min(1).max(200), native_id: z.string().min(1).max(300),
      orca_workspace_id: orcaWorkspaceSchema.optional(), session_key: z.string().min(32).max(200), cwd: z.string().min(1).max(4000), at: z.iso.datetime(),
      event: z.enum(['SessionStart','HubPromptSubmit','UserPromptSubmit','BeforeAgent','PreToolUse','BeforeTool','PostToolUse','PostToolUseFailure','Stop','AfterAgent','SessionEnd','Interrupt','StopFailure','Heartbeat','Watch','PostModelSwitch']),
      turn_id:z.string().min(1).max(300).optional(),
      model:z.string().min(1).max(200).optional(), source:z.string().regex(/^[a-z_]{1,40}$/).optional(),
      process_id: z.number().int().min(1).optional(), process_started: z.string().max(100).optional(), watch_started:z.iso.datetime().optional(),
      transport:z.enum(['opencode_prompt','acp_prompt','antigravity_stream','codex_appserver','tui_prompt']).optional() }).strict(), request.body)
    requireCollaboration()
    const client = await options.authorizeChatAgent!(request,input.agent_id)
    const allowed = client.cli_kind==='codex_cli' ? 'codex_appserver' : client.cli_kind==='opencode' ? 'opencode_prompt' : ['gemini_cli','kiro'].includes(client.cli_kind) ? 'acp_prompt' : client.cli_kind==='antigravity' ? 'antigravity_stream' : undefined
    if (input.transport && input.transport!==allowed && !(input.transport==='tui_prompt' && client.cli_kind!=='claude_desktop')) return reply.code(400).send({error:'Transporte incompatible con este cliente'})
    const bridge = await runtime()
    requireCollaboration()
    const result = await bridge.chat.lifecycle({...nativeSession(input.agent_id,client.cli_kind,input.native_id,input.cwd),orca_workspace_id:input.orca_workspace_id},input)
    reply.header('Cache-Control','no-store')
    if (input.event !== 'Watch' || (client.cli_kind !== 'claude_code' && !input.transport)) return bridge.chat.enrollmentView(result)
    const controller = new AbortController(), abort = () => controller.abort()
    reply.raw.once('close',abort)
    try { return { ...bridge.chat.enrollmentView(result), ...await bridge.wait(result.session.id,controller.signal,input.watch_started) } }
    finally { reply.raw.off('close',abort) }
  })
  app.post('/api/memory/chat/kick', {bodyLimit:4096}, async request=>{
    const user=await options.authorize(request)
    requireCollaboration()
    const input=parse(chatKickInput.extend({project_id:id.optional()}).strict(),request.body)
    const {project_id,...kick}=input
    const { operations } = await service.get()
    requireCollaboration()
    return operations.chat.kick({...kick,...(project_id?{project_id}:{})},{user_id:user.id})
  })
  app.post('/api/memory/chat/coordinator', {bodyLimit:4096}, async request=>{
    const user=await options.authorize(request)
    requireCollaboration()
    const input=parse(chatCoordinatorInput,request.body)
    const {operations}=await service.get()
    requireCollaboration()
    const result=await operations.chat.designateCoordinator(input,user.id)
    return {...result,...await operations.teams?.stopTransferredPlans(result.affected_plans)}
  })
  app.post('/api/memory/chat/channels/delete', {bodyLimit:4096}, async request=>{
    const user=await options.authorize(request)
    requireCollaboration()
    const input=parse(chatDeleteChannelInput,request.body),{operations}=await service.get()
    const result=await operations.chat.deleteChannel(input,{user_id:user.id})
    return {...result,...await operations.teams?.stopTransferredPlans(result.affected_plans)}
  })
  app.post('/api/memory/chat/channels/restore', {bodyLimit:4096,preHandler:auth}, async request=>{
    requireCollaboration()
    const {channel_id}=parse(z.object({channel_id:id}).strict(),request.body),{operations}=await service.get()
    return operations.chat.restoreChannel(channel_id)
  })
  // Read-only views of cross-project read access. Decisions and revocations are leader MCP operations after asking the person in its CLI.
  const page = { limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }
  app.get('/api/memory/chat/read-requests', {preHandler:auth}, async (request, reply) => {
    const filter=parse(z.object({ state:z.enum(['pending_leader','pending_person','granted','rejected','cancelled','all']).default('all'), project_id:id.optional(), ...page }).strict(),request.query)
    const {operations}=await service.get()
    reply.header('Cache-Control','no-store')
    return operations.chat.readRequests({...filter,state:filter.state==='all'?undefined:filter.state})
  })
  app.get('/api/memory/chat/read-grants', {preHandler:auth}, async (request, reply) => {
    const filter=parse(z.object({ active:z.enum(['true','false']).default('true').transform(v=>v==='true'), project_id:id.optional(), ...page }).strict(),request.query)
    const {operations}=await service.get()
    reply.header('Cache-Control','no-store')
    return operations.chat.readGrants(filter)
  })
  app.get('/api/memory/chat/authority-events', {preHandler:auth}, async (request, reply) => {
    const raw=request.query as Record<string,unknown>
    const filter=parse(z.object({ project_id:id.optional(), channel_id:id.optional(),
      kind:z.union([z.string().regex(/^[a-z_]{1,40}$/),z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(20)]).optional(), ...page }).strict(),raw)
    const {operations}=await service.get()
    reply.header('Cache-Control','no-store')
    return listAuthorityEvents(operations.chat.db,{...filter,kinds:filter.kind===undefined?undefined:[filter.kind].flat()})
  })
  app.get('/api/memory/teams/preferences', {preHandler:auth}, async()=>{
    const {operations}=await service.get()
    return {preferred_backend:await operations.teams?.preference() ?? 'hub'}
  })
  app.put('/api/memory/teams/preferences', {preHandler:auth}, async request=>{
    const input=parse(z.object({preferred_backend:z.enum(['hub','native'])}).strict(),request.body)
    const {operations}=await service.get()
    check(operations.teams,'La flota no está disponible.',503)
    return operations.teams.setPreference(input.preferred_backend)
  })
  app.get('/api/memory/teams/:planId', {preHandler:auth}, async request=>{
    const {planId}=parse(z.object({planId:id}),request.params)
    const {operations}=await service.get()
    check(operations.teams,'La flota no está disponible.',503)
    return operations.teams.humanPlan(planId)
  })
  app.addHook('onListen', async () => { if (enabled('agents')) void runtime().catch(() => {}) })
  // Human owner authorization only: never register activity in the MCP operation dispatcher.
  app.get('/api/memory/chat/agents/:sessionId/activity', { preHandler: auth }, async (request, reply) => {
    const { sessionId } = parse(z.object({ sessionId: z.string().min(1).max(300) }), request.params)
    const { after } = parse(z.object({ after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) }), request.query)
    reply.header('Cache-Control', 'no-store')
    return service.fleetActivity(sessionId, after)
  })
  app.addHook("preClose", async () => { await Promise.allSettled([chatRuntime?.close(), watchdog?.close()]) })
  return {
    async close() {
      consumption.close()
      const results = await Promise.allSettled([watchdog?.close(), chatRuntime?.close()])
      for (const result of results) if (result.status === 'rejected') throw result.reason
    },
    async update() {
      if (enabled('agents')) {
        if (app.server.listening) await runtime()
      } else {
        await Promise.all([chatRuntime?.close(), watchdog?.close(), service.suspendFleet()])
        chatRuntime = undefined
        watchdog = undefined
      }
    },
  }
}
