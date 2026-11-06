import { useQuery } from "@tanstack/react-query"
import { api } from "./api"

export const CONSUMPTION_RANGES = ["1h", "12h", "24h", "48h", "7d", "30d", "90d", "1y", "3y"] as const
export type ConsumptionRange = (typeof CONSUMPTION_RANGES)[number]
export const DEFAULT_RANGE: ConsumptionRange = "24h"

export type ConsumptionGroup = "agent" | "cli" | "origin"
export type ConsumptionUnit = "tokens" | "credits"
export type ConsumptionOrigin = "model" | "person" | "cli_tools" | "mcp_tools" | "hub_tools" | "fixed" | "compaction" | "unknown"

/** Un valor `unit: null` es una sesión sin consumo registrado ("Sin dato"). */
export interface SummaryRow {
  key: string
  label: string
  cli_kind: string | null
  unit: ConsumptionUnit | null
  total: number
  input: number
  output: number
  cache_write: number
  cache_read: number
  credits: number
  cost_usd: number | null
  unpriced: boolean
  context_peak_pct: number | null
  context_peak_tokens: number | null
  compactions: number
  /** Turnos registrados: número para Kiro, null para las CLI que informan tokens. */
  turns: number | null
  /** Solo en el resumen por agente. */
  project_title: string | null
  channel_name: string | null
  top_origins: { origin: ConsumptionOrigin; amount: number }[]
}

export interface SeriesItem {
  cli_kind: string
  unit: string
  points: { bucket: string; total: number | null }[]
}

export interface AgentDetail {
  cli_kind: string | null
  model: string | null
  turns: number
  model_calls: number
  source: "file" | "acp" | null
  row: SummaryRow | null
  breakdown: { origin: ConsumptionOrigin; unit: ConsumptionUnit; amount: number; cost_usd: number | null }[]
  /** Último porcentaje de contexto del período. */
  context_last_pct: number | null
  context: { at: string; pct: number | null; tokens: number | null; compaction: boolean }[]
}

/** Desde este porcentaje de la ventana el pico de contexto se marca como advertencia. */
export const CONTEXT_WARN_PCT = 80

const POLL_MS = 30_000

function search(values: Record<string, string | null | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value)
  return params.toString()
}

export function useConsumptionSummary(range: ConsumptionRange, group: ConsumptionGroup, projectId: string | null) {
  return useQuery({
    queryKey: ["consumption", "summary", range, group, projectId],
    queryFn: () => api.get<{ items: SummaryRow[] }>(`/memory/usage/consumption/summary?${search({ range, group, project_id: projectId })}`),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  })
}

export function useConsumptionSeries(range: ConsumptionRange, projectId: string | null) {
  const tz = String(-new Date().getTimezoneOffset())
  return useQuery({
    queryKey: ["consumption", "series", range, projectId, tz],
    queryFn: () => api.get<{ items: SeriesItem[] }>(`/memory/usage/consumption/series?${search({ range, project_id: projectId, tz_offset_minutes: tz })}`),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  })
}

export function useConsumptionAgent(id: string | null, range: ConsumptionRange) {
  return useQuery({
    queryKey: ["consumption", "agent", id, range],
    queryFn: () => api.get<AgentDetail>(`/memory/usage/consumption/agent/${encodeURIComponent(id ?? "")}?${search({ range })}`),
    enabled: id !== null,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  })
}

/** Interpreta un compartimento horario (ISO) o diario (`AAAA-MM-DD`). */
export function parseBucket(bucket: string): Date | null {
  // Un día sin hora se muestra con su fecha de calendario, sin corrimiento por zona horaria.
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bucket)
  const date = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(bucket)
  return Number.isNaN(date.getTime()) ? null : date
}

/** El rango agrupa por hora hasta 48 h; por día en adelante. */
export function dailyRange(range: ConsumptionRange): boolean {
  return !["1h", "12h", "24h", "48h"].includes(range)
}
