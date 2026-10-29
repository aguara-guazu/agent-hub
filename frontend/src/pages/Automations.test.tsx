import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Route, Routes } from 'react-router-dom'
import { DeliveriesPage, DeliveryDetailPage, SchedulesPage, describeNextRun, describeRecurrence, generatedNote } from './Automations'
import type { RawRunDetail, RawRunListItem, ScheduleView } from '../lib/automations'
import type { User } from '../lib/types'
import { buttonByText, click, flush, installFetch, jsonResponse, need, q, qa, renderWithProviders, setupDom, setValue, teardownDom, textOf } from '../test-utils'
import type { ApiCall } from '../test-utils'

const user: User = { id: 'u1', email: 'a@b.c', full_name: 'Ana', org_role: 'member', is_active: true, squads: [], organization: 'Local' } as User

function schedule(overrides: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: 's1', scope: 'owner', project_id: null, template: 'daily_brief', template_version: 1, kind: 'synthesis', title: 'Brief diario',
    recurrence: { type: 'daily', time: '08:00', weekdays: [1, 2, 3, 4, 5] }, timezone: 'America/Argentina/Buenos_Aires',
    next_run_at: '2026-10-29T11:00:00Z', next_run_local: '2026-10-29T08:00:00-03:00', delivery: ['hub_inbox', 'app_window', 'gmail_self'],
    delivery_unavailable: ['gmail_self'], state: 'active', paused_by: null, revision: 3, human_override: [],
    created_by: { kind: 'agent', agent_id: 'a1', label: 'Quilla' }, admission_note: 'Dentro de los límites del Hub: solo lectura, entrega solo a ti', ...overrides,
  }
}

/** Fila plana tal como la devuelve `GET /api/memory/schedules/runs`. */
function run(overrides: Partial<RawRunListItem> = {}): RawRunListItem {
  return { id: 'r1', schedule_id: 's1', artifact_kind: 'brief', title: 'Brief · martes 28/10', schedule_title: 'Brief diario', project_id: null, scheduled_for: '2026-10-28T11:00:00Z', started_at: '2026-10-28T11:00:05Z', finished_at: null,
    state: 'succeeded', trigger: 'clock', skip_reason: null, deferred_reason: null, read_at: null, ...overrides }
}

let calls: ApiCall[]
beforeEach(() => { setupDom(); calls = [] })
afterEach(teardownDom)

describe('formatos', () => {
  it('describe la recurrencia y la próxima ejecución', () => {
    expect(describeRecurrence({ type: 'daily', time: '08:00', weekdays: [1, 2, 3, 4, 5] })).toBe('Lunes a viernes a las 08:00')
    expect(describeRecurrence({ type: 'daily', time: '17:30' })).toBe('Todos los días a las 17:30')
    expect(describeRecurrence({ type: 'daily', time: '09:00', weekdays: [1, 3] })).toBe('L X a las 09:00')
    expect(describeRecurrence({ type: 'interval', minutes: 120 })).toBe('Cada 2 h')
    const now = Date.parse('2026-10-28T20:00:00Z')
    expect(describeNextRun('2026-10-29T10:00:00Z', now)).toContain('en 14 h')
    expect(describeNextRun(null, now)).toBe('—')
  })
})

describe('formato de tiempos de una entrega', () => {
  it('sólo marca «generado» con retraso real, al encender o a mano', () => {
    const base = { scheduled_for: '2026-10-28T11:00:00Z', state: 'succeeded' as const }
    expect(generatedNote({ ...base, trigger: 'clock', started_at: '2026-10-28T11:00:05Z' })).toBe('')
    expect(generatedNote({ ...base, trigger: 'clock', started_at: '2026-10-28T12:14:00Z' })).toContain('con retraso')
    expect(generatedNote({ ...base, trigger: 'misfire', started_at: '2026-10-28T12:14:00Z' })).toContain('al encender')
    expect(generatedNote({ ...base, trigger: 'run_now', started_at: '2026-10-28T11:00:05Z' })).toBe(' · ejecutado manualmente')
    expect(generatedNote({ ...base, trigger: 'clock', started_at: null, state: 'deferred' })).toContain('diferido')
  })
})

describe('Programaciones', () => {
  function mockSchedules(items: ScheduleView[], extra: { constraints?: unknown[]; settings?: object } = {}) {
    return installFetch({ user, handle: call => {
      calls.push(call)
      if (call.path === '/memory/schedules') return jsonResponse({ items, total: items.length, limit: 200, offset: 0, delivery_available: { gmail_self: { available: false, reason: 'scope_missing' }, slack_self: { available: true } } })
      if (call.path === '/memory/schedule-constraints') return jsonResponse({ items: extra.constraints ?? [] })
      if (call.path === '/memory/schedules/delivery-channels') return jsonResponse({ items: [{ channel: 'app', available: true }, { channel: 'gmail', available: true, destination: 'ana@example.com' }, { channel: 'slack', available: false, reason: 'not_connected' }] })
      if (call.path === '/automations') return jsonResponse({ automations_enabled: true, notify_schedule_created: true, notify_delivery: true, workday_hours: 9, keep_awake: true, ...extra.settings })
      if (call.path.startsWith('/memory/schedules/s1/')) return jsonResponse(schedule())
      return undefined
    } })
  }

  it('muestra la automatización con su origen, el motivo de no pedir aprobación y los canales faltantes', async () => {
    mockSchedules([schedule()])
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules' })
    const text = textOf(container)
    expect(text).toContain('Brief diario')
    expect(text).toContain('Lunes a viernes a las 08:00')
    expect(text).toContain('Quilla')
    expect(text).toContain('Dentro de los límites del Hub: solo lectura, entrega solo a ti')
    expect(text).toContain('Las automatizaciones corren solo mientras Agent Hub está abierto')
    expect(qa(container, '.chip').find(chip => chip.textContent?.includes('Gmail'))?.getAttribute('title')).toContain('Falta autorizar el envío')
  })

  it('marca los campos que la persona fijó y muestra al sistema como creador', async () => {
    mockSchedules([schedule({ human_override: ['recurrence', 'delivery'], created_by: { kind: 'system', agent_id: null, label: 'Hub' } })])
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules' })
    const text = textOf(container)
    expect(text).toContain('horario fijado por ti')
    expect(text).toContain('Canales fijados por ti')
    expect(text).toContain('Agent Hub')
    expect(text).not.toContain('Quilla')
  })

  it('el tipo se rotula con o sin modelo y la última ejecución abre su entrega', async () => {
    mockSchedules([schedule({ kind: 'notice', last_run: { id: 'r7', state: 'succeeded', scheduled_for: '2026-10-28T11:00:00Z', trigger: 'clock' } })])
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules' })
    expect(textOf(container)).toContain('Sin modelo')
    expect(textOf(container)).not.toContain('Aviso')
    expect(qa<HTMLAnchorElement>(container, 'a').some(anchor => anchor.getAttribute('href') === '/deliveries/r7')).toBe(true)
  })

  it('Canales guarda App fija más los canales elegidos y no deja marcar uno no disponible', async () => {
    const api = mockSchedules([schedule({ delivery: ['hub_inbox', 'app_window'] })])
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules' })
    await click(buttonByText(container, 'Canales'))
    await flush(3)
    const boxes = qa<HTMLInputElement>(document.body, '.automations-form input[type="checkbox"]')
    expect(boxes[0]!.disabled).toBe(true)
    expect(boxes[2]!.disabled).toBe(true)
    expect(textOf(document.body)).toContain('No está conectado')
    expect(document.body.querySelector('.automations-form a[href$="/catalog"]')).not.toBeNull()
    await click(boxes[1])
    await click(buttonByText(document.body, 'Guardar'))
    expect(api.lastCall('/memory/schedules/s1/delivery', 'PUT')?.body).toEqual({ expected_revision: 3, delivery: ['hub_inbox', 'app_window', 'gmail_self'] })
  })

  it('Gmail sin el envío autorizado ofrece Autorizar en Canales y no deja marcarlo', async () => {
    installFetch({ user, handle: call => {
      if (call.path === '/memory/schedules') return jsonResponse({ items: [schedule({ delivery: ['hub_inbox', 'app_window'] })], total: 1, limit: 200, offset: 0 })
      if (call.path === '/memory/schedule-constraints') return jsonResponse({ items: [] })
      if (call.path === '/memory/schedules/delivery-channels') return jsonResponse({ items: [{ channel: 'app', available: true }, { channel: 'gmail', available: false, reason: 'scope_missing', destination: 'ana@example.com' }, { channel: 'slack', available: false, reason: 'not_connected' }] })
      if (call.path === '/memory/call') return jsonResponse((call.body as { operation: string }).operation === 'list_connectors' ? [{ id: 'g1', provider: 'google', name: 'A', config: {}, project_ids: [], interval_minutes: 30, enabled: true, account_email: 'ana@example.com' }] : {})
      if (call.path === '/automations') return jsonResponse({ automations_enabled: true, notify_schedule_created: true, notify_delivery: true, workday_hours: 9, keep_awake: true })
      return undefined
    } })
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules' })
    await click(buttonByText(container, 'Canales'))
    await flush(3)
    const boxes = qa<HTMLInputElement>(document.body, '.automations-form input[type="checkbox"]')
    expect(boxes[1]!.disabled).toBe(true)
    expect(textOf(document.body)).toContain('Gmail a mi propia cuenta (ana@example.com)')
    expect(textOf(document.body)).toContain('Falta autorizar el envío')
    expect(buttonByText(document.body, 'Autorizar')).toBeTruthy()
  })

  function mockGmailSetup(items: ScheduleView[], gmail: { available: boolean; reason?: string; destination?: string }) {
    return installFetch({ user, handle: call => {
      calls.push(call)
      if (call.path === '/memory/schedules') return jsonResponse({ items, total: items.length, limit: 200, offset: 0, delivery_available: { gmail_self: gmail, slack_self: { available: false, reason: 'not_connected' } } })
      if (call.path === '/memory/schedule-constraints') return jsonResponse({ items: [] })
      if (call.path === '/automations') return jsonResponse({ automations_enabled: true, notify_schedule_created: true, notify_delivery: true, workday_hours: 9, keep_awake: true })
      if (call.path === '/memory/call') return jsonResponse((call.body as { operation: string }).operation === 'list_connectors' ? [{ id: 'g1', provider: 'google', name: 'A', config: {}, project_ids: [], interval_minutes: 30, enabled: true, account_email: 'ana@example.com' }] : {})
      if (call.path === '/memory/connectors/g1/google/start') return jsonResponse({ authorization_url: 'https://accounts.google.com/o/oauth2/auth?x=1', gmail_send: true })
      if (call.path.startsWith('/memory/schedules/s')) return jsonResponse(schedule())
      return undefined
    } })
  }

  it('el aviso de Gmail sin autorizar abre el asistente: explica el permiso, abre Google y espera la confirmación', async () => {
    const api = mockGmailSetup([schedule({ delivery: ['hub_inbox', 'app_window'], delivery_unavailable: [] })], { available: false, reason: 'scope_missing', destination: 'ana@example.com' })
    const open = vi.fn()
    vi.stubGlobal('open', open)
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules' })
    await flush(3)
    expect(textOf(container)).toContain('Recibe el brief y el cierre en tu correo')
    await click(buttonByText(container, 'Autorizar Gmail'))
    await flush(3)
    expect(textOf(document.body)).toContain('1. Permiso')
    expect(textOf(document.body)).toContain('ana@example.com; nunca a terceros')
    await click(buttonByText(document.body, 'Continuar con Google'))
    await flush(2)
    expect(api.lastCall('/memory/connectors/g1/google/start', 'POST')?.body).toEqual({ gmail_send: true })
    expect(open).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth?x=1', '_blank', 'noopener,noreferrer')
    expect(textOf(document.body)).toContain('Completa el permiso en el navegador')
  })

  it('con Gmail listo y sin usar, el asistente agrega Gmail a las automatizaciones elegidas conservando sus otros canales', async () => {
    const api = mockGmailSetup([schedule({ delivery: ['hub_inbox', 'app_window'], delivery_unavailable: [] }),
      schedule({ id: 's2', title: 'Cierre del día', template: 'daily_close', revision: 5, delivery: ['hub_inbox', 'app_window', 'slack_self'], delivery_unavailable: [] })], { available: true, destination: 'ana@example.com' })
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules' })
    await flush(3)
    await click(buttonByText(container, 'Elegir automatizaciones'))
    await flush(2)
    const boxes = qa<HTMLInputElement>(document.body, '[role="dialog"] input[type="checkbox"]')
    expect(boxes.map(box => box.checked)).toEqual([true, true])
    await click(buttonByText(document.body, 'Agregar Gmail'))
    await flush(4)
    expect(api.lastCall('/memory/schedules/s1/delivery', 'PUT')?.body).toEqual({ expected_revision: 3, delivery: ['hub_inbox', 'app_window', 'gmail_self'] })
    expect(api.lastCall('/memory/schedules/s2/delivery', 'PUT')?.body).toEqual({ expected_revision: 5, delivery: ['hub_inbox', 'app_window', 'slack_self', 'gmail_self'] })
  })

  it('«Ahora no» oculta el aviso de Gmail y no llama a nada', async () => {
    const api = mockGmailSetup([schedule({ delivery: ['hub_inbox', 'app_window'], delivery_unavailable: [] })], { available: false, reason: 'scope_missing' })
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules' })
    await flush(3)
    await click(buttonByText(container, 'Ahora no'))
    expect(textOf(container)).not.toContain('Recibe el brief y el cierre en tu correo')
    expect(api.callsTo('/memory/connectors/g1/google/start', 'POST')).toHaveLength(0)
  })

  it('avisa si las automatizaciones están apagadas y explica el estado vacío', async () => {
    mockSchedules([], { settings: { automations_enabled: false } })
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules' })
    expect(textOf(container)).toContain('Automatizaciones desactivadas en Ajustes')
    expect(textOf(container)).toContain('Todavía no hay automatizaciones')
  })

  it('pausar y ejecutar ahora envían la revisión esperada', async () => {
    const api = mockSchedules([schedule()])
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules' })
    await click(buttonByText(container, 'Pausar'))
    expect(api.lastCall('/memory/schedules/s1/pause', 'POST')?.body).toEqual({ expected_revision: 3 })
    await click(buttonByText(container, 'Ejecutar ahora'))
    expect(api.callsTo('/memory/schedules/s1/run_now', 'POST')).toHaveLength(0)
    expect(textOf(document.body)).toContain('fuera de su horario')
    expect(textOf(document.body)).toContain('también se envía a tu propia cuenta')
    await click(buttonByText(need(document.body, '[role="dialog"]'), 'Ejecutar'))
    expect(api.callsTo('/memory/schedules/s1/run_now', 'POST')).toHaveLength(1)
  })

  it('cada fila lleva un id para poder desplazarse hasta ella', async () => {
    mockSchedules([schedule()])
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules' })
    expect(q(container, 'tr#schedule-s1')).not.toBeNull()
  })

  it('cambiar horario guarda una recurrencia diaria con los días elegidos', async () => {
    const api = mockSchedules([schedule()])
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules' })
    await click(buttonByText(container, 'Cambiar horario'))
    await setValue(need(document.body, 'input[type="time"]'), '09:30')
    await click(qa(document.body, '.automations-day').find(chip => chip.textContent === 'V'))
    await click(buttonByText(document.body, 'Guardar'))
    expect(api.lastCall('/memory/schedules/s1/recurrence', 'PUT')?.body).toEqual({ expected_revision: 3, recurrence: { type: 'daily', time: '09:30', weekdays: [1, 2, 3, 4] } })
  })

  it('cancelar pide confirmación y puede restringir todo el tipo en el proyecto', async () => {
    const api = mockSchedules([schedule()])
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules' })
    await click(qa(container, 'button').find(button => button.textContent === 'Cancelar'))
    expect(textOf(document.body)).toContain('El agente no podrá volver a crear esta automatización')
    await click(need(document.body, '.automations-check input'))
    await click(buttonByText(document.body, 'Cancelar automatización'))
    expect(api.lastCall('/memory/schedules/s1/cancel', 'POST')?.body).toEqual({ expected_revision: 3, scope: 'template_project' })
  })

  it('lista las restricciones y permite levantarlas', async () => {
    const api = mockSchedules([], { constraints: [{ id: 'c1', scope: 'target', project_id: null, template: 'daily_close', target_key: 'k', schedule_id: 's9', reason: null, created_at: '2026-10-28T12:00:00Z' }] })
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules' })
    expect(textOf(container)).toContain('Restricciones')
    await click(buttonByText(container, 'Levantar restricción'))
    expect(api.callsTo('/memory/schedule-constraints/c1/lift', 'POST')).toHaveLength(1)
  })

  it('con foco en un schedule lo resalta', async () => {
    mockSchedules([schedule()])
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules?focus=s1' })
    expect(q(container, '.automations-focus')).not.toBeNull()
  })
})

describe('Entregas', () => {
  it('sin deliveries ni decision en la fila no inventa «sin acciones» ni canales', async () => {
    installFetch({ user, handle: call => call.path === '/memory/schedules/runs' ? jsonResponse({ items: [run()], total: 1, limit: 50, offset: 0 }) : undefined })
    const { container } = await renderWithProviders(<DeliveriesPage />, { route: '/deliveries' })
    expect(textOf(container)).toContain('Brief · martes 28/10')
    expect(textOf(container)).not.toContain('sin acciones')
    expect(qa<HTMLAnchorElement>(container, 'a').some(anchor => anchor.getAttribute('href') === '/deliveries/r1')).toBe(true)
  })

  it('lista las entregas con el estado por canal y la decisión', async () => {
    installFetch({ user, handle: call => {
      if (call.path === '/memory/schedules/runs') return jsonResponse({ items: [run({ deliveries: [{ target: 'app_window', state: 'sent' }, { target: 'gmail_self', state: 'failed', error_code: 'token_expired' }], decision: { state: 'pending', expires_at: '2026-10-28T23:59:00Z', approved: 0, total: 2 } })], total: 1, limit: 50, offset: 0 })
      return undefined
    } })
    const { container } = await renderWithProviders(<DeliveriesPage />, { route: '/deliveries' })
    const text = textOf(container)
    expect(text).toContain('Brief · martes 28/10')
    expect(text).toContain('App ✓')
    expect(text).toContain('Gmail falló: token_expired')
    expect(text).toContain('pendiente hasta')
    expect(q(container, '.automations-unread')).not.toBeNull()
  })

  it('resume la decisión de cada fila con los estados reales del run', async () => {
    const rows = [['pending', 'pendiente hasta'], ['dispatching', 'ejecutando 1 de 2'], ['uncertain', 'en reconciliación'], ['expired', 'vencido'], ['done', 'aprobado 2 de 2'], ['none', 'sin acciones']] as const
    installFetch({ user, handle: call => call.path === '/memory/schedules/runs' ? jsonResponse({ items: rows.map(([state], index) => run({ id: `r${index}`, title: `Entrega ${state}`, decision: { state, expires_at: '2026-10-28T23:59:00Z', approved: state === 'dispatching' ? 1 : 2, total: 2 } })), total: rows.length, limit: 50, offset: 0 }) : undefined })
    const { container } = await renderWithProviders(<DeliveriesPage />, { route: '/deliveries' })
    const lines = qa(container, 'tbody tr').map(row => textOf(row))
    rows.forEach(([state, text], index) => expect(lines[index], state).toContain(text))
  })

  it('el filtro de proyecto se manda al core', async () => {
    const api = installFetch({ user, handle: call => {
      if (call.path === '/memory/schedules/runs') return jsonResponse({ items: [], total: 0, limit: 50, offset: 0 })
      if (call.path === '/memory/call') return jsonResponse({ items: [{ id: 'p1', kind: 'project', title: 'Proyecto X', data: {} }], total: 1, limit: 200, offset: 0 })
      return undefined
    } })
    const { container } = await renderWithProviders(<DeliveriesPage />, { route: '/deliveries' })
    const select = qa<HTMLSelectElement>(container, 'select')[1]!
    await setValue(select, 'p1')
    expect(api.calls.some(call => call.url.includes('project_id=p1'))).toBe(true)
  })

  it('el filtro de tipo se manda al core', async () => {
    const api = installFetch({ user, handle: call => call.path === '/memory/schedules/runs' ? jsonResponse({ items: [], total: 0, limit: 50, offset: 0 }) : call.path === '/memory/call' ? jsonResponse({ items: [], total: 0, limit: 200, offset: 0 }) : undefined })
    const { container } = await renderWithProviders(<DeliveriesPage />, { route: '/deliveries' })
    await setValue(need(container, 'select'), 'close')
    expect(api.calls.some(call => call.url.includes('kind=close'))).toBe(true)
  })
})

describe('Detalle de una entrega', () => {
  /** Fila de `hour_estimates` con la que el backend completa el ítem. */
  const estimate = { id: 'e1', estimated_seconds: 5400, basis: 'notas 10:15–12:40', confidence: 'medium', assumptions: ['sin pruebas manuales'], approved_seconds: 3600, sent_seconds: null, state: 'approved', label: 'estimación' }
  /** Detalle tal como lo devuelve `GET …/runs/:runId`: run, artefacto, estados públicos de los ítems y entregas por separado. */
  const detail = {
    run: { id: 'r1', schedule_id: 's1', scheduled_for: '2026-10-28T11:00:00Z', trigger: 'clock', state: 'succeeded', started_at: '2026-10-28T11:00:05Z', finished_at: null, skip_reason: null, deferred_reason: null },
    artifact: { id: 'a1', kind: 'brief', title: 'Brief · martes 28/10', read_at: null, body_md: '# Cierre\n\n<script>alert(1)</script> [Jira](https://example.atlassian.net/browse/ABC-1) [malo](javascript:alert(1))',
      items: [{ ordinal: 1, kind: 'jira_worklog', project_id: 'p', summary: 'ABC-1 worklog 2 h', estimate_id: 'e1', estimate }, { ordinal: 2, kind: 'jira_transition', project_id: 'p', summary: 'ABC-2 → En revisión' }] },
    items: [{ ordinal: 1, kind: 'jira_worklog', state: 'proposed', estimate_id: 'e1' }, { ordinal: 2, kind: 'jira_transition', state: 'proposed' }],
    deliveries: [{ id: 'd1', target: 'app_window', state: 'sent' }, { id: 'd2', target: 'gmail_self', state: 'failed', error_code: 'token_expired' }], incidents: [],
  } as unknown as RawRunDetail
  const decision = { request_id: 'q1', revision: 1, state: 'open', expires_at: '2026-10-28T23:59:00Z', digest: 'd'.repeat(64), authority: 'verified',
    items: [{ ordinal: 1, kind: 'jira_worklog', summary: 'ABC-1 worklog 2 h', state: 'pending', effect_digest: 'e1' }, { ordinal: 2, kind: 'jira_transition', summary: 'ABC-2 → En revisión', state: 'pending', effect_digest: 'e2' }] }

  function mockDetail(overrides: { decision?: object; deliveries?: object[] } = {}) {
    return installFetch({ user, handle: call => {
      calls.push(call)
      if (call.path === '/memory/schedules/deliveries/d2/retry') return jsonResponse({ delivery_id: 'd2', state: 'sent', may_duplicate: overrides.deliveries?.some(item => (item as { state: string }).state === 'uncertain') ?? false })
      if (call.path === '/memory/schedules/runs/r1') return jsonResponse(overrides.deliveries ? { ...detail, deliveries: overrides.deliveries } : detail)
      if (call.path === '/memory/schedules/runs/r1/decision') return jsonResponse({ ...decision, ...overrides.decision })
      if (call.path === '/memory/schedules/runs/r1/read') return jsonResponse({})
      if (call.path.startsWith('/memory/schedules/runs/r1/')) return jsonResponse({ request_id: 'q1', revision: 1, state: 'open', items: [] })
      return undefined
    } })
  }
  const mount = () => renderWithProviders(<Routes><Route path="/deliveries/:runId" element={<DeliveryDetailPage />} /></Routes>, { route: '/deliveries/r1' })

  it('muestra el markdown sin HTML crudo ni enlaces peligrosos y marca la entrega como leída', async () => {
    const api = mockDetail()
    const { container } = await mount()
    expect(textOf(container)).toContain('<script>alert(1)</script>')
    expect(qa(container, 'script')).toHaveLength(0)
    expect(qa<HTMLAnchorElement>(container, '.md a').map(anchor => anchor.getAttribute('href'))).toEqual(['https://example.atlassian.net/browse/ABC-1'])
    expect(api.callsTo('/memory/schedules/runs/r1/read', 'PUT')).toHaveLength(1)
  })

  it('muestra la estimación del backend con lo estimado y lo aprobado por separado y decimales en español', async () => {
    mockDetail()
    const { container } = await mount()
    const text = textOf(container)
    expect(text).toContain('Estimación del agente, no medición: 1,5 h')
    expect(text).toContain('confianza media')
    expect(text).toContain('Base: notas 10:15–12:40')
    expect(text).toContain('Supuestos: sin pruebas manuales')
    expect(text).toContain('Aprobado: 1 h')
    expect(text).not.toContain('Enviado')
  })

  it('aprueba los ítems seleccionados con el digest exacto de la solicitud', async () => {
    const api = mockDetail()
    const { container } = await mount()
    await click(qa(container, '.automations-item input[type="checkbox"]')[1])
    await click(buttonByText(container, 'Aprobar seleccionados'))
    expect(api.lastCall('/memory/schedules/runs/r1/approve', 'POST')?.body).toEqual({ ordinals: [1], digest: 'd'.repeat(64) })
  })

  it('rechazar todo pide confirmación y envía todos los ítems propuestos', async () => {
    const api = mockDetail()
    const { container } = await mount()
    await click(buttonByText(container, 'Rechazar todo'))
    expect(api.callsTo('/memory/schedules/runs/r1/reject', 'POST')).toHaveLength(0)
    expect(textOf(document.body)).toContain('Ninguna de las 2 acciones propuestas se ejecutará')
    await click(buttonByText(need(document.body, '[role="dialog"]'), 'Rechazar todo'))
    expect(api.lastCall('/memory/schedules/runs/r1/reject', 'POST')?.body).toEqual({ ordinals: [1, 2] })
  })

  it('corregir horas envía segundos en múltiplos de media hora', async () => {
    const api = mockDetail()
    const { container } = await mount()
    await setValue(need(container, 'input[aria-label="Horas del ítem 1"]'), '1.5')
    await click(buttonByText(container, 'Corregir'))
    expect(api.lastCall('/memory/schedules/runs/r1/revise', 'POST')?.body).toEqual({ ordinal: 1, seconds: 5400 })
  })

  it('nunca muestra ni copia un código de aprobación, aunque la respuesta traiga una línea', async () => {
    const api = installFetch({ user, handle: call => {
      if (call.path === '/memory/schedules/runs/r1') return jsonResponse(detail)
      if (call.path === '/memory/schedules/runs/r1/decision') return jsonResponse({ ...decision, reply_line: 'aprobar K7P4-M2XN 1,2' })
      if (call.path === '/memory/schedules/runs/r1/read') return jsonResponse({})
      return undefined
    } })
    const { container } = await mount()
    expect(textOf(container)).not.toContain('K7P4-M2XN')
    expect(qa(container, 'button').some(button => button.textContent?.includes('Copiar respuesta'))).toBe(false)
    expect(api.calls.length).toBeGreaterThan(0)
  })

  it('con autoridad no verificable no se puede aprobar y se explica', async () => {
    mockDetail({ decision: { authority: 'authority_unavailable' } })
    const { container } = await mount()
    expect(textOf(container)).toContain('No se puede verificar la autoridad')
    expect(buttonByText(container, 'Aprobar seleccionados').disabled).toBe(true)
  })

  it('aprobar un push muestra el efecto exacto y exige confirmar antes de enviar el digest', async () => {
    const withPush = { ...decision, items: [{ ordinal: 1, kind: 'git_push', summary: 'feat/x a1b2c3d → origin', state: 'pending', effect_digest: 'e1' }, { ordinal: 2, kind: 'jira_worklog', summary: 'ABC-1 worklog 2 h', state: 'pending', effect_digest: 'e2' }] }
    const api = installFetch({ user, handle: call => {
      if (call.path === '/memory/schedules/runs/r1') return jsonResponse(detail)
      if (call.path === '/memory/schedules/runs/r1/decision') return jsonResponse(withPush)
      if (call.path === '/memory/schedules/runs/r1/read') return jsonResponse({})
      if (call.path.startsWith('/memory/schedules/runs/r1/')) return jsonResponse({ request_id: 'q1', revision: 1, state: 'open', items: [] })
      return undefined
    } })
    const { container } = await mount()
    await click(buttonByText(container, 'Aprobar seleccionados'))
    expect(api.callsTo('/memory/schedules/runs/r1/approve', 'POST')).toHaveLength(0)
    const dialog = need(document.body, '[role="dialog"]')
    expect(textOf(dialog)).toContain('Push: feat/x a1b2c3d → origin')
    expect(textOf(dialog)).toContain('Horas en Jira: ABC-1 worklog 2 h')
    await click(buttonByText(dialog, 'Aprobar'))
    expect(api.lastCall('/memory/schedules/runs/r1/approve', 'POST')?.body).toEqual({ ordinals: [1, 2], digest: 'd'.repeat(64) })
  })

  it('avisa que tras corregir horas se aprueba desde la app y el código del canal deja de valer', async () => {
    mockDetail()
    const { container } = await mount()
    expect(textOf(container)).toContain('tras corregir, aprueba desde la app; el código enviado por el canal deja de valer')
  })

  it('un ítem en reconciliación del almacén no se puede seleccionar ni aprobar', async () => {
    const items = [{ ...decision.items[0]!, state: 'blocked_uncertain' }, decision.items[1]!]
    const api = mockDetail({ decision: { items } })
    const { container } = await mount()
    const boxes = qa<HTMLInputElement>(container, '.automations-item input[type="checkbox"]')
    expect(boxes[0]!.disabled).toBe(true)
    expect(textOf(container)).toContain('en reconciliación')
    await click(buttonByText(container, 'Aprobar seleccionados'))
    await click(buttonByText(need(document.body, '[role="dialog"]'), 'Aprobar'))
    expect(api.lastCall('/memory/schedules/runs/r1/approve', 'POST')?.body).toEqual({ ordinals: [2], digest: 'd'.repeat(64) })
  })

  it('una solicitud bloqueada se explica y no ofrece aprobar', async () => {
    mockDetail({ decision: { state: 'locked' } })
    const { container } = await mount()
    expect(textOf(container)).toContain('bloqueada por demasiados intentos fallidos')
    expect(qa(container, 'button').some(button => button.textContent?.includes('Aprobar seleccionados'))).toBe(false)
  })

  it('reintentar una entrega fallida pide confirmación antes de llamar', async () => {
    const api = mockDetail()
    const { container } = await mount()
    expect(qa(container, 'button').filter(button => button.textContent?.startsWith('Reintentar'))).toHaveLength(1)
    await click(buttonByText(container, 'Reintentar Gmail'))
    expect(api.callsTo('/memory/schedules/deliveries/d2/retry', 'POST')).toHaveLength(0)
    expect(textOf(need(document.body, '[role="dialog"]'))).toContain('El envío falló')
    await click(buttonByText(need(document.body, '[role="dialog"]'), 'Reintentar'))
    expect(api.lastCall('/memory/schedules/deliveries/d2/retry', 'POST')?.body).toEqual({})
  })

  it('reintentar una entrega incierta advierte que puede llegar dos veces y Volver no llama', async () => {
    const api = mockDetail({ deliveries: [{ id: 'd2', target: 'gmail_self', state: 'uncertain' }] })
    const { container } = await mount()
    await click(buttonByText(container, 'Reintentar Gmail'))
    expect(textOf(need(document.body, '[role="dialog"]'))).toContain('puede llegar dos veces')
    await click(buttonByText(need(document.body, '[role="dialog"]'), 'Volver'))
    expect(api.callsTo('/memory/schedules/deliveries/d2/retry', 'POST')).toHaveLength(0)
  })

  it('no ofrece reintentar entregas enviadas ni la de la app', async () => {
    mockDetail({ deliveries: [{ id: 'd1', target: 'app_window', state: 'failed' }, { id: 'd2', target: 'gmail_self', state: 'sent' }] })
    const { container } = await mount()
    expect(qa(container, 'button').some(button => button.textContent?.startsWith('Reintentar'))).toBe(false)
  })

  it('aprobar solo horas no pide confirmación adicional', async () => {
    const api = mockDetail({ decision: { items: decision.items.filter(item => item.kind === 'jira_worklog') } })
    const { container } = await mount()
    await click(buttonByText(container, 'Aprobar seleccionados'))
    expect(api.lastCall('/memory/schedules/runs/r1/approve', 'POST')?.body).toEqual({ ordinals: [1], digest: 'd'.repeat(64) })
  })

  it('una solicitud vencida ofrece volver a proponer y no permite aprobar', async () => {
    const api = mockDetail({ decision: { state: 'expired', reply_line: null, items: decision.items.map(item => ({ ...item, state: 'expired' })) } })
    const { container } = await mount()
    expect(qa(container, 'button').some(button => button.textContent === 'Aprobar seleccionados')).toBe(false)
    await click(buttonByText(container, 'Volver a proponer'))
    expect(api.callsTo('/memory/schedules/runs/r1/repropose', 'POST')).toHaveLength(1)
  })
})
