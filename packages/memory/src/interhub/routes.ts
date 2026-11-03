import { z } from "zod"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { MemoryService } from "../service.js"
import { check, id, parse } from "../contracts.js"

const params = z.object({ id }).strict()
const page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(100), offset: z.coerce.number().int().min(0).default(0) }).strict()

/**
 * Read-only routes for the person's UI. The person never acts on inter-hub channels: they can only see the roster
 * and, at the hub that created the channel, the code to read or hand to their agent. Nothing here logs request or
 * response bodies, and every response is `no-store`.
 */
export function interhubRoutes(app: FastifyInstance, service: MemoryService, authorize: (request: FastifyRequest) => Promise<unknown>, requireCollaboration: () => void) {
  const services = async () => {
    const { operations } = await service.get()
    check(operations.interhub, "Los canales entre hubs no están disponibles en este servicio.", 503)
    return operations.interhub
  }
  app.get("/api/memory/interhub/orphans", { preHandler: async request => { await authorize(request) } }, async (request, reply) => {
    requireCollaboration()
    reply.header("Cache-Control", "no-store")
    const { limit, offset } = parse(page, request.query)
    const channels = await (await services()).listOrphans()
    const items = channels.slice(offset, offset + limit).map(({ channel_id, name, created_at, archived_at, closed_at }) => ({ channel_id, name, created_at, archived_at, closed_at }))
    return { items, total: channels.length, limit, offset }
  })
  app.get("/api/memory/interhub/channels/:id/roster", { preHandler: async request => { await authorize(request) } }, async (request, reply) => {
    requireCollaboration()
    reply.header("Cache-Control", "no-store")
    const { id: channelId } = parse(params, request.params)
    const roster = await (await services()).roster(channelId)
    check(roster, "Canal entre hubs inexistente", 404)
    return roster
  })
  app.get("/api/memory/interhub/channels/:id/code", { preHandler: async request => { await authorize(request) } }, async (request, reply) => {
    requireCollaboration()
    reply.header("Cache-Control", "no-store")
    const { id: channelId } = parse(params, request.params)
    const code = await (await services()).creatorCode(channelId)
    // Same answer for "not the creator hub", "revoked" and "unknown channel": the route is no oracle.
    check(code, "Sin código disponible", 404)
    return { code }
  })
}
