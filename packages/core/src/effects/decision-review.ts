import { DecisionReviewError, type ConsumeResult, type DecisionItemView, type DecisionMutation, type DecisionReview, type DecisionService, type DecisionStore, type DecisionView } from '@agenthub/memory'

const WORKLOG = 'jira_worklog'
const STEP_SECONDS = 1800

export interface DecisionReviewDeps {
  store: DecisionStore
  service: DecisionService
  /** El artefacto pasa a apuntar a la solicitud corregida; `false` si ya no apuntaba a la anterior. */
  schedules: { replaceDecisionRef(runId: string, oldRef: string, newRef: string): Promise<boolean> }
}

const REFUSALS: Partial<Record<ConsumeResult['outcome'], string>> = {
  expired: 'expired', revoked: 'revoked', superseded: 'superseded', locked: 'locked', digest_mismatch: 'digest_mismatch',
  bad_selection: 'bad_selection', no_open_request: 'bad_selection',
}

/**
 * Operaciones del dueño desde la app sobre la solicitud más reciente de un run. Nada de lo que devuelve incluye el código de aprobación ni una línea de
 * respuesta; la autoridad es el digest exacto de lo mostrado. Cada operación pasa por la compuerta de autoridad del artefacto.
 */
export function createDecisionReview(deps: DecisionReviewDeps): DecisionReview {
  const { store, service } = deps
  const latest = (runId: string) => store.requestsOfRun(runId)[0]
  const items = (request: { items: DecisionItemView[] }): DecisionItemView[] => request.items.map(item => ({ ordinal: item.ordinal, kind: item.kind, summary: item.summary, state: item.state, effect_digest: item.effect_digest }))
  const mutation = (requestId: string, extra: Partial<DecisionMutation> = {}): DecisionMutation => {
    const request = store.publicRequest(requestId)
    return { request_id: request.request_id, revision: request.revision, state: request.state, expires_at: request.expires_at, digest: request.canonical_digest, items: items(request), ...extra }
  }
  const require = (runId: string) => {
    const request = latest(runId)
    if (!request) throw new DecisionReviewError(404, 'no_decision')
    return request
  }

  return {
    async view(runId) {
      const request = latest(runId)
      if (!request) return null
      const view: DecisionView = { request_id: request.request_id, revision: request.revision, state: request.state, expires_at: request.expires_at, digest: request.canonical_digest,
        authority: (await service.live(request.request_id)) ? 'verified' : 'authority_unavailable', items: items(request) }
      return view
    },

    async decide(runId, input) {
      const request = require(runId)
      const outcome = await service.processOwner(request.request_id, input)
      if (outcome.gated) throw new DecisionReviewError(409, 'authority_unavailable')
      const result = outcome.value
      if (result.outcome !== 'approved' && result.outcome !== 'rejected') throw new DecisionReviewError(409, REFUSALS[result.outcome] ?? 'bad_selection')
      return mutation(request.request_id, {
        ...(result.approved ? { approved: result.approved.map(item => item.ordinal) } : {}),
        ...(result.rejected ? { rejected: result.rejected } : {}),
        ...(result.blocked_uncertain ? { blocked_uncertain: result.blocked_uncertain } : {}),
      })
    },

    async revise(runId, input) {
      const request = require(runId)
      if (!Number.isInteger(input.seconds) || input.seconds < STEP_SECONDS || input.seconds % STEP_SECONDS !== 0) throw new DecisionReviewError(400, 'bad_value')
      if (!(await service.live(request.request_id))) throw new DecisionReviewError(409, 'authority_unavailable')
      const item = store.itemEffect(request.request_id, input.ordinal)
      const effect = item?.effect as Record<string, unknown> | undefined
      if (!item || item.kind !== WORKLOG || item.state !== 'pending' || !effect || typeof effect !== 'object' || typeof effect['seconds'] !== 'number') throw new DecisionReviewError(409, 'not_revisable')
      let revised: { request_id: string; revision: number }
      try { revised = store.reviseRequest(request.request_id, input.ordinal, { ...effect, seconds: input.seconds }) } catch (error) {
        const code = (error as { code?: string }).code
        throw new DecisionReviewError(409, code === 'request_not_open' ? 'locked' : 'not_revisable')
      }
      if (!(await deps.schedules.replaceDecisionRef(runId, request.request_id, revised.request_id))) throw new DecisionReviewError(409, 'authority_unavailable')
      return mutation(revised.request_id)
    },

    async repropose() { throw new DecisionReviewError(501, 'not_reproposable') },
  }
}
