import { useT } from "../../../i18n"
import { isFinishReason, isOrigin, isTaskStatus, type AgentNote, type TaskEvent, type TaskRow } from "./types"

/** Etiquetas traducidas de los valores internos de tareas y notas; un valor desconocido se muestra como «—» (R3). */
export function useTaskLabels() {
  const { t } = useT("project")
  const status = useT("status").t
  const statusLabel = (value: unknown) => isTaskStatus(value) ? status(`task.${value}`) : "—"
  const originLabel = (value: unknown) => isOrigin(value) ? t(`tasks.origin.${value}`) : t("tasks.origin.manual")
  const noteState = (note: Pick<AgentNote, "state">) => t(`tasks.noteState.${note.state}`)
  const finishReason = (note: Pick<AgentNote, "state" | "finish_reason">) => note.state !== "working" && isFinishReason(note.finish_reason) ? t(`tasks.finishReason.${note.finish_reason}`) : undefined

  /** Detalle de una línea: estado en Jira, responsable y tipo, o el origen y la referencia del pendiente. */
  const rowDetail = (task: TaskRow): string => {
    const parts = task.kind === "jira"
      ? [task.external_key, task.external_status, task.assignee, task.issue_type]
      : [originLabel(task.origin), task.code_ref ?? task.source_title ?? task.description?.slice(0, 140)]
    return parts.filter((part): part is string => typeof part === "string" && part.trim() !== "").join(" · ")
  }

  /** Qué cambió en un evento del historial de la tarea. */
  const eventLabel = (event: TaskEvent): string => {
    if (event.action === "created") return t("tasks.panel.event.created", { status: statusLabel(event.status_after) })
    if (event.action === "status") {
      const jira = event.detail?.jira_status ? t("tasks.panel.event.jiraStatus", { status: event.detail.jira_status }) : ""
      return `${t("tasks.panel.event.status", { from: statusLabel(event.status_before), to: statusLabel(event.status_after) })}${jira}`
    }
    if (event.action === "note") return t("tasks.panel.event.note")
    if (event.action === "jira_comment") return t("tasks.panel.event.jiraComment")
    return t("tasks.panel.event.updated")
  }

  /** `user` es la persona desde la app; los agentes llegan con su etiqueta. */
  const actorLabel = (actor: string | null | undefined) => !actor ? "—" : actor === "user" ? t("tasks.panel.you") : actor

  return { actorLabel, statusLabel, originLabel, noteState, finishReason, rowDetail, eventLabel }
}
