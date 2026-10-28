import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectAutomation } from './ProjectAutomation'
import type { ProjectAutomationView } from '../lib/project-automation'
import type { MemoryEntity } from '../lib/memory'
import type { User } from '../lib/types'
import { buttonByText, click, flush, installFetch, jsonResponse, qa, renderWithProviders, setValue, setupDom, teardownDom, textOf } from '../test-utils'

const user = { id: 'u1', email: 'a@b.c', full_name: 'Ana', org_role: 'member', is_active: true, squads: [], organization: 'Local' } as User
const project = (data: Record<string, unknown> = { jira_project_key: 'ABC' }): MemoryEntity => ({ id: 'p1', kind: 'project', title: 'Proyecto X', data, created_at: '', updated_at: '' })
const document = { schema_version: 1 as const, roster: { coordinator: { cli: 'claude_code', model: 'opus' }, project_agent: { cli: 'codex_cli', model: 'gpt' } }, item_kinds: ['jira_worklog' as const], repository_ids: [], limits: { max_concurrent_plans: 1, max_members: 2, max_runtime_minutes: 60 } }
const off: ProjectAutomationView = { project_id: 'p1', enabled: false, delegation: null, channel: null, channel_candidates: [{ id: 'c1', name: 'feature/x' }], coordinator: 'no_channel', repositories: [{ id: 'r1', repo_path: '/repo', canonical_remote_url: 'git@x:y.git', remote_name: 'origin', default_branch: 'main', allowed_branches: ['feat/*'] }] }
const on = (source: 'owner_ui' | 'coordinator_declaration'): ProjectAutomationView => ({ ...off, enabled: true, coordinator: 'ready', channel: { id: 'c1', name: 'feature/x' },
  delegation: { version: 2, digest: 'abcdef0123456789', approval_source: source, instruction: 'activa el brief', created_at: '2026-10-28T12:00:00Z', revoked_at: null, document } })

beforeEach(setupDom)
afterEach(teardownDom)

function mock(view: ProjectAutomationView) {
  return installFetch({ user, handle: call => {
    if (call.path === '/memory/projects/p1/automation') return jsonResponse(call.method === 'PUT' ? view : view)
    if (call.path === '/memory/schedules/delivery-channels') return jsonResponse({ items: [{ channel: 'app', available: true }, { channel: 'gmail', available: false, reason: 'scope_missing', destination: 'ana@example.com' }] })
    if (call.path === '/memory/call') return jsonResponse((call.body as { operation: string }).operation === 'list_connectors' ? [{ id: 'g1', provider: 'google', name: 'Google trabajo', config: { gmail_enabled: true }, project_ids: [], interval_minutes: 30, enabled: true }] : {})
    if (call.path === '/memory/connectors/g1/google/start') return jsonResponse({ authorization_url: 'https://accounts.google.com/o/oauth2/auth?x=1' })
    if (call.path === '/memory/schedules') return jsonResponse({ items: [], total: 0, limit: 200, offset: 0 })
    if (call.path === '/memory/schedules/runs') return jsonResponse({ items: [], total: 0, limit: 1, offset: 0 })
    return undefined
  } })
}

it('apagado: explica la función y ofrece activarla', async () => {
  mock(off)
  const { container } = await renderWithProviders(<ProjectAutomation project={project()} />)
  expect(textOf(container)).toContain('Cada mañana a las 08:00 recibes el estado del proyecto')
  expect(qa(container, 'button').some(button => button.textContent === 'Activar para este proyecto')).toBe(true)
})

it('activar confirma una sola vez con el documento y la versión esperada', async () => {
  const api = mock(off)
  const { container } = await renderWithProviders(<ProjectAutomation project={project()} />)
  await click(buttonByText(container, 'Activar para este proyecto'))
  expect(textOf(container)).toContain('Gmail a ana@example.com: Falta autorizar el envío')
  const [coordinatorModel, agentModel] = qa<HTMLInputElement>(container, '.project-automation-roster input')
  await setValue(coordinatorModel, 'opus')
  await setValue(agentModel, 'gpt')
  await click(buttonByText(container, 'Activar para este proyecto'))
  const body = api.lastCall('/memory/projects/p1/automation', 'PUT')?.body as { enabled: boolean; expected_version: number | null; channel_id: string; document: typeof document }
  expect(body.enabled).toBe(true)
  expect(body.expected_version).toBeNull()
  expect(body.channel_id).toBe('c1')
  expect(body.document.item_kinds).toEqual(['jira_worklog'])
  expect(body.document.roster).toEqual({ coordinator: { cli: 'claude_code', model: 'opus' }, project_agent: { cli: 'claude_code', model: 'gpt' } })
  expect(body.document.limits).toEqual({ max_concurrent_plans: 1, max_members: 2, max_runtime_minutes: 60 })
})

it('sin clave de Jira deshabilita las acciones de Jira y lo dice', async () => {
  mock(off)
  const { container } = await renderWithProviders(<ProjectAutomation project={project({})} />)
  await click(buttonByText(container, 'Activar para este proyecto'))
  expect(textOf(container)).toContain('Falta la clave de proyecto de Jira')
  expect(qa<HTMLInputElement>(container, 'input[type="checkbox"]').slice(0, 2).every(box => box.disabled)).toBe(true)
})

it('advierte cuando el proyecto excluye el procesamiento remoto', async () => {
  mock(off)
  const { container } = await renderWithProviders(<ProjectAutomation project={project({ jira_project_key: 'ABC', remote_processing: false })} />)
  await click(buttonByText(container, 'Activar para este proyecto'))
  expect(textOf(container)).toContain('El resumen de este proyecto no se generará con un modelo remoto')
})

it('sin canal autorizado no pide coordinador y avisa qué sigue funcionando', async () => {
  mock({ ...off, channel_candidates: [] })
  const { container } = await renderWithProviders(<ProjectAutomation project={project()} />)
  await click(buttonByText(container, 'Activar para este proyecto'))
  expect(textOf(container)).toContain('Sin canal: el brief, el cierre y el estado funcionan igual')
  expect(qa(container, '.project-automation-roster')).toHaveLength(0)
  expect(buttonByText(container, 'Activar para este proyecto').disabled).toBe(false)
})

it('activo: muestra la delegación aprobada en la app y permite desactivar con confirmación', async () => {
  const api = mock(on('owner_ui'))
  const { container } = await renderWithProviders(<ProjectAutomation project={project()} />)
  expect(textOf(container)).toContain('Delegación v2')
  expect(textOf(container)).toContain('Aprobada en la app')
  expect(textOf(container)).toContain('digest abcdef01…')
  expect(qa(container, 'button').some(button => button.textContent === 'Confirmar en la app')).toBe(false)
  await click(buttonByText(container, 'Desactivar'))
  await click(qa(document_body(), 'button').filter(button => button.textContent === 'Desactivar').at(-1))
  const body = api.lastCall('/memory/projects/p1/automation', 'PUT')?.body as { enabled: boolean; expected_version: number }
  expect(body).toMatchObject({ enabled: false, expected_version: 2 })
})

it('una delegación declarada por un agente muestra su frase y se confirma en la app', async () => {
  const api = mock(on('coordinator_declaration'))
  const { container } = await renderWithProviders(<ProjectAutomation project={project()} />)
  expect(textOf(container)).toContain('Declarada por un agente: «activa el brief»')
  await click(buttonByText(container, 'Confirmar en la app'))
  expect(api.lastCall('/memory/projects/p1/automation', 'PUT')?.body).toMatchObject({ enabled: true, expected_version: 2, document })
})

function document_body(): HTMLElement { return globalThis.document.body }

it('Autorizar guarda gmail_send_enabled en la fuente y abre la autorización de Google tras el aviso', async () => {
  const api = mock(off)
  const open = vi.fn()
  vi.stubGlobal('open', open)
  const { container } = await renderWithProviders(<ProjectAutomation project={project()} />)
  await click(buttonByText(container, 'Activar para este proyecto'))
  await flush(3)
  await click(buttonByText(container, 'Autorizar'))
  expect(textOf(globalThis.document.body)).toContain('Google mostrará una pantalla de advertencia')
  expect(textOf(globalThis.document.body)).toContain('Agent Hub solo enviará correos a ana@example.com; nunca a terceros')
  await click(buttonByText(globalThis.document.body, 'Continuar con Google'))
  const saved = api.calls.find(call => call.path === '/memory/call' && (call.body as { operation: string }).operation === 'save_connector')?.body as { input: { id: string; config: Record<string, unknown> } }
  expect(saved.input.id).toBe('g1')
  expect(saved.input.config).toEqual({ gmail_enabled: true, gmail_send_enabled: true })
  expect(api.callsTo('/memory/connectors/g1/google/start', 'POST')).toHaveLength(1)
  expect(open).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth?x=1', '_blank', 'noopener,noreferrer')
})
