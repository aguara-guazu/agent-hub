import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/Toast'
import { installFetch, jsonResponse } from '../test-utils'
import { MemoryEntityPage, MemoryExplore } from './Memory'
import { MemorySettings } from './MemorySettings'
import { MEMORY_REFRESH_MS } from '../lib/memory'

let root: Root, container: HTMLDivElement, client: QueryClient
const project = { id: 'project', kind: 'project', title: 'Proyecto', data: {}, created_at: '2026-09-23', updated_at: '2026-09-23' }
const ai = { extraction: 'disabled', extraction_model: 'deepseek-flash', remote_processing_enabled: false, embeddings_enabled: false, embedding_model: 'embed', ollama_url: 'http://localhost:11434', identity_auto_merge: true }
const status = { ready: true, counts: {}, ai }
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  focusManager.setFocused(true)
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); focusManager.setFocused(undefined); vi.useRealTimers(); vi.unstubAllGlobals() })
async function tick(ms = 20) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
async function mount(page: 'project' | 'global' | 'settings') {
  const path = page === 'project' ? '/projects/project' : page === 'settings' ? '/memory/sources' : '/memory'
  await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><ToastProvider><Routes>
    <Route path="/projects/:id" element={<MemoryEntityPage />} /><Route path="/memory" element={<MemoryExplore />} /><Route path="/memory/sources" element={<MemorySettings />} />
  </Routes></ToastProvider></MemoryRouter></QueryClientProvider>) })
  await tick(); await tick()
}
async function change(select: HTMLSelectElement, value: string) { await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) }); await tick() }

it.each(['project', 'global'] as const)('muestra escrituras externas sin salir de la vista %s ni perder su filtro', async page => {
  let externalWrite = false
  const mock = installFetch({ handle: call => {
    if (call.path === '/memory/status') return jsonResponse(status)
    if (call.path === '/memory/call') {
      const { operation, input } = call.body as any
      if (operation === 'get_entity') return jsonResponse({ entity: project, links: [], sources: [], evidence: [], changes: [] })
      if (operation === 'list_entities') return jsonResponse({ items: externalWrite && input.kind ? [{ ...project, id: 'new', kind: page === 'project' ? 'fact' : 'note', title: 'Nuevo contenido del agente', data: { text: 'Con evidencia' } }] : [], total: externalWrite ? 1 : 0 })
    }
  } })
  await mount(page)
  if (page === 'project') {
    await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Decisiones y hallazgos')!.click() }); await tick()
  } else await change(container.querySelector('select[aria-label="Tipo de entidad"]')!, 'note')
  expect(container.textContent).not.toContain('Nuevo contenido del agente')
  externalWrite = true
  await tick(MEMORY_REFRESH_MS + 20)
  expect(container.textContent).toContain('Nuevo contenido del agente')
  if (page === 'project') {
    expect(container.querySelector('.memory-project-tabs .active')?.textContent).toBe('Decisiones y hallazgos')
    expect((mock.calls.filter(c => (c.body as any)?.operation === 'list_entities').at(-1)?.body as any).input).toMatchObject({ project_id: 'project', kind: 'fact', offset: 0 })
  } else expect(container.querySelector<HTMLSelectElement>('select[aria-label="Tipo de entidad"]')!.value).toBe('note')
  focusManager.setFocused(false)
  const before = mock.calls.length
  await tick(MEMORY_REFRESH_MS + 20)
  expect(mock.calls.length).toBe(before)
  await act(async () => { focusManager.setFocused(true) }); await tick()
  expect(mock.calls.length).toBeGreaterThan(before)
})

it('permite configurar OpenCode una sola vez con un modelo conectado', async () => {
  const mock = installFetch({ handle: call => {
    if (call.path === '/memory/status') return jsonResponse(status)
    if (call.path === '/memory/opencode') return jsonResponse({ installed: true, models: [{ id: 'fixture/chat', name: 'Proveedor · Modelo' }] })
    if (call.path === '/memory/ai') return jsonResponse(call.body)
    if (call.path === '/memory/call') return jsonResponse((call.body as any).operation === 'list_connectors' ? [] : { items: [], total: 0 })
  } })
  await mount('settings')
  await change(container.querySelector<HTMLSelectElement>('select')!, 'opencode')
  await tick()
  const models = [...container.querySelectorAll('select')].find(s => s.textContent?.includes('Proveedor · Modelo'))!
  await change(models, 'fixture/chat')
  const permission = [...container.querySelectorAll('label')].find(l => l.textContent?.includes('Permitir enviar fragmentos'))!.querySelector('input')!
  await act(async () => { permission.click() })
  expect(container.textContent).toContain('No necesitás abrir OpenCode')
  await act(async () => { models.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await tick()
  expect(mock.lastCall('/memory/ai', 'PUT')?.body).toMatchObject({ extraction: 'opencode', extraction_model: 'fixture/chat', remote_processing_enabled: true })
})

it.each([true, false])('prueba el modelo de OpenCode y limpia el resultado al cambiarlo (éxito: %s)', async success => {
  const mock = installFetch({ handle: call => {
    if (call.path === '/memory/status') return jsonResponse(status)
    if (call.path === '/memory/opencode') return jsonResponse({ installed: true, models: [{ id: 'fixture/chat', name: 'Modelo A' }, { id: 'fixture/other', name: 'Modelo B' }] })
    if (call.path === '/memory/opencode/test') return success ? jsonResponse({ model: 'fixture/chat', ok: true }) : jsonResponse({ detail: 'El proveedor rechazó el acceso desde OpenCode.' }, 409)
    if (call.path === '/memory/call') return jsonResponse((call.body as any).operation === 'list_connectors' ? [] : { items: [], total: 0 })
  } })
  await mount('settings')
  await change(container.querySelector<HTMLSelectElement>('select')!, 'opencode')
  const models = [...container.querySelectorAll('select')].find(s => s.textContent?.includes('Modelo A'))!
  await change(models, 'fixture/chat')
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Probar modelo')!.click() }); await tick()
  expect(mock.lastCall('/memory/opencode/test', 'POST')?.body).toEqual({ model: 'fixture/chat' })
  const message = success ? 'Modelo verificado' : 'El proveedor rechazó el acceso'
  expect(container.textContent).toContain(message)
  await change(models, 'fixture/other')
  expect(container.textContent).not.toContain(message)
  expect(mock.calls.some(c => c.path === '/memory/ai')).toBe(false)
})
