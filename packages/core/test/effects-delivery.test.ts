import { beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { DecisionStore, GmailSelfSender, type Exclusion } from '@agenthub/memory'
import type { CallResult } from '@agenthub/gateway'
import { createDeliveryAdapters, type DeliveryArtifact } from '../src/effects/delivery.js'
import { SlackSelfDelivery } from '../src/effects/slack-self.js'
import type { EffectToolResolver } from '../src/effects/tools.js'

const ACCOUNT = 'me@example.com', USER = 'U0TESTUSER1', DM = 'D0TESTDM001'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const text = (value: unknown): CallResult => ({ is_error: false, content: [{ type: 'text', text: JSON.stringify(value) }] })

let store: DecisionStore, exclusions: Exclusion[], artifact: DeliveryArtifact | null, granted: boolean, connector: string | null, pending: { account: string | null } | null
let gmailCalls: Array<{ url: string; method?: string | undefined }>, slackCalls: Array<{ name: string; args: Record<string, unknown> }>, slackServers: Map<string, Set<string>>

const fetcher = (async (url: string, init?: RequestInit) => {
  gmailCalls.push({ url: String(url), method: init?.method })
  return String(url).endsWith('/profile') ? json({ emailAddress: ACCOUNT }) : json({ id: 'gm-1', threadId: 'th-1' })
}) as unknown as typeof fetch
const sender = () => new GmailSelfSender({ granted: () => granted, token: async () => 't' } as never, fetcher)
const tools: EffectToolResolver = {
  candidates: names => [...slackServers].filter(([, set]) => names.every(name => set.has(name))).map(([id]) => id),
  forServer: id => ({ server_id: id, enabled: name => !!slackServers.get(id)?.has(name), async call(name, args) {
    slackCalls.push({ name, args })
    return name === 'slack_read_user_profile' ? text({ user_id: USER, team_id: 'T1' }) : text({ ts: '1760000000.000100', channel: DM })
  } }),
}
const adapters = () => {
  const sink = { async add(entries: Exclusion[]) { exclusions.push(...entries) } }
  return createDeliveryAdapters({ store, exclusions: sink, artifacts: { load: async () => artifact }, slack: new SlackSelfDelivery({ store, tools, exclusions: sink }),
    gmail: { sender: sender(), connectorId: async () => connector, sendPending: async () => pending } })
}
const sends = () => gmailCalls.filter(call => call.method === 'POST')
const input = (target: 'gmail_self' | 'slack_self') => ({ delivery_id: 'd1', run_id: 'run-1', artifact_id: 'art-1', target, expected_generation: 0 })

beforeEach(() => {
  exclusions = []; gmailCalls = []; slackCalls = []; granted = true; connector = 'conn-1'; pending = null
  slackServers = new Map([['srv', new Set(['slack_send_message', 'slack_read_user_profile'])]])
  store = new DecisionStore(':memory:', { key: randomBytes(32), exclusions: { async add(entries) { exclusions.push(...entries) } } })
  artifact = { title: 'Brief 08:00', body_md: 'Resumen', decision_request_ref: null }
})

describe('entregas por canal propio', () => {
  it('available refleja conexión, scope, identidad y herramientas', async () => {
    expect(await adapters().available()).toEqual({ gmail_self: { available: true, destination: ACCOUNT }, slack_self: { available: true } })
    granted = false; slackServers = new Map()
    expect(await adapters().available()).toEqual({ gmail_self: { available: false, reason: 'scope_missing' }, slack_self: { available: false, reason: 'not_connected' } })
    connector = null
    expect((await adapters().available()).gmail_self).toEqual({ available: false, reason: 'not_connected' })
  })

  it('una fuente que lee Gmail sin el envío habilitado ofrece autorizarlo, con la cuenta como destino si se conoce, y no envía', async () => {
    connector = null; pending = { account: ACCOUNT }
    expect((await adapters().available()).gmail_self).toEqual({ available: false, reason: 'scope_missing', destination: ACCOUNT })
    pending = { account: null }
    expect((await adapters().available()).gmail_self).toEqual({ available: false, reason: 'scope_missing' })
    expect(await adapters().executeDelivery(input('gmail_self'))).toEqual({ state: 'failed', error_code: 'not_connected' })
    expect(gmailCalls).toHaveLength(0)
  })

  it('un resumen sin acciones sale por Gmail como mensaje de control excluido de la ingesta', async () => {
    expect(await adapters().executeDelivery(input('gmail_self'))).toEqual({ state: 'sent' })
    expect(sends()).toHaveLength(1)
    expect(exclusions.map(entry => entry.kind).sort()).toEqual(['message', 'rfc_message_id', 'thread'])
    expect(exclusions.find(entry => entry.kind === 'rfc_message_id')!.native_id).toMatch(/^<hub-.+@agent-hub\.invalid>$/)
  })

  it('sin scope o sin conector no sale nada', async () => {
    granted = false
    expect(await adapters().executeDelivery(input('gmail_self'))).toMatchObject({ state: 'failed', error_code: 'scope_missing' })
    granted = true; connector = null
    expect(await adapters().executeDelivery(input('gmail_self'))).toMatchObject({ state: 'failed', error_code: 'not_connected' })
    expect(sends()).toHaveLength(0)
  })

  it('un artefacto con solicitud de decisión usa el outbox y agrega el código; el destino lo fija el backend', async () => {
    const { request_id } = store.prepareDecision({ run_id: 'run-1', artifact_id: 'art-1', owner_id: 'o', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z',
      items: [{ kind: 'jira_worklog', project_id: 'p1', summary: 'uno', exact_effect: { n: 1 } }] })
    artifact = { ...artifact!, decision_request_ref: request_id }
    expect(await adapters().executeDelivery(input('gmail_self'))).toMatchObject({ state: 'sent' })
    expect(store.bindingsOf(request_id)[0]).toMatchObject({ integration: 'gmail', state: 'active', delivery_state: 'sent' })
    expect(await adapters().executeDelivery(input('slack_self'))).toMatchObject({ state: 'sent' })
    expect(store.bindingsOf(request_id).map(binding => binding.integration).sort()).toEqual(['gmail', 'slack'])
    const send = slackCalls.find(call => call.name === 'slack_send_message')!
    expect(send.args['channel_id']).toBe(USER)
    expect(String(send.args['message'])).toMatch(/aprobar [A-Z0-9]{4}-[A-Z0-9]{4}/)
  })

  it('Slack sin solicitud envía el resumen al propio DM y excluye el canal devuelto', async () => {
    expect(await adapters().executeDelivery(input('slack_self'))).toEqual({ state: 'sent' })
    expect(slackCalls.find(call => call.name === 'slack_send_message')!.args).toEqual({ channel_id: USER, message: 'Brief 08:00\n\nResumen' })
    expect(exclusions).toContainEqual({ integration: 'slack', account: USER, kind: 'conversation', native_id: DM })
  })

  it('falta el artefacto o el destino no está en la lista: no se envía', async () => {
    artifact = null
    expect(await adapters().executeDelivery(input('gmail_self'))).toMatchObject({ state: 'failed', error_code: 'artifact_missing' })
    expect(await adapters().executeDelivery({ ...input('gmail_self'), target: 'hub_inbox' as never })).toMatchObject({ state: 'failed', error_code: 'target_not_allowed' })
    expect(sends()).toHaveLength(0)
  })
})
