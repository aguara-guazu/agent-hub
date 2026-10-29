import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { DecisionService, DecisionStore } from '@agenthub/memory'
import { createScheduleEffects, DecisionAuthorityUnavailable } from '../src/effects/index.js'

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
