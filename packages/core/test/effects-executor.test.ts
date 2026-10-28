import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { DecisionService, DecisionStore } from '@agenthub/memory'
import { CoreActionExecutor, EffectRejected, type ActionAdapter } from '../src/effects/executor.js'
import type { EffectTools } from '../src/effects/tools.js'

const key = randomBytes(32)
const OWNER = 'owner-1'
let clock = new Date('2026-10-28T20:00:00.000Z')
const effect = { cloud: 'site', issue_key: 'ABC-1', seconds: 1800 }

let store: DecisionStore
let authority: 'live' | 'unavailable' | 'unknown'
let automations: boolean
let enabledTools: Set<string>
let toolTraces: Array<{ runId?: string; intentId: string; callId: string }>

const tools: EffectTools = { enabled: name => enabledTools.has(name), call: async () => ({ is_error: false, content: [] }) }

function adapter(over: Partial<ActionAdapter<typeof effect>> = {}): ActionAdapter<typeof effect> & { calls: { prepare: number; execute: number } } {
  const calls = { prepare: 0, execute: 0 }
  return {
    kind: 'jira_worklog', tools: ['addWorklogToJiraIssue'],
    effect: { parse: raw => { const value = raw as typeof effect; if (typeof value?.issue_key !== 'string') throw new Error('invalid'); return value } },
    prepare: async () => { calls.prepare++; return { guard: 'ok' } },
    execute: async () => { calls.execute++; return { state: 'succeeded', remote_ref: 'wl-1', result_digest: 'd1' } },
    reconcile: async () => null,
    ...over, calls,
  } as ActionAdapter<typeof effect> & { calls: { prepare: number; execute: number } }
}

function executor(...adapters: ActionAdapter<any>[]) {
  const decisions = new DecisionService(store, async () => authority)
  return new CoreActionExecutor({ decisions, adapters, automationsEnabled: () => automations, toolsFor: trace => { toolTraces.push(trace); return tools } })
}

async function approvedIntent() {
  const prepared = store.prepareDecision({ run_id: 'run-1', artifact_id: 'art-1', owner_id: OWNER, project_ids: ['p1'], expires_at: new Date(clock.getTime() + 3600_000).toISOString(),
    items: [{ kind: 'jira_worklog', project_id: 'p1', summary: 'item 1', exact_effect: effect }] })
  const reserved = await store.reserveDelivery({ request_id: prepared.request_id, integration: 'gmail', account: 'me@example.com', correlation: '<h@hub>', provenance: 'test' })
  store.beginSend(reserved.delivery_id)
  await store.recordNative(reserved.delivery_id, { native_id: 'n1', thread_id: 't1' })
  const consumed = store.consumeReply({ integration: 'gmail', account: 'me@example.com', native_message_id: 'm1', binding_id: reserved.binding_id,
    parsed: { kind: 'approve', code: store.codeFor(prepared.request_id).replace(/-/g, ''), items: 'all' } })
  if (consumed.outcome !== 'approved') throw new Error(`no aprobado: ${consumed.outcome}`)
  return { requestId: prepared.request_id, intentId: consumed.approved![0]!.intent_id }
}

beforeEach(() => {
  clock = new Date('2026-10-28T20:00:00.000Z')
  authority = 'live'; automations = true; enabledTools = new Set(['addWorklogToJiraIssue']); toolTraces = []
  store = new DecisionStore(':memory:', { key, now: () => clock, exclusions: { async add() {} } })
})
afterEach(() => store.close())

describe('ejecutor del core', () => {
  it('ejecuta el efecto aprobado una sola vez y deja el recibo en el almacén', async () => {
    const { intentId } = await approvedIntent()
    const wl = adapter()
    const receipt = await executor(wl).executeApprovedAction({ intent_id: intentId, expected_generation: 0 })
    expect(receipt).toEqual({ intent_id: intentId, state: 'succeeded', remote_ref: 'wl-1', result_digest: 'd1' })
    expect(wl.calls).toEqual({ prepare: 1, execute: 1 })
    expect(store.intent(intentId)).toMatchObject({ state: 'succeeded', remote_ref: 'wl-1' })
    expect(toolTraces[0]).toMatchObject({ runId: 'run-1', intentId })
  })

  it('con las automatizaciones apagadas no despacha ni toca la intención', async () => {
    const { intentId } = await approvedIntent()
    automations = false
    const wl = adapter()
    expect(await executor(wl).executeApprovedAction({ intent_id: intentId, expected_generation: 0 })).toMatchObject({ state: 'rejected_before_dispatch', error_code: 'automations_off' })
    expect(wl.calls).toEqual({ prepare: 0, execute: 0 })
    expect(store.intent(intentId)).toMatchObject({ state: 'pending', generation: 0 })
  })

  it('sin autoridad vigente del artefacto no reclama la intención', async () => {
    const { intentId } = await approvedIntent()
    authority = 'unavailable'
    const wl = adapter()
    expect(await executor(wl).executeApprovedAction({ intent_id: intentId, expected_generation: 0 })).toMatchObject({ state: 'rejected_before_dispatch', error_code: 'authority_unavailable' })
    expect(wl.calls.execute).toBe(0)
    expect(store.intent(intentId)).toMatchObject({ state: 'pending', generation: 0 })
  })

  it('una generación vieja no avanza', async () => {
    const { intentId } = await approvedIntent()
    const wl = adapter()
    expect(await executor(wl).executeApprovedAction({ intent_id: intentId, expected_generation: 7 })).toMatchObject({ error_code: 'stale_generation' })
    expect(wl.calls.execute).toBe(0)
  })

  it('una herramienta apagada para la identidad de servicio se rechaza antes del dispatch', async () => {
    const { intentId } = await approvedIntent()
    enabledTools = new Set()
    const wl = adapter()
    expect(await executor(wl).executeApprovedAction({ intent_id: intentId, expected_generation: 0 })).toMatchObject({ state: 'rejected_before_dispatch', error_code: 'tool_off' })
    expect(wl.calls).toEqual({ prepare: 0, execute: 0 })
    expect(store.intent(intentId)).toMatchObject({ state: 'rejected_before_dispatch', error_code: 'tool_off' })
  })

  it('un guard del adaptador rechaza sin ejecutar y conserva su código', async () => {
    const { intentId } = await approvedIntent()
    const wl = adapter({ prepare: async () => { throw new EffectRejected('assignee_mismatch') } })
    expect(await executor(wl).executeApprovedAction({ intent_id: intentId, expected_generation: 0 })).toMatchObject({ state: 'rejected_before_dispatch', error_code: 'assignee_mismatch' })
    expect(store.intent(intentId)).toMatchObject({ state: 'rejected_before_dispatch', error_code: 'assignee_mismatch' })
  })

  it('un fallo inesperado en prepare tampoco despacha', async () => {
    const { intentId } = await approvedIntent()
    const wl = adapter({ prepare: async () => { throw new Error('boom') } })
    expect(await executor(wl).executeApprovedAction({ intent_id: intentId, expected_generation: 0 })).toMatchObject({ error_code: 'prepare_failed' })
    expect(wl.calls.execute).toBe(0)
  })

  it('un efecto que no cumple el esquema se rechaza', async () => {
    const { intentId } = await approvedIntent()
    const wl = adapter({ effect: { parse: () => { throw new Error('schema') } } })
    expect(await executor(wl).executeApprovedAction({ intent_id: intentId, expected_generation: 0 })).toMatchObject({ error_code: 'invalid_effect' })
  })

  it('un tipo sin adaptador en la lista cerrada no se ejecuta', async () => {
    const { intentId } = await approvedIntent()
    expect(await executor(adapter({ kind: 'git_push' })).executeApprovedAction({ intent_id: intentId, expected_generation: 0 })).toMatchObject({ error_code: 'adapter_not_allowed' })
    expect(store.intent(intentId)).toMatchObject({ state: 'rejected_before_dispatch' })
  })

  it('una excepción en execute deja la intención incierta y no se reintenta', async () => {
    const { intentId } = await approvedIntent()
    const execute = vi.fn(async () => { throw new Error('timeout') })
    const run = executor(adapter({ execute }))
    expect(await run.executeApprovedAction({ intent_id: intentId, expected_generation: 0 })).toMatchObject({ state: 'uncertain', error_code: 'execute_failed' })
    expect(store.intent(intentId)).toMatchObject({ state: 'uncertain' })
    const generation = store.intent(intentId)!.generation
    expect(await run.executeApprovedAction({ intent_id: intentId, expected_generation: generation })).toMatchObject({ state: 'rejected_before_dispatch', error_code: 'state_uncertain' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('un rechazo comprobado en execute se registra como no enviado', async () => {
    const { intentId } = await approvedIntent()
    const wl = adapter({ execute: async () => ({ state: 'rejected_before_dispatch', error_code: 'not_fast_forward' }) })
    expect(await executor(wl).executeApprovedAction({ intent_id: intentId, expected_generation: 0 })).toMatchObject({ state: 'rejected_before_dispatch', error_code: 'not_fast_forward' })
    expect(store.intent(intentId)).toMatchObject({ state: 'rejected_before_dispatch' })
  })

  it('revocar mientras el adaptador prepara impide el dispatch', async () => {
    const { intentId, requestId } = await approvedIntent()
    const wl = adapter({ prepare: async () => { store.revokeRequest(requestId); return {} } })
    const receipt = await executor(wl).executeApprovedAction({ intent_id: intentId, expected_generation: 0 })
    expect(receipt).toMatchObject({ state: 'rejected_before_dispatch', error_code: 'revoked' })
    expect(wl.calls.execute).toBe(0)
  })

  it('dos ejecuciones concurrentes con la misma generación efectúan una sola vez', async () => {
    const { intentId } = await approvedIntent()
    const wl = adapter()
    const run = executor(wl)
    const [first, second] = await Promise.all([run.executeApprovedAction({ intent_id: intentId, expected_generation: 0 }), run.executeApprovedAction({ intent_id: intentId, expected_generation: 0 })])
    expect([first.state, second.state].sort()).toEqual(['rejected_before_dispatch', 'succeeded'])
    expect(wl.calls.execute).toBe(1)
  })

  it('reconcile es de solo lectura y sin prueba concluyente queda incierto', async () => {
    const { intentId } = await approvedIntent()
    const wl = adapter({ execute: async () => { throw new Error('timeout') } })
    const run = executor(wl)
    await run.executeApprovedAction({ intent_id: intentId, expected_generation: 0 })
    expect(await run.reconcile(intentId)).toMatchObject({ state: 'uncertain', error_code: 'no_conclusive_evidence' })
    const proven = executor(adapter({ reconcile: async () => ({ state: 'succeeded', remote_ref: 'wl-9' }) }))
    expect(await proven.reconcile(intentId)).toMatchObject({ state: 'succeeded', remote_ref: 'wl-9' })
    expect(store.intent(intentId)).toMatchObject({ state: 'uncertain' })
    expect(await run.reconcile('desconocida')).toMatchObject({ error_code: 'intent_not_found' })
  })

  it('reconcile de una intención terminal devuelve lo guardado sin consultar al adaptador', async () => {
    const { intentId } = await approvedIntent()
    const wl = adapter({ reconcile: vi.fn(async () => null) })
    const run = executor(wl)
    await run.executeApprovedAction({ intent_id: intentId, expected_generation: 0 })
    expect(await run.reconcile(intentId)).toMatchObject({ state: 'succeeded', remote_ref: 'wl-1' })
    expect(wl.reconcile).not.toHaveBeenCalled()
  })

  it('rechaza adaptadores duplicados para un mismo tipo', () => {
    expect(() => executor(adapter(), adapter())).toThrow(/duplicado/)
  })
})
