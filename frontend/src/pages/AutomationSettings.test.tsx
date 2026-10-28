import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AutomationSettings } from './AutomationSettings'
import type { User } from '../lib/types'
import { actAsync, click, installFetch, jsonResponse, need, qa, renderWithProviders, setValue, setupDom, teardownDom, textOf } from '../test-utils'

const user = { id: 'u1', email: 'a@b.c', full_name: 'Ana', org_role: 'member', is_active: true, squads: [], organization: 'Local' } as User
const settings = { automations_enabled: true, notify_schedule_created: true, notify_delivery: true, workday_hours: 9, keep_awake: true }

beforeEach(setupDom)
afterEach(() => { vi.unstubAllGlobals(); teardownDom() })

function mock() {
  return installFetch({ user, handle: call => call.path === '/automations' ? jsonResponse(call.method === 'PUT' ? { ...settings, ...(call.body as object) } : settings) : undefined })
}
const toggle = (container: HTMLElement, label: string): HTMLButtonElement => need<HTMLButtonElement>(container, `button[aria-label="${label}"]`)

it('apagar automatizaciones y los avisos guarda sólo el campo cambiado', async () => {
  const api = mock()
  const { container } = await renderWithProviders(<AutomationSettings />, { route: '/settings' })
  expect(toggle(container, 'Habilitar automatizaciones').getAttribute('aria-checked')).toBe('true')
  await click(toggle(container, 'Habilitar automatizaciones'))
  expect(api.lastCall('/automations', 'PUT')?.body).toEqual({ automations_enabled: false })
  await click(toggle(container, 'Notificar cuando un agente programe, cambie o cancele una automatización'))
  expect(api.lastCall('/automations', 'PUT')?.body).toEqual({ notify_schedule_created: false })
  await click(toggle(container, 'Notificar cuando llegue una entrega'))
  expect(api.lastCall('/automations', 'PUT')?.body).toEqual({ notify_delivery: false })
})

it('muestra la zona horaria del sistema sin selector y dice qué detiene cada interruptor', async () => {
  mock()
  const { container } = await renderWithProviders(<AutomationSettings />, { route: '/settings' })
  expect(textOf(container)).toContain(`la del sistema (${Intl.DateTimeFormat().resolvedOptions().timeZone})`)
  expect(textOf(container)).toContain('Colaboración apagada: se detienen equipos y flota. Automatizaciones apagadas: se detienen brief, cierre y entregas.')
  expect(qa(container, 'select')).toHaveLength(0)
})

it('la jornada se guarda al salir del campo y sólo si es válida', async () => {
  const api = mock()
  const { container } = await renderWithProviders(<AutomationSettings />, { route: '/settings' })
  const input = need<HTMLInputElement>(container, 'input[aria-label="Jornada de referencia en horas"]')
  await setValue(input, '30')
  await actAsync(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
  expect(api.callsTo('/automations', 'PUT')).toHaveLength(0)
  await setValue(input, '7.5')
  await actAsync(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
  expect(api.lastCall('/automations', 'PUT')?.body).toEqual({ workday_hours: 7.5 })
})

it('mantener despierta sólo aparece dentro de la app de escritorio y avisa del límite de la tapa', async () => {
  mock()
  const browser = await renderWithProviders(<AutomationSettings />, { route: '/settings' })
  expect(textOf(browser.container)).not.toContain('Mantener la Mac despierta')
  browser.unmount()
  vi.stubGlobal('agentHub', {})
  const desktop = await renderWithProviders(<AutomationSettings />, { route: '/settings' })
  expect(textOf(desktop.container)).toContain('Mantener la Mac despierta durante el brief')
  expect(textOf(desktop.container)).toContain('No cubre cerrar la tapa')
  const api = mock()
  const again = await renderWithProviders(<AutomationSettings />, { route: '/settings' })
  await click(toggle(again.container, 'Mantener la Mac despierta hasta completar y enviar el brief'))
  expect(api.lastCall('/automations', 'PUT')?.body).toEqual({ keep_awake: false })
})
