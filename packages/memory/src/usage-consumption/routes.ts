import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { CONSUMPTION_CLIS, consumptionEventSchema } from '@agenthub/shared'
import { parse } from '../contracts.js'
import type { MemoryService } from '../service.js'
import { ConsumptionStore } from './store.js'

const DAY_MS = 86_400_000

const cursorSchema = z.object({
  hub_session_id: z.string().min(1).max(200),
  native_session_id: z.string().min(1).max(200),
  file_path: z.string().max(4000).nullable(),
  file_offset: z.number().int().nonnegative(),
  scan_state: z.unknown(),
}).strict()

/** Daemon-only: the local daemon reads native session files and reports figures; no CLI can call these through MCP. */
export function registerConsumptionRoutes(
  app: FastifyInstance,
  service: MemoryService,
  authorize: (request: FastifyRequest) => Promise<unknown>,
): { close(): void } {
  const store = async () => new ConsumptionStore((await service.get()).db)

  app.get('/api/memory/usage/consumption/links', { preHandler: authorize }, async (request, reply) => {
    const query = parse(z.object({ cli: z.enum(CONSUMPTION_CLIS).optional() }).strict(), request.query)
    reply.header('Cache-Control', 'no-store')
    return { items: await (await store()).links(query.cli) }
  })

  app.post('/api/memory/usage/consumption/ingest', { preHandler: authorize, bodyLimit: 2_000_000 }, async (request, reply) => {
    const body = parse(z.object({ events: z.array(consumptionEventSchema).max(500), cursor: cursorSchema.optional() }).strict(), request.body)
    reply.header('Cache-Control', 'no-store')
    return (await store()).ingest(body.events, body.cursor)
  })

  // Retention runs once a day; it never keeps the process alive.
  const timer = setInterval(() => {
    void store().then(value => value.prune()).catch(() => app.log.warn('No se pudo aplicar la retención del consumo'))
  }, DAY_MS)
  timer.unref()
  return { close: () => clearInterval(timer) }
}
