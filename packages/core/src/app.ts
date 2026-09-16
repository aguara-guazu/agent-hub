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
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import { loadSettings, type Settings } from './config.js'
import { Database } from './db/database.js'
import { runMigrations } from './db/migrations.js'
import { Store } from './store.js'
import { record as auditRecord, verify as auditVerify } from './audit/ledger.js'
import { buildMatrix } from './matrix.js'
import { applyProbeResult, QUARANTINE_TOOL_MISSING } from './catalog/reconcile.js'
import { DEFAULT_TIMEOUT_MS as PROBE_TIMEOUT_MS, probeServer } from './catalog/probe.js'
import { ProbeRetryScheduler } from './catalog/retry.js'
import { applyStarterCatalog } from './catalog/starter.js'
import { applyFactorySkill, type FactorySkill } from './catalog/factory-skills.js'
import { hubSkill } from './catalog/hub-skill.js'
import { skillContentHash } from './hashing.js'
import { computeSnapshot, explain } from './policy/resolver.js'
import { ensureLocalOwner } from './local.js'
import {
  agentScopeKeys,
  InvalidationBus,
  publishPolicyChange,
} from './events.js'
import {
  normalizeEmail,
  normalizeSlug,
  serializeSquads,
  serializeUser,
  serializeUsers,
  validateCatalogSlug,
  validateSecretRefs,
  ValidationError,
} from './serialize.js'
import {
  serializeAgent,
  serializeAuditEvent,
  serializeClientAccount,
  serializeMachine,
  serializeServer,
  serializeSkill,
  serializeToolCall,
} from './serialize_catalog.js'
import {
  createAccessToken,
  DAEMON_TOKEN_PREFIX,
  decodeAccessToken,
  generateDaemonToken,
  hashDaemonToken,
  hashPassword,
  NO_LOCAL_PASSWORD,
  verifyPassword,
} from './security.js'
import type { AgentInstance, ApiToken, Machine, McpServerRow, McpToolRow, User } from './types.js'
import type { CliKind } from '@agenthub/shared'
import { auth as oauthAuthorize } from '@modelcontextprotocol/sdk/client/auth.js'
import { FileOAuthProvider, OAUTH_AUTH_REQUIRED_MESSAGE, OAuthStore } from '@agenthub/gateway'
import { registerMemory, memoryTools, memorySkill, googleSetupSkill, MemoryError } from '@agenthub/memory'

const CLI_KINDS = ['claude_code', 'codex_cli', 'gemini_cli', 'kiro']
const ORG_ROLES = ['owner', 'admin', 'member']

/** Error HTTP con código explícito, como las `HTTPException` del backend. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function isAdmin(user: User): boolean {
  return user.org_role === 'admin' || user.org_role === 'owner'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireObject(body: unknown): Record<string, unknown> {
  if (!isObject(body)) throw new HttpError(422, 'el cuerpo debe ser un objeto JSON')
  return body
}

function rejectUnknown(body: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new HttpError(422, `campo desconocido: ${key}`)
    }
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(422, `falta el campo ${field}`)
  return value
}

function optionalString(body: Record<string, unknown>, field: string, fallback = ''): string {
  const value = body[field]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new HttpError(422, `el campo ${field} debe ser texto`)
  return value
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

export function buildApp(options: BuildAppOptions = {}): CoreApp {
  const settings = loadSettings(options.settings)
  const db = new Database(settings.databasePath)
  runMigrations(db, settings.databasePath)
  const store = new Store(db)
  const bus = new InvalidationBus()
  // Credenciales OAuth de los MCP servers: archivos 0600 fuera de la base.
  const oauthStore = new OAuthStore(settings.oauthDir)
  const probeOptions = { oauthStore, redirectUrl: settings.oauthRedirectUrl }

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

  // El cuerpo de las respuestas 204 no lleva contenido.
  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError || error instanceof MemoryError) {
      return reply.code(error instanceof HttpError ? error.status : error.statusCode).send({ detail: error.message })
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
    const memory = registerMemory(fastify, { directory: memoryDirectory, baseUrl,
      worker: process.env.AGENTHUB_MEMORY_WORKER !== '0',
      authorize: async request => {
        const user = await currentUser(request)
        if (user.id !== owner.id) throw new HttpError(403, 'La memoria pertenece al dueño local del hub')
        return user
      },
    })
    const registerCatalog = () => {
      const installedId = store.setting('memory_catalog_server_id')
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
      store.setSetting('memory_catalog_server_id', server.id)
      registerMemorySkill()
      publishPolicyChange(bus, store, 'user', owner.id)
    }
    // Skills de fábrica de la memoria: mismas reglas de actualización que `agent-hub`
    // (catalog/factory-skills.ts). Las claves en settings son `<clave>_id` y `<clave>_hash`;
    // `memory` conserva las históricas.
    const factorySkills: { key: string; skill: FactorySkill }[] = [
      { key: 'memory_skill', skill: memorySkill },
      { key: 'google_setup_skill', skill: googleSetupSkill },
    ]
    const registerMemorySkill = () => { for (const entry of factorySkills) applyFactorySkill(store, owner, entry.key, entry.skill) }
    if (process.env.AGENTHUB_MEMORY_DATABASE_URL || memory.service.vault.has('database')) registerCatalog()
    fastify.addHook('onResponse', async request => { if (request.url === '/api/memory/database' && request.method === 'PUT' && memory.service.vault.has('database')) registerCatalog() })
  }

  function ownedMachine(user: User, machineId: string): Machine {
    const machine = store.machine(machineId)
    if (!machine || machine.user_id !== user.id) throw new HttpError(404, 'maquina inexistente')
    return machine
  }

  function serverOr404(user: User, serverId: string) {
    const server = store.server(serverId)
    if (!server || server.user_id !== user.id) throw new HttpError(404, 'el MCP server no existe')
    return server
  }

  function skillOr404(user: User, skillId: string) {
    const skill = store.skill(skillId)
    if (!skill || skill.user_id !== user.id) throw new HttpError(404, 'la skill no existe')
    return skill
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
  /** Vista pública de un server: incluye si la cuenta OAuth está autorizada, nunca el token. */
  function serverView(server: McpServerRow, tools?: McpToolRow[]) {
    const oauth = server.auth === 'oauth'
      ? { authorized: oauthStore.hasTokens(server.id), clientConfigured: oauthStore.hasClient(server.id) }
      : { authorized: false, clientConfigured: false }
    return serializeServer(server, tools ?? store.toolsOfServer(server.id), oauth)
  }

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

  // ============================================================ catalog
  fastify.get('/api/catalog/servers', async (request) => {
    const user = await currentUser(request)
    const servers = store.serversOfUser(user.id)
    const tools = store.toolsOfServers(servers.map((s) => s.id))
    return servers.map((s) => serverView(s, tools.get(s.id) ?? []))
  })

  fastify.get('/api/local/overview', async (request) => {
    const user = await currentUser(request)
    const matrix = buildMatrix(store, user)
    const clients = store.agentsOfUser(user.id).map(({ agent, machine }) => {
      const sync = db.get('SELECT snapshot_hash, synced_at FROM local_client_sync WHERE agent_id = ?', agent.id)
      const snapshot = computeSnapshot(store, agent.id)
      return { ...serializeAgent(agent, machine), config_path: agent.config_path,
        synced_at: sync?.synced_at ?? null,
        synchronized: !agent.drift_detected && sync?.snapshot_hash === snapshot.snapshot_hash,
        server_count: snapshot.servers.length, skill_count: snapshot.skills.length,
      }
    })
    return { hostname: hostname(), clients, rows: matrix.rows }
  })

  const SERVER_FIELDS = [
    'slug', 'display_name', 'description', 'transport', 'command', 'args', 'env', 'cwd', 'url', 'headers',
    'secret_refs', 'requires_host_access', 'container_image', 'allow_hosts', 'allow_ports', 'read_mounts', 'write_mounts',
    'auth',
  ]

  function readServerPayload(body: Record<string, unknown>, partial: boolean) {
    const out: Record<string, unknown> = {}
    if (!partial) {
      out.slug = validateCatalogSlug(requireString(body, 'slug'))
      out.display_name = requireString(body, 'display_name')
      const transport = requireString(body, 'transport')
      if (transport !== 'stdio' && transport !== 'http') throw new HttpError(422, 'transport invalido')
      out.transport = transport
    } else {
      if ('display_name' in body && (typeof body.display_name !== 'string' || body.display_name.length === 0)) {
        throw new HttpError(422, 'display_name no puede ser vacio')
      }
      if ('transport' in body && body.transport !== 'stdio' && body.transport !== 'http') {
        throw new HttpError(422, 'transport invalido')
      }
    }
    if ('auth' in body) {
      if (body.auth !== 'none' && body.auth !== 'oauth') throw new HttpError(422, 'auth invalido: none u oauth')
      out.auth = body.auth
    }
    for (const field of ['description', 'command', 'cwd', 'url', 'container_image']) {
      if (field in body) out[field] = optionalString(body, field)
    }
    for (const field of ['args', 'allow_hosts', 'read_mounts', 'write_mounts', 'allow_ports']) {
      if (field in body) {
        if (!Array.isArray(body[field])) throw new HttpError(422, `el campo ${field} debe ser una lista`)
        out[field] = body[field]
      }
    }
    for (const field of ['env', 'headers']) {
      if (field in body) {
        if (!isObject(body[field])) throw new HttpError(422, `el campo ${field} debe ser un objeto`)
        out[field] = body[field]
      }
    }
    if ('secret_refs' in body) {
      if (!isObject(body.secret_refs)) throw new HttpError(422, 'secret_refs debe ser un objeto')
      out.secret_refs = validateSecretRefs(body.secret_refs as Record<string, string>)
    }
    if ('requires_host_access' in body) {
      if (typeof body.requires_host_access !== 'boolean') throw new HttpError(422, 'requires_host_access debe ser booleano')
      out.requires_host_access = body.requires_host_access
    }
    return out
  }

  fastify.post('/api/catalog/servers', async (request, reply) => {
    const user = await currentUser(request)
    const body = requireObject(request.body)
    rejectUnknown(body, SERVER_FIELDS)
    const payload = readServerPayload(body, false)
    const transport = payload.transport as string
    const command = (payload.command as string) ?? ''
    const url = (payload.url as string) ?? ''
    if (transport === 'stdio' && !String(command).trim()) throw new HttpError(422, 'un server stdio necesita un comando')
    if (transport === 'http' && !String(url).trim()) throw new HttpError(422, 'un server http necesita una URL')
    if (payload.auth === 'oauth' && transport !== 'http') throw new HttpError(422, 'OAuth solo aplica a servers http')
    if (store.serverBySlug(user.id, payload.slug as string)) {
      throw new HttpError(409, `ya tenes un MCP server con el slug ${payload.slug}`)
    }
    const server = store.insertServer({
      user_id: user.id,
      slug: payload.slug as string,
      display_name: payload.display_name as string,
      description: (payload.description as string) ?? '',
      transport: transport as 'stdio' | 'http',
      command: String(command),
      args: (payload.args as string[]) ?? [],
      env: (payload.env as Record<string, string>) ?? {},
      cwd: (payload.cwd as string) ?? '',
      url: String(url),
      headers: (payload.headers as Record<string, string>) ?? {},
      secret_refs: (payload.secret_refs as Record<string, string>) ?? {},
      requires_host_access: (payload.requires_host_access as boolean) ?? false,
      container_image: (payload.container_image as string) ?? '',
      allow_hosts: (payload.allow_hosts as string[]) ?? [],
      allow_ports: (payload.allow_ports as number[]) ?? [],
      read_mounts: (payload.read_mounts as string[]) ?? [],
      write_mounts: (payload.write_mounts as string[]) ?? [],
      auth: (payload.auth as McpServerRow['auth'] | undefined) ?? 'none',
    })
    notifyAfterCommit('user', user.id)
    return reply.code(201).send(serverView(server, []))
  })

  fastify.patch('/api/catalog/servers/:id', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const server = serverOr404(user, id)
    const body = requireObject(request.body)
    rejectUnknown(body, SERVER_FIELDS.filter((f) => f !== 'slug'))
    const payload = readServerPayload(body, true)
    const nextAuth = (payload.auth as McpServerRow['auth'] | undefined) ?? server.auth
    const nextTransport = (payload.transport as McpServerRow['transport'] | undefined) ?? server.transport
    if (nextAuth === 'oauth' && nextTransport !== 'http') throw new HttpError(422, 'OAuth solo aplica a servers http')
    // Dejar de usar OAuth borra la cuenta autorizada: no quedan tokens sin dueño.
    if (server.auth === 'oauth' && nextAuth !== 'oauth') oauthStore.delete(server.id)
    store.updateServer(server.id, payload)
    notifyAfterCommit('user', user.id)
    const fresh = store.server(server.id)!
    return serverView(fresh)
  })

  fastify.delete('/api/catalog/servers/:id', async (request, reply) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const server = serverOr404(user, id)
    const toolIds = store.toolsOfServer(server.id).map((t) => t.id)
    store.forgetResource('mcp_tool', toolIds)
    store.forgetResource('mcp_server', [server.id])
    store.deleteServer(server.id)
    oauthStore.delete(server.id)
    notifyAfterCommit('user', user.id)
    return reply.code(204).send()
  })

  fastify.post('/api/catalog/servers/:id/probe', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const server = serverOr404(user, id)
    const result = await probeServer(server, PROBE_TIMEOUT_MS, probeOptions)
    applyProbeResult(store, server, result)
    notifyAfterCommit('user', user.id)
    const fresh = store.server(server.id)!
    return serverView(fresh)
  })

  // ------------------------------------------------------------ oauth
  // Flujos en curso: `state` -> server. Viven en memoria y vencen solos. El navegador
  // vuelve a `/api/oauth/callback` sin sesión de la consola: el `state` es la prueba.
  const pendingOAuth = new Map<string, { serverId: string; expiresAt: number }>()
  const OAUTH_PENDING_TTL_MS = 10 * 60_000
  function prunePendingOAuth(): void {
    const now = Date.now()
    for (const [state, entry] of pendingOAuth) if (entry.expiresAt < now) pendingOAuth.delete(state)
  }
  function oauthProvider(server: McpServerRow): FileOAuthProvider {
    return new FileOAuthProvider({
      store: oauthStore,
      serverId: server.id,
      serverUrl: server.url,
      redirectUrl: settings.oauthRedirectUrl,
      interactive: true,
    })
  }
  function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
  function escapeHtml(text: string): string {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return text.replace(/[&<>"']/g, (c) => map[c] ?? c)
  }
  function oauthPage(title: string, detail: string): string {
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Agent Hub</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0f1412;color:#e8ede9;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:32rem;padding:2rem}h1{font-size:1.4rem}p{color:#a7b0aa;line-height:1.5}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><p>Podés cerrar esta pestaña y volver a Agent Hub.</p></main></body></html>`
  }
  async function probeAndApply(server: McpServerRow) {
    const result = await probeServer(server, PROBE_TIMEOUT_MS, probeOptions)
    applyProbeResult(store, server, result)
    notifyAfterCommit('user', server.user_id)
    return result
  }

  fastify.post('/api/catalog/servers/:id/oauth/start', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const server = serverOr404(user, id)
    if (server.transport !== 'http' || server.auth !== 'oauth') throw new HttpError(422, 'este server no usa OAuth')
    if (!server.url.trim()) throw new HttpError(422, 'el server no tiene URL')
    const provider = oauthProvider(server)
    let outcome: 'AUTHORIZED' | 'REDIRECT'
    try {
      outcome = await oauthAuthorize(provider, { serverUrl: server.url })
    } catch (error) {
      throw new HttpError(502, `no se pudo iniciar la autorización: ${describeError(error)}`)
    }
    if (outcome === 'AUTHORIZED') {
      // Había un refresh token vigente: no hace falta pasar por el navegador.
      await probeAndApply(server)
      return { status: 'authorized', server: serverView(store.server(server.id)!) }
    }
    const url = provider.authorizationUrl
    const state = provider.pendingState()
    if (!url || !state) throw new HttpError(502, 'el servidor de autorización no devolvió una URL utilizable')
    prunePendingOAuth()
    pendingOAuth.set(state, { serverId: server.id, expiresAt: Date.now() + OAUTH_PENDING_TTL_MS })
    return { status: 'redirect', authorization_url: url.toString() }
  })

  fastify.get('/api/oauth/callback', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>
    const state = query.state ?? ''
    prunePendingOAuth()
    const pending = state ? pendingOAuth.get(state) : undefined
    reply.type('text/html; charset=utf-8')
    if (!pending) return reply.code(400).send(oauthPage('Solicitud desconocida o vencida', 'Volvé a Agent Hub y usá «Conectar cuenta» otra vez.'))
    pendingOAuth.delete(state)
    const server = store.server(pending.serverId)
    if (!server) return reply.code(404).send(oauthPage('El server ya no existe', 'Se eliminó del catálogo mientras autorizabas.'))
    if (query.error) {
      const detail = query.error_description || query.error
      store.updateServer(server.id, { last_probe_error: `autorización rechazada: ${detail}` })
      notifyAfterCommit('user', server.user_id)
      return reply.code(400).send(oauthPage('La autorización no se completó', detail))
    }
    if (!query.code) return reply.code(400).send(oauthPage('Falta el código de autorización', 'El servidor volvió sin el parámetro code.'))
    try {
      const outcome = await oauthAuthorize(oauthProvider(server), { serverUrl: server.url, authorizationCode: query.code })
      if (outcome !== 'AUTHORIZED') throw new Error('el servidor no entregó tokens')
    } catch (error) {
      const detail = describeError(error)
      store.updateServer(server.id, { last_probe_error: `no se pudo canjear la autorización: ${detail}` })
      notifyAfterCommit('user', server.user_id)
      return reply.code(502).send(oauthPage('No se pudo completar la conexión', detail))
    }
    const result = await probeAndApply(server)
    return reply.send(oauthPage('Cuenta conectada', result.ok
      ? `${server.display_name}: ${result.tools.length} herramientas disponibles.`
      : `${server.display_name} quedó autorizado, pero el sondeo falló: ${result.error}`))
  })

  fastify.get('/api/oauth/settings', async (request) => {
    await currentUser(request)
    // La URL de retorno que hay que registrar en el proveedor cuando el cliente se crea a mano.
    return { redirect_url: settings.oauthRedirectUrl }
  })

  fastify.post('/api/catalog/servers/:id/oauth/client', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const server = serverOr404(user, id)
    if (server.auth !== 'oauth') throw new HttpError(422, 'este server no usa OAuth')
    const body = requireObject(request.body)
    rejectUnknown(body, ['client_id', 'client_secret'])
    const clientId = requireString(body, 'client_id').trim()
    if (!clientId) throw new HttpError(422, 'client_id no puede ser vacio')
    const clientSecret = optionalString(body, 'client_secret').trim()
    // Va al archivo 0600 del server, nunca a la base ni a la respuesta.
    oauthStore.saveClientCredentials(server.id, server.url, { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) })
    store.updateServer(server.id, { last_probe_error: OAUTH_AUTH_REQUIRED_MESSAGE })
    notifyAfterCommit('user', user.id)
    return serverView(store.server(server.id)!)
  })

  fastify.post('/api/catalog/servers/:id/oauth/logout', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const server = serverOr404(user, id)
    oauthStore.delete(server.id)
    if (server.auth === 'oauth') store.updateServer(server.id, { last_probe_error: OAUTH_AUTH_REQUIRED_MESSAGE })
    notifyAfterCommit('user', user.id)
    return serverView(store.server(server.id)!)
  })

  fastify.post('/api/catalog/servers/:id/approve', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const server = serverOr404(user, id)
    for (const tool of store.toolsOfServer(server.id)) {
      if (tool.quarantine_reason === QUARANTINE_TOOL_MISSING) continue
      store.updateTool(tool.id, { quarantined: false, quarantine_reason: '' })
    }
    notifyAfterCommit('user', user.id)
    const fresh = store.server(server.id)!
    return serverView(fresh)
  })

  fastify.get('/api/catalog/skills', async (request) => {
    const user = await currentUser(request)
    return store.skillsOfUser(user.id).map(serializeSkill)
  })

  fastify.post('/api/catalog/skills', async (request, reply) => {
    const user = await currentUser(request)
    const body = requireObject(request.body)
    rejectUnknown(body, ['slug', 'display_name', 'description', 'body'])
    const slug = validateCatalogSlug(requireString(body, 'slug'))
    const displayName = requireString(body, 'display_name')
    const description = optionalString(body, 'description')
    const skillBody = optionalString(body, 'body')
    if (store.skillBySlug(user.id, slug)) throw new HttpError(409, `ya tenes una skill con el slug ${slug}`)
    const skill = store.insertSkill({
      user_id: user.id,
      slug,
      display_name: displayName,
      description,
      body: skillBody,
      content_hash: skillContentHash(displayName, description, skillBody),
    })
    notifyAfterCommit('user', user.id)
    return reply.code(201).send(serializeSkill(skill))
  })

  fastify.patch('/api/catalog/skills/:id', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const skill = skillOr404(user, id)
    const body = requireObject(request.body)
    rejectUnknown(body, ['display_name', 'description', 'body'])
    const displayName = 'display_name' in body ? requireString(body, 'display_name') : skill.display_name
    const description = 'description' in body ? optionalString(body, 'description') : skill.description
    const skillBody = 'body' in body ? optionalString(body, 'body') : skill.body
    const newHash = skillContentHash(displayName, description, skillBody)
    const fields: { display_name?: string; description?: string; body?: string; version?: number; content_hash?: string } = {
      display_name: displayName,
      description,
      body: skillBody,
    }
    if (newHash !== skill.content_hash) {
      fields.version = skill.version + 1
      fields.content_hash = newHash
    }
    store.updateSkill(skill.id, fields)
    notifyAfterCommit('user', user.id)
    return serializeSkill(store.skill(skill.id)!)
  })

  fastify.delete('/api/catalog/skills/:id', async (request, reply) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const skill = skillOr404(user, id)
    store.forgetResource('skill', [skill.id])
    store.deleteSkill(skill.id)
    notifyAfterCommit('user', user.id)
    return reply.code(204).send()
  })

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
    return computeSnapshot(store, agentId)
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

  // ============================================================ machines
  function machineForWrite(user: User, machineId: string): Machine {
    if (!isAdmin(user)) return ownedMachine(user, machineId)
    const machine = store.machine(machineId)
    if (!machine) throw new HttpError(404, 'maquina inexistente')
    const owner = store.user(machine.user_id)
    if (!owner || owner.organization_id !== user.organization_id) throw new HttpError(404, 'maquina inexistente')
    return machine
  }

  fastify.post('/api/machines/enroll', async (request) => {
    const user = await currentUser(request)
    const body = requireObject(request.body)
    const hostname = requireString(body, 'hostname')
    const os = optionalString(body, 'os')
    const daemonVersion = optionalString(body, 'daemon_version')
    const at = new Date().toISOString()

    let machine = store.machineByHostname(user.id, hostname)
    let revoked = 0
    if (!machine) {
      machine = store.insertMachine({ user_id: user.id, hostname, os, daemon_version: daemonVersion })
    } else {
      store.updateMachine(machine.id, { os: os || machine.os, daemon_version: daemonVersion || machine.daemon_version })
      revoked = store.revokeTokensOfMachine(machine.id, at)
      machine = store.machine(machine.id)!
    }
    const [raw, digest] = generateDaemonToken()
    store.insertToken({ user_id: user.id, machine_id: machine.id, name: `daemon@${machine.hostname}`, token_hash: digest })

    auditRecord(store, user.organization_id, user, 'machine.enroll', 'machine', machine.id, {
      hostname: machine.hostname,
      os: machine.os,
      revoked_tokens: revoked,
    })
    return {
      machine: serializeMachine(machine, user, store.agentsOfMachine(machine.id)),
      token: raw,
    }
  })

  fastify.get('/api/machines', async (request) => {
    const user = await currentUser(request)
    if (isAdmin(user)) {
      return store.machinesOfOrg(user.organization_id).map(({ machine, owner }) =>
        serializeMachine(machine, owner, store.agentsOfMachine(machine.id)),
      )
    }
    return store.machinesOfUser(user.id).map((machine) => serializeMachine(machine, user, store.agentsOfMachine(machine.id)))
  })

  fastify.delete('/api/machines/:id', async (request, reply) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const machine = machineForWrite(user, id)
    store.revokeTokensOfMachine(machine.id, new Date().toISOString())
    auditRecord(store, user.organization_id, user, 'machine.delete', 'machine', machine.id, { hostname: machine.hostname })
    store.deleteMachine(machine.id)
    return reply.code(204).send()
  })

  fastify.post('/api/machines/:id/agents', async (request) => {
    const daemon = currentDaemon(request)
    const { id } = request.params as { id: string }
    if (id !== daemon.machine.id) throw new HttpError(403, 'el token no corresponde a esa maquina')
    const body = requireObject(request.body)
    const agents = Array.isArray(body.agents) ? body.agents : []
    const existing = new Map(store.agentsOfMachine(daemon.machine.id).map((a) => [a.cli_kind, a]))
    for (const item of agents) {
      if (!isObject(item)) continue
      const cliKind = String(item.cli_kind ?? '')
      if (!CLI_KINDS.includes(cliKind)) throw new HttpError(422, `cli_kind invalido: ${cliKind}`)
      const kind = cliKind as CliKind
      const cliVersion = typeof item.cli_version === 'string' ? item.cli_version : ''
      const configPath = typeof item.config_path === 'string' ? item.config_path : ''
      const found = existing.get(kind)
      if (!found) {
        const created = store.insertAgent({ machine_id: daemon.machine.id, cli_kind: kind, cli_version: cliVersion, config_path: configPath })
        existing.set(kind, created)
        auditRecord(store, daemon.user.organization_id, `daemon@${daemon.machine.hostname}`, 'agent.detected', 'agent_instance', created.id, {
          cli_kind: cliKind,
          cli_version: cliVersion,
        })
      } else {
        store.updateAgent(found.id, {
          cli_version: cliVersion || found.cli_version,
          config_path: configPath || found.config_path,
        })
      }
    }
    return store.agentsOfMachine(daemon.machine.id).map((a) => serializeAgent(a, daemon.machine))
  })

  fastify.patch('/api/machines/agents/:id', async (request) => {
    const user = await currentUser(request)
    const { id } = request.params as { id: string }
    const agent = ownedAgent(user, id)
    const machine = store.machine(agent.machine_id)!
    const body = requireObject(request.body)
    if (typeof body.enabled === 'boolean' && body.enabled !== agent.enabled) {
      store.updateAgent(agent.id, { enabled: body.enabled })
      auditRecord(store, user.organization_id, user, body.enabled ? 'agent.enabled' : 'agent.disabled', 'agent_instance', agent.id, {
        cli_kind: agent.cli_kind,
        hostname: machine.hostname,
      })
      notifyAfterCommit('agent', agent.id)
    }
    return serializeAgent(store.agent(agent.id)!, machine)
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
    if (typeof body.drift_detail === 'string') fields.drift_detail = body.drift_detail
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
