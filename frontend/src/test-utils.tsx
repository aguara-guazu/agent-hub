/** Herramientas de render para las pruebas de la consola.
 *
 *  El proyecto no tiene @testing-library instalado y no se instala nada nuevo, asi
 *  que todo se monta con `createRoot` y se consulta el DOM a mano. Este archivo
 *  concentra las tres cosas que si o si comparten todas las pantallas:
 *
 *  1. Los proveedores reales (QueryClient, router, avisos y sesion). No hay dobles
 *     de `AuthProvider`: la sesion se simula respondiendo `GET /auth/me`, que es lo
 *     que hace el navegador de verdad.
 *  2. Un `fetch` simulado que registra cada llamada. Las pruebas de la matriz
 *     verifican el cuerpo exacto del PUT, asi que el registro es parte del contrato.
 *  3. Interacciones envueltas en `act`, incluida la escritura en campos, que en
 *     React necesita esquivar el rastreador de valor del nodo.
 */

import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'

import { ToastProvider } from './components/Toast'
import { setToken } from './lib/api'
import { AuthProvider } from './lib/auth'
import type { User } from './lib/types'

/** Token que se guarda cuando una prueba pide sesion iniciada. */
export const TEST_TOKEN = 'jwt-de-prueba'

/* -------------------------------------------------------------------------- */
/* Entorno                                                                      */
/* -------------------------------------------------------------------------- */

/** Node 26 expone un `localStorage` global propio que queda deshabilitado sin
 *  --localstorage-file y tapa al de jsdom: sin esto lib/api no puede guardar el
 *  token y toda sesion simulada arranca vacia. En el navegador no aplica. */
export function memoryStorage(): Storage {
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

/** Prepara jsdom para React y para lib/api. Va en el `beforeEach` de cada suite. */
export function setupDom(): void {
  ;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('localStorage', memoryStorage())
  window.location.hash = ''
  setToken(null)
}

/** Desmonta todo, saca los globales simulados y borra la sesion. */
export function teardownDom(): void {
  cleanup()
  vi.unstubAllGlobals()
  setToken(null)
}

/* -------------------------------------------------------------------------- */
/* fetch simulado                                                               */
/* -------------------------------------------------------------------------- */

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function noContent(): Response {
  return new Response(null, { status: 204 })
}

/** Una llamada al control plane, tal como la vio el `fetch` simulado. */
export interface ApiCall {
  method: string
  /** Ruta sin el prefijo `/api` ni la query. */
  path: string
  /** URL completa, con query. */
  url: string
  /** Cuerpo ya parseado, o `undefined` si la llamada no llevaba JSON. */
  body: unknown
}

/** Devuelve la respuesta de una ruta, o `undefined` para caer en los valores por
 *  defecto (`/auth/me` y un 404 que nombra la ruta sin handler). */
export type ApiHandler = (call: ApiCall) => Response | Promise<Response> | undefined

export interface FetchMockOptions {
  /** Lo que devuelve `GET /auth/me`. Con un usuario se guarda el token, asi que la
   *  sesion arranca iniciada; con `null` se responde 401. */
  user?: User | null
  handle?: ApiHandler
}

export interface FetchMock {
  /** Todas las llamadas, en orden. */
  calls: ApiCall[]
  callsTo: (path: string, method?: string) => ApiCall[]
  lastCall: (path: string, method?: string) => ApiCall | undefined
}

export function installFetch(options: FetchMockOptions = {}): FetchMock {
  const calls: ApiCall[] = []
  const user = options.user ?? null
  if (user !== null) setToken(TEST_TOKEN)

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const withoutPrefix = url.startsWith('/api') ? url.slice(4) : url
      const path = withoutPrefix.split('?')[0]
      const method = (init?.method ?? 'GET').toUpperCase()
      let body: unknown
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      const call: ApiCall = { method, path, url, body }
      calls.push(call)

      const answer = options.handle?.(call)
      if (answer !== undefined) return answer
      if (path === '/auth/me') {
        return user !== null ? jsonResponse(user) : jsonResponse({ detail: 'token invalido' }, 401)
      }
      return jsonResponse({ detail: `sin handler de prueba para ${method} ${path}` }, 404)
    }),
  )

  const matching = (path: string, method?: string): ApiCall[] =>
    calls.filter((call) => call.path === path && (method === undefined || call.method === method))

  return {
    calls,
    callsTo: matching,
    lastCall: (path, method) => matching(path, method).at(-1),
  }
}

/** Promesa que resuelve la prueba, para mirar el DOM con una llamada en vuelo. */
export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/* -------------------------------------------------------------------------- */
/* Montaje                                                                      */
/* -------------------------------------------------------------------------- */

export interface RenderOptions {
  /** Ruta inicial del router en memoria. */
  route?: string
  client?: QueryClient
}

export interface RenderResult {
  container: HTMLElement
  client: QueryClient
  unmount: () => void
}

interface Mounted {
  root: Root
  container: HTMLElement
}

const mounted: Mounted[] = []

function unmountEntry(entry: Mounted): void {
  act(() => entry.root.unmount())
  entry.container.remove()
}

/** Desmonta lo que quedo montado. Sin esto, dos pruebas de la misma suite se
 *  pisan: los modales viven en document.body y las consultas por texto los ven. */
export function cleanup(): void {
  while (mounted.length > 0) {
    const entry = mounted.pop()
    if (entry !== undefined) unmountEntry(entry)
  }
}

export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // Sin reintentos: una prueba que espera un error no puede esperar tres veces.
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })
}

/** Monta un componente con los proveedores reales de la consola.
 *
 *  El orden importa: `AuthProvider` usa `useQueryClient` y `useLocation`, asi que
 *  va adentro del cliente de consultas y del router. */
export async function renderWithProviders(
  ui: ReactNode,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const client = options.client ?? testQueryClient()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const entry: Mounted = { root, container }
  mounted.push(entry)

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[options.route ?? '/matrix']}>
          <ToastProvider>
            <AuthProvider>{ui}</AuthProvider>
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  })
  // La sesion y la primera consulta necesitan un par de vueltas de la cola antes
  // de que la pantalla tenga datos que mirar.
  await flush(2)

  return {
    container,
    client,
    unmount: () => {
      const index = mounted.indexOf(entry)
      if (index !== -1) mounted.splice(index, 1)
      unmountEntry(entry)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Interacciones                                                                */
/* -------------------------------------------------------------------------- */

/** Drena la cola de tareas dentro de `act`. */
export async function flush(times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Corre algo dentro de `act` y drena la cola despues. */
export async function actAsync(fn: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

export async function click(target: Element | null | undefined): Promise<void> {
  if (target === null || target === undefined) throw new Error('click: el elemento no existe')
  await actAsync(() => {
    if (target instanceof HTMLElement) target.click()
    else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

type ValueElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

/** Escribe en un campo controlado por React.
 *
 *  React guarda el ultimo valor en un rastreador pegado al nodo: si se asigna
 *  `node.value` de la forma normal, el rastreador se actualiza solo y React
 *  concluye que nada cambio, asi que no dispara `onChange`. Por eso se usa el
 *  setter nativo del prototipo. */
export async function setValue(target: Element | null | undefined, value: string): Promise<void> {
  if (
    !(target instanceof HTMLInputElement) &&
    !(target instanceof HTMLTextAreaElement) &&
    !(target instanceof HTMLSelectElement)
  ) {
    throw new Error('setValue: el elemento no es un campo de formulario')
  }
  const field: ValueElement = target
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')
  descriptor?.set?.call(field, value)
  await actAsync(() => {
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/* -------------------------------------------------------------------------- */
/* Consultas al DOM                                                             */
/* -------------------------------------------------------------------------- */

export function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T | null {
  return root.querySelector<T>(selector)
}

export function qa<T extends Element = HTMLElement>(root: ParentNode, selector: string): T[] {
  return [...root.querySelectorAll<T>(selector)]
}

/** Como `q`, pero falla con un mensaje util en vez de devolver null. */
export function need<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector)
  if (found === null) throw new Error(`no hay ningun «${selector}» en el DOM`)
  return found
}

/** Boton cuyo texto contiene `text`. Falla listando los que si estan. */
export function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const buttons = qa<HTMLButtonElement>(root, 'button')
  const found = buttons.find((button) => (button.textContent ?? '').includes(text))
  if (found === undefined) {
    const labels = buttons.map((button) => `«${(button.textContent ?? '').trim()}»`).join(', ')
    throw new Error(`no hay boton con el texto «${text}». Hay: ${labels || 'ninguno'}`)
  }
  return found
}

export function textOf(root: ParentNode | null | undefined): string {
  return (root as HTMLElement | null | undefined)?.textContent ?? ''
}

/** El title de un elemento, para las celdas que explican su estado por tooltip. */
export function titleOf(element: Element | null | undefined): string {
  return element?.getAttribute('title') ?? ''
}
