import { Button, Chip, Empty, ErrorState, List, Row, RowLink, SkeletonRows, Tag, type ChipTone } from "../../../components/ui"
import { useT } from "../../../i18n"
import { entityPath, useMemory, type Page } from "../../../lib/memory"
import type { Entity } from "../../../lib/types"
import { ListDate, entityDate, entityDetail, useKindLabel, useProjectNavigation } from "../shared"

interface TaskRow { id: string; title: string; status: string; source_title?: string | null; external_key?: string | null }
type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "dropped"
const TASK_TONE: Record<TaskStatus, ChipTone> = { todo: "off", in_progress: "info", blocked: "warn", done: "off", dropped: "off" }
const isTaskStatus = (value: string): value is TaskStatus => value in TASK_TONE

/**
 * Pestaña Resumen (`?tab=resumen`, la predeterminada): descripción, última actividad (4) y tareas abiertas (2).
 * Contrato: export default, props `{ project: Entity }`.
 */
export default function Resumen({ project }: { project: Entity }) {
  const { t, plural } = useT("project")
  const go = useProjectNavigation()
  const description = typeof project.data.description === "string" ? project.data.description.trim() : ""
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
      {description
        ? <p className="t2 md prose" style={{ lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{description}</p>
        : <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
            <span className="t3">{t("summary.noDescription")}</span>
            <Button small variant="ghost" icon="add" onClick={() => go({ panel: "details" })}>{t("summary.addDescription")}</Button>
          </div>}
      <RecentActivity projectId={project.id} />
      <OpenTasks projectId={project.id} viewAll={count => plural("summary.viewTasks", count)} onViewAll={() => go({ tab: "tareas" })} />
    </div>
  )
}

function RecentActivity({ projectId }: { projectId: string }) {
  const { t } = useT("project")
  const kindLabel = useKindLabel()
  const go = useProjectNavigation()
  const timeline = useMemory<Page<Entity>>("timeline", { project_id: projectId, limit: 4, offset: 0 })
  return (
    <section className="section">
      <div className="section-h"><h2 className="h2">{t("summary.recent")}</h2></div>
      {timeline.isPending ? <SkeletonRows count={3} avatar={false} />
        : timeline.error ? <List><ErrorState error={timeline.error} onRetry={() => void timeline.refetch()} /></List>
        : timeline.data.items.length === 0
          ? <List><Empty icon="document" title={t("summary.recentEmptyTitle")} detail={t("summary.recentEmptyDetail")} action={<Button small icon="add" onClick={() => go({ add: "files" })}>{t("content.emptyAction")}</Button>} /></List>
          : (
            <List>
              {timeline.data.items.map(item => (
                <RowLink
                  key={item.id}
                  to={entityPath(item)}
                  lead={<span style={{ width: 96, display: "flex", flex: "none" }}><Tag>{kindLabel(item)}</Tag></span>}
                  title={item.title}
                  sub={entityDetail(item)}
                  meta={<ListDate value={entityDate(item)} />}
                />
              ))}
            </List>
          )}
    </section>
  )
}

function OpenTasks({ projectId, viewAll, onViewAll }: { projectId: string; viewAll: (count: number) => string; onViewAll: () => void }) {
  const { t } = useT("project")
  const status = useT("status").t
  const tasks = useMemory<Page<TaskRow>>("list_tasks", { project_id: projectId, status: "open", limit: 2, offset: 0 })
  const total = tasks.data?.total ?? 0
  return (
    <section className="section">
      <div className="section-h">
        <h2 className="h2">{t("summary.openTasks")}</h2>
        {total > 2 && <Button small variant="ghost" onClick={onViewAll}>{viewAll(total)}</Button>}
      </div>
      {tasks.isPending ? <SkeletonRows count={2} avatar={false} />
        : tasks.error ? <List><ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} /></List>
        : total === 0 ? <p className="t3">{t("summary.tasksEmpty")}</p>
        : (
          <List>
            {tasks.data.items.map(task => (
              <Row
                key={task.id}
                onOpen={onViewAll}
                lead={isTaskStatus(task.status) ? <Chip tone={TASK_TONE[task.status]}>{status(`task.${task.status}`)}</Chip> : undefined}
                title={task.title}
                sub={task.source_title ?? undefined}
                meta={task.external_key ? <span className="mono xs">{task.external_key}</span> : undefined}
              />
            ))}
          </List>
        )}
    </section>
  )
}
