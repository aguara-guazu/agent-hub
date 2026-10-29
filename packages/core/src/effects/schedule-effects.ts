import type { DecisionService, ScheduleEffects, ActionExecutor, DeliveryAdapters } from '@agenthub/memory'

/** La autoridad del artefacto no está vigente: la solicitud de decisión no se prepara. `code` es estable para que el runtime lo compare. */
export class DecisionAuthorityUnavailable extends Error {
  readonly code = 'authority_unavailable'
  constructor() { super('authority_unavailable'); this.name = 'DecisionAuthorityUnavailable' }
}

/** El artefacto solo trae ítems informativos: no hay nada que aprobar. */
export class NoActionableItems extends Error {
  readonly code = 'no_actionable_items'
  constructor() { super('no_actionable_items'); this.name = 'NoActionableItems' }
}

/**
 * Arma el objeto que el core entrega a `registerMemory`. `prepareDecision` ordena los ítems por su número, los pasa al servicio con la compuerta de autoridad
 * (con `ownerId`, la solicitud queda a nombre del dueño real del hub aunque el runtime envíe su valor por defecto; los de tipo `info` no se aprueban y se omiten, y el resto conserva su número del artefacto) y devuelve la referencia opaca de la solicitud; es idempotente por run.
 */
export function createScheduleEffects(parts: { deliveries: DeliveryAdapters; actions: ActionExecutor; decisions: DecisionService; ownerId?: string }): ScheduleEffects {
  const decisions: ScheduleEffects['decisions'] & { revokeAll(): Promise<number> } = {
      /** El número de cada ítem es el del artefacto: la persona responde por ese número y los `info` simplemente no figuran. */
      async prepareDecision(input) {
        const actionable = [...input.items].sort((a, b) => a.ordinal - b.ordinal).flatMap(item => item.kind === 'info' ? [] : [{ ordinal: item.ordinal, kind: item.kind, project_id: item.project_id, summary: item.summary, exact_effect: item.effect }])
        if (!actionable.length) throw new NoActionableItems()
        const outcome = await parts.decisions.prepareDecision({ run_id: input.run_id, artifact_id: input.artifact_id, owner_id: parts.ownerId ?? input.owner_id, project_ids: input.project_ids, expires_at: input.expires_at, items: actionable })
        if (outcome.gated) throw new DecisionAuthorityUnavailable()
        return { decision_request_ref: outcome.value.request_id }
      },
      /** Apagar las automatizaciones revoca toda solicitud viva: el gate atómico de `markDispatching` lo ve aunque un efecto ya estuviera reclamado. */
      async revokeAll() { return parts.decisions.store.revokeAll() },
  }
  return { deliveries: parts.deliveries, actions: parts.actions, decisions }
}
