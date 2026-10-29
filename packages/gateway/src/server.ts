import { bindTuiSession } from './tui-session.js'
import { orcaWorkspaceId } from './orca-workspace.js'
/**
 * Gateway MCP: la unica entrada que ven los CLIs.
 *
 * DOS TIEMPOS DISTINTOS, Y ESA ES LA IDEA
 *
 * - `tools/list` se contesta con el snapshot cacheado. No descubre nada, no conecta
 *   con ningun upstream y no espera a la red: listar es instantaneo y funciona aunque
 *   todos los upstreams esten caidos o el control plane no conteste.
 * - `tools/call` vuelve a resolver la politica CONTRA EL SNAPSHOT VIGENTE en ese
 *   instante. Apagar una herramienta en el panel deniega la llamada siguiente aunque
 *   el CLI siga mostrandola en su lista vieja. Este es el invariante del producto.
 *
 * La denegacion se devuelve como `CallToolResult` con `isError`, no como excepcion de
 * protocolo, para que el modelo pueda leer el motivo y decirlo.
 *
 * Es HEADLESS y por STDIO: el CLI lanza `agenthub gateway --agent <id>` como proceso
 * hijo y le habla por tuberias. No hay ningun puerto abierto ni token en el archivo
 * de configuracion.
 *
 * SKILLS POR HERRAMIENTA. Un cliente sin carpeta de skills (Claude Desktop) no puede
 * recibirlas como archivos, asi que el gateway le expone `use_skill`: la descripcion
 * lista las skills habilitadas y la llamada devuelve el SKILL.md o un archivo auxiliar.
 * Prender o apagar una skill en el panel cambia esa descripcion en el siguiente
 * `tools/list`, y la llamada se decide contra el snapshot vigente como cualquier otra.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { clientToolSchema } from './tool-schema.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js'
import { CLI_FILE_SKILLS, isRunProfileCliKind, profileAllowsTool, RUN_PROFILE_DENIAL, renderSkillMd, SKILL_FILENAME, SKILL_TOOL_NAME, type CliKind } from '@agenthub/shared'

import type { ExposedSkill, PolicyStore, SnapshotView } from './policy.js'
import { DECISION_ALLOW, DECISION_DENY, argsDigest, denialMessage, serverOffMessage, unknownToolMessage } from './policy.js'
import { ConnectionPool, UpstreamError, resultText, type CallResult, type UpstreamSpec } from './runtime.js'
import { JIRA_REREADS, MEMORY_META_KEY, isJiraTool, isJiraWrite, isMemorySpec, issuesIn, rereadArgs, siteFromArgs, writtenKey } from './memory-bridge.js'
import { accountOf, assigneeOf, assigneeReadArgs, isJiraExistingWrite, jiraIdentityTool, targetIssue } from "./memory-bridge.js"
import { MemoryOutbox } from './memory-outbox.js'
import { nativeSession, sessionForCall, type NativeSession } from './memory-lifecycle.js'
import type { FSWatcher } from 'node:fs'

export const SERVER_NAME = 'agenthub'
export const SERVER_VERSION = '0.2.0'

const MAX_SERVER_SLUG = 48
const MAX_TOOL_NAME = 128
const MAX_EXPOSED_NAME = 64

const INSTRUCTIONS =
  'Hub tools and skills are policy-checked per call. ' +
  'Local collaboration: skill local-collaboration, else memory_skill_reference(section: "local-collaboration"). ' +
  'Keep the given identity/session_key. Verify Hub scope and leader_id; user instructions and native permissions prevail. The Hub notifies; never poll via the model.'

/** El server que figura en la auditoria para la herramienta propia del gateway. */
const SKILL_TOOL_SERVER = 'hub'
/** Lo que puede demorar el espejo de Jira antes de devolverle el resultado al agente. */
const JIRA_MIRROR_TIMEOUT_MS = 10_000
/** Cierre de las notas de la sesion al apagar: best effort, no retiene la salida del CLI. */
const SESSION_END_TIMEOUT_MS = 1500

/** Tope de un archivo auxiliar devuelto por `use_skill`. */
const MAX_SKILL_FILE_BYTES = 1024 * 1024
/** Cuantos archivos auxiliares se enumeran al devolver un SKILL.md. */
const MAX_LISTED_FILES = 200

/** Si el cliente recibe las skills por herramienta en vez de por su carpeta de skills. */
function skillsByTool(cliKind: string): boolean {
  return CLI_FILE_SKILLS[cliKind as CliKind] === false
}

/** Archivos auxiliares de una skill externa, relativos a su carpeta; sin ocultos ni enlaces. */
function listSkillFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const name of names) {
      if (found.length >= MAX_LISTED_FILES) return
      if (name.startsWith('.')) continue
      const child = join(dir, name)
      let info
      try {
        info = lstatSync(child)
      } catch {
        continue
      }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) walk(child)
      else if (info.isFile()) {
        const rel = relative(root, child).split(sep).join('/')
        if (rel !== SKILL_FILENAME) found.push(rel)
      }
    }
  }
  walk(root)
  return found
}

/**
 * Resuelve un archivo auxiliar dentro de la carpeta de la skill. La ruta se ancla al
 * `realpath` de la carpeta y se vuelve a comprobar tras resolver enlaces: nada fuera de
 * la skill se puede leer, ni por `..` ni por un symlink.
 */
function resolveSkillFile(root: string, file: string): { path: string } | { error: string } {
  const base = realpathSync(root)
  const inside = (path: string): boolean => path === base || path.startsWith(base + sep)
  const target = resolve(base, file)
  if (!inside(target)) return { error: `'${file}' is outside the skill folder` }
  if (!existsSync(target)) return { error: `the skill has no file '${file}'` }
  const real = realpathSync(target)
  if (!inside(real)) return { error: `'${file}' points outside the skill folder` }
  const info = statSync(real)
  if (!info.isFile()) return { error: `'${file}' is not a file` }
  if (info.size > MAX_SKILL_FILE_BYTES) return { error: `'${file}' exceeds the ${MAX_SKILL_FILE_BYTES / 1024} KB limit` }
  return { path: real }
}

/** Texto completo del SKILL.md de una skill: el archivo real si es externa, o el render del snapshot. */
function skillMarkdown(skill: ExposedSkill): string {
  if (skill.source === 'external') {
    try {
      return readFileSync(join(skill.sourcePath, SKILL_FILENAME), 'utf-8')
    } catch {
      // La carpeta pudo desaparecer entre el snapshot y la llamada: el cuerpo guardado sigue valiendo.
    }
  }
  return renderSkillMd({ slug: skill.slug, display_name: skill.displayName, description: skill.description, body: skill.body })
}

/** Definicion de `use_skill` para la vista, o `null` si a este cliente no le corresponde. */
function skillToolFor(view: SnapshotView): ListToolsResult['tools'][number] | null {
  if (!skillsByTool(view.cliKind) || view.skills.length === 0) return null
  if (view.tool(SKILL_TOOL_NAME) !== undefined) return null
  const lines = view.skills.map((skill) => `- ${skill.slug}: ${skill.description || skill.displayName || skill.slug}`)
  const description =
    'Enabled Agent Hub skills. If the task matches one, call with its slug BEFORE starting and follow the returned SKILL.md. ' +
    "With 'file', returns that skill's auxiliary file (scripts, references) by relative path.\n\n" +
    `Skills:\n${lines.join('\n')}`
  return {
    name: SKILL_TOOL_NAME,
    title: 'Use a skill',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Skill slug', enum: view.skills.map((skill) => skill.slug) },
        file: { type: 'string', description: 'Optional relative path of an auxiliary skill file' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
  }
}

/** Lo que se reporta al control plane de una invocacion. Nunca lleva los argumentos: solo su digest. */
export interface ToolCallRecord {
  agent_id: string
  server_slug: string
  tool_name: string
  exposed_name: string
  decision: string
  args_digest: string
  duration_ms: number
  denial_reason: string
  error: string
}

/** Quien recibe el reporte de una invocacion. Un fallo suyo jamas afecta al resultado. */
export type ToolCallReporter = (record: ToolCallRecord) => Promise<void>

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started))
}

/** El gateway de UN `agent_instance`. */
export class GatewayServer {
  private readonly agentInstanceId: string
  private readonly store: PolicyStore
  private readonly pool: ConnectionPool
  private readonly reporter: ToolCallReporter | undefined
  private readonly server: Server
  private readonly onListed: ((hash: string) => void) | undefined
  private readonly refreshPolicy: (() => Promise<void>) | undefined
  private lastListedHashValue = ''
  private connected = false
  /** Una sesion por proceso de gateway: es lo que la memoria llama sesion de agente. */
  private readonly sessionId = randomUUID()
  private memoryUsed = false
  private workFolder: Promise<string | null> | undefined
  private readonly outbox: MemoryOutbox | undefined
  private deliveryTimer: ReturnType<typeof setInterval> | undefined
  private deliveryWatcher: FSWatcher | undefined
  private readonly memorySessions = new Map<string, Record<string, unknown>>()

  constructor(
    agentInstanceId: string,
    store: PolicyStore,
    pool: ConnectionPool,
    options: { reporter?: ToolCallReporter; onListed?: (hash: string) => void; refreshPolicy?: () => Promise<void>; serverName?: string; version?: string; outbox?: MemoryOutbox } = {},
  ) {
    if (store.agentInstanceId !== agentInstanceId) {
      throw new Error('el store de politica es de otro agent_instance')
    }
    this.agentInstanceId = agentInstanceId
    this.store = store
    this.pool = pool
    this.reporter = options.reporter
    this.onListed = options.onListed
    this.refreshPolicy = options.refreshPolicy
    this.outbox = options.outbox
    this.server = new Server(
      { name: options.serverName ?? SERVER_NAME, version: options.version ?? SERVER_VERSION },
      { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS + (process.env.AGENTHUB_TUI_AGENT===agentInstanceId && process.env.AGENTHUB_TUI_KEY ? ` session_key=${process.env.AGENTHUB_TUI_KEY}; always use it in memory_chat_*.` : '') },
    )
    this.server.setRequestHandler(ListToolsRequestSchema, async () => this.handleListTools())
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => this.handleCallTool(request))
    // Avisar `tools/list_changed` a la sesion abierta. Es un aviso, no una garantia:
    // solo Claude Code refresca en caliente. Para el resto la denegacion en call vale.
    store.subscribe(() => {
      if (this.connected) {
        void this.server.sendToolListChanged().catch(() => undefined)
      }
    })
  }

  get mcpServer(): Server {
    return this.server
  }

  /** Hash del snapshot que el CLI listo por ultima vez. */
  get lastListedHash(): string {
    return this.lastListedHashValue
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport)
    this.connected = true
    if (this.outbox) {
      this.deliveryWatcher = await this.outbox.watch(() => { void this.flushMemory().catch(() => undefined) })
      this.deliveryTimer = setInterval(() => { void this.flushMemory().catch(() => undefined) }, 5000)
      this.deliveryTimer.unref()
      void this.flushMemory().catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    clearInterval(this.deliveryTimer)
    this.deliveryWatcher?.close()
    if (this.memoryUsed) await this.endMemorySession()
    this.memoryUsed = false
    this.connected = false
    await this.server.close()
  }

  /** La carpeta del cliente: su primer root MCP si lo declara, si no la carpeta desde la que lanzo el gateway. */
  private workingFolder(): Promise<string | null> {
    this.workFolder ??= (async () => {
      if (this.server.getClientCapabilities()?.roots) {
        try {
          const { roots } = await this.server.listRoots(undefined, { timeout: 1500 })
          const first = roots.find((root) => root.uri.startsWith('file://'))
          if (first) return fileURLToPath(first.uri)
        } catch {
          // El cliente no respondio roots: se usa la carpeta del proceso.
        }
      }
      return process.cwd()
    })()
    return this.workFolder
  }

  async flushMemory(): Promise<void> {
    this.store.refresh()
    await this.refreshPolicy?.()
    await this.outbox?.flush(() => this.store.current, this.pool)
  }

  private async memoryMeta(view: SnapshotView, native?: NativeSession): Promise<Record<string, unknown>> {
    bindTuiSession(this.agentInstanceId,process.env.KIRO_SESSION_ID)
    this.memoryUsed = true
    const tui=process.env.AGENTHUB_TUI_AGENT===this.agentInstanceId && process.env.AGENTHUB_TUI_SESSION
    const who = (tui ? {...nativeSession(this.agentInstanceId,view.cliKind,tui,await this.workingFolder()),orca_workspace_id:orcaWorkspaceId()} : native) ?? { agent_id: this.agentInstanceId, cli_kind: view.cliKind, client: this.server.getClientVersion()?.name ?? '',
      session_id: this.sessionId, cwd: await this.workingFolder(), orca_workspace_id: orcaWorkspaceId() }
    const meta = { [MEMORY_META_KEY]: { ...who } }
    this.memorySessions.set(who.session_id, meta)
    return meta
  }

  /**
   * Segunda barrera de los perfiles de run: aunque el snapshot ya venga acotado, tools/list y tools/call vuelven a filtrar
   * por la capacidad fija del perfil, de modo que una lista cacheada por el CLI no devuelva una herramienta fuera de él.
   */
  private profilePermits(view: SnapshotView, tool: { serverSlug: string; toolName: string }): boolean {
    if (!isRunProfileCliKind(view.cliKind)) return true
    const spec = view.specFor(tool.serverSlug)
    return spec !== undefined && profileAllowsTool(view.cliKind, { memory: isMemorySpec(spec), tool: tool.toolName, endpoint: { transport: spec.transport, url: spec.url } })
  }

  /** El server de memoria vigente para este agente, si expone la herramienta pedida. */
  private memoryFor(view: SnapshotView, toolName: string): UpstreamSpec | undefined {
    const spec = view.upstreams().find(isMemorySpec)
    return spec && view.tools.some((tool) => tool.serverSlug === spec.slug && tool.toolName === toolName) ? spec : undefined
  }

  /**
   * Regla permanente del dueño: solo se escribe en issues asignados a él. Antes de reenviar una escritura sobre un issue existente
   * se leen, por el mismo server y con la misma credencial, la cuenta que escribe (`atlassianUserInfo`) y el asignado (`getJiraIssue`).
   * Devuelve `null` si coinciden o `{ code, message }` para rechazar. Cualquier duda rechaza; no se guardan ni registran cuerpos.
   */
  private async verifyJiraOwner(view: SnapshotView, spec: UpstreamSpec, args: Record<string, unknown>): Promise<{ code: string; message: string } | null> {
    const reject = (code: string, message: string) => ({ code, message: `${message} Agent Hub solo escribe en tickets de Jira asignados a vos (${code}).` })
    const issue = targetIssue(args)
    if (!issue) return reject("issue_unverified", "La escritura no indica el ticket (issueIdOrKey o issue_key), así que no se puede verificar el asignado.")
    const ofServer = view.tools.filter((tool) => tool.serverSlug === spec.slug)
    const identity = ofServer.find((tool) => jiraIdentityTool(tool.toolName))
    const reader = ofServer.find((tool) => JIRA_REREADS.includes(tool.toolName.toLowerCase()))
    if (!identity) return reject("identity_unverified", `El server ${spec.slug} no tiene habilitada una herramienta de identidad (atlassianUserInfo); no se escribió en ${issue}.`)
    const readArgs = reader ? assigneeReadArgs(reader.toolName, args, issue) : undefined
    if (!reader || !readArgs) return reject("assignee_unverified", `No hay una lectura del ticket habilitada (getJiraIssue con cloudId) en ${spec.slug}; no se escribió en ${issue}.`)
    const call = async (name: string, input: Record<string, unknown>) => {
      try { const result = await this.pool.callTool(this.agentInstanceId, spec, name, input); return result.is_error ? undefined : result } catch { return undefined }
    }
    const [who, read] = await Promise.all([call(identity.toolName, {}), call(reader.toolName, readArgs)])
    const account = who ? accountOf(who) : undefined
    if (!account) return reject("identity_unverified", `No se pudo leer la cuenta con la que escribe ${spec.slug}; no se escribió en ${issue}.`)
    const assignee = read ? assigneeOf(read, issue) : undefined
    if (!assignee) return reject("assignee_unverified", `No se pudo leer el asignado de ${issue}; no se escribió.`)
    if (assignee.account === null) return reject("issue_unassigned", `${issue} no tiene asignado. Asignátelo en Jira y reintentá.`)
    if (assignee.account !== account) return reject("assignee_mismatch", `${issue} está asignado a ${assignee.name ?? "otra persona"}, no a vos: no se escribió.`)
    return null
  }

  private async mirrorJira(view: SnapshotView, spec: UpstreamSpec, toolName: string, args: Record<string, unknown>, result: CallResult, native?: NativeSession): Promise<void> {
    const memory = this.memoryFor(view, 'sync_tasks')
    const issues = issuesIn(result)
    const key = isJiraWrite(toolName) ? writtenKey(args, result) : undefined
    const reread = view.tools.find((tool) => tool.serverSlug === spec.slug && JIRA_REREADS.includes(tool.toolName.toLowerCase()))
    const readArgs = key && reread ? rereadArgs(reread.toolName, args, key) : undefined
    const site = siteFromArgs(args), meta = await this.memoryMeta(view, native)
    const resources = !site && typeof args['cloudId'] === 'string'
      ? view.tools.find(tool => tool.serverSlug === spec.slug && tool.toolName.toLowerCase() === 'getaccessibleatlassianresources') : undefined
    if (this.outbox && (issues.length || (reread && readArgs))) {
      const ids: string[] = []
      for (let offset = 0; offset < Math.max(1, issues.length); offset += 500) {
        ids.push(await this.outbox.enqueue({ operation: 'sync_tasks',
          args: { issues: issues.slice(offset, offset + 500), source: 'mcp_mirror', ...(site ? { site_url: site } : {}) }, meta,
          ...(resources ? { siteLookup: { server: spec.slug, tool: resources.toolName, cloudId: String(args['cloudId']) } } : {}),
          ...(reread && readArgs ? { reread: { server: spec.slug, tool: reread.toolName, args: readArgs } } : {}) }))
      }
      await this.flushMemory()
      if ((await Promise.all(ids.map(id => this.outbox!.has(id)))).some(Boolean)) throw new Error('delivery_pending')
      return
    }
    if (!memory) throw new Error('memory_unavailable')
    if (reread && readArgs) {
      const fresh = await this.pool.callTool(this.agentInstanceId, spec, reread.toolName, readArgs)
      if (fresh.is_error) throw new Error('jira_reread_failed')
      issues.push(...issuesIn(fresh))
    }
    if (!issues.length) {
      if (isJiraWrite(toolName)) throw new Error('jira_issue_missing')
      return
    }
    for (let offset = 0; offset < issues.length; offset += 500) {
      const mirrored = await this.pool.callTool(this.agentInstanceId, memory, 'sync_tasks',
        { issues: issues.slice(offset, offset + 500), source: 'mcp_mirror', ...(site ? { site_url: site } : {}) }, meta)
      if (mirrored.is_error) throw new Error('memory_sync_failed')
      const summary = mirrored.structured_content ?? (() => {
        try { return JSON.parse(resultText(mirrored)) as Record<string, unknown> } catch { return {} }
      })()
      if (Number(summary['invalid']) > 0 || (Array.isArray(summary['unmatched']) && summary['unmatched'].length)) throw new Error('memory_sync_incomplete')
    }
  }

  private async endMemorySession(): Promise<void> {
    if (this.outbox) {
      for (const meta of this.memorySessions.values()) await this.outbox.enqueue({ operation: 'finish_notes', args: { reason: 'session_end', before: new Date().toISOString() }, meta })
      this.memorySessions.clear()
      await Promise.race([this.flushMemory().catch(() => undefined), new Promise(resolve => setTimeout(resolve, SESSION_END_TIMEOUT_MS).unref())])
      return
    }
    const memory = this.memoryFor(this.store.current, 'finish_notes')
    if (!memory) return
    const meta = await this.memoryMeta(this.store.current)
    await Promise.race([
      this.pool.callTool(this.agentInstanceId, memory, 'finish_notes', { reason: 'session_end' }, meta).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, SESSION_END_TIMEOUT_MS).unref?.()),
    ])
  }

  private async handleListTools(): Promise<ListToolsResult> {
    this.store.refresh()
    await this.refreshPolicy?.()
    const view = this.store.current
    this.lastListedHashValue = view.snapshotHash
    this.onListed?.(view.snapshotHash)
    const tools: ListToolsResult['tools'] = view.tools.filter((tool) => this.profilePermits(view, tool)).map((tool) => ({
      name: tool.exposedName,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: clientToolSchema(tool.inputSchema,view.cliKind) as { type: 'object'; [k: string]: unknown },
    }))
    const skillTool = skillToolFor(view)
    if (skillTool !== null) tools.push(skillTool)
    return { tools }
  }

  /** `use_skill`: la politica vigente decide, como en cualquier otra llamada. */
  private async handleSkillCall(
    view: SnapshotView,
    args: Record<string, unknown>,
    digest: string,
    started: number,
  ): Promise<CallToolResult> {
    const slug = typeof args['slug'] === 'string' ? args['slug'].trim() : ''
    const file = typeof args['file'] === 'string' ? args['file'].trim() : ''
    const record = (decision: string, denialReason: string, error = ''): Promise<void> =>
      this.report({
        agent_id: this.agentInstanceId,
        server_slug: SKILL_TOOL_SERVER,
        tool_name: SKILL_TOOL_NAME,
        exposed_name: SKILL_TOOL_NAME,
        decision,
        args_digest: digest,
        duration_ms: elapsedMs(started),
        denial_reason: denialReason,
        error,
      })

    const skill = view.skill(slug)
    if (skill === undefined) {
      const denied = view.deniedSkill(slug)
      const available = view.skills.map((item) => item.slug).join(', ') || 'none'
      const message = denied !== undefined
        ? `The hub turned off skill '${slug}' for this agent; it is not delivered.` +
          (denied.detail ? ` Reason: ${denied.detail}.` : '') + (denied.source ? ` Deciding level: ${denied.source}.` : '') +
          ' Turn it on in the hub panel to restore it.'
        : `No skill '${slug}' is enabled for this agent. Available skills: ${available}.`
      await record(DECISION_DENY, message)
      return errorResult(message)
    }

    if (file !== '') {
      if (skill.source !== 'external') {
        const message = `Skill '${slug}' is a single SKILL.md with no auxiliary files.`
        await record(DECISION_ALLOW, '', message)
        return errorResult(message)
      }
      let resolved: ReturnType<typeof resolveSkillFile>
      try {
        resolved = resolveSkillFile(skill.sourcePath, file)
      } catch (err) {
        resolved = { error: `could not read '${file}': ${String(err)}` }
      }
      if ('error' in resolved) {
        await record(DECISION_ALLOW, '', resolved.error)
        return errorResult(resolved.error)
      }
      const data = readFileSync(resolved.path)
      if (data.includes(0)) {
        const message = `'${file}' is binary and cannot be shown as text.`
        await record(DECISION_ALLOW, '', message)
        return errorResult(message)
      }
      await record(DECISION_ALLOW, '')
      return { content: [{ type: 'text', text: data.toString('utf-8') }] }
    }

    let text = skillMarkdown(skill)
    if (skill.source === 'external') {
      const files = listSkillFiles(skill.sourcePath)
      if (files.length > 0) {
        text += `\n\n---\nAuxiliary skill files (request with use_skill {slug: '${slug}', file: <path>}):\n` +
          files.map((item) => `- ${item}`).join('\n') + '\n'
      }
    }
    await record(DECISION_ALLOW, '')
    return { content: [{ type: 'text', text }] }
  }

  private async handleCallTool(request: CallToolRequest): Promise<CallToolResult> {
    const started = performance.now()
    this.store.refresh()
    await this.refreshPolicy?.()
    // Se toma la vista UNA vez y se usa hasta el final: la llamada trabaja con una
    // politica coherente, y la siguiente ya ve la nueva.
    const view = this.store.current
    const name = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    const digest = argsDigest(args)

    if (name === SKILL_TOOL_NAME && skillsByTool(view.cliKind) && view.tool(name) === undefined) {
      return this.handleSkillCall(view, args, digest, started)
    }

    const tool = view.tool(name)
    if (tool === undefined) {
      return this.deny(view, name, digest, started)
    }
    if (!this.profilePermits(view, tool)) {
      await this.report({
        agent_id: this.agentInstanceId, server_slug: tool.serverSlug, tool_name: tool.toolName, exposed_name: name,
        decision: DECISION_DENY, args_digest: digest, duration_ms: elapsedMs(started), denial_reason: RUN_PROFILE_DENIAL, error: '',
      })
      return errorResult(`${RUN_PROFILE_DENIAL}: '${name}'.`)
    }

    const spec = view.specFor(tool.serverSlug)
    if (spec === undefined) {
      const message = `The hub has no connection data for server '${tool.serverSlug}', so it cannot run '${name}'.`
      await this.report({
        agent_id: this.agentInstanceId,
        server_slug: tool.serverSlug,
        tool_name: tool.toolName,
        exposed_name: name,
        decision: DECISION_DENY,
        args_digest: digest,
        duration_ms: elapsedMs(started),
        denial_reason: message,
        error: '',
      })
      return errorResult(message)
    }

    try {
      const native = this.outbox ? await sessionForCall(this.outbox.directory, name, args) : undefined
      const meta = isMemorySpec(spec) ? await this.memoryMeta(view, native) : undefined
      if (!meta && isJiraExistingWrite(tool.toolName)) {
        const refused = await this.verifyJiraOwner(view, spec, args)
        if (refused) {
          await this.report({ agent_id: this.agentInstanceId, server_slug: tool.serverSlug, tool_name: tool.toolName, exposed_name: name,
            decision: DECISION_DENY, args_digest: digest, duration_ms: elapsedMs(started), denial_reason: `jira_owner_guard:${refused.code}`, error: "" })
          return errorResult(refused.message)
        }
      }
      const result = await this.pool.callTool(this.agentInstanceId, spec, tool.toolName, args, meta)
      if (!result.is_error && !meta && isJiraTool(tool.toolName)) {
        // Preserve the successful Jira result, but never silently claim the local mirror is current.
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            this.mirrorJira(view, spec, tool.toolName, args, result, native),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('mirror_timeout')), JIRA_MIRROR_TIMEOUT_MS); timeout.unref?.() }),
          ])
        } catch {
          result.content.push({ type: 'text', text: 'Jira succeeded; the local task update is unconfirmed. Never repeat the Jira change: the hub retries saved deliveries, even after restarts. Check memory_list_tasks and the project key; if the result has no issues, sync via memory_sync_tasks.' })
        } finally { clearTimeout(timeout) }
      }
      await this.report({
        agent_id: this.agentInstanceId,
        server_slug: tool.serverSlug,
        tool_name: tool.toolName,
        exposed_name: name,
        decision: DECISION_ALLOW,
        args_digest: digest,
        duration_ms: elapsedMs(started),
        denial_reason: '',
        error: result.is_error ? resultText(result) : '',
      })
      return {
        content: result.content as CallToolResult['content'],
        isError: result.is_error,
        ...(result.structured_content ? { structuredContent: result.structured_content } : {}),
      }
    } catch (err) {
      // El upstream fallo, pero la politica DIJO QUE SI: se reporta `allow` con el
      // error, porque para la auditoria lo que importa es que se autorizo.
      const reason = err instanceof UpstreamError ? err.reason : String(err)
      const message = `The hub allowed '${name}' but the MCP server did not respond: ${reason}`
      await this.report({
        agent_id: this.agentInstanceId,
        server_slug: tool.serverSlug,
        tool_name: tool.toolName,
        exposed_name: name,
        decision: DECISION_ALLOW,
        args_digest: digest,
        duration_ms: elapsedMs(started),
        denial_reason: '',
        error: reason,
      })
      return errorResult(message)
    }
  }

  /** Camino de denegacion: el corazon del producto. */
  private async deny(
    view: PolicyStore['current'],
    name: string,
    digest: string,
    started: number,
  ): Promise<CallToolResult> {
    let message: string
    let serverSlug = ''
    let toolName = ''
    const denied = view.denialFor(name)
    if (denied !== undefined) {
      message = denialMessage(denied)
      const slash = denied.slug.indexOf('/')
      if (slash >= 0) {
        serverSlug = denied.slug.slice(0, slash)
        toolName = denied.slug.slice(slash + 1)
      } else {
        serverSlug = denied.slug
      }
    } else {
      const off = view.deniedServerFor(name)
      message = off !== undefined ? serverOffMessage(name, off) : unknownToolMessage(name)
      serverSlug = off?.slug ?? ''
    }
    await this.report({
      agent_id: this.agentInstanceId,
      server_slug: serverSlug,
      tool_name: toolName,
      exposed_name: name,
      decision: DECISION_DENY,
      args_digest: digest,
      duration_ms: elapsedMs(started),
      denial_reason: message,
      error: '',
    })
    return errorResult(message)
  }

  private async report(record: ToolCallRecord): Promise<void> {
    if (this.reporter === undefined) return
    const trimmed: ToolCallRecord = {
      ...record,
      server_slug: record.server_slug.slice(0, MAX_SERVER_SLUG),
      tool_name: record.tool_name.slice(0, MAX_TOOL_NAME),
      exposed_name: record.exposed_name.slice(0, MAX_EXPOSED_NAME),
    }
    try {
      await this.reporter(trimmed)
    } catch {
      // Un fallo del reporte nunca puede afectar el resultado de la llamada.
    }
  }
}
