import { useRuns, useSchedules, type RunListItem } from "./automations"
import { useOverview, type LocalClient } from "./local"
import { useMemory, useMemoryStatus, type MemoryEntity, type Page } from "./memory"
import { useServers } from "./queries"
import type { McpServer } from "./types"

/**
 * Fuentes de Inicio › Pendientes. Cada pendiente sale de un endpoint existente; ninguno se calcula en el backend para Inicio:
 * - servidores con `oauth_status: "required"` → `GET /servers`
 * - Claude Desktop con `restart_pending` → `GET /local/overview`
 * - Gmail sin permiso de envío → `GET /memory/schedules` (`delivery_available.gmail_self.reason`)
 * - fuentes con `last_error` → memoria `list_connectors`
 * - entregas con decisión `pending` y entregas sin leer → `GET /memory/schedules/runs`
 * - duplicados, vínculos de identidad y sugerencias de proyecto → memoria `list_duplicate_proposals`, `list_identity_proposals`, `list_project_suggestions`
 * - hechos por revisar, personas sin email y fuentes sin proyecto → memoria `review`
 */

/** Tamaño de página de cada fuente; Inicio muestra las primeras filas y el resto queda detrás de «Ver todos». */
export const PENDING_PAGE = 50
const REVIEW_PAGE = 100
const PROPOSAL_CATEGORIES = new Set(["identity_match", "person_duplicate"])
const SOURCE_KINDS = new Set(["meeting", "document", "message", "issue", "note"])

export interface Connector { id: string; provider: string; name: string; enabled: boolean; last_error: string | null }
export interface ProjectSuggestion {
  id: string
  source_title: string
  source_kind: string
  occurred_at: string | null
  data: { source_entity_id: string; candidate_project_id?: string | null; candidate_project_title?: string | null; confidence?: string; suggested_title?: string | null; suggested_description?: string | null; reason?: string }
}

export interface PendingInbox {
  /** Sin datos de ninguna fuente todavía. */
  loading: boolean
  /** Todas las fuentes que respondieron fallaron. */
  error: unknown
  memoryReady: boolean
  memoryState: string | null
  connections: {
    oauthServers: McpServer[]
    restartClients: LocalClient[]
    gmailScopeMissing: { destination: string | null } | null
    failingConnectors: Connector[]
  }
  agents: {
    decisions: RunListItem[]
    unreadOther: number
  }
  memory: {
    duplicates: MemoryEntity[]
    identities: MemoryEntity[]
    suggestions: ProjectSuggestion[]
    facts: MemoryEntity[]
    unresolvedPeople: number
    unassignedSources: number
  }
  /** Filas que muestra Inicio: los casos agrupados cuentan como una. */
  count: number
  refetch: () => void
}

function firstError(...errors: unknown[]): unknown {
  return errors.find(error => error !== null && error !== undefined) ?? null
}

/** Reúne los pendientes. React Query deduplica con las vistas que piden lo mismo, así que montarlo en el shell y en Inicio no duplica pedidos. */
export function usePendingInbox(): PendingInbox {
  const servers = useServers()
  const overview = useOverview()
  const schedules = useSchedules()
  const runs = useRuns({ limit: String(PENDING_PAGE) })
  const unread = useRuns({ unread: "true", limit: String(PENDING_PAGE) })
  const memoryStatus = useMemoryStatus()
  const ready = memoryStatus.data?.ready === true
  const connectors = useMemory<Connector[]>("list_connectors", {}, ready)
  const duplicates = useMemory<Page<MemoryEntity>>("list_duplicate_proposals", { state: "pending", limit: PENDING_PAGE, offset: 0 }, ready)
  const identities = useMemory<Page<MemoryEntity>>("list_identity_proposals", { state: "pending", limit: PENDING_PAGE, offset: 0 }, ready)
  const suggestions = useMemory<Page<ProjectSuggestion>>("list_project_suggestions", { limit: PENDING_PAGE, offset: 0 }, ready)
  const review = useMemory<Page<MemoryEntity>>("review", { limit: REVIEW_PAGE, offset: 0 }, ready)

  const decisions = (runs.data?.items ?? []).filter(run => run.decision?.state === "pending")
  const decided = new Set(decisions.map(run => run.run_id))
  const unreadOther = (unread.data?.items ?? []).filter(run => !decided.has(run.run_id)).length
  const gmail = schedules.data?.delivery_available?.gmail_self
  const suggested = new Set((suggestions.data?.items ?? []).map(item => item.data.source_entity_id))
  const reviewItems = review.data?.items ?? []
  const facts = reviewItems.filter(entity => entity.kind === "fact" && !PROPOSAL_CATEGORIES.has(String(entity.data.category)))
  const unresolvedPeople = reviewItems.filter(entity => entity.kind === "person").length
  const unassignedSources = reviewItems.filter(entity => SOURCE_KINDS.has(entity.kind) && !suggested.has(entity.id)).length

  const inbox: Omit<PendingInbox, "count" | "refetch"> = {
    loading: servers.isPending && overview.isPending && runs.isPending && memoryStatus.isPending,
    error: servers.isError && overview.isError && runs.isError ? firstError(servers.error, overview.error, runs.error) : null,
    memoryReady: ready,
    memoryState: memoryStatus.data?.state ?? (memoryStatus.isError ? "error" : null),
    connections: {
      oauthServers: (servers.data ?? []).filter(server => server.oauth_status === "required"),
      restartClients: (overview.data?.clients ?? []).filter(client => client.cli_kind === "claude_desktop" && client.restart_pending),
      gmailScopeMissing: gmail?.reason === "scope_missing" ? { destination: gmail.destination ?? null } : null,
      failingConnectors: (connectors.data ?? []).filter(connector => connector.enabled && Boolean(connector.last_error)),
    },
    agents: { decisions, unreadOther },
    memory: {
      duplicates: duplicates.data?.items ?? [],
      identities: identities.data?.items ?? [],
      suggestions: suggestions.data?.items ?? [],
      facts,
      unresolvedPeople,
      unassignedSources,
    },
  }
  const refetch = () => { void servers.refetch(); void overview.refetch(); void runs.refetch(); void memoryStatus.refetch() }
  return { ...inbox, count: pendingRows(inbox), refetch }
}

function pendingRows({ connections: c, agents: a, memory: m }: Omit<PendingInbox, "count" | "refetch">): number {
  return (c.oauthServers.length > 0 ? 1 : 0) + c.restartClients.length + (c.gmailScopeMissing ? 1 : 0) + c.failingConnectors.length
    + a.decisions.length + (a.unreadOther > 0 ? 1 : 0)
    + m.duplicates.length + m.identities.length + m.suggestions.length + m.facts.length
    + (m.unresolvedPeople > 0 ? 1 : 0) + (m.unassignedSources > 0 ? 1 : 0)
}

/**
 * Proyectos ordenados por última actualización (`list_entities` ordena por fecha del contenido, no por edición),
 * y sus nombres por id para el detalle de entregas y automatizaciones.
 */
export function useRecentProjects(limit = 5) {
  const ready = useMemoryStatus().data?.ready === true
  const projects = useMemory<Page<MemoryEntity>>("list_entities", { kind: "project", limit: 100, offset: 0 }, ready)
  const all = projects.data?.items ?? []
  const items = [...all].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit)
  const names = new Map(all.map(project => [project.id, project.title]))
  return { items, names, isPending: ready && projects.isPending, error: projects.error, refetch: projects.refetch }
}

/** Entregas de hoy y automatizaciones que todavía corren hoy, en hora local. */
export function useToday(now: Date) {
  const schedules = useSchedules()
  const runs = useRuns({ limit: String(PENDING_PAGE) })
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const end = start + 24 * 60 * 60 * 1000
  const inToday = (value: string | null | undefined) => {
    const time = value ? new Date(value).getTime() : Number.NaN
    return time >= start && time < end
  }
  const ran = (runs.data?.items ?? []).filter(run => inToday(run.scheduled_for))
  const upcoming = (schedules.data?.items ?? []).filter(schedule => schedule.state === "active" && inToday(schedule.next_run_at) && new Date(schedule.next_run_at!).getTime() >= now.getTime())
  const rows = [
    ...ran.map(run => ({ key: `r-${run.run_id}`, at: run.scheduled_for, title: run.title, projectId: run.project_id, run, schedule: null })),
    ...upcoming.map(schedule => ({ key: `s-${schedule.id}`, at: schedule.next_run_at!, title: schedule.title, projectId: schedule.project_id, run: null, schedule })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  return { rows, isPending: schedules.isPending && runs.isPending, error: schedules.isError && runs.isError ? schedules.error : null, refetch: () => { void schedules.refetch(); void runs.refetch() } }
}
