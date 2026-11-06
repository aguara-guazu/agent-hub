import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { consumptionEventSchema } from "@agenthub/shared"
import { check, parse } from "../contracts.js"
import type { MemoryService } from "../service.js"
import { isConsumptionCli } from "./links.js"
import { ConsumptionStore } from "./store.js"

const DAY_MS = 86_400_000

const agentId = z.string().min(1).max(200)

const cursorSchema = z.object({
  hub_session_id: z.string().min(1).max(200),
  native_session_id: z.string().min(1).max(200),
  file_path: z.string().max(4000).nullable(),
  file_offset: z.number().int().nonnegative(),
  scan_state: z.unknown(),
}).strict()

/**
 * Daemon-only ingress, authorized like registerUsageRoutes: the client is identified by agent_id and must be a
 * registered CLI. Without authorizeUsageAgent the routes are not registered at all.
 */
export function registerConsumptionRoutes(
  app: FastifyInstance,
  service: MemoryService,
  authorizeUsageAgent?: (request: FastifyRequest, agentId: string) => Promise<{ cli_kind: string }>,
): { close(): void } {
  if (!authorizeUsageAgent) return { close: () => undefined }
  const store = async () => new ConsumptionStore((await service.get()).db)
  const clientCli = async (request: FastifyRequest, id: string) => {
    const client = await authorizeUsageAgent(request, id)
    check(isConsumptionCli(client.cli_kind), "Esta CLI no reporta consumo", 403)
    return client.cli_kind
  }

  app.get("/api/memory/usage/consumption/links", async (request, reply) => {
    const query = parse(z.object({ agent_id: agentId }).strict(), request.query)
    const cli = await clientCli(request, query.agent_id)
    reply.header("Cache-Control", "no-store")
    return { items: await (await store()).links(cli) }
  })

  app.post("/api/memory/usage/consumption/ingest", { bodyLimit: 2_000_000 }, async (request, reply) => {
    const body = parse(z.object({
      agent_id: agentId,
      events: z.array(consumptionEventSchema).max(500),
      cursor: cursorSchema.optional(),
    }).strict(), request.body)
    const cli = await clientCli(request, body.agent_id)
    check(body.events.every(event => event.cli_kind === cli), "El lote contiene consumo de otra CLI", 403)
    reply.header("Cache-Control", "no-store")
    return (await store()).ingest(body.events, cli, body.cursor)
  })

  // Retention runs once a day; it never keeps the process alive.
  const timer = setInterval(() => {
    void store().then(value => value.prune()).catch(() => app.log.warn("No se pudo aplicar la retención del consumo"))
  }, DAY_MS)
  timer.unref()
  return { close: () => clearInterval(timer) }
}
