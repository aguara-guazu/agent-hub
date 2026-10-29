import { afterEach, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { registerProjectAutomationRoutes } from '../src/project-automation-routes.js'
import type { ProjectAutomationService } from '../src/project-automation-service.js'

const projectId = randomUUID(), channelId = randomUUID()
const stub = {
  view: vi.fn(async (id: string) => ({ project_id: id })),
  activate: vi.fn(async (_principal: unknown, input: Record<string, unknown>) => ({ project_id: input.project_id, enabled: input.enabled, schedules: [{ template: 'daily_brief' }], plans: { closed: [], failed: [] }, coordinator_state: 'ready', changed: true })),
  addRepository: vi.fn(async (_id: string, input: unknown) => ({ repository: input })),
  updateRepository: vi.fn(async (_id: string, repoId: string, patch: unknown) => ({ repository: { id: repoId, ...(patch as object) } })),
  removeRepository: vi.fn(async (_id: string, repoId: string) => ({ removed: repoId })),
  replaceRepositories: vi.fn(async (_id: string, repositories: unknown, digest: string) => ({ repositories, digest })),
  branches: vi.fn(async () => ({ branches: ['main'], default_branch: 'main' })),
}
const document = { schema_version: 1, roster: { coordinator: { cli: 'claude_code', model: 'm' }, project_agent: { cli: 'claude_code', model: 'm' } }, item_kinds: ['jira_worklog'], repository_ids: [], limits: { max_concurrent_plans: 1, max_runtime_minutes: 30 } }
let allowed = true
const app = Fastify()
registerProjectAutomationRoutes(app, async () => stub as unknown as ProjectAutomationService, async () => { if (!allowed) throw Object.assign(new Error('no'), { statusCode: 401 }); return { id: 'owner-1' } })
afterEach(() => { vi.clearAllMocks(); allowed = true })

it('activates as the owner and answers only the view, without the internal outcome fields', async () => {
  const response = await app.inject({ method: 'PUT', url: `/api/memory/projects/${projectId}/automation`, payload: { enabled: true, expected_version: null, channel_id: channelId, document } })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ project_id: projectId, enabled: true })
  expect(stub.activate).toHaveBeenCalledWith({ kind: 'human', ref: 'owner-1' }, { project_id: projectId, enabled: true, delegation: document, channel_id: channelId, expected_version: null })
})

it('rejects unknown fields, a missing document and a malformed project id before reaching the service', async () => {
  const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, payload: payload as never })
  const base = { enabled: true, expected_version: null, channel_id: null }
  expect((await put(`/api/memory/projects/${projectId}/automation`, { ...base, document: { ...document, limits: { ...document.limits, max_members: 2 } } })).statusCode).toBeGreaterThanOrEqual(400)
  expect((await put(`/api/memory/projects/${projectId}/automation`, base)).statusCode).toBeGreaterThanOrEqual(400)
  expect((await put(`/api/memory/projects/${projectId}/automation`, { ...base, document, extra: 1 })).statusCode).toBeGreaterThanOrEqual(400)
  expect((await put('/api/memory/projects/not-a-uuid/automation', { ...base, document })).statusCode).toBeGreaterThanOrEqual(400)
  expect(stub.activate).not.toHaveBeenCalled()
  const off = await put(`/api/memory/projects/${projectId}/automation`, { enabled: false, expected_version: 1, channel_id: null })
  expect(off.statusCode).toBe(200)
})

const digest = 'a'.repeat(64), repository = { repo_path: '/r', allowed_branches: ['feature/*'] }

it('adds, updates, removes and replaces repositories through separate routes and only the replacement takes a digest', async () => {
  const base = `/api/memory/projects/${projectId}/repositories`
  expect((await app.inject({ method: 'POST', url: base, payload: repository })).json()).toEqual({ repository })
  expect(stub.addRepository).toHaveBeenCalledWith(projectId, repository)
  expect((await app.inject({ method: 'PUT', url: `${base}/repo-1`, payload: { allowed_branches: ['x/*'] } })).json()).toEqual({ repository: { id: 'repo-1', allowed_branches: ['x/*'] } })
  expect((await app.inject({ method: 'DELETE', url: `${base}/repo-1` })).json()).toEqual({ removed: 'repo-1' })
  expect((await app.inject({ method: 'PUT', url: base, payload: { repositories: [repository], expected_ids_digest: digest } })).statusCode).toBe(200)
  expect(stub.replaceRepositories).toHaveBeenCalledWith(projectId, [repository], digest)
  for (const payload of [{ repositories: [repository] }, { repositories: [repository], expected_ids_digest: 'short' }, { ...repository }, { repositories: [{ ...repository, repo_path: undefined }], expected_ids_digest: digest }])
    expect((await app.inject({ method: 'PUT', url: base, payload: payload as never })).statusCode).toBeGreaterThanOrEqual(400)
  expect((await app.inject({ method: 'POST', url: base, payload: { ...repository, id: 'x' } as never })).statusCode).toBeGreaterThanOrEqual(400)
  expect(stub.replaceRepositories).toHaveBeenCalledTimes(1)
})

it('serves the view and the branches only to the owner, and every repository route needs that authorization', async () => {
  expect((await app.inject({ method: 'GET', url: `/api/memory/projects/${projectId}/automation` })).json()).toEqual({ project_id: projectId })
  expect((await app.inject({ method: 'GET', url: `/api/memory/projects/${projectId}/repositories/branches?repo_path=%2Fr` })).json()).toEqual({ branches: ['main'], default_branch: 'main' })
  expect((await app.inject({ method: 'GET', url: `/api/memory/projects/${projectId}/repositories/branches` })).statusCode).toBeGreaterThanOrEqual(400)
  allowed = false
  const base = `/api/memory/projects/${projectId}/repositories`
  for (const request of [{ method: 'GET', url: `/api/memory/projects/${projectId}/automation` }, { method: 'POST', url: base, payload: repository }, { method: 'PUT', url: `${base}/r1`, payload: { allowed_branches: [] } },
    { method: 'DELETE', url: `${base}/r1` }, { method: 'PUT', url: base, payload: { repositories: [], expected_ids_digest: digest } }] as const)
    expect((await app.inject(request as never)).statusCode).toBe(401)
})
