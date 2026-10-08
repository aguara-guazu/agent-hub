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

it('refleja la preparación automática sin perder una edición pendiente', async () => {
  let persisted = { ...ai }
  installFetch({ handle: call => {
    if (call.path === '/memory/status') return jsonResponse({ ...status, ai: persisted })
    if (call.path === '/memory/call') return jsonResponse((call.body as any).operation === 'list_connectors' ? [] : { items: [], total: 0 })
  } })
  await mount('settings')
  persisted = { ...persisted, extraction: 'deepseek', embeddings_enabled: true, embedding_model: 'embeddinggemma-2-native-q8-v1' }
  await tick(10_100)
  const provider = container.querySelector<HTMLSelectElement>('select')!
  expect(provider.value).toBe('deepseek')
  expect([...container.querySelectorAll('button')].find(b => b.textContent === 'Guardar configuración')!.disabled).toBe(true)
  await change(provider, 'disabled')
  persisted = { ...persisted, extraction_model: 'new-account-model' }
  await tick(10_100)
  expect(provider.value).toBe('disabled')
  expect([...container.querySelectorAll('button')].find(b => b.textContent === 'Guardar configuración')!.disabled).toBe(false)
})

it('Guardar queda grisado sin cambios, se habilita al editar y vuelve a grisado al guardar', async () => {
  let persisted = { ...ai, extraction: 'opencode', extraction_model: 'fixture/a', extraction_reasoning_effort: '' }
  const mock = installFetch({ handle: call => {
    if (call.path === '/memory/status') return jsonResponse({ ...status, ai: persisted })
    if (call.path === '/memory/opencode') return jsonResponse({ installed: true, models: ['a', 'b'].map(id => ({ id: `fixture/${id}`, name: `Modelo ${id}`, reasoning_efforts: ['low', 'high'] })) })
    if (call.path === '/memory/ai') { persisted = call.body as typeof persisted; return jsonResponse(persisted) }
    if (call.path === '/memory/call') return jsonResponse((call.body as any).operation === 'list_connectors' ? [] : { items: [], total: 0 })
  } })
  await mount('settings')
  const save = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Guardar')!
  const models = [...container.querySelectorAll('select')].find(s => s.textContent?.includes('Modelo a'))!
  expect(container.textContent).not.toContain('Actualizar modelos')
  expect(save().disabled).toBe(true)
  await change(models, 'fixture/b'); expect(save().disabled).toBe(false)
  await change(models, 'fixture/a'); expect(save().disabled).toBe(true)
  await change(container.querySelector('[aria-label="Esfuerzo de razonamiento"]')!, 'high')
  expect(save().disabled).toBe(false)
  await act(async () => save().click()); await tick(); await tick()
  expect(mock.lastCall('/memory/ai', 'PUT')?.body).toMatchObject({ extraction_model: 'fixture/a', extraction_reasoning_effort: 'high' })
  expect(save().disabled).toBe(true)
  expect([...container.querySelectorAll('button')].find(b => b.textContent === 'Guardar configuración')!.disabled).toBe(true)
})

it('un guardado fallido permite reintentar y uno en curso conserva cambios posteriores', async () => {
  let persisted = { ...ai, extraction: 'opencode', extraction_model: 'fixture/a', extraction_reasoning_effort: '' }
  let respond: ((response: Response) => void) | undefined, submitted: typeof persisted
  installFetch({ handle: call => {
    if (call.path === '/memory/status') return jsonResponse({ ...status, ai: persisted })
    if (call.path === '/memory/opencode') return jsonResponse({ installed: true, models: ['a', 'b', 'c'].map(id => ({ id: `fixture/${id}`, name: `Modelo ${id}` })) })
    if (call.path === '/memory/ai') { submitted = call.body as typeof persisted; return new Promise<Response>(resolve => { respond = resolve }) }
    if (call.path === '/memory/call') return jsonResponse((call.body as any).operation === 'list_connectors' ? [] : { items: [], total: 0 })
  } })
  await mount('settings')
  const save = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Guardar')!
  const models = [...container.querySelectorAll('select')].find(s => s.textContent?.includes('Modelo a'))!
  await change(models, 'fixture/b'); await act(async () => save().click()); await tick()
  expect([...container.querySelectorAll('button')].find(b => b.textContent === 'Guardando…')!.disabled).toBe(true)
  await act(async () => respond!(jsonResponse({ detail: 'No se pudo guardar' }, 500))); await tick()
  expect(save().disabled).toBe(false)
  await act(async () => save().click()); await tick()
  await change(models, 'fixture/c')
  persisted = submitted!
  await act(async () => respond!(jsonResponse(persisted))); await tick(); await tick()
  expect(models.value).toBe('fixture/c')
  expect(save().disabled).toBe(false)
})

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

it.each([['claude_code', 'Claude Code'], ['codex_cli', 'Codex'], ['kiro', 'Kiro CLI']])('configura %s con modelos consultados y prueba en segundo plano', async (provider, label) => {
  const path = `/memory/extraction-cli/${provider}`
  const mock = installFetch({ handle: call => {
    if (call.path === '/memory/status') return jsonResponse(status)
    if (call.path === path) return jsonResponse({ installed: true, models: [{ id: 'fixture', name: 'Modelo de la cuenta' }] })
    if (call.path === `${path}/test`) return jsonResponse({ ok: true, model: 'fixture', resolved_model: 'fixture' })
    if (call.path === '/memory/ai') return jsonResponse(call.body)
    if (call.path === '/memory/call') return jsonResponse((call.body as any).operation === 'list_connectors' ? [] : { items: [], total: 0 })
  } })
  await mount('settings')
  await change(container.querySelector<HTMLSelectElement>('select')!, provider!)
  expect(container.textContent).toContain(`No necesitás abrir ${label}`)
  const models = [...container.querySelectorAll('select')].find(s => s.textContent?.includes('Modelo de la cuenta'))!
  await change(models, 'fixture')
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Probar modelo')!.click() }); await tick()
  expect(mock.lastCall(`${path}/test`, 'POST')?.body).toEqual({ model: 'fixture' })
  expect(container.textContent).toContain('Modelo verificado')
  const permission = [...container.querySelectorAll('label')].find(l => l.textContent?.includes('Permitir enviar fragmentos'))!.querySelector('input')!
  await act(async () => { permission.click() }); await tick()
  await act(async () => { models.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await tick()
  expect(mock.lastCall('/memory/ai', 'PUT')?.body).toMatchObject({ extraction: provider, extraction_model: 'fixture', remote_processing_enabled: true })
  await change(container.querySelector<HTMLSelectElement>('select')!, 'opencode')
  expect(container.textContent).not.toContain('Modelo verificado')
})

it.each(['claude_code', 'codex_cli', 'kiro', 'opencode'])('prueba y guarda el esfuerzo de %s; lo reinicia al cambiar de modelo o proveedor', async provider => {
  const path = provider === 'opencode' ? '/memory/opencode' : `/memory/extraction-cli/${provider}`
  let savedStatus = status
  const mock = installFetch({ handle: call => {
    if (call.path === '/memory/status') return jsonResponse(savedStatus)
    if (call.path === path) return jsonResponse({ installed: true, models: [
      { id: 'fixture/chat', name: 'Modelo con esfuerzo', reasoning_efforts: ['low', 'high'] },
      { id: 'fixture/other', name: 'Modelo sin esfuerzo', reasoning_efforts: [] },
    ] })
    if (call.path === `${path}/test`) return jsonResponse({ ok: true, model: 'fixture/chat' })
    if (call.path === '/memory/ai') { savedStatus = { ...savedStatus, ai: call.body as typeof status.ai }; return jsonResponse(call.body) }
    if (call.path === '/memory/call') return jsonResponse((call.body as any).operation === 'list_connectors' ? [] : { items: [], total: 0 })
  } })
  await mount('settings')
  const providers = container.querySelector<HTMLSelectElement>('select')!
  await change(providers, provider)
  const models = [...container.querySelectorAll('select')].find(s => s.textContent?.includes('Modelo con esfuerzo'))!
  await change(models, 'fixture/chat')
  const effort = container.querySelector<HTMLSelectElement>('[aria-label="Esfuerzo de razonamiento"]')!
  expect([...effort.options].map(o => o.value)).toEqual(['', 'low', 'high'])
  await change(effort, 'high')
  await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Probar modelo')!.click() }); await tick()
  expect(mock.lastCall(`${path}/test`, 'POST')?.body).toEqual({ model: 'fixture/chat', reasoning_effort: 'high' })
  expect(container.textContent).toContain('Modelo verificado')
  await change(effort, 'low')
  expect(container.textContent).not.toContain('Modelo verificado')
  await act(async () => { models.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await tick()
  expect(mock.lastCall('/memory/ai', 'PUT')?.body).toMatchObject({ extraction_reasoning_effort: 'low' })
  await change(models, 'fixture/other')
  expect(effort.value).toBe('')
  expect([...effort.options].map(o => o.value)).toEqual([''])
  await change(models, 'fixture/chat'); await change(effort, 'high')
  await change(providers, 'ollama')
  await act(async () => { providers.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await tick()
  expect(mock.lastCall('/memory/ai', 'PUT')?.body).toMatchObject({ extraction_reasoning_effort: '' })
})
