import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { DecisionService, DecisionStore } from '@agenthub/memory'
import type { CallResult } from '@agenthub/gateway'
import { parseSlackThread, pollSlackReplies } from '../src/effects/slack-replies.js'
import { EffectToolDenied, type EffectToolResolver } from '../src/effects/tools.js'

const USER = 'U0TESTUSER1', DM = 'D0TESTDM001', TEAM = 'T0TEAM0001', DELIVERY = '1760000000.000100'
const text = (value: unknown): CallResult => ({ is_error: false, content: [{ type: 'text', text: JSON.stringify(value) }] })

let store: DecisionStore, requestId: string, code: string
let servers: Map<string, Set<string>>, thread: () => CallResult, reads: Array<Record<string, unknown>>, authority: 'live' | 'unavailable'
const resolver: EffectToolResolver = {
  candidates: names => [...servers].filter(([, tools]) => names.every(name => tools.has(name))).map(([id]) => id),
  forServer: serverId => ({ server_id: serverId, enabled: name => !!servers.get(serverId)?.has(name),
    async call(name, args) { if (!servers.get(serverId)?.has(name)) throw new EffectToolDenied(name, 'tool_off'); reads.push(args); return thread() } }),
}
const message = (ts: string, over: Record<string, unknown> = {}) => ({ ts, thread_ts: DELIVERY, user: USER, team: TEAM, text: `aprobar ${code} 1`, ...over })

beforeEach(async () => {
  reads = []; authority = 'live'
  servers = new Map([['srv', new Set(['slack_read_thread'])]])
  store = new DecisionStore(':memory:', { key: randomBytes(32), exclusions: { async add() {} } })
  requestId = store.prepareDecision({ run_id: 'run-1', artifact_id: 'a1', owner_id: 'o', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z', items: [
    { kind: 'jira_worklog', project_id: 'p1', summary: 'uno', exact_effect: { n: 1 } }, { kind: 'jira_worklog', project_id: 'p1', summary: 'dos', exact_effect: { n: 2 } }] }).request_id
  const reserved = await store.reserveDelivery({ request_id: requestId, integration: 'slack', account: USER, correlation: 'slack-1', conversation: USER, remote_user: USER, team: TEAM, provenance: 'test' })
  store.beginSend(reserved.delivery_id)
  await store.recordNative(reserved.delivery_id, { native_id: DELIVERY, delivery_ref: DELIVERY, conversation: DM })
  code = store.codeFor(requestId)
  thread = () => text({ messages: [{ ts: DELIVERY, user: USER, team: TEAM, text: 'entrega' }, message('1760000100.000200')] })
})
afterEach(() => store.close())
const poll = () => pollSlackReplies({ store, service: new DecisionService(store, async () => authority), tools: resolver })

describe('lector de respuestas de Slack', () => {
  it('acepta solo listas estructuradas de mensajes', () => {
    expect(parseSlackThread(text({ messages: [message('1.1')] }), DM)).toHaveLength(1)
    expect(parseSlackThread(text('texto libre con aprobar'), DM)).toEqual([])
    expect(parseSlackThread({ is_error: true, content: [] }, DM)).toEqual([])
    expect(parseSlackThread(text({ messages: [{ ts: 1, text: 'x' }] }), DM)).toEqual([])
  })

  it('lee el hilo de la entrega y aprueba la respuesta verificada del usuario', async () => {
    const out = await poll()
    expect(reads).toEqual([{ channel_id: DM, message_ts: DELIVERY }])
    expect(out).toMatchObject({ consumed: 1, rejected: { hub_message: 1 } })
    expect(store.getApprovedItems(requestId).map(item => item.ordinal)).toEqual([1])
  })

  it('rechaza bots, otros usuarios, ediciones, subtipos y mensajes fuera del hilo', async () => {
    thread = () => text({ messages: [message('1.1', { bot_id: 'B1' }), message('1.2', { user: 'U0OTHER0002' }), message('1.3', { edited: { ts: '1' } }), message('1.4', { subtype: 'channel_join' }),
      message('1.5', { thread_ts: '9.9' }), message('1.6', { team: 'T0OTHER002' })] })
    const out = await poll()
    expect(out.consumed).toBe(0)
    expect(out.rejected).toMatchObject({ bot: 2, user: 1, edited: 1, not_in_thread: 1, team: 1 })
    expect(store.getApprovedItems(requestId)).toEqual([])
  })

  it('sin autoridad vigente no se consume nada; repetir el sondeo no duplica', async () => {
    authority = 'unavailable'
    expect(await poll()).toMatchObject({ consumed: 0, rejected: { authority_unavailable: 1 } })
    authority = 'live'
    await poll(); const again = await poll()
    expect(again.consumed).toBe(0)
    expect(store.getApprovedItems(requestId)).toHaveLength(1)
  })

  it('sin herramienta, con varios servidores o sin binding no hay lectura', async () => {
    servers = new Map()
    expect(await poll()).toMatchObject({ inspected: 0, rejected: { tool_off: 1 } })
    servers = new Map([['a', new Set(['slack_read_thread'])], ['b', new Set(['slack_read_thread'])]])
    expect(await poll()).toMatchObject({ inspected: 0, rejected: { ambiguous_server: 1 } })
    expect(reads).toEqual([])
    store.revokeRequest(requestId)
    servers = new Map([['srv', new Set(['slack_read_thread'])]])
    expect((await poll()).inspected).toBe(0)
    expect(reads).toEqual([])
  })

  it('un fallo de lectura no consume nada', async () => {
    thread = () => { throw new Error('rate_limited') }
    expect(await poll()).toMatchObject({ consumed: 0, rejected: { fetch_failed: 1 } })
  })
})
