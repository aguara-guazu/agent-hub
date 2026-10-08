import { ToastProvider } from '../components/Toast'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installFetch, jsonResponse, setupDom } from '../test-utils'
import { MediaSettings } from './MediaSettings'
let root: Root, container: HTMLDivElement, client: QueryClient
const settings = { pdf: true, ocr: false, transcription: false, vision: false, audio: false, automatic: true, language: 'es' }
const modules = Object.fromEntries(['ocr','decoder','speech','vision','audio'].map(name => [name, { state: 'missing' }]))
beforeEach(() => { setupDom(); vi.useFakeTimers(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) })
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(20) }) }
async function mount() { await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><ToastProvider><MediaSettings /></ToastProvider></MemoryRouter></QueryClientProvider>)); await tick(); await tick() }
function button(name: string) { return [...container.querySelectorAll('button')].find(b => b.textContent === name)! }
it('descarga sólo por acción explícita y guarda únicamente cuando hay cambios', async () => {
  let saved = { ...settings }
  const mock = installFetch({ handle: call => {
    if (call.method === 'PUT') saved = call.body as typeof settings
    return jsonResponse({ settings: saved, modules })
  } })
  await mount(); expect(button('Guardar').disabled).toBe(true); expect(mock.callsTo('/memory/media/ocr/install')).toHaveLength(0)
  await act(async () => button('Descargar módulo').click()); await tick()
  expect(mock.callsTo('/memory/media/ocr/install')).toHaveLength(1)
  await act(async () => [...container.querySelectorAll<HTMLLabelElement>('label')].find(l => l.textContent?.includes('Reconocer texto'))!.querySelector<HTMLInputElement>('input')!.click()); await tick()
  expect(button('Guardar').disabled).toBe(false)
  await act(async () => button('Guardar').click()); await tick()
  expect(saved).toEqual({ ...settings, ocr: true }); expect(button('Guardar').disabled).toBe(true)
})
it('muestra progreso, permite cancelar y conserva cambios cuando guardar falla', async () => {
  const mock = installFetch({ handle: call => call.method === 'PUT' ? jsonResponse({ detail: 'Descargá OCR primero' }, 409) : jsonResponse({ settings, modules: { ...modules, speech: { state: 'downloading', percent: 32, file: 'modelo' } } }) })
  await mount(); expect(container.querySelector('progress')!.value).toBe(32)
  await act(async () => button('Cancelar descarga').click()); await tick()
  expect(mock.callsTo('/memory/media/speech/cancel')).toHaveLength(1)
  await act(async () => [...container.querySelectorAll<HTMLLabelElement>('label')].find(l => l.textContent?.includes('Reconocer texto'))!.querySelector<HTMLInputElement>('input')!.click()); await tick()
  await act(async () => button('Guardar').click()); await tick()
  expect(container.textContent).toContain('Descargá OCR primero'); expect([...container.querySelectorAll<HTMLLabelElement>('label')].find(l => l.textContent?.includes('Reconocer texto'))!.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
  expect(button('Guardar').disabled).toBe(false)
})
