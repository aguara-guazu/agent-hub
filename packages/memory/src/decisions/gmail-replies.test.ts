import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { DecisionStore } from './store.js'
import { DecisionService, type ArtifactAuthority } from './service.js'
import { pollGmailReplies, gmailEvidence } from './gmail-replies.js'
import { formatCode, normalizeCode } from './codes.js'
import type { GoogleAuth } from '../google-auth.js'

const ACCOUNT = 'me@example.com', THREAD = 'th-1', HUB_ID = '<hub-1@agent-hub.invalid>'
const b64 = (text: string) => Buffer.from(text).toString('base64url')

function message(id: string, headers: Array<[string, string]>, body: string, labels = ['SENT'], thread = THREAD, extra: Record<string, unknown> = {}) {
  return { id, threadId: thread, labelIds: labels, payload: { mimeType: 'text/plain', body: { data: b64(body) }, headers: headers.map(([name, value]) => ({ name, value })), ...extra } }
}

async function setup(authority: ArtifactAuthority = 'live') {
  const store = new DecisionStore(':memory:', { key: randomBytes(32), exclusions: { async add() {} } })
  const { request_id } = store.prepareDecision({ run_id: 'run-1', artifact_id: 'a1', owner_id: 'o', project_ids: ['p1'], expires_at: '2099-01-01T00:00:00.000Z', items: [
    { kind: 'jira_worklog', project_id: 'p1', summary: 'uno', exact_effect: { n: 1 } }, { kind: 'jira_worklog', project_id: 'p1', summary: 'dos', exact_effect: { n: 2 } }] })
  const reserved = await store.reserveDelivery({ request_id, integration: 'gmail', account: ACCOUNT, correlation: HUB_ID, provenance: 'test' })
  store.beginSend(reserved.delivery_id)
  await store.recordNative(reserved.delivery_id, { native_id: 'gm-hub', thread_id: THREAD })
  const code = formatCode(normalizeCode(store.codeFor(request_id))!)
  const google = { granted: () => true, token: async () => 'tok' } as unknown as GoogleAuth
  const run = (messages: unknown[], current: ArtifactAuthority = authority) => {
    const fetcher = (async () => new Response(JSON.stringify({ messages }))) as unknown as typeof fetch
    return pollGmailReplies({ store, service: new DecisionService(store, async () => current), google, connectorId: 'c1', fetcher })
  }
  return { store, request_id, code, run }
}
const reply = (code: string, line: string) => message('gm-reply', [['From', `Yo <${ACCOUNT}>`], ['In-Reply-To', HUB_ID], ['References', HUB_ID]], `${line.replace('CODE', code)}\n\nEl lun escribió:\n> aprobar ${code} 1,2`)

describe('lector de respuestas de Gmail', () => {
  it('construye la evidencia sin heurísticas', () => {
    const evidence = gmailEvidence(message('m', [['From', 'Ana <ana@example.com>'], ['In-Reply-To', '<a@x>'], ['Auto-Submitted', 'auto-replied']], 'hola', ['INBOX'], 't', { filename: 'x.pdf' }))
    expect(evidence).toMatchObject({ id: 'm', threadId: 't', labelIds: ['INBOX'], from: ['ana@example.com'], inReplyTo: ['<a@x>'], autoSubmitted: 'auto-replied', hasAttachments: true })
  })

  it('aprueba solo lo seleccionado con una respuesta verificada y crea la intención', async () => {
    const { store, request_id, code, run } = await setup()
    const out = await run([message('gm-hub', [['From', ACCOUNT], ['Message-ID', HUB_ID]], 'cuerpo', ['SENT', 'INBOX']), reply(code, 'aprobar CODE 1')])
    expect(out).toMatchObject({ consumed: 1, rejected: { hub_message: 1 } })
    expect(store.getApprovedItems(request_id).map(item => [item.ordinal, item.state])).toEqual([[1, 'pending']])
  })

  it('un mensaje que no es del usuario, no está en SENT o no responde al outbox no aprueba nada', async () => {
    const { store, request_id, code, run } = await setup()
    const spoof = message('s1', [['From', 'otra@example.com'], ['In-Reply-To', HUB_ID]], `aprobar ${code} 1,2`)
    const draft = message('s2', [['From', ACCOUNT], ['In-Reply-To', HUB_ID]], `aprobar ${code} 1,2`, ['DRAFT'])
    const unrelated = message('s3', [['From', ACCOUNT], ['In-Reply-To', '<otro@x>']], `aprobar ${code} 1,2`)
    const otherThread = message('s4', [['From', ACCOUNT], ['In-Reply-To', HUB_ID]], `aprobar ${code} 1,2`, ['SENT'], 'th-otro')
    const out = await run([spoof, draft, unrelated, otherThread])
    expect(out.consumed).toBe(0)
    expect(out.rejected).toMatchObject({ from: 1, not_sent: 1, not_reply: 1, thread: 1 })
    expect(store.getApprovedItems(request_id)).toEqual([])
  })

  it('un código inválido o una respuesta sin código no aprueban y la compuerta de autoridad frena todo', async () => {
    const { store, request_id, code, run } = await setup()
    expect((await run([reply('2222-2222', 'aprobar CODE 1')])).consumed).toBe(0)
    expect((await run([reply(code, 'ok')])).consumed).toBe(0)
    const gated = await run([reply(code, 'aprobar CODE 1')], 'unavailable')
    expect(gated).toMatchObject({ consumed: 0, rejected: { authority_unavailable: 1 } })
    expect(store.getApprovedItems(request_id)).toEqual([])
  })

  it('repetir el sondeo no duplica la aprobación', async () => {
    const { store, request_id, code, run } = await setup()
    await run([reply(code, 'aprobar CODE 1')])
    const again = await run([reply(code, 'aprobar CODE 1')])
    expect(again.consumed).toBe(0)
    expect(store.getApprovedItems(request_id)).toHaveLength(1)
  })

  it('sin scope de lectura o sin bindings no hay solicitudes a Gmail', async () => {
    const store = new DecisionStore(':memory:', { key: randomBytes(32), exclusions: { async add() {} } })
    let calls = 0
    const fetcher = (async () => { calls++; return new Response('{}') }) as unknown as typeof fetch
    const base = { store, service: new DecisionService(store, async () => 'live'), connectorId: 'c', fetcher }
    expect(await pollGmailReplies({ ...base, google: { granted: () => false, token: async () => 't' } as unknown as GoogleAuth })).toMatchObject({ inspected: 0 })
    expect(await pollGmailReplies({ ...base, google: { granted: () => true, token: async () => 't' } as unknown as GoogleAuth })).toMatchObject({ inspected: 0 })
    expect(calls).toBe(0)
  })
})
