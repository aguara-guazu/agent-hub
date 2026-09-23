import { Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Layout } from './Layout'
import { MemoryEntityPage, MemoryExplore, MemoryProjects } from '../pages/Memory'
import { actAsync, click, flush, installFetch, jsonResponse, renderWithProviders, setValue, setupDom, teardownDom } from '../test-utils'

const stamp = '2026-09-23T12:00:00Z'
const project = { id: 'p1', title: 'Proyecto Atlas', kind: 'project', data: {}, created_at: stamp, updated_at: stamp }
const fact = { ...project, id: 'f1', title: 'Servicios independientes', kind: 'fact', data: { text: 'Elegimos microservicios' } }
const rows = [project,fact].map(e => ({ key: `entity:${e.id}`, entity_id: e.id, title: e.title, kind: e.kind, preview: 'Contexto de arquitectura', projects: [project], updated_at: stamp, href: e.kind === 'project' ? `/projects/${e.id}` : `/memory/entities/${e.id}?version=v1&fragment=x1` }))
// jsdom does not implement the top-layer dialog API. Focus containment is also checked in Chromium.
Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value() { this.setAttribute('open','') } },
  close: { configurable: true, value() { this.removeAttribute('open') } },
})
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} })
beforeEach(() => { setupDom(); window.history.replaceState(null, '') })
afterEach(() => { teardownDom(); vi.restoreAllMocks() })
function Location() { const location = useLocation(); return <output data-location>{location.pathname}{location.search}</output> }
async function mount(route = '/projects') {
  const mock = installFetch({ handle: call => {
    if (call.path === '/local/overview') return jsonResponse({ hostname: 'Mi Mac', clients: [], rows: [] })
    if (call.path === '/memory/status') return jsonResponse({ ready: true, counts: {} })
    if (call.path === '/memory/search') {
      const input = call.body as any
      return jsonResponse({ items: rows.filter(r => !input.kind || r.kind === input.kind), total: 2, has_more: false, semantic_status: input.query ? 'not_configured' : 'not_requested' })
    }
    if (call.path === '/memory/call') {
      const { operation, input } = call.body as any
      if (operation === 'list_entities') return jsonResponse({ items: input.kind === 'project' ? [project] : [fact], total: 1, limit: 50, offset: 0 })
      if (operation === 'get_entity') return jsonResponse({ entity: input.id === 'p1' ? project : fact, sources: [], links: [], evidence: [], changes: [] })
    }
  } })
  const view = await renderWithProviders(<><Location /><Routes><Route element={<Layout />}>
    <Route path="/projects" element={<MemoryProjects />} /><Route path="/projects/:id" element={<MemoryEntityPage />} />
    <Route path="/memory" element={<MemoryExplore />} /><Route path="/memory/entities/:id" element={<MemoryEntityPage />} />
    <Route path="*" element={<p>Otra sección</p>} />
  </Route></Routes></>, { route })
  await flush(4)
  return { ...view, mock }
}
const back = () => document.querySelector<HTMLButtonElement>('[aria-label="Volver atrás"]')!
const trigger = () => document.querySelector<HTMLButtonElement>('.hub-search-trigger')!
const dialog = () => document.querySelector<HTMLDialogElement>('dialog')!
const input = () => dialog().querySelector<HTMLInputElement>('input')!
const location = () => document.querySelector('[data-location]')!.textContent
const key = (target: Element | Document, value: string, extra = {}) => actAsync(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra })) })

it('abre desde cualquier sección, restaura el foco y permite recorrer y abrir resultados con teclado', async () => {
  await mount('/catalog')
  trigger().focus()
  await key(document, 'k', { ctrlKey: true }); await flush(3)
  expect(dialog().open).toBe(true); expect(document.activeElement).toBe(input())
  await key(document, 'k', { ctrlKey: true })
  expect(dialog().open).toBe(false); expect(document.activeElement).toBe(trigger())
  await click(trigger()); await flush(3)
  await key(input(), 'ArrowDown')
  expect(dialog().querySelector('[aria-selected="true"]')!.textContent).toContain(fact.title)
  await key(input(), 'Enter'); await flush(3)
  expect(dialog().open).toBe(false)
  expect(location()).toBe('/memory/entities/f1?version=v1&fragment=x1')
  expect(back().disabled).toBe(false)
  await click(back())
  expect(location()).toBe('/catalog')
})

it('envía la búsqueda y los filtros, ofrece la configuración local y permite cerrar con Escape', async () => {
  const { mock } = await mount()
  await click(trigger()); await flush(3)
  await setValue(input(), '  decisiones de arquitectura  ')
  await actAsync(() => new Promise(resolve => setTimeout(resolve, 330))); await flush(3)
  expect(mock.lastCall('/memory/search')!.body).toMatchObject({ query: 'decisiones de arquitectura', limit: 20 })
  expect(dialog().textContent).toContain('Por palabras · activá la búsqueda por significado')
  expect(dialog().querySelector('footer a')!.getAttribute('href')).toBe('/memory/sources')
  await click([...dialog().querySelectorAll('button')].find(b => b.textContent === 'Conocimientos')); await flush(3)
  await click(dialog().querySelector('.global-search-filter-button')); await flush(3)
  const selects = dialog().querySelectorAll('select')
  await setValue(selects[0], 'p1'); await flush(3)
  await setValue(selects[2], '7'); await flush(3)
  expect(mock.lastCall('/memory/search')!.body).toMatchObject({ query: 'decisiones de arquitectura', kind: 'fact', project_id: 'p1' })
  expect(Date.parse((mock.lastCall('/memory/search')!.body as any).from)).toBeLessThan(Date.now())
  expect(dialog().querySelectorAll('[role="option"]')).toHaveLength(1)
  await actAsync(() => { dialog().dispatchEvent(new Event('cancel', { bubbles: false, cancelable: true })) })
  expect(dialog().open).toBe(false)
})

it('no roba el atajo cuando se está editando en otro modal', async () => {
  await mount()
  const other = document.createElement('div'); other.setAttribute('role', 'dialog'); document.body.appendChild(other)
  await key(document, 'k', { metaKey: true })
  expect(dialog().open).toBe(false)
  other.remove()
})

it('vuelve a la pestaña del proyecto y a la lista filtrada sin reiniciar el recorrido', async () => {
  await mount()
  expect(back().disabled).toBe(true)
  await setValue(document.querySelector('[aria-label="Buscar proyectos"]'), 'Atlas'); await flush(3)
  await click(document.querySelector('.memory-project-card')); await flush(3)
  await click([...document.querySelectorAll('.memory-project-tabs button')].find(b => b.textContent === 'Decisiones y hallazgos')); await flush(3)
  expect(location()).toBe('/projects/p1?tab=fact')
  await click(document.querySelector('.memory-entity-row')); await flush(3)
  expect(location()).toBe('/memory/entities/f1')
  await click(back()); await flush(3)
  expect(document.querySelector('.memory-project-tabs .active')!.textContent).toBe('Decisiones y hallazgos')
  await click(back()); await flush(3)
  expect(location()).toBe('/projects?q=Atlas')
  expect(document.querySelector<HTMLInputElement>('[aria-label="Buscar proyectos"]')!.value).toBe('Atlas')
  expect(back().disabled).toBe(true)
})

it('ofrece volver al padre al entrar directamente a un detalle y restaura filtros de Explorar', async () => {
  await mount('/memory/entities/f1')
  expect(back().disabled).toBe(false)
  await click(back()); await flush(3)
  expect(location()).toBe('/memory')
  expect(back().disabled).toBe(true)
  await setValue(document.querySelector('[aria-label="Tipo de entidad"]'), 'fact'); await flush(3)
  await click(document.querySelector('.memory-entity-row')); await flush(3)
  await click(back()); await flush(3)
  expect(location()).toBe('/memory?kind=fact')
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Tipo de entidad"]')!.value).toBe('fact')
})
