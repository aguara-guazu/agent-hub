import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { CONSUMPTION_CLIS, consumptionEventSchema } from "@agenthub/shared"
import { check, parse } from "../contracts.js"
import type { MemoryService } from "../service.js"
import { isConsumptionCli } from "./links.js"
import { CONSUMPTION_RANGES, agentDetail, agentFacts, fillSeries, series, summary, type ConsumptionRange } from "./query.js"
import { ConsumptionStore } from "./store.js"

const DAY_MS = 86_400_000

const agentId = z.string().min(1).max(200)
const projectId = z.string().min(1).max(200).optional()
const range = z.enum(CONSUMPTION_RANGES).optional()

const cursorSchema = z.object({
  hub_session_id: z.string().min(1).max(200),
  native_session_id: z.string().min(1).max(200),
  file_path: z.string().max(4000).nullable(),
  file_offset: z.number().int().nonnegative(),
  scan_state: z.unknown(),
}).strict()

export interface ConsumptionRouteAuth {
  /** Daemon-only: identifies the reporting CLI by agent_id, like registerUsageRoutes. Absent means no daemon routes. */
  authorizeUsageAgent?: ((request: FastifyRequest, agentId: string) => Promise<{ cli_kind: string }>) | undefined
  /** Human owner only, for the interface routes. */
  authorizeOwner: (request: FastifyRequest) => Promise<unknown>
}

/**
 * Daemon ingress (agent_id identifies the CLI) and owner-only read routes for the Consumo tab.
 * The owner routes are not exposed to the MCP dispatcher: they never register activity there.
 */
export function registerConsumptionRoutes(app: FastifyInstance, service: MemoryService, auth: ConsumptionRouteAuth): { close(): void } {
  const store = async () => new ConsumptionStore((await service.get()).db)
  const { authorizeUsageAgent, authorizeOwner } = auth
  const clientCli = async (request: FastifyRequest, id: string) => {
    check(authorizeUsageAgent, "La ingesta de consumo no está disponible", 403)
    const client = await authorizeUsageAgent(request, id)
    check(isConsumptionCli(client.cli_kind), "Esta CLI no reporta consumo", 403)
    return client.cli_kind
  }

  if (authorizeUsageAgent) {
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
  }

  // Human owner only: the Consumo tab. These routes are not registered in the MCP operation dispatcher.
  app.get("/api/memory/usage/consumption/summary", { preHandler: authorizeOwner }, async (request, reply) => {
    const query = parse(z.object({ range, group: z.enum(["agent", "cli", "origin"]).optional(), project_id: projectId }).strict(), request.query)
    reply.header("Cache-Control", "no-store")
    const { db } = await service.get()
    return { items: await summary(db, { range: (query.range ?? "24h") as ConsumptionRange, group: query.group ?? "agent", projectId: query.project_id ?? null }) }
  })

  app.get("/api/memory/usage/consumption/series", { preHandler: authorizeOwner }, async (request, reply) => {
    const query = parse(z.object({ range, project_id: projectId }).strict(), request.query)
    const selected = (query.range ?? "24h") as ConsumptionRange
    const projectScope = query.project_id ?? null
    reply.header("Cache-Control", "no-store")
    const { db } = await service.get()
    const items: { cli_kind: string; unit: string; points: { bucket: string; total: number | null }[] }[] = []
    for (const cli of CONSUMPTION_CLIS) {
      const rows = await series(db, { range: selected, projectId: projectScope, cli })
      for (const unit of ["tokens", "credits"] as const) {
        const points = rows.filter(row => row.unit === unit).map(row => ({ bucket: row.bucket, total: row.total }))
        if (points.length) items.push({ cli_kind: cli, unit, points: fillSeries(selected, points) })
      }
    }
    const costRows = await series(db, { range: selected, projectId: projectScope })
    items.push({ cli_kind: "cost", unit: "usd", points: fillSeries(selected, costRows.filter(row => row.unit === "tokens").map(row => ({ bucket: row.bucket, total: row.cost_usd }))) })
    return { items }
  })

  app.get("/api/memory/usage/consumption/agent/:hubSessionId", { preHandler: authorizeOwner }, async (request, reply) => {
    const params = parse(z.object({ hubSessionId: agentId }).strict(), request.params)
    const query = parse(z.object({ range }).strict(), request.query)
    reply.header("Cache-Control", "no-store")
    const { db } = await service.get()
    const exists = await db.query("SELECT 1 AS ok FROM chat_sessions WHERE id=$1", [params.hubSessionId])
    check(exists.length > 0, "La sesión no existe", 404)
    const selected = (query.range ?? "24h") as ConsumptionRange
    return { ...(await agentDetail(db, params.hubSessionId, selected)), ...(await agentFacts(db, params.hubSessionId, selected)) }
  })

  // Retention runs once a day; it never keeps the process alive.
  const timer = setInterval(() => {
    void store().then(value => value.prune()).catch(() => app.log.warn("No se pudo aplicar la retención del consumo"))
  }, DAY_MS)
  timer.unref()
  return { close: () => clearInterval(timer) }
}
