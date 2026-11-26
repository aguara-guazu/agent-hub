// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { portfolioPolicy } from '@agenthub/shared/assistants'
import Inbox from './Inbox'
import Settings from './Settings'
import { api } from '../../lib/api'
import { ToastProvider } from '../../components/ui'

it('abre la bandeja, el chat y los ajustes generales sin elegir el primer proyecto', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const projects = ['Alfa', 'Beta'].map((title) => ({ id: title.toLowerCase(), title, active: true, last_scan: null, last_error: null }))
  const notice = 'b2413265-13b5-49c6-96c5-c0d1c5991d4d'
  const get = vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/modules') return { agents: true, connections: true }
    if (path === '/assistants/projects') return { items: projects }
    if (path === '/assistants/notices/' + notice)
      return {
        entries: [
          {
            id: 'case-0',
            project: 'Alfa',
            source: 'Jira',
            title: 'ALF-1 vencida',
            reason: 'Bloquea la entrega de hoy',
            severity: 7,
            calendar: 'Demo Alfa en 25 min',
            url: 'https://example.atlassian.net/browse/ALF-1',
            route: '/assistants/case-0',
          },
          {
            id: 'case-1',
            project: 'Beta',
            source: 'Slack · clientes',
            title: 'Pregunta del cliente',
            reason: 'Te mencionaron en el hilo',
            severity: 8,
            url: 'https://app.slack.com/archives/CTest/p100',
            route: '/assistants/case-1',
          },
        ],
      }
    if (path.startsWith('/assistants/inbox?'))
      return {
        items: projects.map((p, i) => ({
          id: 'case-' + i,
          project_id: p.id,
          title: 'Asunto ' + p.title,
          state: 'open',
          kind: 'jira',
          reason: 'Entrega del proyecto',
          score: 9 - i,
        })),
        has_more: false,
        total: projects.length,
        urgent: projects.length,
        important: 0,
      }
    if (path === '/assistants/chat') return { item: null, messages: [] }
    if (path === '/assistants/work') return { items: [] }
    if (path === '/assistants/settings') return { version: 0, config: portfolioPolicy.parse({}) }
    throw Error('Ruta inesperada ' + path)
  })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const open = (entry: string) =>
    act(async () => {
      root.render(
        <QueryClientProvider client={cache}>
          <ToastProvider>
            <MemoryRouter key={entry} initialEntries={[entry]}>
              <Inbox />
            </MemoryRouter>
          </ToastProvider>
        </QueryClientProvider>,
      )
    })
  const shows = (text: string) =>
    vi.waitFor(async () => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
      expect(host.textContent).toContain(text)
    })
  try {
    await open('/assistants')
    await shows('Asunto Beta')
    expect(host.textContent).toContain('Asunto Alfa')
    expect(host.textContent).toMatch(/(Urgentes|Urgent) · 2/)
    expect(host.querySelector('.ph-text')?.textContent).toMatch(/^\D+2 /)
    expect(host.querySelector('#issue-case-1')).toBeTruthy()
    expect(host.querySelector('.assistant-composer textarea')).toBeTruthy()
    expect(get.mock.calls.some(([path]) => path === '/assistants/chat')).toBe(true)
    expect(get.mock.calls.some(([path]) => path.includes('project=') || path.startsWith('/assistants/projects/'))).toBe(false)
    await open('/assistants?notice=' + notice)
    await shows('ALF-1 vencida')
    expect(host.querySelectorAll('.assistant-rows .row')).toHaveLength(2)
    expect(host.textContent).toContain('Bloquea la entrega de hoy')
    expect(host.textContent).toContain('Demo Alfa en 25 min')
    expect(host.textContent).toContain('Slack · clientes')
    expect(host.textContent).not.toContain('Asunto Beta')
    expect(host.querySelector('#issue-case-1')).toBeTruthy()
    await act(async () => {
      root.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter>
            <Settings />
          </MemoryRouter>
        </QueryClientProvider>,
      )
    })
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
      expect(host.querySelector('form input[type=number]')).toBeTruthy()
    })
    expect(host.querySelector<HTMLInputElement>('input[min="1"][max="4"]')?.value).toBe('3')
    expect(host.querySelector<HTMLInputElement>('input[min="5"][max="240"]')?.value).toBe('30')
    expect(host.querySelector('[role="combobox"][aria-label$="9/10"]')).toBeTruthy()
    expect(get.mock.calls.some(([path]) => path === '/assistants/settings')).toBe(true)
    expect(get.mock.calls.some(([path]) => path.startsWith('/assistants/projects/'))).toBe(false)
  } finally {
    await act(async () => root.unmount())
    host.remove()
    cache.clear()
    get.mockRestore()
  }
})
