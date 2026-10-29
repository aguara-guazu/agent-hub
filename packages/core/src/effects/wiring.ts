import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { ConnectionPool } from '@agenthub/gateway'
import { type ActionTickResult, createDerivedPorts, DecisionService, DecisionStore, DerivedDispatcher, GmailSelfSender, MemoryExclusionSink, pollGmailReplies, type DecisionAuthorityReader, type DerivedTeams, type DerivedTick, type GoogleAuth, type ReplyPollResult, type ScheduleEffects, type Vault } from '@agenthub/memory'
import type { Store } from '../store.js'
import { CoreActionExecutor, type ActionAdapter } from './executor.js'
import { createDeliveryAdapters, type DeliveryArtifacts } from './delivery.js'
import { SlackSelfDelivery } from './slack-self.js'
import { pollSlackReplies, type SlackPollResult } from './slack-replies.js'
import { createEffectToolResolver } from './tools.js'
import { createScheduleEffects } from './schedule-effects.js'
import { createDecisionReview } from './decision-review.js'
import { createJiraGuard } from './jira-guard.js'
import { createDecisionAttention } from './attention.js'
import { readJiraServerId } from './jira-server.js'

const KEY_NAME = 'decision-verifier'
const STORE_FILE = 'decisions.sqlite'

/** Lo que el core necesita del servicio de memoria; se resuelve la primera vez que algo lo usa, cuando la base ya está abierta. */
/** Lectura de la base de la memoria que los adaptadores pueden necesitar. */
export type EffectsMemoryDb = { query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]> }

export interface EffectsHost {
  directory: string
  vault: Pick<Vault, 'read' | 'save'>
  google: GoogleAuth
  load(): Promise<{
    db: { query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]> }
    /** Espejo público por ítem, lector de autoridad del artefacto y lectura del artefacto de un run. */
    schedules: { set(entry: any): Promise<void>; replaceDecisionRef(runId: string, oldRef: string, newRef: string): Promise<boolean>; artifactAuthority: DecisionAuthorityReader; artifactOfRun(runId: string): Promise<{ id: string; title: string; body_md: string; decision_request_ref: string | null } | undefined> }
    /** Orquestación de equipos del servicio de memoria; sin ella los planes derivados no se despachan. */
    teams?: DerivedTeams
  }>
}

export interface CoreEffectsOptions {
  store: Store
  pool: ConnectionPool
  ownerId: string
  host: EffectsHost
  automationsEnabled: () => boolean
  /**
   * Adaptadores de acción registrados por las áreas dueñas de cada tipo (Jira, push). Una función se evalúa una vez al resolver los efectos y recibe la
   * base de la memoria ya abierta, de modo que pueden leer del core (p. ej. `readJiraServerId`) y de la delegación vigente sin que el cableado conozca su forma.
   */
  adapters?: readonly ActionAdapter<any>[] | ((deps: { db: EffectsMemoryDb }) => readonly ActionAdapter<any>[])
}

/** Resultado de un ciclo de sondeo: cada canal informa por separado y un fallo en uno no detiene al otro. */
export interface ReplyTickResult {
  skipped?: 'automations_off'
  expired?: number
  gmail?: ReplyPollResult | { error: string } | null
  slack?: SlackPollResult | { error: string }
  /** Despacho inmediato de lo recién aprobado por canal. */
  actions?: ActionTickResult
  derived?: DerivedTick | { error: string }
}

/** Resultado de un ciclo de despacho: solo conteos, nunca efectos ni contenido. */
export type { ActionTickResult } from '@agenthub/memory'

/** Clave del verificador: vive en el Vault local, nunca en el almacén de decisiones ni en un archivo de configuración. */
function verifierKey(vault: EffectsHost['vault']): Buffer {
  const saved = vault.read<{ key?: string }>(KEY_NAME)?.key
  if (saved) return Buffer.from(saved, 'base64')
  const key = randomBytes(32)
  vault.save(KEY_NAME, { key: key.toString('base64') })
  return key
}

/**
 * Efectos del scheduler con sus dependencias resueltas de forma perezosa: el almacén de decisiones, el sink de exclusiones y los lectores de artefactos
 * necesitan la base de la memoria, que el servicio abre después de registrar las rutas. Un fallo al resolver deja cada llamada fallando cerrada.
 */
export function createCoreScheduleEffects(options: CoreEffectsOptions): ScheduleEffects & { ready(): Promise<{ store: DecisionStore; service: DecisionService }>; replyTick(): Promise<ReplyTickResult>; actionTick(): Promise<ActionTickResult> } {
  type Resolved = { store: DecisionStore; service: DecisionService; db: EffectsMemoryDb; effects: ScheduleEffects; tools: ReturnType<typeof createEffectToolResolver>; gmailConnector(): Promise<string | null>; derived?: DerivedDispatcher }
  const tools = createEffectToolResolver(options.store, options.pool, options.ownerId)
  let ready: Promise<Resolved> | undefined
  let dispatching = false
  /**
   * Despacha las intenciones aprobadas y sin despachar, de a una y en secuencia, con la generación que acaba de leer. Lo incierto nunca vuelve a esta lista
   * (`dispatchable()` solo devuelve `pending` con autoridad vigente), así que un resultado ambiguo no se reintenta solo. Un ciclo en curso no se solapa.
   */
  const runActionTick = async (): Promise<ActionTickResult> => {
    if (!options.automationsEnabled()) return { skipped: 'automations_off' }
    if (dispatching) return { skipped: 'in_flight' }
    dispatching = true
    try {
      const { service, effects } = await resolve()
      const result: { attempted: number; succeeded: number; rejected: number; uncertain: number; errors?: number } = { attempted: 0, succeeded: 0, rejected: 0, uncertain: 0 }
      for (const intent of await service.dispatchable()) {
        if (!options.automationsEnabled()) break
        const receipt = await effects.actions.executeApprovedAction({ intent_id: intent.intent_id, expected_generation: intent.generation }).catch(() => null)
        result.attempted++
        if (!receipt) result.errors = (result.errors ?? 0) + 1
        else if (receipt.state === 'succeeded') result.succeeded++
        else if (receipt.state === 'rejected_before_dispatch') result.rejected++
        else result.uncertain++
      }
      return result
    } finally { dispatching = false }
  }
  /** Una resolución fallida no se conserva: el siguiente uso reintenta en lugar de quedar roto hasta reiniciar el core. */
  const resolve = () => ready ??= (async () => {
    const { db, schedules, teams } = await options.host.load()
    const store = new DecisionStore(join(options.host.directory, STORE_FILE), { key: verifierKey(options.host.vault), exclusions: new MemoryExclusionSink(db), publicState: schedules })
    try {
      store.recover()
      store.resyncMirror()
      const service = new DecisionService(store, query => schedules.artifactAuthority(query))
      const exclusions = new MemoryExclusionSink(db)
      const artifacts: DeliveryArtifacts = { load: async ({ run_id, artifact_id }) => {
        const artifact = await schedules.artifactOfRun(run_id)
        return artifact && artifact.id === artifact_id ? { title: artifact.title, body_md: artifact.body_md, decision_request_ref: artifact.decision_request_ref } : null
      } }
      const googleSources = () => db.query<{ id: string; config: Record<string, any>; mailbox: unknown }>("SELECT id, config, json_extract(cursor,'$.gmail.mailbox') AS mailbox FROM connectors WHERE provider = 'google' AND enabled = 1 ORDER BY created_at")
      const reads = (row: { config: Record<string, any> }) => row.config?.['gmail_enabled'] !== false
      const sends = (row: { config: Record<string, any> }) => row.config?.['gmail_send_enabled'] === true && reads(row)
      const gmail = { sender: new GmailSelfSender(options.host.google),
        connectorId: async () => (await googleSources()).find(sends)?.id ?? null,
        sendPending: async () => {
          const rows = await googleSources()
          const source = rows.some(sends) ? undefined : rows.find(reads)
          return source ? { account: typeof source.mailbox === 'string' && source.mailbox ? source.mailbox : null } : null
        } }
      const effects = createScheduleEffects({
        deliveries: createDeliveryAdapters({ store, artifacts, exclusions, gmail, slack: new SlackSelfDelivery({ store, tools, exclusions }) }),
        actions: new CoreActionExecutor({ decisions: service, adapters: typeof options.adapters === 'function' ? options.adapters({ db }) : options.adapters ?? [], automationsEnabled: options.automationsEnabled, tools }),
        decisions: service,
        ownerId: options.ownerId,
        review: createDecisionReview({ store, service, schedules, onApproved: () => { void runActionTick().catch(() => undefined) } }),
      })
      // Derived plans read the approved follow-ups through the public API of the decision service; the host attaches no issuer of the action profile here.
      let derived: DerivedDispatcher | undefined
      if (teams) {
        teams.attachAutomation(createDerivedPorts({ decisions: service, ownerId: () => options.ownerId, automationsEnabled: options.automationsEnabled }))
        derived = new DerivedDispatcher({ db, teams, decisions: service })
      }
      return { store, service, db, effects, tools, gmailConnector: gmail.connectorId, ...(derived ? { derived } : {}) }
    } catch (error) { store.close(); throw error }
  })().catch(error => { ready = undefined; throw error })
  const effects = async () => (await resolve()).effects
  const review = async () => (await effects()).review!
  return {
    deliveries: {
      available: async () => (await effects()).deliveries.available(),
      executeDelivery: async input => (await effects()).deliveries.executeDelivery(input),
    },
    actions: {
      executeApprovedAction: async input => (await effects()).actions.executeApprovedAction(input),
      reconcile: async intentId => (await effects()).actions.reconcile(intentId),
    },
    decisions: {
      prepareDecision: async input => (await effects()).decisions.prepareDecision(input),
      revokeAll: async () => ((await effects()).decisions as { revokeAll(): Promise<number> }).revokeAll(),
    } as ScheduleEffects['decisions'],
    review: {
      view: async runId => (await review()).view(runId),
      decide: async (runId, input) => (await review()).decide(runId, input),
      revise: async (runId, input) => (await review()).revise(runId, input),
      repropose: async runId => (await review()).repropose(runId),
      releaseDelivery: async (runId, integration) => (await review()).releaseDelivery(runId, integration),
    },
    jira: createJiraGuard({ serverId: () => readJiraServerId(options.store, options.ownerId), tools: serverId => tools.forServer(serverId) }),
    attention: createDecisionAttention({ resolve }),
    ready: async () => { const { store, service } = await resolve(); return { store, service } },
    /**
     * Ciclo de sondeo para el reloj del scheduler: vence solicitudes, lee las respuestas de Gmail y de Slack y publica el espejo público.
     * Con las automatizaciones apagadas no hace nada. Un canal que falla no impide el otro ni el vencimiento.
     */
    actionTick: runActionTick,
    async replyTick() {
      if (!options.automationsEnabled()) return { skipped: 'automations_off' as const }
      const { store, service, tools, gmailConnector, derived } = await resolve()
      const result: ReplyTickResult = { expired: store.expireDue() }
      try {
        const connectorId = await gmailConnector()
        result.gmail = connectorId ? await pollGmailReplies({ store, service, google: options.host.google, connectorId }) : null
      } catch (error) { result.gmail = { error: error instanceof Error ? error.name : 'error' } }
      try { result.slack = await pollSlackReplies({ store, service, tools }) } catch (error) { result.slack = { error: error instanceof Error ? error.name : 'error' } }
      const consumed = (result.gmail && 'consumed' in result.gmail ? result.gmail.consumed : 0) + (result.slack && 'consumed' in result.slack ? result.slack.consumed : 0)
      if (consumed > 0) result.actions = await runActionTick().catch((): ActionTickResult => ({ attempted: 0, succeeded: 0, rejected: 0, uncertain: 0, errors: 1 }))
      if (derived) result.derived = await derived.tick().catch(() => ({ error: 'derived_tick_failed' }))
      await store.flushMirror().catch(() => undefined)
      return result
    },
  }
}
