import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { DecisionStore } from '@agenthub/memory'
import type { CallResult } from '@agenthub/gateway'
import { SlackSelfDelivery, parseSlackIdentity, parseSlackSent } from '../src/effects/slack-self.js'
import { EffectToolDenied, type EffectToolResolver } from '../src/effects/tools.js'

const text = (value: unknown): CallResult => ({ is_error: false, content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })
const USER = 'U0TESTUSER1', DM = 'D0TESTDM001'

let store: DecisionStore, requestId: string, calls: Array<{ name: string; args: Record<string, unknown> }>
let servers: Map<string, Set<string>>
let handlers: { profile: () => CallResult | Promise<CallResult>; send: () => CallResult | Promise<CallResult> }
const exclusions: unknown[] = []

const resolver: EffectToolResolver = {
  candidates: names => [...servers].filter(([, tools]) => names.every(name => tools.has(name))).map(([id]) => id),
  forServer: serverId => ({ server_id: serverId, enabled: name => !!servers.get(serverId)?.has(name),
    async call(name, args) {
      if (!servers.get(serverId)?.has(name)) throw new EffectToolDenied(name, 'tool_off')
      calls.push({ name, args })
      return name === 'slack_read_user_profile' ? handlers.profile() : handlers.send()
    } }),
}

beforeEach(() => {
  calls = []; exclusions.length = 0
  servers = new Map([['srv-slack', new Set(['slack_send_message', 'slack_read_user_profile'])]])
  handlers = { profile: () => text({ user_id: USER, is_bot: false, team_id: 'T1' }), send: () => text({ ok: true, ts: '1760000000.000100', channel: DM }) }
  store = new DecisionStore(':memory:', { key: randomBytes(32), exclusions: { async add(entries) { exclusions.push(...entries) } } })
  requestId = store.prepareDecision({ run_id: 'run-1', artifact_id: 'art-1', owner_id: 'owner', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z',
    items: [{ kind: 'jira_worklog', project_id: 'p1', summary: 'Registrar 0.5 h', exact_effect: { a: 1 } }] }).request_id
})
afterEach(() => store.close())
const delivery = () => new SlackSelfDelivery({ store, tools: resolver })

describe('parseo de respuestas del MCP de Slack', () => {
  it('acredita la identidad solo con un campo estructurado válido y detecta bots', () => {
    expect(parseSlackIdentity(text({ user: { id: USER, is_bot: false } }))).toMatchObject({ user_id: USER, is_bot: false })
    expect(parseSlackIdentity(text({ user_id: USER, is_bot: true }))).toMatchObject({ is_bot: true })
    expect(parseSlackIdentity(text({ user_id: 'no-es-un-id' }))).toBeNull()
    expect(parseSlackIdentity({ is_error: true, content: [] })).toBeNull()
  })
  it('un user ID en texto libre no acredita nada (podría ser otra persona)', () => {
    expect(parseSlackIdentity(text(`Name: Ana\nUser ID: ${USER}`))).toBeNull()
    expect(parseSlackIdentity(text('manager: U0AAAAAAAA'))).toBeNull()
    expect(parseSlackIdentity(text({ title: 'Dev', manager: 'U0AAAAAAAA' }))).toBeNull()
    expect(parseSlackIdentity(text('sin datos'))).toBeNull()
  })
  it('el recibo exige ts y canal juntos, de campos estructurados o de un único permalink', () => {
    expect(parseSlackSent(text({ ts: '1760000000.000100', channel: DM }))).toEqual({ ts: '1760000000.000100', channel: DM })
    expect(parseSlackSent(text({ message: { ts: '1760000000.000100', channel: DM } }))).toEqual({ ts: '1760000000.000100', channel: DM })
    expect(parseSlackSent(text(`https://x.slack.com/archives/${DM}/p1760000000000100`))).toEqual({ ts: '1760000000.000100', channel: DM })
  })
  it('sin canal, con ts suelto o con permalinks distintos no hay recibo', () => {
    expect(parseSlackSent(text({ ts: '1760000000.000100' }))).toBeNull()
    expect(parseSlackSent(text('ok 1760000000.000100'))).toBeNull()
    expect(parseSlackSent(text('enviado'))).toBeNull()
    expect(parseSlackSent(text(`https://x.slack.com/archives/${DM}/p1760000000000100 y https://x.slack.com/archives/C0TESTCHAN1/p1760000000000200`))).toBeNull()
    expect(parseSlackSent({ is_error: true, content: [{ type: 'text', text: `/archives/${DM}/p1760000000000100` }] })).toBeNull()
  })
})

describe('Slack a uno mismo', () => {
  it('disponible con identidad humana; no disponible sin herramientas, con bot, sin identidad o con dos servidores', async () => {
    expect(await delivery().available()).toEqual({ available: true, user_id: USER })
    handlers.profile = () => text({ user_id: USER, is_bot: true })
    expect(await delivery().available()).toEqual({ available: false, reason: 'identity_is_bot' })
    handlers.profile = () => text('nada')
    expect(await delivery().available()).toEqual({ available: false, reason: 'identity_unverified' })
    servers = new Map()
    expect(await delivery().available()).toEqual({ available: false, reason: 'tool_off' })
    servers = new Map([['a', new Set(['slack_send_message', 'slack_read_user_profile'])], ['b', new Set(['slack_send_message', 'slack_read_user_profile'])]])
    expect(await delivery().available()).toEqual({ available: false, reason: 'identity_unverified' })
  })

  it('envía al user ID acreditado, con el código al pie, y deja la entrega enviada con binding activo y exclusiones', async () => {
    const receipt = await delivery().deliver({ request_id: requestId, text: 'Resumen' })
    expect(receipt).toMatchObject({ state: 'sent' })
    const send = calls.find(call => call.name === 'slack_send_message')!
    expect(send.args['channel_id']).toBe(USER)
    expect(String(send.args['message'])).toContain('Resumen')
    expect(String(send.args['message'])).toMatch(/aprobar [A-Z0-9]{4}-[A-Z0-9]{4} 1,2/)
    expect(Object.keys(send.args).sort()).toEqual(['channel_id', 'message'])
    expect(store.bindingsOf(requestId)[0]).toMatchObject({ integration: 'slack', account: USER, state: 'active', delivery_state: 'sent', remote_user: USER, team: 'T1', delivery_ref: '1760000000.000100', conversation: DM })
    expect(exclusions).toContainEqual({ integration: 'slack', account: USER, kind: 'conversation', native_id: USER })
    expect(exclusions).toContainEqual({ integration: 'slack', account: USER, kind: 'conversation', native_id: DM })
    expect(exclusions).toContainEqual({ integration: 'slack', account: USER, kind: 'message', native_id: '1760000000.000100' })
  })

  it('con identidad de bot o sin acreditar no reserva ni envía', async () => {
    handlers.profile = () => text({ user_id: USER, is_bot: true })
    expect(await delivery().deliver({ request_id: requestId, text: 'x' })).toMatchObject({ state: 'failed', error_code: 'identity_is_bot' })
    handlers.profile = () => text('nada')
    expect(await delivery().deliver({ request_id: requestId, text: 'x' })).toMatchObject({ state: 'failed', error_code: 'identity_unverified' })
    expect(calls.some(call => call.name === 'slack_send_message')).toBe(false)
    expect(store.bindingsOf(requestId)).toEqual([])
  })

  it('una excepción o un error de la herramienta deja la entrega incierta y no se reenvía', async () => {
    handlers.send = () => { throw new Error('timeout') }
    expect(await delivery().deliver({ request_id: requestId, text: 'x' })).toMatchObject({ state: 'uncertain', error_code: 'send_threw' })
    expect(store.bindingsOf(requestId)[0]).toMatchObject({ state: 'quarantined', delivery_state: 'uncertain' })
    expect(await delivery().deliver({ request_id: requestId, text: 'x' })).toMatchObject({ state: 'uncertain', error_code: 'delivery_already_dispatched' })
    expect(calls.filter(call => call.name === 'slack_send_message')).toHaveLength(1)
  })

  it('un envío sin ts y canal interpretables queda incierto en lugar de registrar un recibo inventado', async () => {
    handlers.send = () => text({ ts: '1760000000.000100' })
    expect(await delivery().deliver({ request_id: requestId, text: 'x' })).toMatchObject({ state: 'uncertain', error_code: 'receipt_unparsed' })
    expect(store.bindingsOf(requestId)[0]).toMatchObject({ state: 'quarantined', delivery_state: 'uncertain' })
  })
  it('un error de la herramienta deja la entrega incierta', async () => {
    handlers.send = () => ({ is_error: true, content: [{ type: 'text', text: 'channel_not_found' }] })
    expect(await delivery().deliver({ request_id: requestId, text: 'x' })).toMatchObject({ state: 'uncertain', error_code: 'tool_error' })
  })

  it('repetir la entrega ya enviada no vuelve a enviar y una solicitud cerrada se omite', async () => {
    await delivery().deliver({ request_id: requestId, text: 'x' })
    expect(await delivery().deliver({ request_id: requestId, text: 'x' })).toMatchObject({ state: 'sent', error_code: 'delivery_already_dispatched' })
    expect(calls.filter(call => call.name === 'slack_send_message')).toHaveLength(1)
    const other = store.prepareDecision({ run_id: 'run-2', artifact_id: 'a2', owner_id: 'owner', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z', items: [{ kind: 'jira_worklog', project_id: 'p1', summary: 's', exact_effect: { b: 2 } }] }).request_id
    store.revokeRequest(other)
    expect(await delivery().deliver({ request_id: other, text: 'x' })).toMatchObject({ state: 'skipped', error_code: 'request_not_open' })
  })
})
