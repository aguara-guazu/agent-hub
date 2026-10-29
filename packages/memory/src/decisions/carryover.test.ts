import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { DecisionStore } from './store.js'

const OWNER = 'owner-1'
const SINCE = '2026-10-20T00:00:00.000Z'
let clock = new Date('2026-10-28T20:00:00.000Z')
const advance = (minutes: number) => { clock = new Date(clock.getTime() + minutes * 60_000) }
const at = (minutes: number) => new Date(clock.getTime() + minutes * 60_000).toISOString()
const effect = (n: number) => ({ kind: 'jira_worklog', issue_key: `ABC-${n}`, seconds: 1800 * n })

function setup() {
  clock = new Date('2026-10-28T20:00:00.000Z')
  const store = new DecisionStore(':memory:', { key: randomBytes(32), now: () => clock, exclusions: { async add() {} } })
  const prepare = (run: string, items: Array<{ n: number; operation_key?: string }>, ttl = 60) => store.prepareDecision({ run_id: run, artifact_id: `art-${run}`, owner_id: OWNER, project_ids: ['p1'], expires_at: at(ttl),
    items: items.map(item => ({ kind: 'jira_worklog' as const, project_id: 'p1', summary: `worklog ${item.n}`, exact_effect: effect(item.n), ...(item.operation_key ? { operation_key: item.operation_key } : {}) })) })
  const approveAll = async (requestId: string) => {
    const reserved = await store.reserveDelivery({ request_id: requestId, integration: 'gmail', account: 'me@example.com', correlation: `<hub-${requestId}@hub>`, provenance: 'test' })
    store.beginSend(reserved.delivery_id)
    await store.recordNative(reserved.delivery_id, { native_id: `native-${requestId}`, thread_id: `thread-${requestId}` })
    return store.consumeReply({ integration: 'gmail', account: 'me@example.com', native_message_id: `m-${requestId}`, binding_id: reserved.binding_id,
      parsed: { kind: 'approve', code: store.codeFor(requestId).replace(/-/g, ''), items: 'all' } })
  }
  return { store, prepare, approveAll }
}

describe('solicitudes que esperan respuesta', () => {
  it('lista solo las abiertas con ítems por decidir y sin vencer, sin código ni digest', async () => {
    const { store, prepare, approveAll } = setup()
    const open = prepare('run-open', [{ n: 1 }, { n: 2 }]), done = prepare('run-done', [{ n: 3 }])
    await approveAll(done.request_id)
    const waiting = store.awaitingReply()
    expect(waiting).toEqual([{ request_id: open.request_id, run_id: 'run-open', project_ids: ['p1'], created_at: clock.toISOString(), expires_at: at(60), pending: 2 }])
    expect(Object.keys(waiting[0]!).sort()).toEqual(['created_at', 'expires_at', 'pending', 'project_ids', 'request_id', 'run_id'])
    advance(61)
    expect(store.awaitingReply()).toEqual([])
  })
})

describe('ítems que una solicitud vencida dejó sin despachar', () => {
  it('no ofrece nada antes del vencimiento y luego devuelve el efecto guardado de los ítems sin responder', () => {
    const { store, prepare } = setup()
    prepare('run-1', [{ n: 1 }, { n: 2 }])
    expect(store.carryoverItems(SINCE, 10)).toEqual([])
    advance(61)
    store.expireDue()
    const items = store.carryoverItems(SINCE, 10)
    expect(items.map(item => [item.run_id, item.ordinal, item.summary, item.effect])).toEqual([['run-1', 1, 'worklog 1', effect(1)], ['run-1', 2, 'worklog 2', effect(2)]])
  })

  it('un ítem aprobado cuya intención venció antes de despachar también se arrastra', async () => {
    const { store, prepare, approveAll } = setup()
    const request = prepare('run-1', [{ n: 1 }])
    await approveAll(request.request_id)
    advance(61)
    store.expireDue()
    expect(store.carryoverItems(SINCE, 10).map(item => item.effect)).toEqual([effect(1)])
  })

  it('lo que alcanzó a despachar, aunque quedara incierto, no se vuelve a ofrecer ni por otra solicitud con la misma operación', async () => {
    const { store, prepare, approveAll } = setup()
    const first = prepare('run-1', [{ n: 1, operation_key: 'op-1' }])
    const outcome = await approveAll(first.request_id)
    const intent = outcome.approved![0]!.intent_id
    const claimed = store.claimIntent(intent, 0) as { generation: number }
    expect(store.markDispatching(intent, claimed.generation)).toBe('ok')
    store.completeIntent(intent, claimed.generation, { state: 'uncertain', error_code: 'send_threw' })
    prepare('run-2', [{ n: 1, operation_key: 'op-1' }])
    advance(61)
    store.expireDue()
    expect(store.carryoverItems(SINCE, 10)).toEqual([])
  })

  it('una solicitud más nueva y abierta retoma la operación; al vencer ella, de las dos copias queda la más reciente', () => {
    const { store, prepare } = setup()
    prepare('run-1', [{ n: 1, operation_key: 'op-1' }], 30)
    advance(10)
    const second = prepare('run-2', [{ n: 1, operation_key: 'op-1' }], 30)
    advance(25)
    store.expireDue()
    expect(store.carryoverItems(SINCE, 10)).toEqual([])
    advance(60)
    store.expireDue()
    expect(store.publicRequest(second.request_id).state).toBe('expired')
    expect(store.carryoverItems(SINCE, 10).map(item => item.run_id)).toEqual(['run-2'])
  })

  it('un ítem que la persona rechazó en una solicitud más nueva no se arrastra', async () => {
    const { store, prepare } = setup()
    prepare('run-1', [{ n: 1, operation_key: 'op-1' }], 30)
    advance(31)
    const second = prepare('run-2', [{ n: 1, operation_key: 'op-1' }], 600)
    const reserved = await store.reserveDelivery({ request_id: second.request_id, integration: 'gmail', account: 'me@example.com', correlation: '<hub-2@hub>', provenance: 'test' })
    store.beginSend(reserved.delivery_id)
    await store.recordNative(reserved.delivery_id, { native_id: 'native-2', thread_id: 'thread-2' })
    store.consumeReply({ integration: 'gmail', account: 'me@example.com', native_message_id: 'm-2', binding_id: reserved.binding_id, parsed: { kind: 'reject', code: store.codeFor(second.request_id).replace(/-/g, ''), items: 'all' } })
    store.expireDue()
    expect(store.carryoverItems(SINCE, 10)).toEqual([])
  })

  it('lo que una solicitud posterior retomó y también venció no se ofrece de nuevo desde la original', () => {
    const { store, prepare } = setup()
    prepare('run-close', [{ n: 1, operation_key: 'op-1' }], 30)
    advance(31)
    store.expireDue()
    prepare('run-brief', [{ n: 1, operation_key: 'op-1' }], 30)
    advance(31)
    store.expireDue()
    expect(store.carryoverItems(SINCE, 10).map(item => item.run_id)).toEqual(['run-brief'])
  })

  it('respeta la ventana y el límite', () => {
    const { store, prepare } = setup()
    prepare('run-1', [{ n: 1 }, { n: 2 }, { n: 3 }])
    advance(61)
    store.expireDue()
    expect(store.carryoverItems(SINCE, 2)).toHaveLength(2)
    expect(store.carryoverItems(at(1), 10)).toEqual([])
  })

  it('lo reofrecido por repropose deja de arrastrarse', () => {
    const { store, prepare } = setup()
    const request = prepare('run-1', [{ n: 1 }])
    advance(61)
    store.expireDue()
    expect(store.carryoverItems(SINCE, 10)).toHaveLength(1)
    store.reproposeRequest(request.request_id, at(600))
    expect(store.carryoverItems(SINCE, 10)).toEqual([])
  })
})
