import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/Toast'
import { installFetch, jsonResponse } from '../test-utils'
import { ProjectSharing, ProjectForum } from './MemorySharing'

let root: Root, container: HTMLDivElement, client: QueryClient
let role: string, revoked: boolean, reveals: number, pending: ((response: Response) => void) | undefined, defer: boolean
const phrase = 'only owners may see this isolated test phrase'
const project = { id: 'project', kind: 'project', title: 'Proyecto', data: {}, created_at: '', updated_at: '' }
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  role = 'owner'; revoked = false; reveals = 0; defer = false; pending = undefined
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  installFetch({ handle: call => {
    const body = call.body as any
    if (call.path === '/memory/sharing/call') {
      if (body.operation === 'status') return jsonResponse({ identity: { id: 'me', name: 'Owner' }, network: { settings: { enabled: false, bootstrap: [] }, connected_peers: 0 }, projects: [{ id: project.id, enabled: true }] })
      if (body.operation === 'recovery_phrase') {
        reveals++
        if (defer) return new Promise<Response>(resolve => { pending = resolve })
        return jsonResponse({ recovery_phrase: phrase })
      }
    }
    if (call.path === '/memory/call') return jsonResponse(body.operation === 'shared_status'
      ? { members: [{ identity: { id: 'me', name: 'Owner' }, role, invite: false, revoked, expires_at: null }], conflict: null, publications: [] }
      : body.operation === 'read_messages' ? { items: [{ id: 'message', agent_label: 'Agente A', text: 'Coordinación visible', created_at: '2026-10-16', expires_at: '2026-10-17', to_member: null }], total: 1 } : { items: [], total: 0 })
  } })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(30) }) }
async function mount(forum = false) {
  await act(async () => { root.render(<QueryClientProvider client={client}><ToastProvider>{forum ? <ProjectForum projectId={project.id} /> : <ProjectSharing project={project} />}</ToastProvider></QueryClientProvider>) })
  await tick(); await tick()
}
const revealButton = () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Ver palabras de recuperación')
const phraseField = () => document.querySelector<HTMLTextAreaElement>('[aria-label="Frase de recuperación del proyecto"]')
async function click(button: HTMLButtonElement) { await act(async () => button.click()); await tick(); await tick() }

it.each(['reader', 'maintainer', 'revoked owner'])('no ofrece ni consulta la frase para %s', async value => {
  role = value === 'revoked owner' ? 'owner' : value; revoked = value === 'revoked owner'
  await mount()
  expect(revealButton()).toBeUndefined(); expect(reveals).toBe(0); expect(phraseField()).toBeNull()
})
it('sólo revela a pedido, no cachea la frase y la retira cuando pierde el rol owner', async () => {
  await mount(); expect(reveals).toBe(0)
  await click(revealButton()!)
  expect(phraseField()?.value).toBe(phrase)
  expect(JSON.stringify(client.getQueryCache().getAll().map(q => q.state.data))).not.toContain(phrase)
  role = 'reader'
  await act(async () => { await client.invalidateQueries({ queryKey: ['memory'] }) }); await tick()
  expect(revealButton()).toBeUndefined(); expect(phraseField()).toBeNull()
})
it('cerrar mientras carga descarta la respuesta y exige otra consulta al volver a abrir', async () => {
  defer = true; await mount(); await click(revealButton()!)
  await click(document.querySelector<HTMLButtonElement>('[aria-label="Cerrar"]')!)
  await act(async () => { pending!(jsonResponse({ recovery_phrase: phrase })) }); await tick()
  expect(phraseField()).toBeNull()
  defer = false; await click(revealButton()!)
  expect(reveals).toBe(2); expect(phraseField()?.value).toBe(phrase)
})
it('separa el foro de compartir y permite observar sin formulario ni acciones sobre los mensajes', async () => {
  await mount()
  expect(container.textContent).not.toContain('Fuentes compartidas')
  expect(container.querySelector('[aria-label="Fuente para compartir"]')).toBeNull()
  expect(container.textContent).not.toContain('Coordinación visible')
  await mount(true)
  expect(container.textContent).toContain('Foro de agentes')
  expect(container.textContent).toContain('Coordinación visible')
  expect(container.querySelector('textarea,input')).toBeNull()
  expect(container.textContent).not.toContain('Marcar atendido')
  expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Enviar')).toBe(false)
})
