import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { CODE_ALPHABET, codeHmac, deriveCode, formatCode, normalizeCode } from './codes.js'
import { DecisionStore, MAX_FAILED_ATTEMPTS, ACCOUNT_FAILURE_LIMIT } from './store.js'
import { extractNewText, parseReply, verifyGmailReply, verifySlackReply, type GmailBindingView, type GmailEvidence } from './verifier.js'
import type { Exclusion, ParsedReply, PublicStateSink } from './contract.js'

const key = randomBytes(32)
const OWNER = 'owner-1'
const effect = (n: number) => ({ cloud: 'site', issue_key: `ABC-${n}`, seconds: 1800 * n })
let clock = new Date('2026-10-28T20:00:00.000Z')
const later = (minutes: number) => new Date(clock.getTime() + minutes * 60_000).toISOString()

function setup(extra: { exclusions?: Exclusion[]; mirror?: Array<Record<string, unknown>>; failMirror?: () => boolean } = {}) {
  clock = new Date('2026-10-28T20:00:00.000Z')
  const sink = { async add(entries: Exclusion[]) { extra.exclusions?.push(...entries) } }
  const publicState: PublicStateSink = { async set(entry) { if (extra.failMirror?.()) throw new Error('down'); extra.mirror?.push(entry) } }
  const store = new DecisionStore(':memory:', { key, now: () => clock, exclusions: sink, publicState })
  const prepare = (run = 'run-1', count = 3) => store.prepareDecision({ run_id: run, artifact_id: `art-${run}`, owner_id: OWNER, project_ids: ['p1'],
    expires_at: later(600), items: Array.from({ length: count }, (_, i) => ({ kind: 'jira_worklog' as const, project_id: 'p1', summary: `item ${i + 1}`, exact_effect: effect(i + 1) })) })
  const activate = async (requestId: string, integration: 'gmail' | 'slack' = 'gmail') => {
    const reserved = await store.reserveDelivery({ request_id: requestId, integration, account: 'me@example.com', correlation: `<hub-${requestId}@hub>`,
      ...(integration === 'slack' ? { conversation: 'D1' } : {}), provenance: 'test' })
    await store.recordNative(reserved.delivery_id, { native_id: `native-${requestId}`, thread_id: `thread-${requestId}`, delivery_ref: '1700000000.000100' })
    return reserved
  }
  return { store, prepare, activate }
}
const reply = (store: DecisionStore, bindingId: string, id: string, parsed: ParsedReply) =>
  store.consumeReply({ integration: 'gmail', account: 'me@example.com', native_message_id: id, binding_id: bindingId, parsed })

describe('códigos', () => {
  it('derivan de forma determinista, legible y sin símbolos ambiguos', () => {
    const a = deriveCode(key, OWNER, 'req', 1, 0), b = deriveCode(key, OWNER, 'req', 1, 0)
    expect(a).toBe(b)
    expect(a).toHaveLength(8)
    expect([...a].every(char => CODE_ALPHABET.includes(char))).toBe(true)
    expect(deriveCode(key, OWNER, 'req', 1, 1)).not.toBe(a)
    expect(deriveCode(key, OWNER, 'req2', 1, 0)).not.toBe(a)
    expect(deriveCode(randomBytes(32), OWNER, 'req', 1, 0)).not.toBe(a)
    expect(normalizeCode(formatCode(a))).toBe(a)
    expect(normalizeCode(a.toLowerCase().replace(/^(....)/, '$1 '))).toBe(a)
    expect(normalizeCode('0000-0000')).toBeNull()
  })
  it('el HMAC depende del dueño', () => {
    expect(codeHmac(key, 'a', 'ABCDEFGH')).not.toBe(codeHmac(key, 'b', 'ABCDEFGH'))
  })
})

describe('gramática de respuestas', () => {
  it.each([
    ['aprobar K7P4-M2XN 1,3', { kind: 'approve', code: 'K7P4M2XN', items: [1, 3] }],
    ['Aprobar k7p4 m2xn 1-3', { kind: 'approve', code: 'K7P4M2XN', items: [1, 2, 3] }],
    ['K7P4-M2XN ok', { kind: 'approve', code: 'K7P4M2XN', items: 'all' }],
    ['K7P4-M2XN sí.', { kind: 'approve', code: 'K7P4M2XN', items: 'all' }],
    ['rechazar K7P4-M2XN 2', { kind: 'reject', code: 'K7P4M2XN', items: [2] }],
    ['hoy no', { kind: 'reject', code: null, items: 'all' }],
    ['no', { kind: 'reject', code: null, items: 'all' }],
    ['K7P4-M2XN 2=1.5', { kind: 'revise', code: 'K7P4M2XN', ordinal: 2, value: '1.5' }],
    ['K7P4-M2XN 2=1,5', { kind: 'revise', code: 'K7P4M2XN', ordinal: 2, value: '1.5' }],
  ] as Array<[string, ParsedReply]>)('acepta %s', (text, expected) => { expect(parseReply(text)).toEqual(expected) })
  it.each(['ok', 'sí', 'aprobar 1,3', 'aprobar K7P4-M2XN', 'dale', 'aprobar K7P4-M2XN 0', 'aprobar 0000-0000 1', 'aprobar K7P4-M2XN 1\nrechazar K7P4-M2XN 2', ''])(
    'no aprueba con «%s»', text => { expect(parseReply(text).kind).toBe('unrecognized') })
  it('limita la selección', () => { expect(parseReply('aprobar K7P4-M2XN 1-200').kind).toBe('unrecognized') })
})

describe('texto nuevo de un correo', () => {
  it('toma la línea anterior a la cita', () => {
    expect(extractNewText('aprobar K7P4-M2XN 1\n\nEl mar, 28 oct 2026 a las 8:00, Hub <me@example.com> escribió:\n> Responde: aprobar K7P4-M2XN 1,2')).toBe('aprobar K7P4-M2XN 1')
    expect(extractNewText('K7P4-M2XN ok\n\n-- \nLuciano')).toBe('K7P4-M2XN ok')
    expect(extractNewText('K7P4-M2XN ok\nEnviado desde mi iPhone\n\nOn Tue, Oct 28, 2026 at 8:00 AM Hub wrote:\n> x')).toBe('K7P4-M2XN ok')
  })
  it('descarta lo ambiguo: citas sin marca, varias líneas o reenvíos', () => {
    expect(extractNewText('Responde: aprobar K7P4-M2XN 1,2\nsegunda línea')).toBeNull()
    expect(extractNewText('> aprobar K7P4-M2XN 1')).toBeNull()
    expect(extractNewText('')).toBeNull()
    expect(extractNewText('---------- Forwarded message ---------\nFrom: x\nResponde: aprobar K7P4-M2XN 1')).toBeNull()
  })
})

describe('verificación de binding', () => {
  const binding: GmailBindingView = { account: 'me@example.com', threadId: 'T1', correlations: ['<hub-1@hub>'], hubNativeIds: ['hub-native'] }
  const good: GmailEvidence = { id: 'm1', threadId: 'T1', labelIds: ['SENT'], from: ['me@example.com'], inReplyTo: ['<hub-1@hub>'], references: [], autoSubmitted: null, hasAttachments: false,
    bodyText: 'aprobar K7P4-M2XN 1' }
  it('acepta una respuesta SENT de la cuenta en el hilo', () => { expect(verifyGmailReply(good, binding)).toEqual({ ok: true, parsed: { kind: 'approve', code: 'K7P4M2XN', items: [1] } }) })
  it.each([
    ['sin SENT', { labelIds: ['INBOX'] }, 'not_sent'],
    ['borrador', { labelIds: ['SENT', 'DRAFT'] }, 'not_sent'],
    ['otro remitente', { from: ['otro@example.com'] }, 'from'],
    ['plus-addressing', { from: ['me+x@example.com'] }, 'from'],
    ['dos From', { from: ['me@example.com', 'x@example.com'] }, 'from'],
    ['otro hilo', { threadId: 'T2' }, 'thread'],
    ['sin relación con el outbox', { inReplyTo: ['<otro@x>'] }, 'not_reply'],
    ['mensaje del Hub', { id: 'hub-native' }, 'hub_message'],
    ['automático', { autoSubmitted: 'auto-replied' }, 'automatic'],
    ['adjuntos', { hasAttachments: true }, 'attachments'],
    ['cuerpo ambiguo', { bodyText: 'hola\naprobar K7P4-M2XN 1' }, 'ambiguous_text'],
  ] as Array<[string, Partial<GmailEvidence>, string]>)('rechaza %s', (_name, patch, reason) => {
    expect(verifyGmailReply({ ...good, ...patch }, binding)).toEqual({ ok: false, reason })
  })
  it('acepta un alias solo si está verificado', () => {
    expect(verifyGmailReply({ ...good, from: ['alias@example.com'] }, { ...binding, verifiedAliases: ['alias@example.com'] }).ok).toBe(true)
  })
  it('una respuesta con References (no In-Reply-To) también vale', () => {
    expect(verifyGmailReply({ ...good, inReplyTo: [], references: ['<x@y>', '<hub-1@hub>'] }, binding).ok).toBe(true)
  })
  const slack = { channel: 'D1', team: 'T', userId: 'U1', deliveryTs: '1.1', hubTs: ['1.1', '1.2'] }
  const message = { channel: 'D1', team: 'T', user: 'U1', ts: '2.0', thread_ts: '1.1', text: 'aprobar K7P4-M2XN 1' }
  it('Slack: acepta la respuesta del usuario en el hilo de la entrega', () => { expect(verifySlackReply(message, slack).ok).toBe(true) })
  it.each([
    ['bot', { bot_id: 'B1' }, 'bot'], ['app', { app_id: 'A1' }, 'bot'], ['subtipo', { subtype: 'channel_join' }, 'bot'], ['oculto', { hidden: true }, 'bot'],
    ['editado', { edited: { ts: '3' } }, 'edited'], ['otro canal', { channel: 'D2' }, 'channel'], ['otro usuario', { user: 'U2' }, 'user'], ['otro equipo', { team: 'T2' }, 'team'],
    ['fuera del hilo', { thread_ts: undefined }, 'not_in_thread'], ['otro hilo', { thread_ts: '9.9' }, 'not_in_thread'], ['mensaje del Hub', { ts: '1.2' }, 'hub_message'],
  ] as Array<[string, Record<string, unknown>, string]>)('Slack: rechaza %s', (_name, patch, reason) => {
    expect(verifySlackReply({ ...message, ...patch } as never, slack)).toEqual({ ok: false, reason })
  })
  it('Slack: sin identidad fijada no hay aprobación', () => { expect(verifySlackReply(message, { ...slack, userId: null })).toEqual({ ok: false, reason: 'binding_incomplete' }) })
})

describe('DecisionStore', () => {
  it('prepareDecision es idempotente por run y rechaza contenido distinto', () => {
    const { store, prepare } = setup()
    const first = prepare(), second = prepare()
    expect(second.request_id).toBe(first.request_id)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(() => prepare('run-1', 2)).toThrow(/otro contenido/)
    expect(store.publicRequest(first.request_id).items.map(item => item.state)).toEqual(['pending', 'pending', 'pending'])
  })
  it('el código se reconstruye igual y no queda en claro en el archivo', () => {
    const { store, prepare } = setup()
    const { request_id } = prepare()
    const code = store.codeFor(request_id)
    expect(store.codeFor(request_id)).toBe(code)
    const dump = JSON.stringify((store as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db.prepare('SELECT * FROM decision_requests').all())
    expect(dump).not.toContain(normalizeCode(code)!)
  })
  it('reserva el outbox antes de enviar y la exclusión se registra antes del recibo nativo', async () => {
    const exclusions: Exclusion[] = []
    const { store, prepare } = setup({ exclusions })
    const { request_id } = prepare()
    const reserved = await store.reserveDelivery({ request_id, integration: 'gmail', account: 'me@example.com', correlation: '<hub-1@hub>', provenance: 'oauth' })
    expect(exclusions).toEqual([{ integration: 'gmail', account: 'me@example.com', kind: 'rfc_message_id', native_id: '<hub-1@hub>' }])
    expect(store.bindingOf(request_id)?.state).toBe('reserved')
    expect(store.isExcluded({ integration: 'gmail', account: 'me@example.com', kind: 'rfc_message_id', native_id: '<hub-1@hub>' })).toBe(true)
    expect((await store.reserveDelivery({ request_id, integration: 'gmail', account: 'me@example.com', correlation: '<otro@hub>', provenance: 'oauth' })).delivery_id).toBe(reserved.delivery_id)
    await store.recordNative(reserved.delivery_id, { native_id: 'gm-1', thread_id: 'th-1' })
    expect(exclusions.slice(1)).toEqual([{ integration: 'gmail', account: 'me@example.com', kind: 'message', native_id: 'gm-1' }, { integration: 'gmail', account: 'me@example.com', kind: 'thread', native_id: 'th-1' }])
    expect(store.bindingOf(request_id)).toMatchObject({ state: 'active', conversation: 'th-1' })
    await expect(store.reserveDelivery({ request_id, integration: 'gmail', account: 'me@example.com', correlation: '<x@hub>', provenance: 'oauth' })).rejects.toThrow(/delivery_already_dispatched/)
  })
  it('un envío incierto deja el binding en cuarentena y no admite respuestas', async () => {
    const { store, prepare } = setup()
    const { request_id } = prepare()
    const reserved = await store.reserveDelivery({ request_id, integration: 'gmail', account: 'me@example.com', correlation: '<hub-1@hub>', provenance: 'oauth' })
    store.markDeliveryUncertain(reserved.delivery_id)
    expect(store.bindingOf(request_id)?.state).toBe('quarantined')
    expect(reply(store, reserved.binding_id, 'in-1', { kind: 'approve', code: normalizeCode(store.codeFor(request_id))!, items: 'all' }).outcome).toBe('binding_unavailable')
    await expect(store.reserveDelivery({ request_id, integration: 'gmail', account: 'me@example.com', correlation: '<x@hub>', provenance: 'oauth' })).rejects.toThrow(/delivery_already_dispatched/)
  })
  it('una falla comprobada permite reservar de nuevo', async () => {
    const { store, prepare } = setup()
    const { request_id } = prepare()
    const first = await store.reserveDelivery({ request_id, integration: 'gmail', account: 'me@example.com', correlation: '<hub-1@hub>', provenance: 'oauth' })
    store.markDeliveryFailed(first.delivery_id)
    const second = await store.reserveDelivery({ request_id, integration: 'gmail', account: 'me@example.com', correlation: '<hub-2@hub>', provenance: 'oauth' })
    expect(second.delivery_id).not.toBe(first.delivery_id)
  })

  it('aprueba una selección con el código correcto y crea una intención por ítem', async () => {
    const { store, prepare, activate } = setup()
    const { request_id } = prepare()
    const { binding_id } = await activate(request_id)
    const code = normalizeCode(store.codeFor(request_id))!
    const result = reply(store, binding_id, 'in-1', { kind: 'approve', code, items: [1, 3] })
    expect(result.outcome).toBe('approved')
    expect(result.approved?.map(item => item.ordinal)).toEqual([1, 3])
    expect(store.publicRequest(request_id).items.map(item => item.state)).toEqual(['approved', 'pending', 'approved'])
    expect(store.pendingIntents()).toHaveLength(2)
  })
  it('un duplicado devuelve el resultado previo sin crear otra intención', async () => {
    const { store, prepare, activate } = setup()
    const { request_id } = prepare()
    const { binding_id } = await activate(request_id)
    const parsed: ParsedReply = { kind: 'approve', code: normalizeCode(store.codeFor(request_id))!, items: [1] }
    expect(reply(store, binding_id, 'in-1', parsed).outcome).toBe('approved')
    expect(reply(store, binding_id, 'in-1', parsed).outcome).toBe('duplicate')
    expect(store.pendingIntents()).toHaveLength(1)
  })
  it('un segundo mensaje no aprueba dos veces el mismo ítem', async () => {
    const { store, prepare, activate } = setup()
    const { request_id } = prepare()
    const { binding_id } = await activate(request_id)
    const parsed: ParsedReply = { kind: 'approve', code: normalizeCode(store.codeFor(request_id))!, items: [1] }
    reply(store, binding_id, 'in-1', parsed)
    expect(reply(store, binding_id, 'in-2', parsed).outcome).toBe('bad_selection')
    expect(store.pendingIntents()).toHaveLength(1)
  })
  it('un código erróneo cuenta, y a los cinco intentos la solicitud se bloquea', async () => {
    const { store, prepare, activate } = setup()
    const { request_id } = prepare()
    const { binding_id } = await activate(request_id)
    const wrong: ParsedReply = { kind: 'approve', code: '22222222', items: 'all' }
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) expect(reply(store, binding_id, `bad-${i}`, wrong).outcome).toBe('invalid_code')
    expect(reply(store, binding_id, 'bad-last', wrong).outcome).toBe('locked')
    const good: ParsedReply = { kind: 'approve', code: normalizeCode(store.codeFor(request_id))!, items: 'all' }
    expect(reply(store, binding_id, 'good', good).outcome).toBe('locked')
    expect(store.pendingIntents()).toHaveLength(0)
  })
  it('limita los fallos por cuenta', async () => {
    const { store, prepare, activate } = setup()
    const ids: string[] = []
    for (let i = 0; i < 4; i++) { const { request_id } = prepare(`run-${i}`, 1); ids.push((await activate(request_id)).binding_id) }
    const wrong: ParsedReply = { kind: 'approve', code: '22222222', items: 'all' }
    let rate = 0
    for (let i = 0; i < ACCOUNT_FAILURE_LIMIT + 2; i++) if (reply(store, ids[Math.floor(i / 3)]!, `w-${i}`, wrong).outcome === 'rate_limited') rate++
    expect(rate).toBeGreaterThan(0)
  })
  it('«no» rechaza sin código y no crea intenciones', async () => {
    const { store, prepare, activate } = setup()
    const { request_id } = prepare()
    const { binding_id } = await activate(request_id)
    const result = reply(store, binding_id, 'in-1', { kind: 'reject', code: null, items: 'all' })
    expect(result).toMatchObject({ outcome: 'rejected', rejected: [1, 2, 3] })
    expect(store.pendingIntents()).toHaveLength(0)
    expect(store.publicRequest(request_id).state).toBe('closed')
  })
  it('una solicitud vencida o revocada no se consume', async () => {
    const { store, prepare, activate } = setup()
    const a = prepare('run-a', 1), b = prepare('run-b', 1)
    const bindingA = (await activate(a.request_id)).binding_id, bindingB = (await activate(b.request_id)).binding_id
    store.revokeRequest(b.request_id)
    expect(reply(store, bindingB, 'rv', { kind: 'approve', code: normalizeCode(store.codeFor(b.request_id))!, items: 'all' }).outcome).toBe('revoked')
    clock = new Date(clock.getTime() + 11 * 3600_000)
    expect(reply(store, bindingA, 'ex', { kind: 'approve', code: normalizeCode(store.codeFor(a.request_id))!, items: 'all' }).outcome).toBe('expired')
    expect(store.pendingIntents()).toHaveLength(0)
  })
  it('una corrección crea una revisión que exige aprobar de nuevo y deja la anterior sin efecto', async () => {
    const { store, prepare, activate } = setup()
    const { request_id } = prepare()
    const { binding_id } = await activate(request_id)
    const code = normalizeCode(store.codeFor(request_id))!
    expect(reply(store, binding_id, 'rev', { kind: 'revise', code, ordinal: 2, value: '1.5' })).toMatchObject({ outcome: 'revision_requested', revision: { ordinal: 2, value: '1.5' } })
    const next = store.reviseRequest(request_id, 2, { ...effect(2), seconds: 5400 })
    expect(next.revision).toBe(2)
    expect(store.publicRequest(request_id).state).toBe('superseded')
    expect(store.publicRequest(request_id).items.every(item => item.state === 'superseded')).toBe(true)
    expect(store.codeFor(next.request_id)).not.toBe(store.codeFor(request_id))
    expect(reply(store, binding_id, 'old', { kind: 'approve', code, items: 'all' }).outcome).toBe('revoked')
    expect(store.pendingIntents()).toHaveLength(0)
  })
  it('un efecto incierto no puede aprobarse de nuevo desde otra solicitud', async () => {
    const { store, prepare, activate } = setup()
    const a = prepare('run-a', 1), b = prepare('run-b', 1)
    const bindingA = (await activate(a.request_id)).binding_id
    const approvedA = reply(store, bindingA, 'a', { kind: 'approve', code: normalizeCode(store.codeFor(a.request_id))!, items: 'all' })
    const intent = approvedA.approved![0]!.intent_id
    const claimed = store.claimIntent(intent, 0) as { generation: number }
    expect(store.markDispatching(intent, claimed.generation)).toBe('ok')
    store.completeIntent(intent, claimed.generation, { state: 'uncertain', error_code: 'timeout' })
    const bindingB = (await activate(b.request_id)).binding_id
    const result = reply(store, bindingB, 'b', { kind: 'approve', code: normalizeCode(store.codeFor(b.request_id))!, items: 'all' })
    expect(result.blocked_uncertain).toEqual([1])
    expect(result.approved).toEqual([])
    expect(store.publicRequest(b.request_id).items[0]!.state).toBe('blocked_uncertain')
  })

  it('el reclamo usa fencing y no deja avanzar a una generación vieja', async () => {
    const { store, prepare, activate } = setup()
    const { request_id } = prepare('run-1', 1)
    const { binding_id } = await activate(request_id)
    const intent = reply(store, binding_id, 'a', { kind: 'approve', code: normalizeCode(store.codeFor(request_id))!, items: 'all' }).approved![0]!.intent_id
    expect(store.claimIntent(intent, 5)).toEqual({ rejected: 'stale_generation' })
    const first = store.claimIntent(intent, 0) as { generation: number }
    expect(first.generation).toBe(1)
    expect(store.claimIntent(intent, 0)).toEqual({ rejected: 'stale_generation' })
    expect(store.markDispatching(intent, 9)).toBe('stale')
    expect(store.markDispatching(intent, 1)).toBe('ok')
    expect(store.completeIntent(intent, 0, { state: 'succeeded' })).toBe(false)
    expect(store.completeIntent(intent, 1, { state: 'succeeded', remote_ref: 'w-1' })).toBe(true)
    expect(store.intent(intent)?.state).toBe('succeeded')
  })
  it('la caída entre dispatching y el recibo deja el efecto incierto; prepared vuelve a pending', async () => {
    const { store, prepare, activate } = setup()
    const { request_id } = prepare('run-1', 2)
    const { binding_id } = await activate(request_id)
    const approved = reply(store, binding_id, 'a', { kind: 'approve', code: normalizeCode(store.codeFor(request_id))!, items: 'all' }).approved!
    const first = store.claimIntent(approved[0]!.intent_id, 0) as { generation: number }
    store.markDispatching(approved[0]!.intent_id, first.generation)
    store.claimIntent(approved[1]!.intent_id, 0)
    expect(store.recover()).toEqual({ uncertain: 1, reopened: 1 })
    expect(store.intent(approved[0]!.intent_id)?.state).toBe('uncertain')
    expect(store.intent(approved[1]!.intent_id)?.state).toBe('pending')
  })
  it('revocar todo no toca lo que ya despachó', async () => {
    const { store, prepare, activate } = setup()
    const { request_id } = prepare('run-1', 2)
    const { binding_id } = await activate(request_id)
    const approved = reply(store, binding_id, 'a', { kind: 'approve', code: normalizeCode(store.codeFor(request_id))!, items: 'all' }).approved!
    const first = store.claimIntent(approved[0]!.intent_id, 0) as { generation: number }
    store.markDispatching(approved[0]!.intent_id, first.generation)
    store.revokeAll()
    expect(store.intent(approved[0]!.intent_id)?.state).toBe('dispatching')
    expect(store.intent(approved[1]!.intent_id)).toMatchObject({ state: 'rejected_before_dispatch', error_code: 'revoked' })
  })
  it('una intención aprobada que venció no se reclama', async () => {
    const { store, prepare, activate } = setup()
    const { request_id } = prepare('run-1', 1)
    const { binding_id } = await activate(request_id)
    const intent = reply(store, binding_id, 'a', { kind: 'approve', code: normalizeCode(store.codeFor(request_id))!, items: 'all' }).approved![0]!.intent_id
    clock = new Date(clock.getTime() + 11 * 3600_000)
    expect(store.claimIntent(intent, 0)).toEqual({ rejected: 'expired' })
  })
  it('el espejo público no lleva códigos y se reintenta si falla', async () => {
    const mirror: Array<Record<string, unknown>> = []
    let failing = true
    const { store, prepare, activate } = setup({ mirror, failMirror: () => failing })
    const { request_id } = prepare('run-1', 2)
    const { binding_id } = await activate(request_id)
    await store.flushMirror()
    expect(mirror).toHaveLength(0)
    failing = false
    await store.flushMirror()
    expect(mirror.map(entry => entry['state'])).toEqual(['proposed', 'proposed'])
    reply(store, binding_id, 'a', { kind: 'approve', code: normalizeCode(store.codeFor(request_id))!, items: [1] })
    await store.flushMirror()
    expect(mirror.at(-1)).toMatchObject({ ordinal: 1, state: 'approved' })
    expect(JSON.stringify(mirror)).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/)
  })
  it('una referencia desconocida no tiene autoridad y los aprobados se listan sin efecto', async () => {
    const { store, prepare, activate } = setup()
    const { request_id } = prepare('run-1', 2)
    const { binding_id } = await activate(request_id)
    expect(store.authorityOf(request_id)).toBe('verified')
    expect(store.authorityOf('desconocida')).toBe('authority_unavailable')
    reply(store, binding_id, 'a', { kind: 'approve', code: normalizeCode(store.codeFor(request_id))!, items: [2] })
    const approved = store.getApprovedItems(request_id)
    expect(approved).toHaveLength(1)
    expect(approved[0]).toMatchObject({ ordinal: 2, kind: 'jira_worklog', state: 'pending' })
    expect(Object.keys(approved[0]!)).not.toContain('effect')
    expect(store.publicRequest(request_id).canonical_digest).toMatch(/^[0-9a-f]{64}$/)
  })
  it('un mensaje entrante consumido queda excluido de la ingesta', async () => {
    const { store, prepare, activate } = setup()
    const { request_id } = prepare('run-1', 1)
    const { binding_id } = await activate(request_id)
    reply(store, binding_id, 'in-9', { kind: 'unrecognized', reason: 'no_command' })
    expect(store.isExcluded({ integration: 'gmail', account: 'me@example.com', kind: 'message', native_id: 'in-9' })).toBe(true)
    expect(store.isExcluded({ integration: 'gmail', account: 'me@example.com', kind: 'thread', native_id: `thread-${request_id}` })).toBe(true)
    expect(store.isExcluded({ integration: 'gmail', account: 'me@example.com', kind: 'message', native_id: 'otro' })).toBe(false)
  })
})
