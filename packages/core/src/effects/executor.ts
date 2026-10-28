import { randomUUID } from 'node:crypto'
import type { ActionExecutor, ActionReceipt, DecisionItemKind, DecisionService, IntentRow } from '@agenthub/memory'
import type { EffectTools } from './tools.js'

/** Lo que el adaptador conoce de la intención que ejecuta. El efecto ya viene validado por `ActionAdapter.effect`. */
export interface ActionContext {
  intent_id: string
  request_id: string
  item_id: string
  run_id: string | undefined
  kind: DecisionItemKind
  operation_key: string
  effect_digest: string
  tools: EffectTools
}

/** El adaptador rechaza antes de cualquier escritura: `code` queda en el recibo y la intención en `rejected_before_dispatch`. */
export class EffectRejected extends Error {
  constructor(readonly code: string, message = code) { super(message) }
}

/** `effect.parse` es el esquema (zod u otro) del efecto canónico; lanza si el contenido no cumple. */
export interface ActionAdapter<E = unknown> {
  kind: DecisionItemKind
  effect: { parse(raw: unknown): E }
  /** Herramientas MCP que `execute` puede invocar. Se comprueban contra la identidad `hub_effects` antes del dispatch. */
  tools: readonly string[]
  /** Solo lecturas y guards. Cualquier fallo aquí significa que nada se escribió. */
  prepare(ctx: ActionContext, effect: E): Promise<unknown>
  /** La única fase con efectos. Una excepción se trata como resultado incierto. */
  execute(ctx: ActionContext, prepared: unknown): Promise<Omit<ActionReceipt, 'intent_id'>>
  /** Solo lectura. `null` cuando no hay prueba concluyente en ningún sentido. */
  reconcile(ctx: ActionContext, intentId: string): Promise<Omit<ActionReceipt, 'intent_id'> | null>
}

export interface CoreActionExecutorOptions {
  decisions: DecisionService
  adapters: readonly ActionAdapter<any>[]
  /** Interruptor de automatizaciones: apagado, nada se despacha. */
  automationsEnabled: () => boolean
  /** Herramientas de la identidad de servicio con la correlación de esta ejecución. */
  toolsFor: (trace: { runId?: string; intentId: string; callId: string }) => EffectTools
}

const rejected = (intentId: string, code: string): ActionReceipt => ({ intent_id: intentId, state: 'rejected_before_dispatch', error_code: code })
const uncertain = (intentId: string, code: string): ActionReceipt => ({ intent_id: intentId, state: 'uncertain', error_code: code })

/**
 * Ejecutor genérico del core: autorizar → intención durable → efecto → recibo.
 *
 * El llamador solo entrega `intent_id` y la generación esperada; el efecto sale del almacén privado de decisiones y el adaptador
 * se elige por el tipo del ítem dentro de una lista cerrada. Entre la autorización y el efecto no interviene ningún modelo.
 * Un fallo de `execute`, un timeout o un recibo que no se pudo persistir dejan la intención incierta y nunca se reintentan solos.
 */
export class CoreActionExecutor implements ActionExecutor {
  private readonly adapters = new Map<DecisionItemKind, ActionAdapter<any>>()

  constructor(private readonly options: CoreActionExecutorOptions) {
    for (const adapter of options.adapters) {
      if (this.adapters.has(adapter.kind)) throw new Error(`adaptador duplicado para ${adapter.kind}`)
      this.adapters.set(adapter.kind, adapter)
    }
  }

  private get store() { return this.options.decisions.store }

  private context(intent: IntentRow): ActionContext {
    const run = this.store.runOfRequest(intent.request_id)
    return {
      intent_id: intent.intent_id, request_id: intent.request_id, item_id: intent.item_id, run_id: run, kind: intent.kind, operation_key: intent.operation_key, effect_digest: intent.effect_digest,
      tools: this.options.toolsFor({ ...(run ? { runId: run } : {}), intentId: intent.intent_id, callId: randomUUID() }),
    }
  }

  async executeApprovedAction(input: { intent_id: string; expected_generation: number }): Promise<ActionReceipt> {
    const { intent_id: intentId } = input
    if (!this.options.automationsEnabled()) return rejected(intentId, 'automations_off')
    const claimed = await this.options.decisions.claimForDispatch(intentId, input.expected_generation)
    if (claimed.gated) return rejected(intentId, claimed.reason)
    if ('rejected' in claimed.value) return rejected(intentId, claimed.value.rejected)
    const { intent, generation } = claimed.value
    const release = (code: string): ActionReceipt => {
      this.store.releaseIntent(intentId, generation, code, 'rejected_before_dispatch')
      return rejected(intentId, code)
    }

    const adapter = this.adapters.get(intent.kind)
    if (!adapter) return release('adapter_not_allowed')
    let effect: unknown
    try { effect = adapter.effect.parse(JSON.parse(intent.effect)) } catch { return release('invalid_effect') }
    const ctx = this.context(intent)
    if (!adapter.tools.every(tool => ctx.tools.enabled(tool))) return release('tool_off')

    let prepared: unknown
    try { prepared = await adapter.prepare(ctx, effect) } catch (error) { return release(error instanceof EffectRejected ? error.code : 'prepare_failed') }

    switch (this.store.markDispatching(intentId, generation)) {
      case 'ok': break
      case 'duplicate_effect': return release('duplicate_effect')
      default: return rejected(intentId, this.store.intent(intentId)?.error_code ?? 'stale')
    }

    let receipt: ActionReceipt
    try {
      const result = await adapter.execute(ctx, prepared)
      receipt = { ...result, intent_id: intentId }
    } catch (error) {
      receipt = uncertain(intentId, error instanceof EffectRejected ? error.code : 'execute_failed')
    }
    const recorded = this.store.completeIntent(intentId, generation, receipt)
    return recorded ? receipt : uncertain(intentId, 'receipt_not_recorded')
  }

  async reconcile(intentId: string): Promise<ActionReceipt> {
    const intent = this.store.intent(intentId)
    if (!intent) return rejected(intentId, 'intent_not_found')
    if (intent.state !== 'uncertain' && intent.state !== 'dispatching') {
      return { intent_id: intentId, state: intent.state === 'succeeded' ? 'succeeded' : intent.state === 'rejected_before_dispatch' ? 'rejected_before_dispatch' : 'uncertain',
        ...(intent.remote_ref ? { remote_ref: intent.remote_ref } : {}), ...(intent.error_code ? { error_code: intent.error_code } : {}) }
    }
    const adapter = this.adapters.get(intent.kind)
    if (!adapter) return uncertain(intentId, 'adapter_not_allowed')
    try {
      const result = await adapter.reconcile(this.context(intent), intentId)
      return result ? { ...result, intent_id: intentId } : uncertain(intentId, 'no_conclusive_evidence')
    } catch { return uncertain(intentId, 'reconcile_failed') }
  }
}
