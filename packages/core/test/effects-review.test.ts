import { beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { DecisionReviewError, DecisionService, DecisionStore, type DecisionReview } from '@agenthub/memory'
import { createDecisionReview } from '../src/effects/decision-review.js'

const effect = (issue: string, seconds = 1800) => ({ cloud: 'site', issue_key: issue, seconds })
let store: DecisionStore, authority: 'live' | 'unavailable', refs: Array<[string, string, string]>, review: DecisionReview, clock: Date

const open = (run = 'run-1') => store.prepareDecision({ run_id: run, artifact_id: `a-${run}`, owner_id: 'o', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z', items: [
  { ordinal: 2, kind: 'jira_worklog', project_id: 'p1', summary: 'worklog ABC-1', exact_effect: effect('ABC-1') },
  { ordinal: 3, kind: 'jira_transition', project_id: 'p1', summary: 'transición ABC-2', exact_effect: { issue_key: 'ABC-2', to: 'Done' } }] })
const refusal = async (work: Promise<unknown>) => work.then(() => null, error => error as DecisionReviewError)

beforeEach(() => {
  authority = 'live'; refs = []; clock = new Date('2026-10-29T10:00:00.000Z')
  store = new DecisionStore(':memory:', { key: randomBytes(32), now: () => clock, exclusions: { async add() {} } })
  review = createDecisionReview({ store, service: new DecisionService(store, async () => authority), schedules: { replaceDecisionRef: async (run, oldRef, newRef) => { refs.push([run, oldRef, newRef]); return true } } })
})

describe('revisión del dueño desde la app', () => {
  it('sin solicitud no hay vista y las operaciones dan 404', async () => {
    expect(await review.view('run-x')).toBeNull()
    expect(await refusal(review.decide('run-x', { kind: 'reject', ordinals: [1] }))).toMatchObject({ status: 404, code: 'no_decision' })
  })

  it('la vista trae el digest y la autoridad, sin código ni línea de respuesta', async () => {
    const { request_id } = open()
    const view = await review.view('run-1')
    expect(view).toMatchObject({ request_id, state: 'open', authority: 'verified', digest: store.publicRequest(request_id).canonical_digest })
    expect(view!.items.map(item => item.ordinal)).toEqual([2, 3])
    expect(JSON.stringify(view)).not.toContain(store.codeFor(request_id))
    authority = 'unavailable'
    expect((await review.view('run-1'))!.authority).toBe('authority_unavailable')
  })

  it('aprobar con el digest exacto crea la intención del ítem elegido y el número es el del artefacto', async () => {
    const { request_id } = open()
    const digest = (await review.view('run-1'))!.digest
    const result = await review.decide('run-1', { kind: 'approve', ordinals: [2], digest })
    expect(result).toMatchObject({ approved: [2], items: [{ ordinal: 2, state: 'approved' }, { ordinal: 3, state: 'pending' }] })
    expect(store.getApprovedItems(request_id).map(item => [item.ordinal, item.kind])).toEqual([[2, 'jira_worklog']])
    expect(JSON.stringify(result)).not.toContain(store.codeFor(request_id))
  })

  it('un digest distinto, un ítem inexistente o ya decidido se rechazan sin crear nada', async () => {
    const { request_id } = open()
    const digest = (await review.view('run-1'))!.digest
    expect(await refusal(review.decide('run-1', { kind: 'approve', ordinals: [2], digest: 'f'.repeat(64) }))).toMatchObject({ status: 409, code: 'digest_mismatch' })
    expect(await refusal(review.decide('run-1', { kind: 'approve', ordinals: [1], digest }))).toMatchObject({ code: 'bad_selection' })
    await review.decide('run-1', { kind: 'approve', ordinals: [2], digest })
    expect(await refusal(review.decide('run-1', { kind: 'approve', ordinals: [2], digest }))).toMatchObject({ code: 'bad_selection' })
    expect(store.getApprovedItems(request_id)).toHaveLength(1)
  })

  it('rechazar no exige digest y cierra la solicitud cuando no queda nada pendiente', async () => {
    const { request_id } = open()
    expect(await review.decide('run-1', { kind: 'reject', ordinals: [2, 3] })).toMatchObject({ rejected: [2, 3], state: 'closed' })
    expect(store.getApprovedItems(request_id)).toEqual([])
  })

  it('vencida, revocada o sin autoridad: 409 con código cerrado y sin intención', async () => {
    const { request_id } = open()
    const digest = (await review.view('run-1'))!.digest
    authority = 'unavailable'
    expect(await refusal(review.decide('run-1', { kind: 'approve', ordinals: [2], digest }))).toMatchObject({ code: 'authority_unavailable' })
    authority = 'live'
    store.revokeRequest(request_id)
    expect(await refusal(review.decide('run-1', { kind: 'approve', ordinals: [2], digest }))).toMatchObject({ code: 'revoked' })
    const second = open('run-2')
    const secondDigest = (await review.view('run-2'))!.digest
    clock = new Date('2099-06-01T00:00:00.000Z')
    expect(await refusal(review.decide('run-2', { kind: 'approve', ordinals: [2], digest: secondDigest }))).toMatchObject({ code: 'expired' })
    expect(store.getApprovedItems(second.request_id)).toEqual([])
  })

  it('un ítem cuya operación sigue viva o incierta vuelve como blocked_uncertain, no como error', async () => {
    store.prepareDecision({ run_id: 'run-a', artifact_id: 'a', owner_id: 'o', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z', items: [{ ordinal: 1, kind: 'jira_worklog', project_id: 'p1', summary: 's', exact_effect: effect('ABC-1'), operation_key: 'k' }] })
    const first = (await review.view('run-a'))!
    await review.decide('run-a', { kind: 'approve', ordinals: [1], digest: first.digest })
    store.prepareDecision({ run_id: 'run-b', artifact_id: 'b', owner_id: 'o', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z', items: [{ ordinal: 1, kind: 'jira_worklog', project_id: 'p1', summary: 's', exact_effect: effect('ABC-1', 3600), operation_key: 'k' }] })
    const second = (await review.view('run-b'))!
    const result = await review.decide('run-b', { kind: 'approve', ordinals: [1], digest: second.digest })
    expect(result).toMatchObject({ blocked_uncertain: [1], items: [{ ordinal: 1, state: 'blocked_uncertain' }] })
    expect(result.approved ?? []).toEqual([])
  })

  it('corregir un worklog crea una solicitud nueva con el digest nuevo, anula la anterior y reapunta el artefacto', async () => {
    const { request_id } = open()
    const oldDigest = (await review.view('run-1'))!.digest
    const revised = await review.revise('run-1', { ordinal: 2, seconds: 5400 })
    expect(revised.request_id).not.toBe(request_id)
    expect(revised.digest).not.toBe(oldDigest)
    expect(revised.revision).toBe(2)
    expect(refs).toEqual([['run-1', request_id, revised.request_id]])
    expect(store.publicRequest(request_id).state).toBe('superseded')
    expect(store.itemEffect(revised.request_id, 2)!.effect).toMatchObject({ seconds: 5400, issue_key: 'ABC-1' })
    expect(await refusal(review.decide('run-1', { kind: 'approve', ordinals: [2], digest: oldDigest }))).toMatchObject({ code: 'digest_mismatch' })
    expect((await review.view('run-1'))!.request_id).toBe(revised.request_id)
  })

  it('solo se corrigen worklogs pendientes con segundos válidos', async () => {
    open()
    expect(await refusal(review.revise('run-1', { ordinal: 3, seconds: 3600 }))).toMatchObject({ code: 'not_revisable' })
    expect(await refusal(review.revise('run-1', { ordinal: 9, seconds: 3600 }))).toMatchObject({ code: 'not_revisable' })
    for (const seconds of [0, 1799, 2700]) expect(await refusal(review.revise('run-1', { ordinal: 2, seconds }))).toMatchObject({ status: 400, code: 'bad_value' })
    const digest = (await review.view('run-1'))!.digest
    await review.decide('run-1', { kind: 'approve', ordinals: [2], digest })
    expect(await refusal(review.revise('run-1', { ordinal: 2, seconds: 3600 }))).toMatchObject({ code: 'not_revisable' })
    authority = 'unavailable'
    expect(await refusal(review.revise('run-1', { ordinal: 2, seconds: 3600 }))).toMatchObject({ code: 'authority_unavailable' })
  })

  it('con un artefacto desalineado, corregir falla ANTES de tocar el almacén y la solicitud original sigue abierta', async () => {
    const { request_id } = open()
    const reads: Array<{ run_id: string; decision_request_ref?: string }> = []
    const service = new DecisionService(store, async query => { reads.push(query); return query.decision_request_ref === 'otra-referencia' ? 'live' : 'unknown' })
    const misaligned = createDecisionReview({ store, service, schedules: { replaceDecisionRef: async () => { throw new Error('no debe llamarse') } } })
    expect(await refusal(misaligned.revise('run-1', { ordinal: 2, seconds: 3600 }))).toMatchObject({ status: 409, code: 'authority_unavailable' })
    expect(reads.at(-1)).toEqual({ run_id: 'run-1', decision_request_ref: request_id })
    expect(store.publicRequest(request_id).state).toBe('open')
    expect(store.requestsOfRun('run-1')).toHaveLength(1)
  })
})

describe('reproponer y reintentar entregas', () => {
  const expire = () => { clock = new Date('2099-06-01T00:00:00.000Z'); store.expireDue() }

  it('reproponer una solicitud vencida crea una nueva con código propio, reapunta el artefacto y anula la anterior', async () => {
    const { request_id } = open()
    const oldCode = store.codeFor(request_id)
    expire()
    expect(store.publicRequest(request_id).state).toBe('expired')
    const proposed = await review.repropose('run-1')
    expect(proposed.request_id).not.toBe(request_id)
    expect(proposed).toMatchObject({ revision: 2, state: 'open' })
    expect(proposed.items.map(item => [item.ordinal, item.state])).toEqual([[2, 'pending'], [3, 'pending']])
    expect(store.codeFor(proposed.request_id)).not.toBe(oldCode)
    expect(store.publicRequest(request_id).state).toBe('superseded')
    expect(refs).toEqual([['run-1', request_id, proposed.request_id]])
    expect(Date.parse(proposed.expires_at)).toBeGreaterThan(clock.getTime())
  })

  it('una solicitud abierta o sin ítems elegibles no se repropone', async () => {
    const { request_id } = open()
    expect(await refusal(review.repropose('run-1'))).toMatchObject({ status: 409, code: 'not_reproposable' })
    store.revokeRequest(request_id)
    expect(await refusal(review.repropose('run-1'))).toMatchObject({ code: 'not_reproposable' })
  })

  it('un ítem con intención (aprobado o incierto) nunca se vuelve a proponer; solo los vencidos sin despachar', async () => {
    const { request_id } = open()
    const digest = (await review.view('run-1'))!.digest
    await review.decide('run-1', { kind: 'approve', ordinals: [2], digest })
    const intentId = store.pendingIntents()[0]!.intent_id
    const claim = store.claimIntent(intentId, 0) as { generation: number }
    expect(store.markDispatching(intentId, claim.generation)).toBe('ok')
    store.completeIntent(intentId, claim.generation, { state: 'uncertain', error_code: 'timeout' })
    expire()
    const proposed = await review.repropose('run-1')
    expect(proposed.items.map(item => item.ordinal)).toEqual([3])
    expect(store.getApprovedItems(request_id)[0]).toMatchObject({ ordinal: 2, state: 'uncertain' })
  })

  it('un ítem cuya operación sigue incierta en otra solicitud queda fuera', async () => {
    store.prepareDecision({ run_id: 'run-a', artifact_id: 'a', owner_id: 'o', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z', items: [{ ordinal: 1, kind: 'jira_worklog', project_id: 'p1', summary: 's', exact_effect: effect('ABC-1'), operation_key: 'k' }] })
    await review.decide('run-a', { kind: 'approve', ordinals: [1], digest: (await review.view('run-a'))!.digest })
    const uncertain = store.pendingIntents()[0]!
    const claim = store.claimIntent(uncertain.intent_id, 0) as { generation: number }
    store.markDispatching(uncertain.intent_id, claim.generation)
    store.completeIntent(uncertain.intent_id, claim.generation, { state: 'uncertain', error_code: 'timeout' })
    store.prepareDecision({ run_id: 'run-b', artifact_id: 'b', owner_id: 'o', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z', items: [{ ordinal: 1, kind: 'jira_worklog', project_id: 'p1', summary: 's', exact_effect: effect('ABC-1', 3600), operation_key: 'k' }] })
    clock = new Date('2099-06-01T00:00:00.000Z'); store.expireDue()
    expect(await refusal(review.repropose('run-b'))).toMatchObject({ code: 'not_reproposable' })
  })

  it('sin autoridad vigente no se repropone', async () => {
    open(); expire(); authority = 'unavailable'
    expect(await refusal(review.repropose('run-1'))).toMatchObject({ code: 'authority_unavailable' })
  })

  it('cerrar una entrega incierta permite reservar otra; una enviada o en otra integración no se toca', async () => {
    const { request_id } = open()
    const reserve = (integration: 'gmail' | 'slack', correlation: string) => store.reserveDelivery({ request_id, integration, account: 'me', correlation, provenance: 'test' })
    const gmail = await reserve('gmail', '<g1@hub>')
    store.beginSend(gmail.delivery_id); store.markDeliveryUncertain(gmail.delivery_id)
    const slack = await reserve('slack', 's1')
    store.beginSend(slack.delivery_id); await store.recordNative(slack.delivery_id, { native_id: '1.1', delivery_ref: '1.1' })
    await expect(reserve('gmail', '<g2@hub>')).rejects.toThrow(/delivery_already_dispatched/)
    expect(await review.releaseDelivery('run-1', 'gmail')).toBe(1)
    expect((await reserve('gmail', '<g2@hub>')).delivery_id).not.toBe(gmail.delivery_id)
    expect(await review.releaseDelivery('run-1', 'slack')).toBe(0)
    expect(store.bindingsOf(request_id).find(binding => binding.integration === 'slack')).toMatchObject({ state: 'active', delivery_state: 'sent' })
    expect(await review.releaseDelivery('run-sin-solicitud', 'gmail')).toBe(0)
  })
})
