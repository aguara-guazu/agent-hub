import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installFetch, jsonResponse, setupDom } from '../test-utils'
import { NativeEmbeddings } from './NativeEmbeddings'

let root: Root, container: HTMLDivElement, client: QueryClient
beforeEach(() => {
  setupDom(); vi.useFakeTimers()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function tick(ms = 20) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
async function mount() {
  await act(async () => root.render(<QueryClientProvider client={client}><NativeEmbeddings /></QueryClientProvider>))
  await tick(); await tick()
}
it('espera una acción para descargar, muestra avance, permite cancelar y detecta cuando terminó', async () => {
  let state = 'missing'
  const mock = installFetch({ handle: call => {
    if (call.path.endsWith('/install')) state = 'downloading'
    if (call.path.endsWith('/cancel')) state = 'error'
    return jsonResponse({ state, file: 'model', percent: 40, ...(state === 'error' ? { error: 'Descarga cancelada' } : {}) })
  } })
  await mount()
  expect(mock.callsTo('/memory/embeddings/native/install')).toHaveLength(0)
  expect(container.textContent).toContain('Descargar modelo')
  await act(async () => container.querySelector('button')!.click()); await tick()
  expect(container.textContent).toContain('Cancelar descarga')
  expect(container.querySelector('progress')!.value).toBe(40)
  await act(async () => container.querySelector('button')!.click()); await tick()
  expect(container.textContent).toContain('Reintentar descarga')
  await act(async () => container.querySelector('button')!.click()); await tick()
  state = 'ready'; await tick(1100)
  expect(container.textContent).toContain('Listo para usar')
  expect(container.querySelector('button')).toBeNull()
})
