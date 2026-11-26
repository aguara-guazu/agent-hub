import { moduleStates, operationModules, type ModuleEnabled, type ModuleId } from '@agenthub/shared/modules'
import { registerUpdateDrain, updateSecretAuthorizer } from './update-drain.js'
import { sharingRoutes } from './sharing/routes.js'
import { interhubRoutes } from './interhub/routes.js'
import { ALL_MEDIA_MODULES } from './transcriptions/media-runtime.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { MemoryService } from './service.js'
import { memoryTools } from './operations.js'
import { check, id, parse } from './contracts.js'
import { WorkerSupervisor, workerLogPath } from './supervisor.js'
import { buildReport, tailLog } from './report.js'
import { createRequire } from 'node:module'
import { homedir, release } from 'node:os'
import { requestMigrationRetry } from './legacy-postgres.js'
import { registerScheduleRoutes } from './schedules/schedule-routes.js'
import { registerDecisionRoutes } from './decision-routes.js'
import { registerProjectAutomationRoutes } from './schedules/project-automation-routes.js'
import { registerUpdateHintRoutes } from './sharing/update-hint.js'
import { registerAgentRuntime } from './agents/routes.js'
import { registerResidentTeams } from './assistants/teams.js'
import { registerAssistants } from './assistants/routes.js'
import { registerConnections } from './connectors/routes.js'
import { registerProjectRoutes } from './projects/routes.js'
import { registerMemoryMcp } from './mcp/routes.js'
import { registerTranscriptions } from './transcriptions/routes.js'
import type { MemoryRouteOptions } from './http.js'
export type { MemoryRouteOptions } from './http.js'

const VERSION = String((createRequire(import.meta.url)('../package.json') as { version: string }).version)

export function registerMemory(app: FastifyInstance, options: MemoryRouteOptions) {
  const enabled: ModuleEnabled = options.moduleEnabled ?? (() => true)
  const service = new MemoryService(options.directory, `${options.baseUrl}/api/memory/google/callback`, fetch, options.jiraMcp, true, options.collaborationEnabled,
    { moduleEnabled: enabled, enabled: options.automationsEnabled ?? (() => true), ...(options.scheduleEffects ? { effects: options.scheduleEffects } : {}) }, options.updateTransaction, options.legacyGateways)
  service.moduleEnabled = enabled
  const collaborationEnabled = options.collaborationEnabled ?? (() => true)
  const requireCollaboration = () => check(collaborationEnabled(), 'La colaboración está desactivada en Ajustes', 403)
  const updateDrain = registerUpdateDrain(app, service, { authorize: options.authorizeUpdate ?? updateSecretAuthorizer(undefined),
    beforeStartupAdmit: transactionId => service.get().then(({ stop }) => stop.assertStartupTransaction(transactionId)),
    startupAdmitted: async transactionId => { await (await service.get()).stop.resumeApplied(transactionId) },
    ...(options.updateTransaction ? { startupTransaction: options.updateTransaction } : {}) })
  const stopGuard = { preHandler: async (request: FastifyRequest) => { await (options.authorizeUpdate ?? updateSecretAuthorizer(undefined))(request) } }
  const stopIdBody = z.object({ stop_id: id }).strict()
  app.post("/api/internal/hub-stop", stopGuard, async request => {
    const input = parse(z.object({ source_id: id, reason: z.enum(["update", "quit"]), target_version: z.string().min(1).max(100).optional() }).strict(), request.body)
    return (await service.get()).stop.request({ source_id: input.source_id, reason: input.reason, ...(input.target_version ? { target_version: input.target_version } : {}) })
  })
  app.get("/api/internal/hub-stop/status", stopGuard, async request => {
    const input = parse(z.object({ stop_id: id.optional() }).strict(), request.query)
    return (await service.get()).stop.status(input.stop_id)
  })
  app.post("/api/internal/hub-stop/retry", stopGuard, async request => {
    const input = parse(stopIdBody, request.body)
    return (await service.get()).stop.retry(input.stop_id)
  })
  app.post("/api/internal/hub-stop/cancel", stopGuard, async request => {
    const input = parse(stopIdBody.extend({ reason: z.string().trim().min(1).max(500).default("cancelled_by_user") }), request.body)
    return (await service.get()).stop.cancel(input.stop_id, input.reason)
  })
  app.post("/api/internal/hub-stop/drain", stopGuard, async (request, reply) => {
    const input = parse(stopIdBody, request.body)
    const result = await (await service.get()).stop.acquireDrain(input.stop_id, updateDrain)
    return result.ok ? result : reply.code(409).send(result)
  })
  app.post("/api/internal/hub-stop/commit", stopGuard, async request => {
    const input = parse(stopIdBody.extend({ transaction_id: z.string().min(1).max(100).optional() }), request.body)
    return (await service.get()).stop.commit(input.stop_id, updateDrain, input.transaction_id)
  })
  if (options.authorizeUpdate) registerUpdateHintRoutes(app, async () => (await service.get()).hints, options.authorizeUpdate)
  const worker = new WorkerSupervisor(options.directory, service.google.redirectUrl, () => moduleStates(enabled))
  const auth = async (request: FastifyRequest) => { await options.authorize(request) }
  const agents = registerAgentRuntime(app, service, auth, options, enabled, collaborationEnabled, requireCollaboration)
  const openResidentTeams = registerResidentTeams(app, { backend: async () => (await service.get()).operations.teams,
    available: () => operationModules('resident_team').every(enabled) && collaborationEnabled(),
    baseUrl: options.baseUrl, admission: service.admission })
  const assistants = registerAssistants(app, service, auth, enabled, () => options.scheduleEffects?.jira, openResidentTeams, options.residentReadTools)
  const credentialReference = registerMemoryMcp(app, service, enabled, collaborationEnabled)
  registerConnections(app, service, auth, enabled)
  registerProjectRoutes(app, service, auth, enabled, assistants.trackingChanged)
  registerTranscriptions(app, service, auth, options, enabled)
  interhubRoutes(app, service, options.authorize, requireCollaboration)
  app.addHook('onListen', async () => { void service.startSchedules().catch(() => {}) })
  registerScheduleRoutes(app, service, options.authorize)
  registerDecisionRoutes(app, options.scheduleEffects, options.authorize, { service, ...(options.automationsEnabled ? { automationsEnabled: options.automationsEnabled } : {}) })
  registerProjectAutomationRoutes(app, async () => (await service.get()).operations.projectAutomation, options.authorize)
  sharingRoutes(app, service, options.authorize)
  app.get('/api/memory/status', { preHandler: auth }, () => service.status())
  // Public issue: kind, state, stage, model and the worker lines of this job only. Source titles and payloads stay out
  // because they name clients and projects.
  app.get('/api/memory/jobs/:id/report', { preHandler: auth }, async request => {
    const { id: jobId } = parse(z.object({ id }), request.params)
    const job = (await (await service.get()).db.query('SELECT * FROM jobs WHERE id=$1', [jobId]))[0]
    check(job, 'El trabajo no existe', 404)
    const lines = tailLog(workerLogPath(options.directory), 5000)
    const progress = job.progress ?? {}
    return buildReport({
      title: `Trabajo de memoria ${job.kind} falló: ${String(job.error ?? 'sin mensaje').slice(0, 120)}`,
      summary: `Un trabajo de la memoria (${job.kind}) quedó en estado «${job.state}» después de ${job.attempts} de ${job.max_attempts} intentos.`,
      error: job.error ?? 'sin mensaje',
      environment: { Versión: VERSION, Sistema: `${process.platform} ${release()} (${process.arch})`, Electron: process.versions.electron ?? '-', Node: process.versions.node },
      details: { Tipo: job.kind, Estado: job.state, Etapa: String(progress.stage ?? '-'), Intentos: `${job.attempts}/${job.max_attempts}`,
        ...(progress.provider ? { Proveedor: `${progress.provider}${progress.model ? ` / ${progress.model}` : ''}` } : {}),
        Creado: String(job.created_at), Actualizado: String(job.updated_at) },
      logs: [{ name: 'worker, este trabajo', lines: lines.filter(line => line.includes(job.id)).slice(-60) },
        { name: 'worker, cierres del proceso', lines: lines.filter(line => line.includes('[supervisor]')).slice(-10) }],
      home: homedir(),
    })
  })
  app.post('/api/memory/call', { preHandler: auth, bodyLimit: 36_000_000 }, async (request, reply) => {
    const input = parse(z.object({ operation: z.string().max(100), input: z.unknown().optional() }).strict(), request.body)
    const actor = await options.authorize(request)
    const controller = new AbortController(), abort = () => controller.abort()
    reply.raw.once('close', abort)
    try { return await (await service.get()).operations.call(input.operation, input.input, actor.id, undefined, controller.signal) }
    finally { reply.raw.off('close', abort) }
  })
  app.post('/api/memory/migration/retry', { preHandler: auth }, async () => {
    requestMigrationRetry(options.directory)
    return service.status()
  })
  let defaultsTimer: ReturnType<typeof setInterval> | undefined
  if (options.worker) app.addHook('onListen', async () => {
    const prepare = () => {
      if (!enabled('memory')) return
      void service.defaults.tick().catch(() => {})
      if (enabled('sharing')) void service.get().then(({ network }) => network.start()).catch(() => {})
    }
    prepare()
    defaultsTimer = setInterval(prepare, 5000); defaultsTimer.unref(); worker.start()
  })
  app.addHook("onClose", async () => {
    clearInterval(defaultsTimer)
    const failures: unknown[] = []
    for (const step of [() => assistants.close(), () => agents.close(), () => service.defaults.stop(), () => worker.stop(), () => service.close()]) {
      try { await step() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw failures[0]
  })
  // Re-read committed settings when the transition reaches the front of the queue.
  let transition = Promise.resolve()
  function modulesChanged(id: ModuleId) {
    worker.updateModules()
    const next = transition.then(async () => {
      await assistants.update(id)
      if (id === 'agents') await agents.update()
      if ((id === 'sharing' || id === 'memory') && options.worker && app.server.listening) {
        await service.refreshSharingNetwork()
      }
      if (id === 'memory' && !enabled(id)) await service.nativeEmbeddings.cancelInstall()
      if (id === 'transcriptions' && !enabled(id)) {
        await Promise.all(ALL_MEDIA_MODULES.map(name => service.media[name].cancelInstall()))
      }
      await service.refreshModuleSchedules()
    })
    transition = next.catch(() => {})
    return next
  }
  return { service, modulesChanged, credentialReference, tools: memoryTools }
}
