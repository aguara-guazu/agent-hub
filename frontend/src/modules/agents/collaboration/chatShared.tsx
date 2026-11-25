import { useCallback } from "react"
import { useQueries } from "@tanstack/react-query"
import { Button, type ChipTone } from "../../../components/ui"
import { useFormat, useT } from "../../../i18n"
import { MEMORY_REFRESH_MS, memoryCall, useMemory, type Page } from "../../../lib/memory"
import type { Participant, Plan } from "./chatTypes"

export const MESSAGE_PAGE = 40
export const AGENT_PAGE = 40
// Página máxima que acepta chat_agents y tope de páginas que se piden para un mismo alcance.
const AGENT_FETCH = 100
const AGENT_FETCH_PAGES = 10

/**
 * Todas las sesiones de chat_agents de un alcance, de a AGENT_FETCH (tope AGENT_FETCH_PAGES páginas). La vista filtra con
 * visibleAgents y pagina sobre la lista completa, así el total que muestra es el de las filas que lista. chat_agents ya
 * excluye a los agentes limpiados por el líder: nunca se pide con include_dismissed.
 */
export function useAllAgents(input: Record<string, unknown>, enabled = true) {
  const first = useMemory<Page<Participant>>("chat_agents", { ...input, limit: AGENT_FETCH, offset: 0 }, enabled)
  const pages = first.data ? Math.min(Math.ceil(first.data.total / AGENT_FETCH), AGENT_FETCH_PAGES) : 1
  const rest = useQueries({
    queries: Array.from({ length: Math.max(0, pages - 1) }, (_, index) => {
      const page = { ...input, limit: AGENT_FETCH, offset: (index + 1) * AGENT_FETCH }
      return {
        queryKey: ["memory", "chat_agents", page],
        queryFn: () => memoryCall<Page<Participant>>("chat_agents", page),
        enabled,
        refetchInterval: MEMORY_REFRESH_MS,
        refetchIntervalInBackground: false,
      }
    }),
  })
  const pending = first.isPending || rest.some(query => query.isPending)
  // Entre páginas pedidas en momentos distintos una sesión puede repetirse: se deja una por id.
  const items = pending || !first.data ? undefined
    : [...new Map([...first.data.items, ...rest.flatMap(query => query.data?.items ?? [])].map(agent => [agent.id, agent])).values()]
  return {
    items,
    isPending: pending,
    error: first.error ?? rest.find(query => query.error)?.error ?? null,
    refetch: () => { void first.refetch(); for (const query of rest) void query.refetch() },
  }
}

/** Valor de `.dl` que se corta con elipsis: el `dd` es un ítem de grid y necesita un hijo de bloque. */
export const TRUNC = { display: "block", minWidth: 0, maxWidth: "100%" } as const

/** Sesiones que la vista muestra: sin expulsadas, sin las que no eligieron nick y sin cerradas fuera de un equipo. */
export function visibleAgents(items: readonly Participant[] | undefined): Participant[] {
  return (items ?? [])
    .filter(agent => !agent.removed_at && agent.state !== "removed"
      && (Boolean(agent.team_id) || (!agent.closed_at && agent.state !== "offline"))
      && !agent.needs_nickname && agent.label.trim() !== ""
      && (agent.nickname === undefined || Boolean(agent.nickname?.trim())))
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id))
}

export type AgentState = "idle" | "busy" | "blocked" | "offline" | "unknown" | "stale" | "removed"
export const AGENT_TONE: Record<AgentState, ChipTone> = { idle: "ok", busy: "info", blocked: "warn", offline: "off", unknown: "off", stale: "off", removed: "off" }

export function agentState(agent: Participant): AgentState {
  if (agent.state_reason === "activity_stale") return "stale"
  return (["idle", "busy", "blocked", "offline", "removed"] as const).find(state => state === agent.state) ?? "unknown"
}

export type PlanState = "prepared" | "launching" | "launched" | "active" | "partial" | "uncertain" | "paused" | "cancelled" | "completed" | "unknown"
export const PLAN_TONE: Record<PlanState, ChipTone> = {
  prepared: "warn", launching: "info", launched: "info", active: "ok", partial: "warn", uncertain: "warn", paused: "off", cancelled: "off", completed: "off", unknown: "off",
}

export function planState(value: string | null | undefined): PlanState {
  return (["prepared", "launching", "launched", "active", "partial", "uncertain", "paused", "cancelled", "completed"] as const).find(state => state === value) ?? "unknown"
}

export type QuotaState = "available" | "low" | "exhausted" | "cooldown" | "unknown"
// Agotada o en enfriamiento: es un límite del proveedor, no una falla (Error ≠ Bloqueado).
export const QUOTA_TONE: Record<QuotaState, ChipTone> = { available: "ok", low: "warn", exhausted: "locked", cooldown: "locked", unknown: "off" }

export function quotaState(value: string | undefined): QuotaState {
  return (["available", "low", "exhausted", "cooldown"] as const).find(state => state === value) ?? "unknown"
}

/** Cuota observada del miembro: por nombre de worktree si el plan lo guardó, si no por CLI y modelo. */
export function memberQuota(plan: Plan, member: { worktree_name?: string; cli: string; model: string }): QuotaState | null {
  const usage = plan.plan.usage
  if (plan.plan.usage_redacted || !usage?.length) return null
  const entry = usage.find(item => member.worktree_name && item.worktree_name === member.worktree_name)
    ?? usage.find(item => item.cli === member.cli && item.model === member.model)
  return entry ? quotaState(entry.status) : null
}

const CLI_INITIALS: Record<string, readonly [string, string]> = {
  claude_code: ["claude", "CC"], codex_cli: ["codex", "CX"], gemini_cli: ["gemini", "GC"], kiro: ["kiro", "KI"],
  opencode: ["opencode", "OC"], antigravity: ["antigravity", "AG"], claude_desktop: ["claude", "CD"],
}

/** Iniciales del avatar cuando el nombre es el del cliente («Codex CLI» → CX, no CC); con un nick propio, las del nick. */
export function agentInitials(label: string, cli: string | undefined): string | undefined {
  const entry = cli ? CLI_INITIALS[cli] : undefined
  return entry && label.toLowerCase().startsWith(entry[0]) ? entry[1] : undefined
}

const CLIS = ["claude_code", "codex_cli", "gemini_cli", "kiro", "claude_desktop", "opencode", "antigravity"] as const
type Cli = typeof CLIS[number]

/** Nombre visible de una CLI; una CLI que la app no conoce se muestra con su identificador. */
export function useCliLabel() {
  const status = useT("status").t
  return useCallback((cli: string) => (CLIS.includes(cli as Cli) ? status(`client.${cli as Cli}`) : cli), [status])
}

const CAPABILITIES = ["hub_fleet", "codex_queue", "claude_rewake", "tui_prompt", "codex_appserver", "next_turn", "opencode_prompt", "acp_prompt", "antigravity_stream"] as const
export type Capability = typeof CAPABILITIES[number]

/** Cómo recibe avisos la sesión; `null` si la API devuelve una capacidad que la app no conoce. */
export function capabilityKey(value: string): Capability | null {
  return CAPABILITIES.find(item => item === value) ?? null
}

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
export type Effort = typeof EFFORTS[number]

/** Paginador de listas largas: rango + Anterior / Siguiente. */
export function Pager({ total, offset, limit, onChange }: { total: number; offset: number; limit: number; onChange: (offset: number) => void }) {
  const { t } = useT("collaboration")
  const common = useT("common").t
  const format = useFormat()
  if (total <= limit) return null
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-2)" }}>
      <span className="xs t3">{t("pager.range", { from: format.number(offset + 1), to: format.number(Math.min(offset + limit, total)), total: format.number(total) })}</span>
      <div style={{ display: "flex", gap: "var(--sp-1)" }}>
        <Button small disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>{common("actions.previous")}</Button>
        <Button small disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>{common("actions.next")}</Button>
      </div>
    </div>
  )
}
