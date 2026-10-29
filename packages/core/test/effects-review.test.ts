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

  it('si el artefacto ya no apunta a la solicitud anterior, corregir falla cerrado', async () => {
    open()
    const stale = createDecisionReview({ store, service: new DecisionService(store, async () => 'live'), schedules: { replaceDecisionRef: async () => false } })
    expect(await refusal(stale.revise('run-1', { ordinal: 2, seconds: 3600 }))).toMatchObject({ code: 'authority_unavailable' })
  })
})
