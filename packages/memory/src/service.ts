import { unavailableActivity, type FleetActivity } from './fleet-activity.js'
import { SharedNetwork } from './sharing/network.js'
import { MemoryDefaults, DEFAULTS_KEY } from './defaults.js'
import { MediaRuntime } from './media-runtime.js'
import { NativeEmbeddingPool } from './native-embeddings.js'
import { NATIVE_EMBEDDING_MODEL } from './embedding-model.js'
import { z } from 'zod'
import { MemoryDatabase } from './database.js'
import { Vault, defaultAI, localUrl, type AIConfig } from './config.js'
import { MemoryStore } from './store.js'
import { MemoryOperations } from './operations.js'
import { MemoryAI } from './ai.js'
import { GoogleAuth } from './google-auth.js'
import { OpenCodeRuntime } from './opencode.js'
import { CliExtractionRuntime, extractionClis, isExtractionCli, validCliModel } from './cli-extraction.js'
import { TeamCatalog } from './team-catalog.js'
import { HubTeamRuntime } from './team-hub.js'
import { JobRunner } from './jobs.js'
import { check, MemoryError, parse } from './contracts.js'
import { databaseFile, migrationState, needsMigration } from './legacy-postgres.js'
import { reasoningEffortSchema } from './reasoning.js'
import { ScheduleStore } from './schedule-store.js'
import { ScheduleAdmin } from './schedule-admin.js'
import { ScheduleRuntime } from './schedule-runtime.js'
import { EngineSynthesizer } from './schedule-synthesizer.js'
import { scheduleDeps } from './schedule-deps.js'
import type { ActionTickResult, AttentionReaders, ScheduleAutomation } from './schedule-contract.js'
import './schedule-templates.js'
import './daily-templates.js'
import { createFleetRecovery } from './fleet-recovery.js'

const REPLY_TICK_MS = 60_000
const ACTION_TICK = 'action_tick', ACTION_TICK_MS = 30_000
/**
 * The fleet sweep decides a resume from the restart incidents the clock writes when it starts, so it must run after them: a sweep that came first would
 * skip every member and nothing would trigger it again once the quota was already back.
 */
export async function startClockThenRecover(runtime: { start(): Promise<void> }, recovery: { recover(): Promise<unknown> } | undefined) {
  await runtime.start().catch(error => console.error('[schedules]', error instanceof Error ? error.message : 'falló'))
  await recovery?.recover().catch(error => console.error('[fleet-recovery]', error instanceof Error ? error.message : 'falló'))
}
/** Counts and error names only; a cycle without activity leaves no event. */
export function summarizeReplyTick(result: unknown): Record<string, unknown> | null { return summarizeTick(result, ['expired', 'consumed', 'rejected']) }
/** The action dispatcher leaves an event only when it attempted something or failed; a skipped or empty cycle leaves none. */
export function summarizeActionTick(result: ActionTickResult | undefined): Record<string, unknown> | null {
  if (!result || 'skipped' in result || !(result.attempted > 0 || (result.errors ?? 0) > 0)) return null
  return { attempted: result.attempted, succeeded: result.succeeded, rejected: result.rejected, uncertain: result.uncertain, ...(result.errors ? { errors: result.errors } : {}) }
}
function summarizeTick(result: unknown, outcomes: string[]): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null
  const summary: Record<string, unknown> = {}, errors: string[] = []
  // Only outcomes count: a request left open makes every cycle inspect, which is not activity.
  const outcome = (key: string) => outcomes.includes(key)
  const listed = (result as { errors?: unknown }).errors
  if (Array.isArray(listed)) for (const item of listed) if (typeof item === 'string') errors.push(item.slice(0, 60))
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (typeof value === 'number' && value > 0 && outcome(key)) summary[key] = value
    else if (value && typeof value === 'object') {
      const counts: Record<string, number> = {}
      for (const [name, count] of Object.entries(value)) {
        if (!outcome(name)) continue
        // `rejected` arrives as {reason: n}; its total is the count.
        const total = typeof count === 'number' ? count : count && typeof count === 'object' ? Object.values(count).reduce<number>((sum, n) => sum + (typeof n === 'number' ? n : 0), 0) : 0
        if (total > 0) counts[name] = total
      }
      const error = (value as { error?: unknown }).error
      if (typeof error === 'string') errors.push(`${key}:${error.slice(0, 60)}`)
      if (Object.keys(counts).length) summary[key] = counts
    }
  }
  if (errors.length) summary.errors = errors
  return Object.keys(summary).length ? summary : null
}

export const aiConfigSchema = z.object({ extraction: z.enum(['disabled','deepseek','ollama','opencode', ...extractionClis]), extraction_model: z.string().max(200),
  extraction_reasoning_effort: reasoningEffortSchema,
  embeddings_enabled: z.boolean(), embedding_model: z.string().min(1).max(200), ollama_url: z.url(), remote_processing_enabled: z.boolean(),
  identity_auto_merge: z.boolean().default(true), project_auto_assign: z.boolean().default(true) }).strict().refine(
    config => config.extraction !== 'opencode' || (!config.extraction_model && !config.remote_processing_enabled) || /^[^/\s]+\/\S+$/.test(config.extraction_model),
    { message: 'Elegí un modelo de OpenCode con formato proveedor/modelo', path: ['extraction_model'] }).refine(
    config => !isExtractionCli(config.extraction) || (!config.extraction_model && !config.remote_processing_enabled) || validCliModel(config.extraction_model),
    { message: 'Elegí un nombre de modelo válido para la CLI', path: ['extraction_model'] }).refine(
    config => config.extraction === 'disabled' || !config.remote_processing_enabled || !!config.extraction_model.trim(),
    { message: 'Elegí un modelo antes de habilitar el procesamiento', path: ['extraction_model'] })
/** The engine the person chose: while the integrated model is still downloading for a saved selection, it is reported instead of the engine still in use. */
function selectedAI(ai: AIConfig, defaults: { target?: string; embedding_state?: string } | undefined): AIConfig {
  const pending = defaults?.target === NATIVE_EMBEDDING_MODEL && ['pending', 'downloading'].includes(defaults.embedding_state ?? '')
  return pending ? { ...ai, embedding_model: NATIVE_EMBEDDING_MODEL, embeddings_enabled: true } : ai
}
export class MemoryService {
  usageEnabled:(agentId:string)=>boolean = ()=>true
  readonly defaults = new MemoryDefaults(this)
  readonly media: MediaRuntime
  readonly nativeEmbeddings: NativeEmbeddingPool
  readonly vault: Vault
  readonly google: GoogleAuth
  readonly openCode: OpenCodeRuntime
  readonly cliExtraction: CliExtractionRuntime
  private current: { db: MemoryDatabase; store: MemoryStore; ai: MemoryAI; operations: MemoryOperations; runner: JobRunner; network: SharedNetwork; schedules?: { store: ScheduleStore; admin: ScheduleAdmin; runtime: ScheduleRuntime; attention: () => AttentionReaders } } | null = null
  private initializing: Promise<NonNullable<MemoryService['current']>> | null = null
  constructor(readonly directory: string, redirectUrl: string, private fetcher: typeof fetch = fetch,
    private jiraMcp?: import('./tasks.js').JiraTaskReader, private orchestrationOwner = false, private collaborationEnabled: () => boolean = () => true,
    private automation: ScheduleAutomation = { enabled: () => true }) {
    this.nativeEmbeddings = new NativeEmbeddingPool(directory)
    this.media = new MediaRuntime(directory)
    this.openCode = new OpenCodeRuntime(directory)
    this.vault = new Vault(directory)
    this.cliExtraction = new CliExtractionRuntime(directory, { kiroApiKey: () => this.vault.read<{ api_key: string }>('kiro')?.api_key })
    this.google = new GoogleAuth(this.vault, redirectUrl, fetcher)
  }
  async get() {
    if (this.current) return this.current
    this.initializing ??= this.initialize().finally(() => { this.initializing = null })
    return this.initializing
  }
  private async initialize() {
    if (needsMigration(this.directory, this.vault)) {
      const migration = migrationState(this.directory)
      throw new MemoryError(503, migration?.state === 'failed' ? `La migración de la memoria está pendiente: ${migration.error}` : 'La memoria se está migrando a su nuevo formato')
    }
    const db = new MemoryDatabase(databaseFile(this.directory))
    try { await db.migrate() } catch {
      await db.close().catch(() => undefined)
      throw new MemoryError(503, 'No se pudo abrir la base de memoria local')
    }
    const store = new MemoryStore(db, this.directory)
    const ai = new MemoryAI(() => this.aiSettings(), this.vault, this.fetcher, this.openCode, undefined, undefined, undefined, this.cliExtraction, this.nativeEmbeddings)
    const operations = new MemoryOperations(store, ai, this.google, this.vault, this.fetcher, this.jiraMcp, this.media,
      { catalog: new TeamCatalog(this.cliExtraction), orca: chat => new HubTeamRuntime(chat,this.directory,this.collaborationEnabled) }, this.collaborationEnabled)
    operations.chat.usageEnabled=this.usageEnabled
    operations.ownerJira = () => this.automation.effects?.jira
    if (this.orchestrationOwner) await operations.teams?.initialize()
    const runner = new JobRunner(store, ai, this.vault, this.google, () => this.aiSettings(), this.fetcher, this.media)
    this.current = { db, store, ai, operations, runner, network: new SharedNetwork(operations.sharing) }
    if (this.orchestrationOwner) this.current.schedules = this.createSchedules(db, store, ai, operations)
    return this.current
  }
  /** Clock and admission of schedules; they live only where the orchestration owner runs, never in the worker process. */
  private createSchedules(db: MemoryDatabase, store: MemoryStore, ai: MemoryAI, operations: MemoryOperations) {
    const schedules = new ScheduleStore(db), automation = this.automation
    // Readers of this area; the decision store readers come through `automation.effects` and those of the project automation from its service, both resolved on each run.
    const own: AttentionReaders = {
      uncertain_deliveries: async () => (await schedules.uncertainDeliveries()).map(row => ({ ref: String(row.id), summary: `Entrega ${row.target} incierta`, at: String(row.updated_at), ...(row.project_id ? { project_id: String(row.project_id) } : {}) })),
      overdue_close: async () => (await schedules.overdueCloses()).map(row => ({ ref: String(row.id), summary: 'Cierre del día no ejecutado', at: String(row.scheduled_for) })),
    }
    const runtime = new ScheduleRuntime({ store: schedules, db, memory: store, automation, usage: operations.usage, signals: operations.chat.events, deps: () => scheduleDeps(own, operations.projectAutomation, automation),
      synthesizer: new EngineSynthesizer({ settings: () => this.aiSettings(), cli: this.cliExtraction, ai }),
      ...(operations.teams ? { derivedPlans: { closeAll: (reason: string) => operations.teams!.closeAllDerived(reason) } } : {}) })
    const unavailable = { available: false, reason: 'not_connected' }
    const admin = new ScheduleAdmin({ store: schedules, db, automationsEnabled: () => automation.enabled(), wake: () => runtime.kick(), stopRun: id => runtime.stopRun(id),
      deliveryAvailability: async () => automation.effects ? await automation.effects.deliveries.available().catch(() => ({ gmail_self: unavailable, slack_self: unavailable })) : { gmail_self: unavailable, slack_self: unavailable } })
    operations.schedules = admin
    // Reading channel replies and expiring requests ride the scheduler clock; the effects are injected later by the core, so they are read at each call.
    runtime.addPeriodic('reply_tick', async () => {
      const result = await automation.effects?.replyTick?.()
      const summary = summarizeReplyTick(result)
      if (summary) await schedules.addEvent({ type: 'replies.processed', actor_kind: 'system', payload: summary })
    }, REPLY_TICK_MS)
    // Approved intentions are executed by the core, never by a model; B owns the claim, the generation and the uncertain state, A owns when it runs.
    runtime.addPeriodic(ACTION_TICK, async () => {
      const summary = summarizeActionTick(await automation.effects?.actionTick?.())
      if (summary) await schedules.addEvent({ type: 'action.receipt', actor_kind: 'system', payload: summary })
    }, ACTION_TICK_MS)
    return { store: schedules, admin, runtime, attention: () => scheduleDeps(own, operations.projectAutomation, automation).attention! }
  }
  /** Runs the action dispatcher now, right after a decision was consumed, unless it is already running. */
  async kickActions() { (await this.get()).schedules?.runtime.kickPeriodic(ACTION_TICK) }
  /** Applies an automations switch change now instead of at the next tick. */
  async kickSchedules() { (await this.get()).schedules?.runtime.kick() }
  /** Starts the clock, independent of the collaboration switch, and then looks at members that stopped on an exhausted quota while the Hub was down. */
  async startSchedules() {
    const { schedules, db, operations } = await this.get()
    if (!schedules) return
    await startClockThenRecover(schedules.runtime, createFleetRecovery(db, operations.usage, operations.fleet, operations.usageNotices, operations.teams ? { restart: input => operations.teams!.continueMemberFresh(input.member_id, input.generation) } : undefined))
  }
  async status() {
    const configuration = { database_configured: true, google_client_configured: this.vault.has('google-client'),
      deepseek_configured: this.vault.has('deepseek'), google_redirect_url: this.google.redirectUrl }
    if (needsMigration(this.directory, this.vault)) {
      const migration = migrationState(this.directory)
      return { ready: false, state: migration?.state === 'failed' ? 'migration_pending' as const : 'migrating' as const, ...configuration, counts: {}, pending_jobs: 0,
        ai: defaultAI, migration, detail: migration?.state === 'failed' ? migration.error : 'La memoria se está migrando a su nuevo formato' }
    }
    try {
      const { db } = await this.get()
      const counts = await db.query('SELECT kind,count(*) AS count FROM entities GROUP BY kind')
      const worker = (await db.query("SELECT value FROM settings WHERE key='worker'"))[0]?.value ?? null
      const [sources] = await db.query('SELECT count(*) AS count,max(synced_at) AS last_import FROM sources')
      const [pending] = await db.query("SELECT count(*) AS count FROM jobs WHERE state IN ('queued','running','waiting')")
      const defaults = await this.defaults.status()
      return { ready: true, state: 'ready' as const, ...configuration, counts: Object.fromEntries(counts.map(r => [r.kind, r.count])), sources, pending_jobs: pending?.count ?? 0,
        worker, ai: selectedAI(await this.aiSettings(), defaults), defaults }
    } catch (error) {
      return { ready: false, state: 'unavailable' as const, ...configuration, counts: {}, pending_jobs: 0, ai: defaultAI,
        detail: error instanceof MemoryError ? error.message : 'La memoria local no está disponible' }
    }
  }
  async aiSettings(): Promise<AIConfig> {
    const { db } = await this.get()
    const row = (await db.query("SELECT value FROM settings WHERE key='ai'"))[0]
    return { ...defaultAI, ...row?.value }
  }
  async saveAI(raw: unknown, signal?: AbortSignal) {
    const config = parse(aiConfigSchema, raw)
    // Choosing the integrated model before its download finishes keeps the current engine; MemoryDefaults switches and reindexes once it is ready.
    const deferred = config.embeddings_enabled && config.embedding_model === NATIVE_EMBEDDING_MODEL && !this.nativeEmbeddings.installed()
    localUrl(config.ollama_url)
    check(new URL(config.ollama_url).protocol === 'http:' || new URL(config.ollama_url).protocol === 'https:', 'URL de Ollama inválida')
    if (config.extraction === 'opencode' && config.remote_processing_enabled) {
      await this.openCode.test(config.extraction_model, signal, config.extraction_reasoning_effort)
    }
    if (isExtractionCli(config.extraction) && config.remote_processing_enabled) await this.cliExtraction.test(config.extraction, config.extraction_model, signal, config.extraction_reasoning_effort)
    signal?.throwIfAborted()
    const { db } = await this.get()
    await db.transaction(async sql => {
      const previous = (await sql.query("SELECT value FROM settings WHERE key='ai'"))[0]?.value
      const stored = deferred ? { ...config, embedding_model: previous?.embedding_model ?? config.embedding_model, embeddings_enabled: previous?.embeddings_enabled ?? false } : config
      const changedEmbedding = !!previous && (previous.embedding_model !== stored.embedding_model || previous.embeddings_enabled !== stored.embeddings_enabled)
      if (deferred) {
        await sql.query(`INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=json_set(value,'$.target',$3,'$.embedding_state','pending')`,
          [DEFAULTS_KEY, JSON.stringify({ target: NATIVE_EMBEDDING_MODEL, embedding_state: 'pending', previous_ai: previous ?? null, provider_state: 'preserved' }), NATIVE_EMBEDDING_MODEL])
      } else if (changedEmbedding || config.embedding_model !== NATIVE_EMBEDDING_MODEL) {
        await sql.query("UPDATE settings SET value=json_set(value,'$.embedding_state','custom') WHERE key=$1", [DEFAULTS_KEY])
      }
      await sql.query("UPDATE settings SET value=json_set(value,'$.provider_state','preserved') WHERE key=$1", [DEFAULTS_KEY])
      await sql.query("INSERT INTO settings(key,value) VALUES('ai',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(stored)])
    })
    if (deferred) void this.defaults.tick().catch(() => {})
    return config
  }
  async suspendFleet() { await this.initializing; await this.current?.operations.fleet?.suspend?.() }
  async wakeFleet(sessionId:string,text:string) {
    const fleet=(await this.get()).operations.fleet
    return fleet instanceof HubTeamRuntime ? fleet.wake(sessionId,text) : false
  }
  async fleetActivity(sessionId: string, after = 0): Promise<FleetActivity> {
    const { operations, db } = await this.get()
    check((await db.query('SELECT id FROM chat_sessions WHERE id=$1', [sessionId]))[0], 'Sesión inexistente.', 404)
    return operations.fleet instanceof HubTeamRuntime ? operations.fleet.activity(sessionId, after) : unavailableActivity()
  }
  async fleetConnected(sessionId:string) {
    const {operations,db}=await this.get()
    const member=(await db.query('SELECT id FROM chat_team_members WHERE session_id=$1',[sessionId]))[0]
    const status=member ? await operations.fleet?.status?.(String(member.id)) : undefined
    return !!status && ['starting','busy','idle','waiting_input'].includes(status.state ?? '')
  }
  async close() { this.defaults.stop(); await this.initializing?.catch(() => {}); await this.current?.schedules?.runtime.close(); await this.media.close(); await this.nativeEmbeddings.close(); await this.cliExtraction.close(); await this.openCode.close(); await this.defaults.idle(); const current = this.current; this.current = null; if (current) { await current.operations.fleet?.close?.(); await current.network.stop(); await current.db.close() } }
}
