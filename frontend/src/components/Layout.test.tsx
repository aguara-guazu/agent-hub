import { afterEach, beforeEach, expect, it } from 'vitest'
import { Layout } from './Layout'
import { setupDom, teardownDom, installFetch, jsonResponse, renderWithProviders, click, flush } from '../test-utils'

beforeEach(setupDom)
afterEach(teardownDom)

it.each([false, true])('sincronizar ahora pide fuentes y muestra su resultado sin ocultar errores (%s)', async failure => {
  const api = installFetch({ handle: call => {
    if (call.path === '/local/overview') return jsonResponse({ hostname: 'Test', clients: [], rows: [] })
    if (call.path === '/memory/status') return jsonResponse({ ready: true })
    if (call.path === '/memory/call') return failure
      ? jsonResponse({ detail: 'No se pudo encolar la sincronización' }, 503)
      : jsonResponse({ queued: 2 })
    return undefined
  } })
  const { container } = await renderWithProviders(<Layout />)
  await click(container.querySelector('.hub-sync-button'))
  await flush(4)
  expect(api.callsTo('/memory/call', 'POST')[0]?.body).toEqual({ operation: 'sync_sources', input: {} })
  expect(document.body.textContent).toContain(failure ? 'No se pudo sincronizar' : 'Buscando reuniones y contenido nuevo en 2 fuentes')
  if (failure) expect(document.body.textContent).not.toContain('Sincronización revisada')
})
