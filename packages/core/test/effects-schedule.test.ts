import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { DecisionService, DecisionStore } from '@agenthub/memory'
import { createScheduleEffects, CoreActionExecutor, DecisionAuthorityUnavailable } from '../src/effects/index.js'

const parts = (store: DecisionStore, authority: 'live' | 'unavailable') => ({ deliveries: {} as never, actions: {} as never, decisions: new DecisionService(store, async () => authority) })
const input = { run_id: 'run-1', artifact_id: 'a1', owner_id: 'o', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z', items: [
  { ordinal: 2, kind: 'jira_worklog' as const, project_id: 'p1', summary: 'dos', effect: { n: 2 } }, { ordinal: 1, kind: 'jira_worklog' as const, project_id: 'p1', summary: 'uno', effect: { n: 1 } }] }

describe('ScheduleEffects del core', () => {
  it('prepara la solicitud con los ítems ordenados, es idempotente por run y devuelve una referencia opaca', async () => {
    const store = new DecisionStore(':memory:', { key: randomBytes(32), exclusions: { async add() {} } })
    const effects = createScheduleEffects(parts(store, 'live'))
    const first = await effects.decisions.prepareDecision(input), second = await effects.decisions.prepareDecision(input)
    expect(second).toEqual(first)
    expect(store.publicRequest(first.decision_request_ref).items.map(item => [item.ordinal, item.summary])).toEqual([[1, 'uno'], [2, 'dos']])
  })

  it('los ítems informativos no entran a la solicitud y sin ítems accionables no se prepara', async () => {
    const store = new DecisionStore(':memory:', { key: randomBytes(32), exclusions: { async add() {} } })
    const effects = createScheduleEffects(parts(store, 'live'))
    const { decision_request_ref } = await effects.decisions.prepareDecision({ ...input, items: [...input.items, { ordinal: 3, kind: 'info' as never, project_id: 'p1', summary: 'solo informa', effect: null }] })
    expect(store.publicRequest(decision_request_ref).items).toHaveLength(2)
    await expect(effects.decisions.prepareDecision({ ...input, run_id: 'run-2', items: [{ ordinal: 1, kind: 'info' as never, project_id: 'p1', summary: 'x', effect: null }] })).rejects.toThrow('no_actionable_items')
  })

  it('sin autoridad vigente no prepara nada', async () => {
    const store = new DecisionStore(':memory:', { key: randomBytes(32), exclusions: { async add() {} } })
    await expect(createScheduleEffects(parts(store, 'unavailable')).decisions.prepareDecision(input)).rejects.toBeInstanceOf(DecisionAuthorityUnavailable)
    expect(store.requestsOfRun('run-1')).toEqual([])
  })
})

describe('ScheduleEffects: numeración y apagado', () => {
  async function approved(store: DecisionStore, code: string, requestId: string, line: string) {
    const reserved = await store.reserveDelivery({ request_id: requestId, integration: 'gmail', account: 'me@example.com', correlation: '<h@hub>', provenance: 'test' })
    store.beginSend(reserved.delivery_id)
    await store.recordNative(reserved.delivery_id, { native_id: 'n1', thread_id: 't1' })
    return store.consumeReply({ integration: 'gmail', account: 'me@example.com', native_message_id: 'm1', binding_id: reserved.binding_id, parsed: { kind: 'approve', code, items: line === 'all' ? 'all' : [Number(line)] } })
  }

  it('el número de la solicitud es el del artefacto: con un info en la posición 1, «2» aprueba el segundo ítem del artefacto y el espejo marca ese ordinal', async () => {
    const mirror: Array<Record<string, unknown>> = []
    const store = new DecisionStore(':memory:', { key: randomBytes(32), exclusions: { async add() {} }, publicState: { async set(entry) { mirror.push(entry as never) } } })
    const eff = createScheduleEffects(parts(store, 'live'))
    const { decision_request_ref } = await eff.decisions.prepareDecision({ ...input, items: [
      { ordinal: 1, kind: 'info' as never, project_id: 'p1', summary: 'informa', effect: null },
      { ordinal: 2, kind: 'jira_worklog', project_id: 'p1', summary: 'worklog ABC-1', effect: { issue: 'ABC-1' } },
      { ordinal: 3, kind: 'jira_transition', project_id: 'p1', summary: 'transición ABC-2', effect: { issue: 'ABC-2' } }] })
    expect(store.publicRequest(decision_request_ref).items.map(item => [item.ordinal, item.summary])).toEqual([[2, 'worklog ABC-1'], [3, 'transición ABC-2']])
    const outcome = await approved(store, store.codeFor(decision_request_ref).replace(/-/g, ''), decision_request_ref, '2')
    expect(outcome).toMatchObject({ outcome: 'approved', approved: [{ ordinal: 2 }] })
    const intent = store.intent(outcome.approved![0]!.intent_id)!
    expect(intent.kind).toBe('jira_worklog')
    expect(JSON.parse(intent.effect)).toEqual({ issue: 'ABC-1' })
    await store.flushMirror()
    expect(mirror.filter(entry => entry['state'] === 'approved').map(entry => entry['ordinal'])).toEqual([2])
    const footer = store.publicRequest(decision_request_ref).items.filter(item => item.state === 'pending').map(item => item.ordinal)
    expect(footer).toEqual([3])
  })

  it('el almacén rechaza números repetidos, cero o mezclados con ítems sin número', () => {
    const store = new DecisionStore(':memory:', { key: randomBytes(32), exclusions: { async add() {} } })
    const base = { run_id: 'r', artifact_id: 'a', owner_id: 'o', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z' }
    const item = (ordinal?: number) => ({ ...(ordinal === undefined ? {} : { ordinal }), kind: 'jira_worklog' as const, project_id: 'p1', summary: 's', exact_effect: { n: ordinal ?? 0 } })
    expect(() => store.prepareDecision({ ...base, items: [item(2), item(2)] })).toThrow(/invalid_ordinals|enteros únicos/)
    expect(() => store.prepareDecision({ ...base, items: [item(0)] })).toThrow()
    expect(() => store.prepareDecision({ ...base, items: [item(1), item()] })).toThrow()
    expect(() => store.prepareDecision({ ...base, items: [item(1.5)] })).toThrow()
    expect(store.publicRequest(store.prepareDecision({ ...base, items: [item(), item()] }).request_id).items.map(entry => entry.ordinal)).toEqual([1, 2])
  })

  it('apagar las automatizaciones revoca la solicitud viva: el efecto reclamado no se despacha', async () => {
    const store = new DecisionStore(':memory:', { key: randomBytes(32), exclusions: { async add() {} } })
    const service = new DecisionService(store, async () => 'live')
    const eff = createScheduleEffects({ deliveries: {} as never, actions: {} as never, decisions: service })
    const { decision_request_ref } = await eff.decisions.prepareDecision(input)
    const outcome = await approved(store, store.codeFor(decision_request_ref).replace(/-/g, ''), decision_request_ref, '1')
    const intentId = outcome.approved![0]!.intent_id
    let executed = 0
    const executor = new CoreActionExecutor({ decisions: service, automationsEnabled: () => true, tools: { candidates: () => ['srv'], forServer: () => ({ server_id: 'srv', enabled: () => true, call: async () => ({ is_error: false, content: [] }) }) },
      adapters: [{ kind: 'jira_worklog', tools: ['t'], effect: { parse: raw => raw }, prepare: async () => { await (eff.decisions as { revokeAll(): Promise<number> }).revokeAll(); return {} }, execute: async () => { executed++; return { state: 'succeeded' } }, reconcile: async () => null }] })
    expect(await executor.executeApprovedAction({ intent_id: intentId, expected_generation: 0 })).toMatchObject({ state: 'rejected_before_dispatch', error_code: 'revoked' })
    expect(executed).toBe(0)
  })

  it('los errores del ensamblado llevan un código estable', async () => {
    const store = new DecisionStore(':memory:', { key: randomBytes(32), exclusions: { async add() {} } })
    const none = await createScheduleEffects(parts(store, 'live')).decisions.prepareDecision({ ...input, run_id: 'r9', items: [{ ordinal: 1, kind: 'info' as never, project_id: 'p1', summary: 'x', effect: null }] }).catch(error => error)
    expect(none).toMatchObject({ code: 'no_actionable_items' })
    const gated = await createScheduleEffects(parts(store, 'unavailable')).decisions.prepareDecision(input).catch(error => error)
    expect(gated).toMatchObject({ code: 'authority_unavailable', name: 'DecisionAuthorityUnavailable' })
    expect(none).toMatchObject({ name: 'NoActionableItems' })
    expect(new DecisionAuthorityUnavailable().code).toBe('authority_unavailable')
  })
})

describe('ScheduleEffects: identidad semántica de la operación', () => {
  it('el operation_key del ítem llega al almacén: un segundo cierre del mismo día con otros segundos queda bloqueado por duplicado', async () => {
    const store = new DecisionStore(':memory:', { key: randomBytes(32), exclusions: { async add() {} } })
    const eff = createScheduleEffects(parts(store, 'live'))
    const key = 'jira_worklog:site:ABC-1:2026-10-28T08:00:00Z'
    const request = (run: string, seconds: number) => eff.decisions.prepareDecision({ run_id: run, artifact_id: `a-${run}`, owner_id: 'o', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z',
      items: [{ ordinal: 1, kind: 'jira_worklog', project_id: 'p1', summary: 'cierre', effect: { issue: 'ABC-1', seconds }, operation_key: key }] }).then(async ({ decision_request_ref }) => {
      const reserved = await store.reserveDelivery({ request_id: decision_request_ref, integration: 'gmail', account: 'me@example.com', correlation: `<${run}@hub>`, provenance: 'test' })
      store.beginSend(reserved.delivery_id)
      await store.recordNative(reserved.delivery_id, { native_id: `n-${run}`, thread_id: `t-${run}` })
      return store.consumeReply({ integration: 'gmail', account: 'me@example.com', native_message_id: `m-${run}`, binding_id: reserved.binding_id,
        parsed: { kind: 'approve', code: store.codeFor(decision_request_ref).replace(/-/g, ''), items: 'all' } })
    })
    expect(await request('run-1', 1800)).toMatchObject({ outcome: 'approved', approved: [{ ordinal: 1 }] })
    const second = await request('run-2', 3600)
    expect(second.approved ?? []).toEqual([])
    expect(second.blocked_uncertain).toEqual([1])
  })

  it('sin operation_key el almacén usa el digest del efecto, como antes', async () => {
    const store = new DecisionStore(':memory:', { key: randomBytes(32), exclusions: { async add() {} } })
    const eff = createScheduleEffects(parts(store, 'live'))
    const { decision_request_ref } = await eff.decisions.prepareDecision(input)
    const items = store.getApprovedItems(decision_request_ref)
    expect(items).toEqual([])
    expect(store.publicRequest(decision_request_ref).items).toHaveLength(2)
  })
})
