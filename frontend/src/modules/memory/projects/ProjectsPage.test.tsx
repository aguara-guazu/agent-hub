import i18n from '../../../i18n'
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { ToastProvider } from '../../../components/ui/Toast'
import { api } from '../../../lib/api'
import ProjectsPage from './ProjectsPage'

it('archiva desde la fila y devuelve a activos un proyecto con etapa completada', async () => {
  const previousLanguage = i18n.language
  await i18n.changeLanguage('es')
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const project = { id: 'p', title: 'Continuación', data: { status: 'completed' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  let archived = false, version = 0
  const get = vi.spyOn(api, 'get').mockImplementation(async () => ({ memory: true, sharing: false }))
  const post = vi.spyOn(api, 'post').mockImplementation(async (_path, raw) => {
    const { operation, input } = raw as { operation: string; input: Record<string, unknown> }
    const items = operation === 'list_entities' && input.kind === 'project' && (input.project_state === 'archived') === archived
      ? [{ ...project, archived_at: archived ? '2026-11-26' : null, archive_version: version }] : []
    return { items, total: items.length }
  })
  const put = vi.spyOn(api, 'put').mockImplementation(async (path, raw) => {
    expect(path).toBe('/memory/projects/p/archive')
    expect(raw).toEqual({ state: archived ? 'active' : 'archived', version })
    archived = !archived
    return { version: ++version }
  })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const host = document.createElement('div'), root = createRoot(host)
  const click = async (find: () => Element | null | undefined) => {
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
      expect(find(),host.textContent ?? undefined).toBeTruthy()
    })
    await act(async () => (find() as HTMLButtonElement).click())
  }
  const tab = (name: string) => [...host.querySelectorAll('button')].find(b => b.textContent === name)
  try {
    await act(async () => root.render(<QueryClientProvider client={cache}><MemoryRouter><ToastProvider><ProjectsPage /></ToastProvider></MemoryRouter></QueryClientProvider>))
    await click(() => host.querySelector('[aria-label="Archivar Continuación"]'))
    await vi.waitFor(() => expect(archived).toBe(true))
    await click(() => tab('Archivados'))
    await click(() => host.querySelector('[aria-label="Desarchivar Continuación"]'))
    await click(() => tab('Activos'))
    await vi.waitFor(async () => { await act(async () => { await new Promise(r => setTimeout(r, 5)) }); expect(host.querySelector('[aria-label="Archivar Continuación"]')).toBeTruthy() })
    expect(put).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => root.unmount()); cache.clear(); put.mockRestore(); post.mockRestore(); get.mockRestore(); await i18n.changeLanguage(previousLanguage)
  }
})
