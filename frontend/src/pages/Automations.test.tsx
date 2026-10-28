import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Route, Routes } from 'react-router-dom'
import { DeliveriesPage, DeliveryDetailPage, SchedulesPage, describeNextRun, describeRecurrence, generatedNote } from './Automations'
import type { RunDetail, RunListItem, ScheduleView } from '../lib/automations'
import type { User } from '../lib/types'
import { buttonByText, click, installFetch, jsonResponse, need, q, qa, renderWithProviders, setupDom, setValue, teardownDom, textOf } from '../test-utils'
import type { ApiCall } from '../test-utils'

const user: User = { id: 'u1', email: 'a@b.c', full_name: 'Ana', org_role: 'member', is_active: true, squads: [], organization: 'Local' } as User

function schedule(overrides: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: 's1', scope: 'owner', project_id: null, template: 'daily_brief', template_version: 1, kind: 'synthesis', title: 'Brief diario',
    recurrence: { type: 'daily', time: '08:00', weekdays: [1, 2, 3, 4, 5] }, timezone: 'America/Argentina/Buenos_Aires',
    next_run_at: '2026-10-29T11:00:00Z', next_run_local: '2026-10-29T08:00:00-03:00', delivery: ['hub_inbox', 'app_window', 'gmail_self'],
    delivery_unavailable: [{ target: 'gmail_self', reason: 'scope_missing' }], state: 'active', paused_by: null, revision: 3,
    created_by: { agent_id: 'a1', label: 'Quilla' }, created_by_kind: 'agent', admission_note: 'Dentro de los límites del Hub: solo lectura, entrega solo a ti', last_run: null, ...overrides,
  }
}

function run(overrides: Partial<RunListItem> = {}): RunListItem {
  return { run_id: 'r1', schedule_id: 's1', artifact_kind: 'brief', title: 'Brief · martes 28/10', scheduled_for: '2026-10-28T11:00:00Z', started_at: '2026-10-28T11:00:05Z', state: 'succeeded', trigger: 'clock', read_at: null,
    deliveries: [{ target: 'app_window', state: 'sent' }, { target: 'gmail_self', state: 'failed', error_code: 'token_expired' }], decision: null, ...overrides }
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
      if (call.path === '/memory/schedules') return jsonResponse({ items, total: items.length, limit: 200, offset: 0 })
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
    expect(qa(container, '.chip').find(chip => chip.textContent?.includes('Gmail'))?.getAttribute('title')).toContain('scope_missing')
  })

  it('el tipo se rotula con o sin modelo y la última ejecución abre su entrega', async () => {
    mockSchedules([schedule({ kind: 'notice', last_run: { id: 'r7', state: 'succeeded', scheduled_for: '2026-10-28T11:00:00Z' } })])
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules' })
    expect(textOf(container)).toContain('Sin modelo')
    expect(textOf(container)).not.toContain('Aviso')
    expect(qa<HTMLAnchorElement>(container, 'a').some(anchor => anchor.getAttribute('href') === '/deliveries/r7')).toBe(true)
  })

  it('Canales guarda App fija más los canales elegidos y no deja marcar uno no disponible', async () => {
    const api = mockSchedules([schedule({ delivery: ['hub_inbox', 'app_window'] })])
    const { container } = await renderWithProviders(<SchedulesPage />, { route: '/schedules' })
    await click(buttonByText(container, 'Canales'))
    const boxes = qa<HTMLInputElement>(document.body, '.automations-form input[type="checkbox"]')
    expect(boxes[0]!.disabled).toBe(true)
    expect(boxes[2]!.disabled).toBe(true)
    expect(textOf(document.body)).toContain('No está conectado')
    await click(boxes[1])
    await click(buttonByText(document.body, 'Guardar'))
    expect(api.lastCall('/memory/schedules/s1/delivery', 'PUT')?.body).toEqual({ expected_revision: 3, delivery: ['hub_inbox', 'app_window', 'gmail_self'] })
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
    expect(api.callsTo('/memory/schedules/s1/run_now', 'POST')).toHaveLength(1)
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
  it('lista las entregas con el estado por canal y la decisión', async () => {
    installFetch({ user, handle: call => {
      if (call.path === '/memory/schedules/runs') return jsonResponse({ items: [run({ decision: { state: 'open', expires_at: '2026-10-28T23:59:00Z', approved: 0, total: 2 } })], total: 1, limit: 50, offset: 0 })
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
  const detail: RunDetail = { ...run({ decision: { state: 'open', expires_at: '2026-10-28T23:59:00Z', approved: 0, total: 2 } }), body_md: '# Cierre\n\n<script>alert(1)</script> [Jira](https://example.atlassian.net/browse/ABC-1) [malo](javascript:alert(1))',
    items: [{ ordinal: 1, kind: 'jira_worklog', project_id: 'p', summary: 'ABC-1 worklog 2 h', estimate: { seconds: 5400, basis: 'notas 10:15–12:40', confidence: 'medium', assumptions: ['sin pruebas manuales'], would_change: 'hubo pruebas en staging' } }, { ordinal: 2, kind: 'jira_transition', project_id: 'p', summary: 'ABC-2 → En revisión' }], phases: [] }
  const decision = { request_id: 'q1', revision: 1, state: 'open', expires_at: '2026-10-28T23:59:00Z', digest: 'd'.repeat(64), authority: 'verified', reply_line: 'aprobar K7P4-M2XN 1,2',
    items: [{ ordinal: 1, kind: 'jira_worklog', summary: 'ABC-1 worklog 2 h', state: 'proposed', effect_digest: 'e1' }, { ordinal: 2, kind: 'jira_transition', summary: 'ABC-2 → En revisión', state: 'proposed', effect_digest: 'e2' }] }

  function mockDetail(overrides: { decision?: object } = {}) {
    return installFetch({ user, handle: call => {
      calls.push(call)
      if (call.path === '/memory/schedules/runs/r1') return jsonResponse(detail)
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

  it('muestra la estimación con sus cuatro partes y decimales en español', async () => {
    mockDetail()
    const { container } = await mount()
    const text = textOf(container)
    expect(text).toContain('Estimación del agente, no medición: 1,5 h')
    expect(text).toContain('confianza media')
    expect(text).toContain('Base: notas 10:15–12:40')
    expect(text).toContain('Supuestos: sin pruebas manuales')
    expect(text).toContain('Cambiaría si: hubo pruebas en staging')
  })

  it('aprueba los ítems seleccionados con el digest exacto de la solicitud', async () => {
    const api = mockDetail()
    const { container } = await mount()
    await click(qa(container, '.automations-item input[type="checkbox"]')[1])
    await click(buttonByText(container, 'Aprobar seleccionados'))
    expect(api.lastCall('/memory/schedules/runs/r1/approve', 'POST')?.body).toEqual({ ordinals: [1], digest: 'd'.repeat(64) })
  })

  it('rechazar todo envía todos los ítems propuestos', async () => {
    const api = mockDetail()
    const { container } = await mount()
    await click(buttonByText(container, 'Rechazar todo'))
    expect(api.lastCall('/memory/schedules/runs/r1/reject', 'POST')?.body).toEqual({ ordinals: [1, 2] })
  })

  it('corregir horas envía segundos en múltiplos de media hora', async () => {
    const api = mockDetail()
    const { container } = await mount()
    await setValue(need(container, 'input[aria-label="Horas del ítem 1"]'), '1.5')
    await click(buttonByText(container, 'Corregir'))
    expect(api.lastCall('/memory/schedules/runs/r1/revise', 'POST')?.body).toEqual({ ordinal: 1, seconds: 5400 })
  })

  it('muestra la línea de respuesta sólo con autoridad verificada y una solicitud abierta', async () => {
    mockDetail()
    const verified = await mount()
    expect(textOf(verified.container)).toContain('aprobar K7P4-M2XN 1,2')
    verified.unmount()
    mockDetail({ decision: { authority: 'authority_unavailable', reply_line: null } })
    const unavailable = await mount()
    expect(textOf(unavailable.container)).not.toContain('K7P4-M2XN')
    expect(textOf(unavailable.container)).toContain('No se puede verificar la autoridad')
    expect(buttonByText(unavailable.container, 'Aprobar seleccionados').disabled).toBe(true)
  })

  it('una solicitud vencida ofrece volver a proponer y no permite aprobar', async () => {
    const api = mockDetail({ decision: { state: 'expired', reply_line: null, items: decision.items.map(item => ({ ...item, state: 'expired' })) } })
    const { container } = await mount()
    expect(qa(container, 'button').some(button => button.textContent === 'Aprobar seleccionados')).toBe(false)
    await click(buttonByText(container, 'Volver a proponer'))
    expect(api.callsTo('/memory/schedules/runs/r1/repropose', 'POST')).toHaveLength(1)
  })
})
