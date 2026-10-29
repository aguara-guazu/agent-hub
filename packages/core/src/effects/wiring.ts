import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { ConnectionPool } from '@agenthub/gateway'
import { DecisionService, DecisionStore, GmailSelfSender, MemoryExclusionSink, pollGmailReplies, type DecisionAuthorityReader, type GoogleAuth, type ReplyPollResult, type ScheduleEffects, type Vault } from '@agenthub/memory'
import type { Store } from '../store.js'
import { CoreActionExecutor, type ActionAdapter } from './executor.js'
import { createDeliveryAdapters, type DeliveryArtifacts } from './delivery.js'
import { SlackSelfDelivery } from './slack-self.js'
import { pollSlackReplies, type SlackPollResult } from './slack-replies.js'
import { createEffectToolResolver } from './tools.js'
import { createScheduleEffects } from './schedule-effects.js'
import { createDecisionReview } from './decision-review.js'

const KEY_NAME = 'decision-verifier'
const STORE_FILE = 'decisions.sqlite'

/** Lo que el core necesita del servicio de memoria; se resuelve la primera vez que algo lo usa, cuando la base ya está abierta. */
export interface EffectsHost {
  directory: string
  vault: Pick<Vault, 'read' | 'save'>
  google: GoogleAuth
  load(): Promise<{
    db: { query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]> }
    /** Espejo público por ítem, lector de autoridad del artefacto y lectura del artefacto de un run. */
    schedules: { set(entry: any): Promise<void>; replaceDecisionRef(runId: string, oldRef: string, newRef: string): Promise<boolean>; artifactAuthority: DecisionAuthorityReader; artifactOfRun(runId: string): Promise<{ id: string; title: string; body_md: string; decision_request_ref: string | null } | undefined> }
  }>
}

export interface CoreEffectsOptions {
  store: Store
  pool: ConnectionPool
  ownerId: string
  host: EffectsHost
  automationsEnabled: () => boolean
  /**
   * Adaptadores de acción registrados por las áreas dueñas de cada tipo (Jira, push). Una función se evalúa al resolver los efectos, de modo que
   * pueden leer del core (p. ej. `readJiraServerId`) sin que el cableado conozca su forma.
   */
  adapters?: readonly ActionAdapter<any>[] | (() => readonly ActionAdapter<any>[])
}

/** Resultado de un ciclo de sondeo: cada canal informa por separado y un fallo en uno no detiene al otro. */
export interface ReplyTickResult {
  skipped?: 'automations_off'
  expired?: number
  gmail?: ReplyPollResult | { error: string } | null
  slack?: SlackPollResult | { error: string }
}

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
export function createCoreScheduleEffects(options: CoreEffectsOptions): ScheduleEffects & { ready(): Promise<{ store: DecisionStore; service: DecisionService }>; replyTick(): Promise<ReplyTickResult> } {
  type Resolved = { store: DecisionStore; service: DecisionService; effects: ScheduleEffects; tools: ReturnType<typeof createEffectToolResolver>; gmailConnector(): Promise<string | null> }
  let ready: Promise<Resolved> | undefined
  /** Una resolución fallida no se conserva: el siguiente uso reintenta en lugar de quedar roto hasta reiniciar el core. */
  const resolve = () => ready ??= (async () => {
    const { db, schedules } = await options.host.load()
    const store = new DecisionStore(join(options.host.directory, STORE_FILE), { key: verifierKey(options.host.vault), exclusions: new MemoryExclusionSink(db), publicState: schedules })
    try {
      store.recover()
      store.resyncMirror()
      const service = new DecisionService(store, query => schedules.artifactAuthority(query))
      const tools = createEffectToolResolver(options.store, options.pool, options.ownerId)
      const exclusions = new MemoryExclusionSink(db)
      const artifacts: DeliveryArtifacts = { load: async ({ run_id, artifact_id }) => {
        const artifact = await schedules.artifactOfRun(run_id)
        return artifact && artifact.id === artifact_id ? { title: artifact.title, body_md: artifact.body_md, decision_request_ref: artifact.decision_request_ref } : null
      } }
      const gmail = { sender: new GmailSelfSender(options.host.google), connectorId: async () => {
        const rows = await db.query<{ id: string; config: Record<string, any> }>("SELECT id, config FROM connectors WHERE provider = 'google' AND enabled = 1 ORDER BY created_at")
        return rows.find(row => row.config?.['gmail_send_enabled'] === true && row.config?.['gmail_enabled'] !== false)?.id ?? null
      } }
      const effects = createScheduleEffects({
        deliveries: createDeliveryAdapters({ store, artifacts, exclusions, gmail, slack: new SlackSelfDelivery({ store, tools, exclusions }) }),
        actions: new CoreActionExecutor({ decisions: service, adapters: typeof options.adapters === 'function' ? options.adapters() : options.adapters ?? [], automationsEnabled: options.automationsEnabled, tools }),
        decisions: service,
        ownerId: options.ownerId,
        review: createDecisionReview({ store, service, schedules }),
      })
      return { store, service, effects, tools, gmailConnector: gmail.connectorId }
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
    },
    ready: async () => { const { store, service } = await resolve(); return { store, service } },
    /**
     * Ciclo de sondeo para el reloj del scheduler: vence solicitudes, lee las respuestas de Gmail y de Slack y publica el espejo público.
     * Con las automatizaciones apagadas no hace nada. Un canal que falla no impide el otro ni el vencimiento.
     */
    async replyTick() {
      if (!options.automationsEnabled()) return { skipped: 'automations_off' as const }
      const { store, service, tools, gmailConnector } = await resolve()
      const result: ReplyTickResult = { expired: store.expireDue() }
      try {
        const connectorId = await gmailConnector()
        result.gmail = connectorId ? await pollGmailReplies({ store, service, google: options.host.google, connectorId }) : null
      } catch (error) { result.gmail = { error: error instanceof Error ? error.name : 'error' } }
      try { result.slack = await pollSlackReplies({ store, service, tools }) } catch (error) { result.slack = { error: error instanceof Error ? error.name : 'error' } }
      await store.flushMirror().catch(() => undefined)
      return result
    },
  }
}
