import type { DecisionService, ScheduleEffects, ActionExecutor, DeliveryAdapters } from '@agenthub/memory'

export * from './executor.js'
export * from './tools.js'
export * from './delivery.js'
export * from './slack-self.js'
export * from './slack-replies.js'
export * from './call-audit.js'
export * from './identities.js'

/** La autoridad del artefacto no está vigente: la solicitud de decisión no se prepara. */
export class DecisionAuthorityUnavailable extends Error {
  constructor() { super('authority_unavailable') }
}

/**
 * Arma el objeto que el core entrega a `registerMemory`. `prepareDecision` ordena los ítems por su número, los pasa al servicio con la compuerta de autoridad
 * (los de tipo `info` no se aprueban y se omiten) y devuelve la referencia opaca de la solicitud; es idempotente por run.
 */
export function createScheduleEffects(parts: { deliveries: DeliveryAdapters; actions: ActionExecutor; decisions: DecisionService }): ScheduleEffects {
  return {
    deliveries: parts.deliveries,
    actions: parts.actions,
    decisions: {
      async prepareDecision(input) {
        const actionable = [...input.items].sort((a, b) => a.ordinal - b.ordinal).flatMap(item => item.kind === 'info' ? [] : [{ kind: item.kind, project_id: item.project_id, summary: item.summary, exact_effect: item.effect }])
        if (!actionable.length) throw new Error('no_actionable_items')
        const outcome = await parts.decisions.prepareDecision({ run_id: input.run_id, artifact_id: input.artifact_id, owner_id: input.owner_id, project_ids: input.project_ids, expires_at: input.expires_at, items: actionable })
        if (outcome.gated) throw new DecisionAuthorityUnavailable()
        return { decision_request_ref: outcome.value.request_id }
      },
    },
  }
}
