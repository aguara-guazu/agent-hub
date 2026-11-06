import { z } from "zod"
import type { AgentContext } from "../agents.js"
import { check } from "../contracts.js"
import type { Sql } from "../database.js"
import type { LocalChat } from "../local-chat.js"
import { teamSessionIds } from "./scope.js"
import { CONSUMPTION_RANGES, agentDetail, series, summary, type ConsumptionRange } from "./query.js"

const sessionKey = z.string().min(32).max(200).optional()
const range = z.enum(CONSUMPTION_RANGES).optional()
const detail = z.enum(["series", "breakdown"]).optional()

export const consumptionDefinitions = {
  usage_self: [
    "Token or credit consumption of your own session: totals per unit, cost estimate, context peak, compactions and top origins. Estimates are not exact billing.",
    z.object({ session_key: sessionKey, range, detail }).strict(),
  ],
  usage_team: [
    "Consumption of the agents in the channel or team you lead. Only leaders can call it. Pass agent (hub session id) for one agent's breakdown.",
    z.object({ session_key: sessionKey, range, agent: z.string().min(1).max(200).optional(), detail }).strict(),
  ],
} satisfies Record<string, [string, z.ZodType]>

export interface ConsumptionToolDeps {
  chat: Pick<LocalChat, "identity">
  db: Sql
}

/** Read-only tools. Each call resolves the caller's own session first; nothing is written. */
export async function callConsumptionTool(
  operation: "usage_self" | "usage_team",
  input: { session_key?: string; range?: ConsumptionRange; agent?: string; detail?: "series" | "breakdown" },
  agent: AgentContext | undefined,
  deps: ConsumptionToolDeps,
): Promise<unknown> {
  check(agent, "Estas herramientas son para agentes; la persona ve el consumo en Actividad › Consumo.", 403)
  const who = await deps.chat.identity(agent, input.session_key)
  check(!who.removed_at, "Esta sesión fue expulsada del canal", 410)
  const selectedRange: ConsumptionRange = input.range ?? "24h"

  let sessionIds: string[]
  if (operation === "usage_self") {
    sessionIds = [String(who.id)]
  } else {
    const team = await teamSessionIds(deps.db, String(who.id))
    check(team, "Solo el líder de un canal o equipo puede ver el consumo del equipo.", 403)
    if (input.agent) {
      check(team.includes(input.agent), "El agente no está en tu alcance de consumo.", 404)
      sessionIds = [input.agent]
    } else {
      sessionIds = team
    }
  }

  if (input.detail === "breakdown") {
    const target = operation === "usage_self" ? sessionIds[0]! : input.agent
    check(target, "Indica agent para ver el desglose del equipo.", 400)
    const detail = await agentDetail(deps.db, target, selectedRange)
    return {
      range: selectedRange,
      row: detail.row,
      breakdown: detail.breakdown,
      context_peak_pct: detail.row?.context_peak_pct ?? null,
      context_last_pct: detail.context_last_pct,
      compactions: detail.row?.compactions ?? 0,
    }
  }
  if (input.detail === "series") {
    return { range: selectedRange, items: await series(deps.db, { range: selectedRange, sessionIds }) }
  }
  const rows = await summary(deps.db, { range: selectedRange, sessionIds, group: "agent" })
  return {
    range: selectedRange,
    items: rows.map(row => ({
      agent_id: row.key,
      label: row.label,
      cli: row.cli_kind,
      unit: row.unit,
      total: row.total,
      ...(row.unit === "credits" ? { credits: row.credits } : { input: row.input, output: row.output, cache: row.cache_write + row.cache_read }),
      cost_usd: row.cost_usd,
      unpriced: row.unpriced,
      context_peak_pct: row.context_peak_pct,
      compactions: row.compactions,
      top_origins: row.top_origins,
    })),
    note: "breakdown is estimated",
  }
}
