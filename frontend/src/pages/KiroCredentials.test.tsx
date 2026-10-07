import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installFetch, jsonResponse, noContent, setupDom } from '../test-utils'
import { KiroCredentials } from './KiroCredentials'

let root: Root, container: HTMLDivElement, client: QueryClient
beforeEach(() => {
  setupDom(); vi.useFakeTimers()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(20) }) }
async function mount(onChanged = vi.fn()) {
  await act(async () => root.render(<QueryClientProvider client={client}><KiroCredentials onChanged={onChanged} /></QueryClientProvider>))
  await tick(); await tick(); return onChanged
}
async function fill(value: string) {
  const input = container.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }); await tick()
}
async function click(label: string, parent: ParentNode = container) {
  await act(async () => { [...parent.querySelectorAll('button')].find(b => b.textContent === label)!.click() }); await tick()
}
it('muestra la guía sólo cuando falta la clave, la oculta al guardar y permite eliminarla', async () => {
  let stored = false
  const mock = installFetch({ handle: call => {
    if (call.path !== '/memory/credentials/kiro') return
    if (call.method === 'PUT') { stored = true; return jsonResponse({ configured: true }) }
    if (call.method === 'DELETE') { stored = false; return noContent() }
    return jsonResponse({ configured: stored, stored })
  } })
  const changed = await mount()
  expect(container.querySelector('details')!.open).toBe(true)
  expect(container.querySelectorAll('img')).toHaveLength(3)
  expect(container.querySelector('input')!.type).toBe('password')
  expect(container.textContent).toContain('Falta configurar')
  await fill(' ksk_test_private '); await click('Guardar clave'); await tick()
  expect(mock.lastCall('/memory/credentials/kiro', 'PUT')?.body).toEqual({ api_key: 'ksk_test_private' })
  expect(container.querySelector('input')!.value).toBe('')
  expect(container.textContent).toContain('Clave guardada')
  expect(container.querySelector('details')!.open).toBe(false)
  expect(JSON.stringify(client.getMutationCache().getAll().map(m => m.state))).not.toContain('ksk_test_private')
  expect(changed).toHaveBeenCalledOnce()
  await click('Quitar clave guardada')
  expect(mock.callsTo('/memory/credentials/kiro', 'DELETE')).toHaveLength(0)
  await click('Quitar clave', document); await tick()
  expect(mock.callsTo('/memory/credentials/kiro', 'DELETE')).toHaveLength(1)
  expect(container.textContent).toContain('Falta configurar')
  expect(container.querySelector('details')!.open).toBe(true)
})
it('conserva el campo si falla el guardado y nunca informa éxito', async () => {
  installFetch({ handle: call => call.method === 'PUT' ? jsonResponse({ detail: 'No se pudo guardar' }, 500) : jsonResponse({ configured: false, stored: false }) })
  await mount(); await fill('ksk_failed'); await click('Guardar clave')
  expect(container.textContent).toContain('No se pudo guardar')
  expect(container.textContent).not.toContain('Clave guardada.')
  expect(container.querySelector('input')!.value).toBe('ksk_failed')
})
it('oculta la guía al abrir con una clave ya disponible, sin recuperar su valor', async () => {
  installFetch({ handle: () => jsonResponse({ configured: true, stored: true }) })
  await mount()
  expect(container.textContent).toContain('Guardada en este equipo')
  expect(container.querySelector('input')!.value).toBe('')
  expect(container.querySelector('details')!.open).toBe(false)
})
