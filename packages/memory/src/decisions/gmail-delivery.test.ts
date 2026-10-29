import { describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { GmailSelfSender, composeSelfMessage } from '../connectors/gmail-send.js'
import { GMAIL_SEND_SCOPE, googleScopes, GMAIL_SCOPE } from '../google-auth.js'
import type { GoogleAuth } from '../google-auth.js'
import { DecisionStore } from './store.js'
import { deliverDecisionByGmail, renderDecisionFooter } from './delivery.js'
import { formatCode, normalizeCode } from './codes.js'

const ACCOUNT = 'me@example.com'
const key = randomBytes(32)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function google(over: { granted?: boolean; token?: () => Promise<string> } = {}) {
  return { granted: vi.fn(() => over.granted ?? true), token: over.token ?? (async () => 'token-de-prueba') } as unknown as GoogleAuth
}
/** `send` define la respuesta del POST de envío; el perfil devuelve siempre la cuenta. */
function fakeFetch(send: () => Response | Promise<Response>, profile: () => Response = () => json({ emailAddress: ACCOUNT })) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = (async (url: string, init?: RequestInit) => { calls.push({ url, ...(init ? { init } : {}) }); return String(url).endsWith('/profile') ? profile() : send() }) as unknown as typeof fetch
  return { fetcher, calls }
}
const sentBody = (calls: Array<{ init?: RequestInit }>) => JSON.parse(String(calls.find(call => call.init?.method === 'POST')!.init!.body)) as { raw: string; threadId?: string }
const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8')

describe('scopes de Gmail', () => {
  it('el envío es opcional y pide TODOS los scopes junto con la lectura', () => {
    expect(googleScopes({})).not.toContain(GMAIL_SEND_SCOPE)
    expect(googleScopes({ gmail_send_enabled: false })).not.toContain(GMAIL_SEND_SCOPE)
    const all = googleScopes({ gmail_send_enabled: true })
    expect(all).toContain(GMAIL_SEND_SCOPE)
    expect(all).toContain(GMAIL_SCOPE)
    expect(all.length).toBe(googleScopes({}).length + 1)
  })
})

describe('GmailSelfSender', () => {
  it('compone un mensaje solo a la cuenta propia, con Message-ID propio y marcas de control', () => {
    const mime = composeSelfMessage(ACCOUNT, { message_id: '<hub-1@agent-hub.invalid>', subject: 'Brief ñ', text: 'línea 1\nlínea 2' })
    expect(mime).toContain(`From: ${ACCOUNT}`)
    expect(mime).toContain(`To: ${ACCOUNT}`)
    expect(mime).toContain('Message-ID: <hub-1@agent-hub.invalid>')
    expect(mime).toContain('Auto-Submitted: auto-generated')
    expect(mime).toContain('X-Agent-Hub-Control: 1')
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?/)
    expect(mime.match(/^To:/gm)).toHaveLength(1)
  })

  it('con HTML compone multipart/alternative con la parte de texto primero y ambas en UTF-8', () => {
    const mime = composeSelfMessage(ACCOUNT, { message_id: '<hub-1@agent-hub.invalid>', subject: 'Brief', text: 'texto ñ', html: '<p>html ñ</p>' })
    const boundary = /Content-Type: multipart\/alternative; boundary="([^"]+)"/.exec(mime)![1]!
    const parts = mime.split(`--${boundary}`).slice(1, -1)
    expect(parts).toHaveLength(2)
    expect(parts.map(part => /Content-Type: ([^;]+)/.exec(part)![1])).toEqual(['text/plain', 'text/html'])
    expect(parts.map(part => Buffer.from(part.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8'))).toEqual(['texto ñ', '<p>html ñ</p>'])
    expect(mime.endsWith(`--${boundary}--\r\n`)).toBe(true)
    expect(mime.split('\r\n\r\n')[0]!.match(/^Content-Type:/gm)).toHaveLength(1)
  })

  it('rechaza encabezados con saltos de línea y cuentas inválidas', () => {
    expect(() => composeSelfMessage(ACCOUNT, { message_id: '<a@b>\r\nBcc: x@y.z', subject: 's', text: 't' })).toThrow()
    expect(() => composeSelfMessage('a@b.c, x@y.z', { message_id: '<a@b>', subject: 's', text: 't' })).toThrow()
    expect(composeSelfMessage(ACCOUNT, { message_id: '<a@b>', subject: 'a\r\nBcc: x@y.z', text: 't' })).not.toContain('\r\nBcc:')
  })

  it('envía el destinatario que dice el perfil de la cuenta conectada, nunca otro', async () => {
    const { fetcher, calls } = fakeFetch(() => json({ id: 'gm-1', threadId: 'th-1' }))
    const outcome = await new GmailSelfSender(google(), fetcher).send('conn-1', { message_id: '<hub-1@agent-hub.invalid>', subject: 'Brief', text: 'hola' })
    expect(outcome).toEqual({ state: 'sent', native_id: 'gm-1', thread_id: 'th-1' })
    const raw = decode(sentBody(calls).raw)
    expect(raw).toContain(`To: ${ACCOUNT}`)
    expect((calls[0]!.init!.headers as Record<string, string>)['authorization']).toBe('Bearer token-de-prueba')
  })

  it('sin el scope de envío no sale ninguna solicitud', async () => {
    const { fetcher, calls } = fakeFetch(() => json({ id: 'x' }))
    expect(await new GmailSelfSender(google({ granted: false }), fetcher).send('c', { message_id: '<a@b>', subject: 's', text: 't' })).toEqual({ state: 'failed', reason: 'scope_missing' })
    expect(calls).toHaveLength(0)
  })

  it('si la cuenta del perfil cambió respecto de la fijada, no envía', async () => {
    const { fetcher, calls } = fakeFetch(() => json({ id: 'x' }), () => json({ emailAddress: 'otra@example.com' }))
    expect(await new GmailSelfSender(google(), fetcher).send('c', { message_id: '<a@b>', subject: 's', text: 't' }, ACCOUNT)).toEqual({ state: 'failed', reason: 'account_mismatch' })
    expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(0)
  })

  it.each([[400, 'failed'], [403, 'failed'], [429, 'failed'], [500, 'uncertain'], [503, 'uncertain'], [408, 'uncertain']])('HTTP %i del envío es %s', async (status, state) => {
    const { fetcher } = fakeFetch(() => json({ error: {} }, status))
    expect((await new GmailSelfSender(google(), fetcher).send('c', { message_id: '<a@b>', subject: 's', text: 't' })).state).toBe(state)
  })

  it('una caída de red o una respuesta sin id dejan el resultado incierto', async () => {
    const down = fakeFetch(() => { throw new Error('socket') })
    expect(await new GmailSelfSender(google(), down.fetcher).send('c', { message_id: '<a@b>', subject: 's', text: 't' })).toEqual({ state: 'uncertain', reason: 'network' })
    const empty = fakeFetch(() => json({}))
    expect(await new GmailSelfSender(google(), empty.fetcher).send('c', { message_id: '<a@b>', subject: 's', text: 't' })).toEqual({ state: 'uncertain', reason: 'bad_response' })
  })

  it('no hay solicitud de envío si no se puede comprobar la cuenta', async () => {
    const { fetcher, calls } = fakeFetch(() => json({ id: 'x' }), () => json({}, 401))
    expect(await new GmailSelfSender(google(), fetcher).send('c', { message_id: '<a@b>', subject: 's', text: 't' })).toEqual({ state: 'failed', reason: 'auth' })
    expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(0)
  })
})

describe('entrega de la solicitud de decisión por Gmail', () => {
  function setup(send: () => Response | Promise<Response>) {
    const exclusions: unknown[] = []
    const store = new DecisionStore(':memory:', { key, exclusions: { async add(entries) { exclusions.push(...entries) } } })
    const { request_id } = store.prepareDecision({ run_id: 'run-1', artifact_id: 'art-1', owner_id: 'owner', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z',
      items: [{ kind: 'jira_worklog', project_id: 'p1', summary: 'Registrar 0.5 h en ABC-1', exact_effect: { cloud: 's', issue_key: 'ABC-1', seconds: 1800 } }] })
    const { fetcher, calls } = fakeFetch(send)
    return { store, request_id, calls, exclusions, deps: { store, sender: new GmailSelfSender(google(), fetcher), messageId: () => '<hub-fixed@agent-hub.invalid>' } }
  }
  const input = (request_id: string) => ({ request_id, connector_id: 'conn-1', subject: 'Cierre 17:30', text: 'Resumen del día' })

  it('reserva con la exclusión del Message-ID, envía con el código al pie y deja la entrega enviada y el binding activo', async () => {
    const { store, request_id, calls, exclusions, deps } = setup(() => json({ id: 'gm-1', threadId: 'th-1' }))
    const receipt = await deliverDecisionByGmail(deps, input(request_id))
    expect(receipt).toMatchObject({ state: 'sent' })
    const raw = decode(sentBody(calls).raw)
    const boundary = /boundary="([^"]+)"/.exec(raw)![1]!
    const [body, html] = raw.split(`--${boundary}`).slice(1, 3).map(part => Buffer.from(part.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8'))
    const code = formatCode(normalizeCode(store.codeFor(request_id))!)
    expect(body).toContain('Resumen del día')
    expect(body).toContain(`aprobar ${code} 1,2`)
    expect(html).toContain('Resumen del día')
    expect(html).toContain(`aprobar ${code} 1,2`)
    expect(html).toContain('Registrar 0.5 h en ABC-1')
    expect(exclusions).toContainEqual({ integration: 'gmail', account: ACCOUNT, kind: 'rfc_message_id', native_id: '<hub-fixed@agent-hub.invalid>' })
    expect(exclusions).toContainEqual({ integration: 'gmail', account: ACCOUNT, kind: 'message', native_id: 'gm-1' })
    expect(exclusions).toContainEqual({ integration: 'gmail', account: ACCOUNT, kind: 'thread', native_id: 'th-1' })
    expect(store.bindingsOf(request_id)[0]).toMatchObject({ state: 'active', delivery_state: 'sent', conversation: 'th-1' })
  })

  it('un rechazo de Google cierra la entrega como failed y permite reservar de nuevo', async () => {
    const { store, request_id, deps } = setup(() => json({ error: {} }, 400))
    expect(await deliverDecisionByGmail(deps, input(request_id))).toMatchObject({ state: 'failed', error_code: 'rejected' })
    expect(store.bindingsOf(request_id)[0]).toMatchObject({ state: 'closed', delivery_state: 'failed' })
  })

  it('un resultado ambiguo deja la entrega uncertain, el binding en cuarentena y no se reenvía', async () => {
    const { store, request_id, calls, deps } = setup(() => { throw new Error('timeout') })
    expect(await deliverDecisionByGmail(deps, input(request_id))).toMatchObject({ state: 'uncertain', error_code: 'network' })
    expect(store.bindingsOf(request_id)[0]).toMatchObject({ state: 'quarantined', delivery_state: 'uncertain' })
    expect(await deliverDecisionByGmail(deps, input(request_id))).toMatchObject({ state: 'uncertain', error_code: 'delivery_already_dispatched' })
    expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1)
  })

  it('repetir la entrega de una solicitud ya enviada no vuelve a enviar', async () => {
    const { request_id, calls, deps } = setup(() => json({ id: 'gm-1', threadId: 'th-1' }))
    await deliverDecisionByGmail(deps, input(request_id))
    expect(await deliverDecisionByGmail(deps, input(request_id))).toMatchObject({ state: 'sent', error_code: 'delivery_already_dispatched' })
    expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1)
  })

  it('tras un fallo comprobado y un envío posterior, reintentar no confunde el binding fallido con uno incierto', async () => {
    let attempt = 0, ids = 0
    const { request_id, calls, deps } = setup(() => (++attempt === 1 ? json({ error: {} }, 400) : json({ id: 'gm-2', threadId: 'th-2' })))
    const unique = { ...deps, messageId: () => `<hub-${++ids}@agent-hub.invalid>` }
    expect(await deliverDecisionByGmail(unique, input(request_id))).toMatchObject({ state: 'failed' })
    expect(await deliverDecisionByGmail(unique, input(request_id))).toMatchObject({ state: 'sent' })
    expect(await deliverDecisionByGmail(unique, input(request_id))).toMatchObject({ state: 'sent', error_code: 'delivery_already_dispatched' })
    expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(2)
  })

  it('un envío concurrente solo sale una vez', async () => {
    const { request_id, calls, deps } = setup(() => json({ id: 'gm-1', threadId: 'th-1' }))
    const [a, b] = await Promise.all([deliverDecisionByGmail(deps, input(request_id)), deliverDecisionByGmail(deps, input(request_id))])
    expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1)
    expect([a.state, b.state]).toContain('sent')
  })

  it('con una solicitud cerrada no se entrega', async () => {
    const { store, request_id, calls, deps } = setup(() => json({ id: 'x' }))
    store.revokeRequest(request_id)
    expect(await deliverDecisionByGmail(deps, input(request_id))).toMatchObject({ state: 'skipped', error_code: 'request_not_open' })
    expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(0)
  })

  it('si no se puede acreditar la cuenta no reserva ni envía', async () => {
    const store = new DecisionStore(':memory:', { key, exclusions: { async add() {} } })
    const { request_id } = store.prepareDecision({ run_id: 'run-1', artifact_id: 'a', owner_id: 'o', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z', items: [{ kind: 'jira_worklog', project_id: 'p1', summary: 's', exact_effect: { a: 1 } }] })
    const { fetcher } = fakeFetch(() => json({ id: 'x' }), () => json({}, 401))
    expect(await deliverDecisionByGmail({ store, sender: new GmailSelfSender(google(), fetcher) }, input(request_id))).toMatchObject({ state: 'failed', error_code: 'identity_unverified' })
    expect(store.bindingsOf(request_id)).toEqual([])
  })

  it('el pie lista solo los ítems pendientes y el código en el formato de respuesta', () => {
    const footer = renderDecisionFooter({ request_id: 'r', run_id: 'run', revision: 1, state: 'open', expires_at: '2099-01-01T00:00:00.000Z', canonical_digest: 'd', items: [
      { ordinal: 1, kind: 'jira_worklog', summary: 'uno', state: 'pending', effect_digest: 'x' }, { ordinal: 2, kind: 'jira_worklog', summary: 'dos', state: 'approved', effect_digest: 'y' }] }, 'K7P4M2XN')
    expect(footer).toContain('1. uno')
    expect(footer).not.toContain('2. dos')
    expect(footer).toContain('aprobar K7P4-M2XN 1,2')
    expect(normalizeCode('K7P4-M2XN')).toBe('K7P4M2XN')
  })
})
