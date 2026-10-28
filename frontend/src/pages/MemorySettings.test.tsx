import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemorySettings } from './MemorySettings'
import type { User } from '../lib/types'
import { buttonByText, click, flush, installFetch, jsonResponse, qa, renderWithProviders, setupDom, teardownDom, textOf } from '../test-utils'

const user = { id: 'u1', email: 'a@b.c', full_name: 'Ana', org_role: 'member', is_active: true, squads: [], organization: 'Local' } as User
const google = (overrides: Record<string, unknown> = {}) => ({ id: 'g1', provider: 'google', name: 'Google trabajo', enabled: true, project_ids: [], interval_minutes: 30, config: { gmail_enabled: true }, gmail_authorized: true, account_email: 'ana@example.com', ...overrides })

beforeEach(setupDom)
afterEach(() => { vi.unstubAllGlobals(); teardownDom() })

function mock(connector: Record<string, unknown>) {
  return installFetch({ user, handle: call => {
    if (call.path === '/memory/status') return jsonResponse({ ready: true, state: 'ready', worker: { heartbeat: new Date().toISOString() }, google_client_configured: true })
    if (call.path === '/memory/call') {
      const operation = (call.body as { operation: string }).operation
      return jsonResponse(operation === 'list_connectors' ? [connector] : operation === 'list_entities' ? { items: [], total: 0, limit: 100, offset: 0 } : {})
    }
    if (call.path === '/memory/connectors/g1/google/start') return jsonResponse({ authorization_url: 'https://accounts.google.com/o/oauth2/auth?x=1' })
    return undefined
  } })
}

it('una fuente existente sin envío figura como solo lectura', async () => {
  mock(google())
  const { container } = await renderWithProviders(<MemorySettings />, { route: '/memory/sources' })
  await flush(3)
  expect(textOf(container)).toContain('Gmail: Solo lectura')
  expect(textOf(container)).not.toContain('Falta autorizar el envío de correos')
})

it('con envío habilitado y sin el permiso avisa que falta autorizar y explica que Google pide todo de nuevo', async () => {
  mock(google({ config: { gmail_enabled: true, gmail_send_enabled: true }, gmail_send_authorized: false }))
  const { container } = await renderWithProviders(<MemorySettings />, { route: '/memory/sources' })
  await flush(3)
  expect(textOf(container)).toContain('Gmail: Lectura y envío · el envío es solo a ana@example.com')
  expect(textOf(container)).toContain('Falta autorizar el envío de correos')
  expect(textOf(container)).toContain('Google vuelve a pedir todos los permisos; es normal.')
})

it('Conectar Google muestra el aviso previo y sólo entonces abre la autorización', async () => {
  const api = mock(google({ config: { gmail_enabled: true, gmail_send_enabled: true }, gmail_send_authorized: false }))
  const open = vi.fn()
  vi.stubGlobal('open', open)
  const { container } = await renderWithProviders(<MemorySettings />, { route: '/memory/sources' })
  await flush(3)
  await click(buttonByText(container, 'Conectar Google'))
  expect(open).not.toHaveBeenCalled()
  expect(textOf(document.body)).toContain('Agent Hub solo enviará correos a ana@example.com; nunca a terceros')
  await click(buttonByText(document.body, 'Continuar con Google'))
  expect(api.callsTo('/memory/connectors/g1/google/start', 'POST')).toHaveLength(1)
  expect(open).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth?x=1', '_blank', 'noopener,noreferrer')
})

it('sin envío habilitado Conectar Google va directo a Google', async () => {
  const api = mock(google())
  vi.stubGlobal('open', vi.fn())
  const { container } = await renderWithProviders(<MemorySettings />, { route: '/memory/sources' })
  await flush(3)
  await click(buttonByText(container, 'Conectar Google'))
  expect(api.callsTo('/memory/connectors/g1/google/start', 'POST')).toHaveLength(1)
})

const sendBox = (): HTMLInputElement | undefined => qa<HTMLInputElement>(document.body, '.check input').find(box => box.parentElement?.textContent?.includes('envíe el brief y el cierre'))

it('el formulario de una fuente nueva trae el envío activado', async () => {
  mock(google())
  const { container } = await renderWithProviders(<MemorySettings />, { route: '/memory/sources' })
  await flush(3)
  await click(buttonByText(container, 'Agregar fuente'))
  expect(sendBox()?.checked).toBe(true)
})

it('una fuente existente conserva el envío apagado hasta que la persona lo active', async () => {
  mock(google())
  const { container } = await renderWithProviders(<MemorySettings />, { route: '/memory/sources' })
  await flush(3)
  await click(qa(container, 'button').find(button => button.textContent === 'Configurar'))
  expect(sendBox()?.checked).toBe(false)
  await click(sendBox())
  expect(sendBox()?.checked).toBe(true)
})
