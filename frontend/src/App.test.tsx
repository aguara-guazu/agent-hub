/** Prueba de humo del esqueleto: ruteo, compuerta de sesion y navegacion.
 *  Monta la aplicacion real contra un fetch simulado; no hay libreria de testing
 *  de componentes en el proyecto, asi que se usa react-dom directo. */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HashRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { setToken } from './lib/api'
import type { User } from './lib/types'

declare global {
  // React exige esta bandera para que act() no avise en cada render.
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const member: User = {
  id: 'u-1',
  email: 'dev@craftech.io',
  full_name: 'Dev',
  org_role: 'member',
  is_active: true,
  squads: [],
  organization: 'Craftech',
}


/** Node 26 expone un `localStorage` global propio que queda deshabilitado sin
 *  --localstorage-file, y tapa al de jsdom: sin esto, lib/api no puede guardar el
 *  token y toda sesion simulada arranca vacia. En el navegador no aplica. */
function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, String(value)),
  } as unknown as Storage
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function stubApi(me: User | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/auth/me')) {
        return me ? jsonResponse(me) : new Response('{"detail":"token invalido"}', { status: 401 })
      }
      if (url.endsWith('/local/overview')) return jsonResponse({hostname:'Mi Mac', clients:[], rows:[]})
      return jsonResponse([])
    }),
  )
}

async function mount(): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <HashRouter>
          <App />
        </HashRouter>
      </QueryClientProvider>,
    )
  })
  // Las pantallas se cargan con React.lazy. Esperar sólo microtasks no alcanza:
  // Vite puede resolver el import dinámico en una vuelta posterior del event loop.
  // Desmontar antes deja la resolución de Suspense fuera de act() y Vitest 5 la
  // detecta como trabajo pendiente durante el teardown.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await act(async () => {
      await new Promise((resolveDone) => setTimeout(resolveDone, 0))
    })
    if (attempt > 5 && container.querySelector('.loading-block, .hub-loading') === null) break
    if (attempt === 49) throw new Error('timeout esperando que termine Suspense')
  }

  return {
    container,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
      client.clear()
    },
  }
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('localStorage', memoryStorage())
  delete window.agentHub
  window.history.replaceState(null, '', '/')
  setToken(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
  setToken(null)
})

describe('hub local de escritorio', () => {
  it('ofrece reconectar sin pedir cuenta cuando falta la sesión local', async () => {
    stubApi(null)
    const view = await mount()
    expect(view.container.textContent).toContain('Volver a conectar')
    expect(view.container.querySelector('input[type="password"]')).toBeNull()
    view.unmount()
  })
  it('abre el catálogo y limita la navegación a recursos locales', async () => {
    setToken('local-session')
    stubApi(member)
    const view = await mount()
    expect(window.location.hash).toBe('#/catalog')
    const links = [...view.container.querySelectorAll('nav a')].map(el => el.getAttribute('href'))
    expect(links).toEqual(['#/catalog', '#/skills', '#/projects', '#/memory', '#/clients', '#/activity'])
    expect(view.container.textContent).toContain('Mi Mac')
    expect(view.container.textContent).not.toContain(member.email)
    expect(view.container.textContent).not.toContain(member.organization)
    view.unmount()
  })
  it('consume la sesión de Electron y retira el token de la dirección', async () => {
    stubApi(member)
    window.history.replaceState(null, '', '/?sso_token=desktop-session#/skills')
    const view = await mount()
    expect(window.location.search).toBe('')
    expect(view.container.querySelector('h1')?.textContent).toBe('Skills')
    view.unmount()
  })
  it('recupera una sesión vencida a través del puente sin login', async () => {
    setToken('expired')
    const getSession = vi.fn(async () => 'renewed')
    window.agentHub = { getSession, getCoreStatus: async () => ({state:'running', daemonState:'running', apiBaseUrl:'http://localhost', pid:1}),
      getAutostart: async () => false, setAutostart: async value => value, restartCore: async () => {}, syncNow: async () => {}, onCoreStateChanged: () => () => {}, platform:'darwin' }
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      if (String(input).endsWith('/auth/me')) return init.headers.Authorization === 'Bearer renewed' ? jsonResponse(member) : new Response('{}', {status:401})
      if (String(input).endsWith('/local/overview')) return jsonResponse({hostname:'Mi Mac', clients:[], rows:[]})
      return jsonResponse([])
    }))
    const view = await mount()
    expect(getSession).toHaveBeenCalledOnce()
    expect(view.container.querySelector('h1')?.textContent).toBe('MCP servers')
    view.unmount()
  })
  it('mantiene los enlaces antiguos de clientes y actividad', async () => {
    for (const [route, heading] of [['machines','Clientes'], ['audit','Actividad'], ['settings','Ajustes']]) {
      setToken('local-session')
      stubApi(member)
      window.location.hash = '#/' + route
      const view = await mount()
      expect(view.container.querySelector('h1')?.textContent).toBe(heading)
      view.unmount()
    }
  })
})
