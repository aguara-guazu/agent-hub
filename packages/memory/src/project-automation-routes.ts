import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { check, id, parse } from './contracts.js'
import { delegationDocument } from './project-automation.js'
import type { ProjectAutomationService } from './project-automation-service.js'

const params = z.object({ id }).strict()
const channelInput = z.object({ name: z.string().trim().min(1).max(200), objective: z.string().trim().min(1).max(2000) }).strict()
const activation = z.object({ enabled: z.boolean(), expected_version: z.number().int().min(1).nullable(), channel_id: id.nullable(), channel: channelInput.optional(), document: delegationDocument.optional() }).strict()
const repositories = z.object({ repositories: z.array(z.object({ repo_path: z.string().min(1).max(4000), remote_name: z.string().min(1).max(64).optional(), allowed_branches: z.array(z.string().min(1).max(200)).max(50) }).strict()).max(20) }).strict()

/** Human routes of the per-project activation. Owner authorization only: none of them is an agent operation. */
export function registerProjectAutomationRoutes(app: FastifyInstance, service: () => Promise<ProjectAutomationService>, authorize: (request: FastifyRequest) => Promise<{ id: string }>) {
  const auth = async (request: FastifyRequest) => { await authorize(request) }
  const projectId = (request: FastifyRequest) => parse(params, request.params).id

  app.get('/api/memory/projects/:id/automation', { preHandler: auth }, async request => (await service()).view(projectId(request)))
  app.put('/api/memory/projects/:id/automation', { preHandler: auth, bodyLimit: 32_768 }, async request => {
    const owner = await authorize(request), body = parse(activation, request.body)
    check(!body.enabled || body.document, 'Activar un proyecto requiere el documento de delegación.', 422)
    const { schedules: _schedules, plans: _plans, coordinator_state: _state, changed: _changed, ...view } = await (await service()).activate({ kind: 'human', ref: owner.id },
      { project_id: projectId(request), enabled: body.enabled, delegation: body.document, channel_id: body.channel_id, ...(body.channel ? { channel: body.channel } : {}), expected_version: body.expected_version })
    return view
  })
  app.put('/api/memory/projects/:id/repositories', { preHandler: auth, bodyLimit: 32_768 }, async request => (await service()).setRepositories(projectId(request), parse(repositories, request.body).repositories))
  app.get('/api/memory/projects/:id/repositories/branches', { preHandler: auth }, async request => {
    const { repo_path } = parse(z.object({ repo_path: z.string().min(1).max(4000) }).strict(), request.query)
    return (await service()).branches(projectId(request), repo_path)
  })
}
