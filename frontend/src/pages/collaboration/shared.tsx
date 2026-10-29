import { useCallback } from "react"
import { useSearchParams } from "react-router-dom"
import { Button, type ChipTone } from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import type { Participant, Plan, Receipt } from "./types"

/** Alcance de esta vista: canales sin proyecto. La pestaña Colaboración del proyecto usa su propio alcance. */
export const SCOPE = { unassigned: true } as const

export const THREAD_PAGE = 30
export const MESSAGE_PAGE = 40
export const CHANNEL_PAGE = 40
export const AGENT_PAGE = 40

export type ListView = "threads" | "channels" | "trash"
export type ThreadState = "open" | "resolved"

/** Estado de la vista en la URL: sobrevive a recargas y a los enlaces de notificaciones (`?plan=`). */
export function useCollaborationParams() {
  const [params, setParams] = useSearchParams()
  const patch = useCallback((values: Record<string, string | number | null>) => setParams(current => {
    const next = new URLSearchParams(current)
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === "" || value === 0) next.delete(key)
      else next.set(key, String(value))
    }
    return next
  }, { replace: true }), [setParams])
  const view = params.get("view")
  const number = (key: string) => Math.max(0, Number(params.get(key)) || 0)
  return {
    view: (view === "channels" || view === "trash" ? view : "threads") as ListView,
    state: (params.get("state") === "resolved" ? "resolved" : "open") as ThreadState,
    channel: params.get("channel") ?? "",
    agent: params.get("agent") ?? "",
    query: params.get("q") ?? "",
    thread: params.get("thread") ?? "",
    plan: params.get("plan") ?? "",
    inspect: params.get("inspect") ?? "",
    offset: number("offset"),
    messageOffset: number("moffset"),
    channelOffset: number("coffset"),
    agentOffset: number("aoffset"),
    patch,
  }
}

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

export type ReceiptState = "cancelled" | "answered" | "readAwaiting" | "requested" | "handled" | "read" | "notified" | "pending"
export const RECEIPT_TONE: Record<ReceiptState, ChipTone> = { cancelled: "off", answered: "ok", readAwaiting: "warn", requested: "warn", handled: "ok", read: "info", notified: "info", pending: "off" }

export function receiptState(receipt: Receipt): ReceiptState {
  if (receipt.cancelled_at) return "cancelled"
  if (receipt.response_message_id) return "answered"
  if (receipt.response_required) return receipt.read_at ? "readAwaiting" : "requested"
  if (receipt.handled_at) return "handled"
  if (receipt.read_at) return "read"
  if (receipt.notified_at) return "notified"
  return "pending"
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
