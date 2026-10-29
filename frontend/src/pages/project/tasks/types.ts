import type { ChipTone } from "../../../components/ui"
import type { Page } from "../../../lib/memory"

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "dropped"] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]
export const OPEN_STATUSES = ["in_progress", "blocked", "todo"] as const satisfies readonly TaskStatus[]
export const TASK_TONE: Record<TaskStatus, ChipTone> = { todo: "off", in_progress: "info", blocked: "warn", done: "off", dropped: "off" }
export const isTaskStatus = (value: unknown): value is TaskStatus => typeof value === "string" && value in TASK_TONE

/** Orígenes que la persona puede elegir para un pendiente interno; `jira` lo asigna el espejo. */
export const PENDING_ORIGINS = ["manual", "meeting", "note", "code", "agent"] as const
export type PendingOrigin = (typeof PENDING_ORIGINS)[number]
export type TaskOrigin = PendingOrigin | "jira"
export const isOrigin = (value: unknown): value is TaskOrigin => typeof value === "string" && (value === "jira" || (PENDING_ORIGINS as readonly string[]).includes(value))

export interface TaskEventDetail { note?: string; text?: string; jira_status?: string; jira_status_before?: string }

/** Fila de `list_tasks` / `task` de `get_task` (tabla `tasks`). */
export interface TaskRow {
  id: string
  project_id: string | null
  kind: "jira" | "pending"
  title: string
  description: string | null
  status: TaskStatus
  origin: string
  code_ref: string | null
  external_key: string | null
  external_status: string | null
  external_url: string | null
  assignee: string | null
  assignee_account_id: string | null
  issue_type: string | null
  priority: string | null
  source_title?: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  last_event?: { action: string; actor: string; detail: TaskEventDetail | null; created_at: string } | null
}

export interface TaskCount { kind: "jira" | "pending"; status: TaskStatus; count: number }
export interface TaskPage extends Page<TaskRow> { counts: TaskCount[] }

export interface TaskEvent { id: number | string; action: string; actor: string; status_before: string | null; status_after: string | null; detail: TaskEventDetail | null; created_at: string }

/** Nota de trabajo de un agente (`agent_notes`). */
export interface AgentNote {
  id: string
  agent_label: string
  text: string
  state: "working" | "done" | "blocked"
  finish_reason: string | null
  task_id: string | null
  task_title?: string | null
  task_key?: string | null
  updated_at: string
}

export interface TaskEvidence { id: string; text: string; version_id: string; entity_id: string; title: string }
export interface TaskDetail { task: TaskRow; events: TaskEvent[]; notes: AgentNote[]; evidence: TaskEvidence[] }

export interface TaskStats {
  generated_at: string
  summary: { open: number; in_progress: number; blocked: number; stale_open: number; created_last_2_weeks: number; closed_last_2_weeks: number; done: number; dropped: number }
  weekly: { week: string; created: number; closed: number }[]
  by_status: { kind: "jira" | "pending"; status: string; count: number }[]
  lead_time: { kind: "jira" | "pending"; avg_days: number | null; closed: number }[]
  assignees: { assignee: string; open: number; done: number }[]
  origins: { origin: string; open: number; done: number }[]
  agents: { agent_label: string; notes: number; last_note: string }[]
  stale: { external_key: string | null; title: string; status: string; updated_at: string }[]
  recent: { created_at: string; external_key: string | null; title: string; action: string; status_before: string | null; status_after: string | null; actor: string }[]
}

export interface SyncResult { received: number; created: number; status_changed: number; unmatched?: unknown[] }

export const FINISH_REASONS = ["explicit", "turn_end", "session_end", "inactive", "superseded"] as const
export const isFinishReason = (value: unknown): value is (typeof FINISH_REASONS)[number] => typeof value === "string" && (FINISH_REASONS as readonly string[]).includes(value)
