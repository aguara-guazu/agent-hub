export { HttpError } from './modules/http.js'
import { HttpError, isAdmin, isObject, requireObject, rejectUnknown, requireString, optionalString } from './modules/http.js'
import { registerAgentsRoutes } from './modules/agents/routes.js'
import { registerMcpRoutes } from './modules/mcp/routes.js'
import { registerExternalSkillSync } from './modules/skills/sync.js'
import { registerSkillsRoutes } from './modules/skills/routes.js'
import { moduleStates, type ModuleEnabled } from '@agenthub/shared/modules'
import { registerModuleSettings, installModuleGuards } from './modules/routes.js'
import { moduleEnabled } from './modules/settings.js'
import { collaborationEnabled, COLLABORATION_ENABLED_SETTING } from './collaboration.js'
import { automationsEnabled, readAutomationSettings, saveAutomationSettings } from './automations.js'
/**
 * Aplicación Fastify del control plane local. Espeja la superficie HTTP de
 * `packages/core` implementa `docs/API_CONTRACT.md`: rutas, cuerpos, códigos y formas.
 *
 * Dos principales no intercambiables (sección "Autenticación" del contrato):
 * - Consola web: JWT en `Authorization: Bearer <jwt>`.
 * - Daemon local: token opaco `ahd_...`. Nunca acepta JWT, y el JWT nunca sirve para `/sync`.
 */
import { timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import Fastify,{ type FastifyInstance,type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import { loadSettings, type Settings } from './config.js'
import { Database } from './db/database.js'
import { runMigrations } from './db/migrations.js'
import { DELETE_PURGE_INTERVAL_MS, DELETE_RETENTION_MS, Store } from "./store.js"
import { record as auditRecord, verify as auditVerify } from './audit/ledger.js'
import { buildMatrix, hotReload } from './matrix.js'
import { diffSnapshots, hasChanges, type PendingRestart } from './restart.js'
import { applyProbeResult, MEMORY_CATALOG_SERVER_SETTING } from './catalog/reconcile.js'
import { ProbeRetryScheduler } from './catalog/retry.js'
import { applyStarterCatalog } from './catalog/starter.js'
import { applyFactorySkill, type FactorySkill } from './catalog/factory-skills.js'
import { hubSkill } from './catalog/hub-skill.js'
import { computeSnapshot, explain } from './policy/resolver.js'
import { ensureLocalOwner } from './local.js'
import { agentScopeKeys, InvalidationBus, publishPolicyChange } from './events.js'
import {
  normalizeEmail,
  normalizeSlug,
  serializeSquads,
  serializeUser,
  serializeUsers,
  ValidationError,
} from './serialize.js'
import { serializeAgent, serializeAuditEvent, serializeClientAccount, serializeToolCall } from './serialize_catalog.js'
import {
  createAccessToken,
  DAEMON_TOKEN_PREFIX,
  decodeAccessToken,
  hashDaemonToken,
  hashPassword,
  NO_LOCAL_PASSWORD,
  verifyPassword,
} from './security.js'
import type { AgentInstance, ApiToken, Machine, User } from './types.js'
import { type PolicySnapshot } from '@agenthub/shared'
import { UNMANAGED_MAX_ITEMS, UNMANAGED_MAX_NAME, UNMANAGED_MAX_PATH, type LocalUnmanaged, type UnmanagedInventory } from "@agenthub/shared"
import { ConnectionPool, OAuthStore } from '@agenthub/gateway'
import * as gatewayModule from '@agenthub/gateway'
import { legacyGatewaysFor } from './legacy-policy.js'
import {
  registerMemory,
  updateSecretAuthorizer,
  memoryTools,
  memorySkill,
  collaborationSkill,
  localCollaborationSkill,
  responsabilidadSkill,
  googleSetupSkill,
  hubIssueSkill,
  MemoryError,
  delegatedPushPolicy,
} from '@agenthub/memory'
import { createJiraTaskReader } from './memory-jira.js'
import { createPoolCallAudit } from './effects/call-audit.js'
import { createCoreScheduleEffects } from './effects/wiring.js'
import { createJiraAdapters } from './effects/jira.js'
import { createGitPushAdapter } from './effects/git-push-adapter.js'
import { jiraWriteServerId, readJiraServerSelection, saveJiraServerId } from './effects/jira-server.js'

const ORG_ROLES = ['owner', 'admin', 'member']

const UNMANAGED_REASON = /^(?:(?:toml|json)_parse_error(?:: fila \d+, columna \d+)?|parse_error|read_error(?:: E[A-Z]+)?)$/

/**
 * Deriva que reporta el daemon, sin el texto que un parser de un daemon anterior copiaba tras «no es TOML/JSON válido:»
 * (la línea fallida, con posibles tokens de `env` o `headers`). Lo demás queda igual.
 */
function scrubDriftDetail(detail: string): string {
  // Continuation lines of a multi-line parser message do not start with an absolute path, as every drift line does.
  return detail.replace(/(no es (?:TOML|JSON) válido):[^\n]*(?:\n(?!\/|[A-Za-z]:\\)[^\n]*)*/g, "$1 (parse_error)")
}

/** Inventario `unmanaged` de `POST /api/sync/report`, validado estricto: un campo de más o fuera de tope rechaza el reporte entero. */
function readUnmanagedReport(raw: unknown): UnmanagedInventory {
  const fail = (detail: string): never => { throw new HttpError(422, `unmanaged: ${detail}`) }
  if (!isObject(raw)) fail("debe ser un objeto")
  const body = raw as Record<string, unknown>
  for (const key of Object.keys(body)) if (!["checked_at", "servers", "skills", "errors", "truncated"].includes(key)) fail(`campo desconocido: ${key}`)
  const text = (value: unknown, field: string, max: number): string => {
    if (typeof value !== "string" || value.length === 0 || value.length > max) fail(`${field} debe ser texto de 1 a ${max} caracteres`)
    return value as string
  }
  const list = (value: unknown, field: string, keys: string[]): Record<string, unknown>[] => {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > UNMANAGED_MAX_ITEMS || !value.every(isObject)) fail(`${field} debe ser una lista de hasta ${UNMANAGED_MAX_ITEMS} objetos`)
    for (const item of value as Record<string, unknown>[]) for (const key of Object.keys(item)) if (!keys.includes(key)) fail(`${field}[]: campo desconocido: ${key}`)
    return value as Record<string, unknown>[]
  }
  const checkedAt = text(body.checked_at, "checked_at", 40)
  if (Number.isNaN(Date.parse(checkedAt))) fail("checked_at no es una fecha ISO")
  if (body.truncated !== undefined && typeof body.truncated !== "boolean") fail("truncated debe ser booleano")
  const servers = list(body.servers, "servers", ["name", "path"]).map((item) => ({ name: text(item.name, "servers[].name", UNMANAGED_MAX_NAME), path: text(item.path, "servers[].path", UNMANAGED_MAX_PATH) }))
  const skills = list(body.skills, "skills", ["slug", "path", "linked"]).map((item) => {
    if (typeof item.linked !== "boolean") fail("skills[].linked debe ser booleano")
    return { slug: text(item.slug, "skills[].slug", UNMANAGED_MAX_NAME), path: text(item.path, "skills[].path", UNMANAGED_MAX_PATH), linked: item.linked as boolean }
  })
  // Solo motivos con la forma de código fijo; cualquier otro texto (un mensaje de parser de un daemon viejo) se reemplaza.
  const errors = list(body.errors, "errors", ["path", "reason"]).map((item) => {
    const reason = text(item.reason, "errors[].reason", 300)
    return { path: text(item.path, "errors[].path", UNMANAGED_MAX_PATH), reason: UNMANAGED_REASON.test(reason) ? reason : "unknown_error" }
  })
  if (servers.length + skills.length > UNMANAGED_MAX_ITEMS) fail(`servers y skills suman más de ${UNMANAGED_MAX_ITEMS}`)
  return { checked_at: new Date(checkedAt).toISOString(), servers, skills, errors, truncated: body.truncated === true }
}

export interface CoreApp {
  fastify: FastifyInstance
  store: Store
  db: Database
  settings: Settings
  bus: InvalidationBus
  /** Reintento automático del sondeo; lo arranca quien sirve la app (`server.ts`). */
  probeRetry: ProbeRetryScheduler
}

export interface BuildAppOptions {
  settings?: Partial<Settings>
  /** Crea al dueño local (modo un solo usuario) al arrancar. */
  ensureOwner?: boolean
}

/** Escáner de gateways heredados de `@agenthub/gateway`; ausente en versiones del paquete que aún no lo exportan. */
const legacyScan = (gatewayModule as unknown as { legacyGateways?: (runtimeRoot: string) => Promise<{ count: number; error?: string }> }).legacyGateways

/** Escaneo de gateways heredados según la plataforma; macOS sin escáner o sin raíz queda «desconocido». */
function legacyPolicy(runtimeRoot: string): { legacyGateways?: () => Promise<{ count: number; error?: string; not_applicable?: boolean }> } {
  const scan = legacyGatewaysFor(process.platform, legacyScan, runtimeRoot)
  return scan ? { legacyGateways: scan } : {}
}

export function buildApp(options: BuildAppOptions = {}): CoreApp {
  const settings = loadSettings(options.settings)
  const db = new Database(settings.databasePath)
  runMigrations(db, settings.databasePath)
  const store = new Store(db)
  const bus = new InvalidationBus()
  // Credenciales OAuth de los MCP servers: archivos 0600 fuera de la base.
  const oauthStore = new OAuthStore(settings.oauthDir)
  // El archivo OAuth de un server borrado vive solo durante la ventana de Deshacer.
  store.onServerPurged = (serverId) => oauthStore.delete(serverId)
  const purgeDeleted = (): void => {
    const purged = store.purgeDeleted(new Date(Date.now() - DELETE_RETENTION_MS).toISOString())
    if (purged.servers || purged.skills) console.error(`[catalog] purga de borrados: ${purged.servers} servers, ${purged.skills} skills`)
  }
  purgeDeleted()
  const purgeTimer = setInterval(purgeDeleted, DELETE_PURGE_INTERVAL_MS)
  purgeTimer.unref()

  if (options.ensureOwner ?? settings.localMode) {
    const owner = ensureLocalOwner(store)
    // Contenido de fábrica bajo AGENTHUB_STARTER_CATALOG: servers públicos listos para usar o
    // para «Conectar cuenta», y la skill `agent-hub` que enseña a usar el hub a todos los clientes.
    if (settings.starterCatalog) {
      const seeded = applyStarterCatalog(store, owner)
      if (seeded.added.length) console.error(`[starter] catálogo inicial v${seeded.version}: ${seeded.added.join(', ')}`)
      const skill = applyFactorySkill(store, owner, 'hub_skill', hubSkill)
      if (skill === 'created' || skill === 'updated') console.error(`[starter] skill ${hubSkill.slug}: ${skill}`)
    }
  }

  const fastify = Fastify({ logger: false })
  const enabled: ModuleEnabled = id => moduleEnabled(store, id)
  installModuleGuards(fastify, store, currentUserOrDaemon)
  fastify.addHook("onClose", async () => { clearInterval(purgeTimer) })

  // El cuerpo de las respuestas 204 no lleva contenido.
  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError || error instanceof MemoryError) {
      const code = error instanceof MemoryError ? error.code : undefined
      const location = error instanceof MemoryError ? error.location : undefined
      return reply.code(error instanceof HttpError ? error.status : error.statusCode).send({
        detail: error.message, ...(code ? { code } : {}), ...(location?.field ? { field: location.field } : {}), ...(location?.reason ? { reason: location.reason } : {}),
      })
    }
    if (error instanceof ValidationError) {
      return reply.code(422).send({ detail: error.message })
    }
    // Errores de parseo de JSON de Fastify llegan con statusCode 400.
    const status = (error as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ detail: error instanceof Error ? error.message : 'Solicitud inválida' })
    }
    reply.code(500).send({ detail: 'error interno' })
    return undefined
  })

  void fastify.register(cors, {
    origin: settings.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  })

  // ------------------------------------------------------------ autenticación

  function bearer(request: FastifyRequest): string {
    const header = request.headers.authorization
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      throw new HttpError(401, 'falta el encabezado Authorization: Bearer')
    }
    return header.slice(7).trim()
  }

  async function currentUser(request: FastifyRequest): Promise<User> {
    const token = bearer(request)
    let sub: string
    try {
      const payload = await decodeAccessToken(settings, token)
      sub = typeof payload.sub === 'string' ? payload.sub : ''
    } catch {
      throw new HttpError(401, 'token invalido o vencido')
    }
    const user = store.user(sub)
    if (!user || !user.is_active) throw new HttpError(401, 'usuario inexistente o inactivo')
    return user
  }

  async function requireAdmin(request: FastifyRequest): Promise<User> {
    const user = await currentUser(request)
    if (!isAdmin(user)) throw new HttpError(403, 'hace falta rol admin u owner')
    return user
  }

  interface DaemonPrincipal {
    token: ApiToken
    user: User
    machine: Machine
    agent: AgentInstance | null
  }

  function currentDaemon(request: FastifyRequest): DaemonPrincipal {
    const raw = bearer(request)
    const token = store.tokenByHash(hashDaemonToken(raw))
    if (!token || token.revoked_at !== null) throw new HttpError(401, 'token de daemon invalido o revocado')
    if (token.expires_at !== null && Date.parse(token.expires_at) < Date.now()) {
      throw new HttpError(401, 'token de daemon vencido')
    }
    const user = store.user(token.user_id)
    if (!user || !user.is_active) throw new HttpError(401, 'usuario inexistente o inactivo')
    const machine = token.machine_id ? store.machine(token.machine_id) : undefined
    if (!machine) throw new HttpError(401, 'el token no esta ligado a una maquina')
    const agent = token.agent_instance_id ? store.agent(token.agent_instance_id) ?? null : null
    const at = new Date().toISOString()
    store.touchToken(token.id, at)
    store.updateMachine(machine.id, { last_seen_at: at })
    return { token, user, machine, agent }
  }

  async function currentUserOrDaemon(request: FastifyRequest): Promise<User> {
    const raw = bearer(request)
    if (raw.startsWith(DAEMON_TOKEN_PREFIX)) return currentDaemon(request).user
    return currentUser(request)
  }


  fastify.post('/api/auth/desktop-session', async (request, reply) => {
    if (!settings.localMode || !settings.desktopBootstrapToken) {
      throw new HttpError(404, 'ruta inexistente')
    }
    const supplied = bearer(request)
    const expected = settings.desktopBootstrapToken
    const left = Buffer.from(supplied)
    const right = Buffer.from(expected)
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new HttpError(401, 'bootstrap de escritorio invalido')
    }
    const owner = ensureLocalOwner(store)
    return reply.send({
      access_token: await createAccessToken(settings, owner.id),
      token_type: 'bearer',
      user: serializeUser(store, owner),
    })
  })
  function ownedAgent(user: User, agentId: string): AgentInstance {
    const agent = store.agent(agentId)
    if (!agent) throw new HttpError(404, 'agente inexistente')
    const machine = store.machine(agent.machine_id)!
    const owner = store.user(machine.user_id)!
    const admin = isAdmin(user)
    if (owner.id !== user.id && !(admin && owner.organization_id === user.organization_id)) {
      throw new HttpError(403, 'el agente no es tuyo')
    }
    return agent
  }

  if (settings.localMode) {
    const memoryDirectory = process.env.AGENTHUB_MEMORY_DIR || join(dirname(settings.databasePath), 'memory')
    const owner = ensureLocalOwner(store)
    const baseUrl = new URL(settings.oauthRedirectUrl).origin
    const jiraPool = new ConnectionPool(undefined, { oauthStore, detectContainers: false, onCall: createPoolCallAudit(store, owner.id) })
    fastify.addHook('onClose', async () => { await jiraPool.close() })
    const memoryRef: { service?: { vault: any; google: any; get(): Promise<any> } } = {}
    const scheduleEffects = createCoreScheduleEffects({ store, pool: jiraPool, ownerId: owner.id, moduleEnabled: enabled, automationsEnabled: () => automationsEnabled(store) && enabled('memory'),
      // El servidor de Jira se relee en cada intención: el elegido o, sin elección, `atlassian-rovo`. Con «Ninguno», un servidor que ya no es del dueño
      // o ninguno utilizable, la escritura falla cerrada aunque otro servidor publique las herramientas.
      adapters: ({ db }) => [...createJiraAdapters({ serverId: () => jiraWriteServerId(store, owner.id) }),
        // Los límites del push (ramas, destino canónico) salen de la delegación vigente y se releen en cada intención: revocarla frena un push ya aprobado.
        createGitPushAdapter({ policy: repoId => delegatedPushPolicy(db, repoId) })],
      host: { directory: memoryDirectory, get vault() { return memoryRef.service!.vault }, get google() { return memoryRef.service!.google },
        load: async () => { const current = await memoryRef.service!.get(); return { db: current.db, schedules: current.schedules.store } } } })
    const memory = registerMemory(fastify, { directory: memoryDirectory, baseUrl,
      moduleEnabled: enabled,
      collaborationEnabled: () => enabled('agents') && collaborationEnabled(store),
      automationsEnabled: () => automationsEnabled(store),
      scheduleEffects,
      jiraMcp: createJiraTaskReader(store, owner.id, jiraPool, oauthStore),
      usageAgentEnabled: agentId => !!store.agent(agentId) && computeSnapshot(store,agentId).servers.some(s=>s.id===store.setting(MEMORY_CATALOG_SERVER_SETTING) && s.tools.some(t=>t.name==='usage_status')),
      chatAgentEnabled: agentId => !!store.agent(agentId) && computeSnapshot(store,agentId).servers.some(s=>s.id===store.setting(MEMORY_CATALOG_SERVER_SETTING) && s.tools.some(t=>t.name==='chat_join') && s.tools.some(t=>t.name==='chat_inbox')),
      authorizeUsageAgent: async (request, agentId) => {
        const principal=currentDaemon(request),agent=store.agent(agentId)
        if(!agent || principal.user.id!==owner.id || agent.machine_id!==principal.machine.id || (principal.agent && principal.agent.id!==agentId))
          throw new HttpError(403,'El cliente no pertenece a este daemon local')
        if(!computeSnapshot(store,agentId).servers.some(s=>s.id===store.setting(MEMORY_CATALOG_SERVER_SETTING) && s.tools.some(t=>t.name==='usage_status')))
          throw new HttpError(403,'La consulta de cuotas está deshabilitada para este cliente')
        return {cli_kind:agent.cli_kind}
      },
      authorizeChatAgent: async (request, agentId) => {
        const principal = currentDaemon(request), agent = store.agent(agentId)
        if (!agent || principal.user.id !== owner.id || agent.machine_id !== principal.machine.id || (principal.agent && principal.agent.id !== agentId))
          throw new HttpError(403, 'La sesión no pertenece a este daemon local')
        if (!computeSnapshot(store,agentId).servers.some(s=>s.id===store.setting(MEMORY_CATALOG_SERVER_SETTING) && s.tools.some(t=>t.name==='chat_join')))
          throw new HttpError(403, 'La colaboración local está deshabilitada para este agente')
        return { cli_kind: agent.cli_kind }
      },
      worker: process.env.AGENTHUB_MEMORY_WORKER !== '0',
      authorize: async request => {
        const user = await currentUser(request)
        if (user.id !== owner.id) throw new HttpError(403, 'La memoria pertenece al dueño local del hub')
        return user
      },
      authorizeUpdate: updateSecretAuthorizer(settings.updateDrainSecret),
      ...(settings.updateTransaction ? { updateTransaction: settings.updateTransaction } : {}),
      // El escaneo recibe la raíz `<stateDir>/runtime`, nunca la ruta del lanzador. Sin raíz o sin la función, la compuerta responde legacy_gateways_unknown.
      ...legacyPolicy(settings.gatewayRuntimeRoot),
    })
    memoryRef.service = memory.service
    registerModuleSettings(fastify, store, async request => {
      if ((await currentUser(request)).id !== owner.id) throw new HttpError(403, 'Los módulos pertenecen al dueño local del Hub')
    }, async id => {
      publishPolicyChange(bus, store, 'user', owner.id)
      await memory.modulesChanged(id)
    })
    fastify.get('/api/collaboration', async request => {
      const user = await currentUser(request)
      if (user.id !== owner.id) throw new HttpError(403, 'La configuración pertenece al dueño local del hub')
      return { enabled: collaborationEnabled(store) }
    })
    fastify.put('/api/collaboration', async request => {
      const user = await currentUser(request)
      if (user.id !== owner.id) throw new HttpError(403, 'La configuración pertenece al dueño local del hub')
      const input = request.body as { enabled?: unknown } | null
      if (!input || typeof input.enabled !== 'boolean' || Object.keys(input).some(key => key !== 'enabled'))
        throw new HttpError(422, 'Se requiere enabled booleano')
      store.setSetting(COLLABORATION_ENABLED_SETTING, input.enabled ? '1' : '0')
      if (!input.enabled) await memory.service.suspendFleet()
      publishPolicyChange(bus, store, 'user', owner.id)
      return { enabled: collaborationEnabled(store) }
    })
    fastify.get('/api/automations', async request => {
      const user = await currentUser(request)
      if (user.id !== owner.id) throw new HttpError(403, 'La configuración pertenece al dueño local del hub')
      return readAutomationSettings(store)
    })
    fastify.put('/api/automations', async request => {
      const user = await currentUser(request)
      if (user.id !== owner.id) throw new HttpError(403, 'La configuración pertenece al dueño local del hub')
      const input = request.body as Record<string, unknown> | null
      if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) throw new HttpError(422, 'Se requiere al menos un ajuste')
      const invalid = saveAutomationSettings(store, input)
      if (invalid) throw new HttpError(422, `Ajuste inválido: ${invalid}`)
      // A switch change takes effect now: the runtime cancels what has not started and stops what runs.
      if ('automations_enabled' in input) {
        publishPolicyChange(bus, store, 'user', owner.id)
        await memory.service.kickSchedules()
      }
      return readAutomationSettings(store)
    })
    // Solo la sesión de la app del dueño: un token de daemon o de agente no decodifica como sesión y `currentUser` lo rechaza con 401.
    fastify.get('/api/automations/jira-server', async request => {
      const user = await currentUser(request)
      if (user.id !== owner.id) throw new HttpError(403, 'La configuración pertenece al dueño local del hub')
      return readJiraServerSelection(store, owner.id)
    })
    fastify.put('/api/automations/jira-server', async request => {
      const user = await currentUser(request)
      if (user.id !== owner.id) throw new HttpError(403, 'La configuración pertenece al dueño local del hub')
      const input = request.body as Record<string, unknown> | null
      const serverId = input && typeof input === 'object' ? input['server_id'] : undefined
      if (!input || Array.isArray(input) || Object.keys(input).some(key => key !== 'server_id') || (serverId !== null && typeof serverId !== 'string'))
        throw new HttpError(422, 'Se requiere server_id como texto o null')
      const rejected = saveJiraServerId(store, owner.id, serverId)
      if (rejected === 'unknown_server') throw new HttpError(422, 'El servidor no existe o no pertenece al dueño')
      if (rejected === 'not_usable') throw new HttpError(422, 'El servidor no publica atlassianUserInfo y getJiraIssue')
      return readJiraServerSelection(store, owner.id)
    })
    const registerCatalog = () => {
      const installedId = store.setting(MEMORY_CATALOG_SERVER_SETTING)
      const existing = installedId ? store.server(installedId) : undefined
      if (installedId && !existing) return
      let slug = 'memory'
      for (let suffix = 2; !existing && store.serverBySlug(owner.id, slug); suffix++) slug = `memory-${suffix}`
      const server = existing ?? store.insertServer({ user_id: owner.id, slug, display_name: 'Memoria de proyectos',
        description: 'Proyectos, reuniones, documentos y conocimiento local con evidencia.', transport: 'http', command: '', args: [], env: {}, cwd: '',
        url: `${baseUrl}/api/memory/mcp`, headers: {}, secret_refs: { Authorization: memory.credentialReference },
        requires_host_access: false, container_image: '', allow_hosts: [], allow_ports: [], read_mounts: [], write_mounts: [] })
      if (existing) store.updateServer(existing.id, { url: `${baseUrl}/api/memory/mcp`, secret_refs: { Authorization: memory.credentialReference } })
      applyProbeResult(store, store.server(server.id)!, { ok: true, error: '', auth_required: false, server_name: 'agenthub-memory', server_version: '0.2.0',
        tools: memoryTools.map(t => ({ name: t.name, title: t.name, description: t.description, input_schema: t.inputSchema })) })
      store.setSetting('memory_catalog_installed', '1')
      store.setSetting(MEMORY_CATALOG_SERVER_SETTING, server.id)
      registerMemorySkill()
      publishPolicyChange(bus, store, 'user', owner.id)
    }
    // Skills de fábrica de la memoria: mismas reglas de actualización que `agent-hub`
    // (catalog/factory-skills.ts). Las claves en settings son `<clave>_id` y `<clave>_hash`;
    // `memory` conserva las históricas.
    const factorySkills: { key: string; skill: FactorySkill }[] = [
      { key: 'memory_skill', skill: memorySkill },
      { key: 'collaboration_skill', skill: collaborationSkill },
      { key: 'local_collaboration_skill', skill: localCollaborationSkill },
      { key: 'responsabilidad_skill', skill: responsabilidadSkill },
      { key: 'google_setup_skill', skill: googleSetupSkill },
      { key: "hub_issue_skill", skill: hubIssueSkill },
    ]
    const registerMemorySkill = () => { for (const entry of factorySkills) applyFactorySkill(store, owner, entry.key, entry.skill) }
    registerCatalog()
  } else {
    fastify.get('/api/modules', { preHandler: async request => { await currentUser(request) } }, async () => ({ ...moduleStates(enabled), can_manage: false }))
  }

  const notifyAfterCommit = (scope: 'agent' | 'user', scopeId: string): void => {
    // node:sqlite escribe en modo autocommit fuera de una transacción explícita, así que
    // para cuando llegamos acá el cambio ya está en disco: sólo hay que avisar.
    publishPolicyChange(bus, store, scope, scopeId)
  }
  const probeRetry = new ProbeRetryScheduler({
    store,
    oauthStore,
    redirectUrl: settings.oauthRedirectUrl,
    intervalMs: settings.probeRetrySeconds * 1000,
    onChange: (userId) => notifyAfterCommit('user', userId),
    log: (line) => console.error(line),
  })
  // ============================================================ auth
  fastify.post('/api/auth/login', async (request, reply) => {
    const body = requireObject(request.body)
    const email = optionalString(body, 'email').trim().toLowerCase()
    const password = optionalString(body, 'password')
    const candidates = store.usersByEmail(email)

    let matched: User | null = null
    for (const candidate of candidates) {
      if (candidate.password_hash === NO_LOCAL_PASSWORD) continue
      if ((await verifyPassword(password, candidate.password_hash)) && candidate.is_active) {
        matched = candidate
        break
      }
    }
    if (!matched) throw new HttpError(401, 'email o contrasena invalidos')

    return reply.send({
      access_token: await createAccessToken(settings, matched.id),
      token_type: 'bearer',
      user: serializeUser(store, matched),
    })
  })

  fastify.get('/api/auth/me', async (request) => {
    const user = await currentUser(request)
    return serializeUser(store, user)
  })

  fastify.get('/api/auth/providers', async () => ({
    password_enabled: !settings.localMode,
    oidc_enabled: false,
    oidc_label: '',
    oidc_login_url: '',
  }))

  // ============================================================ identity
  fastify.post('/api/identity/users', async (request, reply) => {
    const admin = await requireAdmin(request)
    const body = requireObject(request.body)
    rejectUnknown(body, ['email', 'full_name', 'password', 'org_role'])
    const email = normalizeEmail(requireString(body, 'email'))
    const password = requireString(body, 'password')
    const fullName = optionalString(body, 'full_name')
    const orgRole = optionalString(body, 'org_role', 'member')
    if (!ORG_ROLES.includes(orgRole)) throw new HttpError(422, 'org_role invalido')
    requireOwnerFor(admin, orgRole)
    if (store.usersOfOrg(admin.organization_id).some((u) => u.email === email)) {
      throw new HttpError(409, 'ya existe un usuario con ese email')
    }
    const user = store.insertUser({
      organization_id: admin.organization_id,
      email,
      full_name: fullName,
      password_hash: await hashPassword(password),
      org_role: orgRole,
      is_active: true,
    })
    return reply.send(serializeUser(store, user))
  })

  fastify.get('/api/identity/users', async (request) => {
    const user = await currentUser(request)
    return serializeUsers(store, store.usersOfOrg(user.organization_id))
  })

  function requireOwnerFor(actor: User, ...roles: string[]): void {
    if (roles.includes('owner') && actor.org_role !== 'owner') throw new HttpError(403, 'hace falta rol owner')
  }

  function lastActiveOwner(target: User): boolean {
    if (target.org_role !== 'owner' || !target.is_active) return false
    return store.activeOwnersExcept(target.organization_id, target.id).length === 0
  }

  fastify.patch('/api/identity/users/:id', async (request) => {
    const admin = await requireAdmin(request)
    const { id } = request.params as { id: string }
    const body = requireObject(request.body)
    rejectUnknown(body, ['full_name', 'org_role', 'is_active'])
    const target = store.user(id)
    if (!target || target.organization_id !== admin.organization_id) throw new HttpError(404, 'el usuario no existe')

    const nextRole = typeof body.org_role === 'string' ? body.org_role : target.org_role
    if ('org_role' in body || 'is_active' in body) requireOwnerFor(admin, target.org_role, nextRole)
    const removesOwner = 'org_role' in body && body.org_role !== 'owner'
    const deactivates = body.is_active === false
    if ((removesOwner || deactivates) && lastActiveOwner(target)) {
      throw new HttpError(409, 'la organizacion quedaria sin ningun owner activo')
    }
    const fields: { full_name?: string; org_role?: string; is_active?: boolean } = {}
    if (typeof body.full_name === 'string') fields.full_name = body.full_name
    if (typeof body.org_role === 'string') {
      if (!ORG_ROLES.includes(body.org_role)) throw new HttpError(422, 'org_role invalido')
      fields.org_role = body.org_role
    }
    if (typeof body.is_active === 'boolean') fields.is_active = body.is_active
    store.updateUser(target.id, fields)
    return serializeUser(store, store.user(target.id)!)
  })

  fastify.get('/api/identity/squads', async (request) => {
    const user = await currentUser(request)
    return serializeSquads(store, store.squadsOfOrg(user.organization_id))
  })

  fastify.post('/api/identity/squads', async (request, reply) => {
    const admin = await requireAdmin(request)
    const body = requireObject(request.body)
    rejectUnknown(body, ['slug', 'name', 'client_account_id'])
    const slug = normalizeSlug(requireString(body, 'slug'))
    const name = requireString(body, 'name')
    const clientAccountId = body.client_account_id === undefined || body.client_account_id === null ? null : String(body.client_account_id)
    if (store.squadBySlug(admin.organization_id, slug)) throw new HttpError(409, 'ya existe un squad con ese slug')
    if (clientAccountId !== null) {
      const account = store.clientAccount(clientAccountId)
      if (!account || account.organization_id !== admin.organization_id) throw new HttpError(404, 'la cuenta de cliente no existe')
    }
    const squad = store.insertSquad({ organization_id: admin.organization_id, slug, name, client_account_id: clientAccountId })
    return reply.send(serializeSquads(store, [squad])[0])
  })

  fastify.post('/api/identity/squads/:id/members', async (request, reply) => {
    const admin = await requireAdmin(request)
    const { id } = request.params as { id: string }
    const body = requireObject(request.body)
    rejectUnknown(body, ['user_id', 'role', 'valid_from', 'valid_to'])
    const squad = store.squad(id)
    if (!squad || squad.organization_id !== admin.organization_id) throw new HttpError(404, 'el squad no existe')
    const userId = requireString(body, 'user_id')
    const member = store.user(userId)
    if (!member || member.organization_id !== admin.organization_id) throw new HttpError(404, 'el usuario no existe')
    const role = optionalString(body, 'role', 'member')
    if (role !== 'lead' && role !== 'member') throw new HttpError(422, 'role invalido')
    const validFrom = body.valid_from === undefined || body.valid_from === null ? null : String(body.valid_from)
    const validTo = body.valid_to === undefined || body.valid_to === null ? null : String(body.valid_to)
    if (validFrom && validTo && Date.parse(validTo) < Date.parse(validFrom)) {
      throw new HttpError(422, 'valid_to no puede ser anterior a valid_from')
    }
    store.upsertMembership({ squad_id: squad.id, user_id: member.id, role, valid_from: validFrom, valid_to: validTo })
    notifyAfterCommit('user', member.id)
    return reply.code(204).send()
  })

  fastify.delete('/api/identity/squads/:id/members/:userId', async (request, reply) => {
    const admin = await requireAdmin(request)
    const { id, userId } = request.params as { id: string; userId: string }
    const squad = store.squad(id)
    if (!squad || squad.organization_id !== admin.organization_id) throw new HttpError(404, 'el squad no existe')
    if (store.deleteMembership(squad.id, userId)) notifyAfterCommit('user', userId)
    return reply.code(204).send()
  })

  fastify.get('/api/identity/client-accounts', async (request) => {
    const user = await currentUser(request)
    return store.clientAccountsOfOrg(user.organization_id).map(serializeClientAccount)
  })

  fastify.post('/api/identity/client-accounts', async (request, reply) => {
    const admin = await requireAdmin(request)
    const body = requireObject(request.body)
    rejectUnknown(body, ['slug', 'name'])
    const slug = normalizeSlug(requireString(body, 'slug'))
    const name = requireString(body, 'name')
    if (store.clientAccountBySlug(admin.organization_id, slug)) throw new HttpError(409, 'ya existe una cuenta con ese slug')
    const account = store.insertClientAccount(admin.organization_id, slug, name)
    return reply.send(serializeClientAccount(account))
  })

  /**
   * Lo que un cliente sin recarga en caliente listó y ya cambió. `null` si recarga solo, si
   * nunca listó o si ya tiene lo vigente. Con el snapshot listado guardado se detalla qué
   * skills y servers difieren; si se perdió, sólo se informa que hay cambios.
   */
  function pendingRestartFor(agent: AgentInstance, machine: Machine, current: PolicySnapshot): PendingRestart | null {
    if (hotReload(agent.cli_kind)) return null
    const listed = agent.last_listed_hash
    if (!listed || listed === current.snapshot_hash) return null
    const previous = store.snapshotByHash(agent.id, listed) as PolicySnapshot | undefined
    let changes = previous ? diffSnapshots(previous, current) : null
    if (changes !== null && !hasChanges(changes)) changes = null
    return {
      agent_id: agent.id,
      cli_kind: agent.cli_kind,
      machine_hostname: machine.hostname,
      snapshot_hash: current.snapshot_hash,
      listed_hash: listed,
      changes,
    }
  }

  /** Inventario del cliente cruzado con el catálogo por slug; `null` si su daemon no lo reportó. */
  function unmanagedView(user: User, agent: AgentInstance): LocalUnmanaged | null {
    const report = agent.unmanaged
    if (report === null) return null
    const servers = new Map(store.serversOfUser(user.id).map((server) => [server.slug, server.id]))
    const skills = new Map(store.skillsOfUser(user.id).map((skill) => [skill.slug, skill.id]))
    return {
      checked_at: report.checked_at,
      servers: report.servers.map((item) => ({ ...item, catalog_server_id: servers.get(item.name) ?? null })),
      skills: report.skills.map((item) => ({ ...item, catalog_skill_id: skills.get(item.slug) ?? null })),
      errors: report.errors,
      truncated: report.truncated,
    }
  }

  fastify.get('/api/local/overview', async (request) => {
    const user = await currentUser(request)
    const matrix = buildMatrix(store, user)
    const clients = store.agentsOfUser(user.id).map(({ agent, machine }) => {
      const sync = db.get('SELECT snapshot_hash, synced_at FROM local_client_sync WHERE agent_id = ?', agent.id)
      const snapshot = computeSnapshot(store, agent.id)
      const pending = pendingRestartFor(agent, machine, snapshot)
      return { ...serializeAgent(agent, machine), config_path: agent.config_path,
        synced_at: sync?.synced_at ?? null,
        synchronized: !agent.drift_detected && sync?.snapshot_hash === snapshot.snapshot_hash,
        server_count: snapshot.servers.length, skill_count: snapshot.skills.length,
        restart_pending: pending !== null,
        pending: pending?.changes ?? null,
        unmanaged: unmanagedView(user, agent),
      }
    })
    return { hostname: hostname(), clients, rows: matrix.rows }
  })

  /** Clientes que necesitan reiniciarse para ver lo vigente; lo consulta el proceso de escritorio. */
  fastify.get('/api/local/pending-restarts', async (request) => {
    const user = await currentUser(request)
    const out: PendingRestart[] = []
    for (const { agent, machine } of store.agentsOfUser(user.id)) {
      if (hotReload(agent.cli_kind) || !agent.last_listed_hash) continue
      const pending = pendingRestartFor(agent, machine, computeSnapshot(store, agent.id))
      if (pending !== null) out.push(pending)
    }
    return out
  })

  registerExternalSkillSync(fastify, { store, currentDaemon, notifyAfterCommit })
  registerSkillsRoutes(fastify, { store, currentUser, notifyAfterCommit })

  registerMcpRoutes(fastify, { store, currentUser, notifyAfterCommit, oauthStore, settings })

  registerAgentsRoutes(fastify, { store, currentUser, notifyAfterCommit, currentDaemon, ownedAgent })

  // ============================================================ policy
  function targetUser(actor: User, userId: string | undefined): User {
    if (!userId || userId === actor.id) return actor
    if (!isAdmin(actor)) throw new HttpError(403, 'solo un admin puede ver la matriz de otra persona')
    const target = store.user(userId)
    if (!target || target.organization_id !== actor.organization_id) throw new HttpError(404, 'usuario inexistente')
    return target
  }

  fastify.get('/api/policy/matrix', async (request) => {
    const user = await currentUser(request)
    const { user_id: userId } = request.query as { user_id?: string }
    return buildMatrix(store, targetUser(user, userId))
  })

  fastify.get('/api/policy/explain', async (request) => {
    const user = await currentUserOrDaemon(request)
    const { agent_id: agentId, resource_type: resourceType, resource_id: resourceId } = request.query as {
      agent_id?: string
      resource_type?: string
      resource_id?: string
    }
    if (!agentId || !resourceType || !resourceId) throw new HttpError(422, 'faltan agent_id, resource_type o resource_id')
    ownedAgent(user, agentId)
    const decision = explain(store, agentId, resourceType, resourceId)
    return { exposed: decision.exposed, source: decision.source, detail: decision.detail }
  })

  fastify.get('/api/policy/snapshot/:agentId', async (request) => {
    const user = await currentUserOrDaemon(request)
    const { agentId } = request.params as { agentId: string }
    ownedAgent(user, agentId)
    const snapshot = computeSnapshot(store, agentId)
    // El gateway lista con este snapshot y reporta su hash: guardarlo permite comparar
    // después lo que la app vio con lo vigente.
    store.storeSnapshot(agentId, snapshot.snapshot_hash, snapshot)
    return snapshot
  })

  function resourceSlug(user: User, resourceType: string, resourceId: string): string {
    if (resourceType === 'mcp_server') {
      const server = store.server(resourceId)
      if (!server || server.user_id !== user.id) throw new HttpError(404, 'el MCP server no existe')
      return server.slug
    }
    if (resourceType === 'skill') {
      const skill = store.skill(resourceId)
      if (!skill || skill.user_id !== user.id) throw new HttpError(404, 'la skill no existe')
      return skill.slug
    }
    const tool = store.tool(resourceId)
    if (!tool) throw new HttpError(404, 'la herramienta no existe')
    const server = store.server(tool.server_id)
    if (!server || server.user_id !== user.id) throw new HttpError(404, 'la herramienta no existe')
    return `${server.slug}/${tool.name}`
  }

  fastify.put('/api/policy/rules', async (request, reply) => {
    const user = await currentUser(request)
    const body = requireObject(request.body)
    rejectUnknown(body, ['scope', 'scope_id', 'resource_type', 'resource_id', 'state', 'reason', 'reset_clients'])
    const scope = requireString(body, 'scope')
    if (scope !== 'user' && scope !== 'client') throw new HttpError(422, 'scope invalido')
    const scopeId = optionalString(body, 'scope_id')
    const resourceType = requireString(body, 'resource_type')
    if (!['mcp_server', 'mcp_tool', 'skill'].includes(resourceType)) throw new HttpError(422, 'resource_type invalido')
    const resourceId = requireString(body, 'resource_id')
    const state = requireString(body, 'state')
    if (!['on', 'off', 'inherit'].includes(state)) throw new HttpError(422, 'state invalido')
    const reason = optionalString(body, 'reason')
    if (reason.length > 500) throw new HttpError(422, 'reason demasiado largo')

    let agent: AgentInstance | null = null
    if (scope === 'client') {
      agent = ownedAgent(user, scopeId)
    } else if (scopeId && scopeId !== user.id) {
      throw new HttpError(403, 'no se puede escribir la politica de otra persona')
    }

    const slug = resourceSlug(user, resourceType, resourceId)
    const existing = store.findRule(user.id, agent ? agent.id : null, resourceType, resourceId)
    if (scope === 'user' && body.reset_clients === true) {
      db.run('DELETE FROM exposure_rules WHERE user_id = ? AND resource_type = ? AND resource_id = ? AND agent_instance_id IS NOT NULL', user.id, resourceType, resourceId)
    }

    if (state === 'inherit') {
      if (existing) store.deleteRule(existing.id)
    } else if (existing) {
      store.updateRule(existing.id, state, reason)
    } else {
      store.insertRule({
        user_id: user.id,
        agent_instance_id: agent ? agent.id : null,
        resource_type: resourceType,
        resource_id: resourceId,
        state,
        reason,
      })
    }

    auditRecord(store, user.organization_id, user, 'policy.rule.set', resourceType, resourceId, {
      scope,
      scope_label: scope === 'user' ? 'todos mis clientes' : 'este cliente',
      scope_id: scopeId,
      resource_slug: slug,
      state,
      reason,
    })

    if (agent) notifyAfterCommit('agent', agent.id)
    else notifyAfterCommit('user', user.id)
    return reply.code(204).send()
  })

  // ============================================================ sync
  function agentOfMachine(daemon: DaemonPrincipal, agentId: string): AgentInstance {
    const agent = store.agent(agentId)
    if (!agent || agent.machine_id !== daemon.machine.id) throw new HttpError(404, 'agente inexistente en esta maquina')
    return agent
  }

  fastify.get('/api/sync/bootstrap', async (request) => {
    const daemon = currentDaemon(request)
    return {
      modules: moduleStates(enabled),
      machine_id: daemon.machine.id,
      user_email: daemon.user.email,
      agents: store.agentsOfMachine(daemon.machine.id).map((a) => serializeAgent(a, daemon.machine)),
    }
  })

  fastify.get('/api/sync/snapshot/:agentId', async (request, reply) => {
    const daemon = currentDaemon(request)
    const { agentId } = request.params as { agentId: string }
    const { known_hash: knownHash, wait } = request.query as { known_hash?: string; wait?: string }
    const agent = agentOfMachine(daemon, agentId)
    const budgetMs = Math.min(Number.parseInt(wait ?? '0', 10) || 0, settings.syncLongPollSeconds) * 1000

    let payload = computeSnapshot(store, agent.id)
    if (knownHash && budgetMs > 0 && payload.snapshot_hash === knownHash) {
      const subscription = bus.subscribe(agentScopeKeys(store, agent.id))
      try {
        const deadline = Date.now() + budgetMs
        while (payload.snapshot_hash === knownHash) {
          const remaining = deadline - Date.now()
          if (remaining <= 0) break
          const changed = await subscription.wait(remaining)
          if (!changed) break
          subscription.clear()
          payload = computeSnapshot(store, agent.id)
        }
      } finally {
        bus.unsubscribe(subscription)
      }
    }

    if (knownHash && payload.snapshot_hash === knownHash) {
      return reply.code(304).send()
    }
    store.storeSnapshot(agent.id, payload.snapshot_hash, payload)
    store.updateMachine(daemon.machine.id, { last_snapshot_hash: payload.snapshot_hash })
    return reply.send(payload)
  })

  fastify.post('/api/sync/report', async (request, reply) => {
    const daemon = currentDaemon(request)
    const body = requireObject(request.body)
    const agent = agentOfMachine(daemon, requireString(body, 'agent_id'))
    const fields: Partial<AgentInstance> = {}
    if (typeof body.listed_hash === 'string') fields.last_listed_hash = body.listed_hash
    if (body.connected === true) fields.last_connected_at = new Date().toISOString()
    if (typeof body.drift_detected === 'boolean') fields.drift_detected = body.drift_detected
    if (typeof body.drift_detail === 'string') fields.drift_detail = scrubDriftDetail(body.drift_detail)
    if (isObject(body.account_skills)) {
      const raw = body.account_skills
      const items = Array.isArray(raw.skills) ? raw.skills.filter(isObject) : []
      fields.account_skills = {
        checked_at: typeof raw.checked_at === 'string' && raw.checked_at ? raw.checked_at : new Date().toISOString(),
        skills: items
          .map((item) => ({ slug: typeof item.slug === 'string' ? item.slug : '', status: item.status === 'stale' ? 'stale' as const : 'synced' as const }))
          .filter((item) => item.slug !== ''),
      }
    }
    if (body.unmanaged !== undefined) fields.unmanaged = readUnmanagedReport(body.unmanaged)
    store.updateAgent(agent.id, fields)
    if (typeof body.synced_hash === 'string') {
      db.run(`INSERT INTO local_client_sync (agent_id, snapshot_hash, synced_at) VALUES (?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET snapshot_hash = excluded.snapshot_hash, synced_at = excluded.synced_at`,
      agent.id, body.synced_hash, new Date().toISOString())
    }
    return reply.code(204).send()
  })

  fastify.post('/api/sync/tool-call', async (request, reply) => {
    const daemon = currentDaemon(request)
    const body = requireObject(request.body)
    const agent = agentOfMachine(daemon, requireString(body, 'agent_id'))
    store.insertToolCall({
      organization_id: daemon.user.organization_id,
      agent_instance_id: agent.id,
      user_id: daemon.user.id,
      server_slug: optionalString(body, 'server_slug'),
      tool_name: optionalString(body, 'tool_name'),
      exposed_name: optionalString(body, 'exposed_name'),
      decision: optionalString(body, 'decision', 'allow'),
      denial_reason: optionalString(body, 'denial_reason'),
      args_digest: optionalString(body, 'args_digest'),
      duration_ms: typeof body.duration_ms === 'number' ? body.duration_ms : 0,
      error: optionalString(body, 'error'),
    })
    return reply.code(204).send()
  })

  // ============================================================ audit
  fastify.get('/api/audit/events', async (request) => {
    const user = await currentUser(request)
    const { limit, action } = request.query as { limit?: string; action?: string }
    const parsed = Math.min(Math.max(Number.parseInt(limit ?? '100', 10) || 100, 1), 500)
    return store.auditEvents(user.organization_id, action ? { action, limit: parsed } : { limit: parsed }).map(serializeAuditEvent)
  })

  fastify.get('/api/audit/tool-calls', async (request) => {
    const user = await currentUser(request)
    const { limit, agent_id: agentId } = request.query as { limit?: string; agent_id?: string }
    const parsed = Math.min(Math.max(Number.parseInt(limit ?? '100', 10) || 100, 1), 500)
    const opts: { orgId: string; userId?: string; agentId?: string; limit: number } = { orgId: user.organization_id, limit: parsed }
    if (!isAdmin(user)) opts.userId = user.id
    if (agentId) {
      const agent = ownedAgent(user, agentId)
      opts.agentId = agent.id
    }
    return store.toolCalls(opts).map(serializeToolCall)
  })

  fastify.get('/api/audit/verify', async (request) => {
    const admin = await requireAdmin(request)
    const { ok, brokenAt } = auditVerify(store, admin.organization_id)
    return { ok, broken_at: brokenAt }
  })

  // ============================================================ meta
  fastify.get('/health', async () => ({ status: 'ok', service: 'agenthub-control-plane' }))

  return { fastify, store, db, settings, bus, probeRetry }
}
