import { useEffect, useState } from "react"
import {
  Avatar, Chip, Dl, ErrorState, Field, Input, List, Loading, MoreMenu, Panel, PanelBody, PanelFooter, PanelHeader, Row, RowLink, Select, Textarea, useToast,
  type MenuItem,
} from "../../../components/ui"
import { useFormat, useT } from "../../../i18n"
import { useMemory } from "../../../lib/memory"
import { useErrorText, useMemoryAction } from "../shared"
import { SidePanel } from "../work"
import { useTaskLabels } from "./labels"
import { PENDING_ORIGINS, TASK_STATUSES, TASK_TONE, isOrigin, type PendingOrigin, type TaskDetail, type TaskRow, type TaskStatus } from "./types"

interface Draft { title: string; description: string; origin: PendingOrigin; codeRef: string; note: string }

function draftOf(task: TaskRow): Draft {
  const origin = isOrigin(task.origin) && task.origin !== "jira" ? task.origin : "manual"
  return { title: task.title, description: task.description ?? "", origin, codeRef: task.code_ref ?? "", note: "" }
}

/**
 * Detalle de una tarea · guardado explícito (campos del pendiente y nota de avance).
 * En tareas de Jira solo se guarda la nota local: título, estado y comentarios viven en Jira y este panel no los escribe.
 */
export function TaskPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { t } = useT("project")
  const detail = useMemory<TaskDetail>("get_task", { id: taskId })
  const task = detail.data?.task
  return (
    <SidePanel>
      {detail.isPending ? (
        <Panel label={t("tasks.panel.label")} onClose={onClose}>
          <PanelHeader title={t("tasks.panel.label")} />
          <PanelBody><Loading /></PanelBody>
        </Panel>
      ) : detail.error || !task ? (
        <Panel label={t("tasks.panel.label")} onClose={onClose}>
          <PanelHeader title={t("tasks.panel.label")} />
          <PanelBody><ErrorState error={detail.error} title={t("tasks.panel.errorTitle")} onRetry={() => void detail.refetch()} /></PanelBody>
        </Panel>
      ) : <TaskEditor key={task.id} detail={detail.data} onClose={onClose} />}
    </SidePanel>
  )
}

function TaskEditor({ detail, onClose }: { detail: TaskDetail; onClose: () => void }) {
  const { t } = useT("project")
  const common = useT("common").t
  const format = useFormat()
  const labels = useTaskLabels()
  const toast = useToast()
  const errorText = useErrorText()
  const task = detail.task
  const jira = task.kind === "jira"
  const [initial, setInitial] = useState(() => draftOf(task))
  const [draft, setDraft] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState("")
  const move = useMemoryAction("save_task")
  const write = useMemoryAction("save_task", { quiet: true })

  // Los pendientes los editan también los agentes: sin cambios locales, el borrador sigue a la versión del servidor.
  const fresh = draftOf(task)
  const dirty = draft.note.trim() !== "" || (!jira && (draft.title !== initial.title || draft.description !== initial.description || draft.origin !== initial.origin || draft.codeRef !== initial.codeRef))
  useEffect(() => {
    if (dirty) return
    if (fresh.title !== initial.title || fresh.description !== initial.description || fresh.origin !== initial.origin || fresh.codeRef !== initial.codeRef) { setInitial(fresh); setDraft(fresh) }
  // Solo reacciona a la versión del servidor.
  }, [task.updated_at])

  const update = (patch: Partial<Draft>) => { setDraft(current => ({ ...current, ...patch })); setBlocked(false) }
  function discard() { setDraft(initial); setError(""); setBlocked(false) }
  async function save() {
    if (!dirty || saving) return
    if (!jira && !draft.title.trim()) { setError(t("tasks.panel.titleRequired")); return }
    setSaving(true); setError("")
    const note = draft.note.trim()
    const fields = jira ? {} : {
      ...(draft.title !== initial.title ? { title: draft.title.trim() } : {}),
      ...(draft.description !== initial.description ? { description: draft.description } : {}),
      ...(draft.origin !== initial.origin ? { origin: draft.origin } : {}),
      ...(draft.codeRef !== initial.codeRef ? { code_ref: draft.codeRef.trim() || null } : {}),
    }
    try {
      await write.mutateAsync({ id: task.id, ...fields, ...(note ? { note } : {}) })
      const saved = { ...draft, title: draft.title.trim(), note: "" }
      setInitial(saved); setDraft(saved); setBlocked(false)
      toast.success(common("states.saved"))
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setSaving(false)
    }
  }

  function setStatus(next: TaskStatus, previous: TaskStatus) {
    move.mutate({ id: task.id, status: next }, {
      onSuccess: () => toast.show({
        kind: "success",
        message: t("tasks.panel.moved", { status: labels.statusLabel(next) }),
        undo: () => move.mutate({ id: task.id, status: previous }),
      }),
    })
  }

  const items: MenuItem[] = jira
    ? task.external_url ? [{ label: t("tasks.panel.openJira"), icon: "arrow", onSelect: () => window.open(task.external_url!, "_blank", "noopener,noreferrer") }] : []
    : TASK_STATUSES.filter(value => value !== task.status).map(value => ({ label: t(`tasks.panel.markAs.${value}`), disabled: move.isPending, onSelect: () => setStatus(value, task.status) }))

  return (
    <Panel label={task.title} onClose={onClose} dirty={dirty} onBlockedClose={() => setBlocked(true)}>
      <PanelHeader
        title={jira && task.external_key ? `${task.external_key} · ${task.title}` : task.title}
        status={<Chip tone={TASK_TONE[task.status] ?? "off"}>{labels.statusLabel(task.status)}</Chip>}
        actions={items.length ? <MoreMenu small ghost items={items} /> : undefined}
      />
      <PanelBody>
        {jira ? (
          <>
            <Dl items={[
              { label: t("tasks.panel.jiraStatus"), value: task.external_status },
              { label: t("tasks.panel.assignee"), value: task.assignee },
              { label: t("tasks.panel.issueType"), value: task.issue_type },
              { label: t("tasks.panel.priority"), value: task.priority },
            ]} />
            {task.description && <p className="t2 prose" style={{ whiteSpace: "pre-wrap" }}>{task.description}</p>}
          </>
        ) : (
          <>
            <Field label={t("tasks.panel.title")}>
              <Input value={draft.title} maxLength={500} disabled={saving} onChange={event => update({ title: event.target.value })} />
            </Field>
            <Field label={t("tasks.panel.description")}>
              <Textarea rows={4} maxLength={8000} value={draft.description} disabled={saving} onChange={event => update({ description: event.target.value })} />
            </Field>
            <Field label={t("tasks.panel.origin")}>
              <Select<PendingOrigin> bare label={t("tasks.panel.origin")} value={draft.origin} disabled={saving} onChange={origin => update({ origin })} options={PENDING_ORIGINS.map(value => ({ value, label: labels.originLabel(value) }))} />
            </Field>
            <Field label={t("tasks.panel.codeRef")} hint={t("tasks.panel.codeRefHint")}>
              <Input mono value={draft.codeRef} maxLength={1000} disabled={saving} onChange={event => update({ codeRef: event.target.value })} />
            </Field>
          </>
        )}
        <Field label={t("tasks.panel.note")} hint={jira ? t("tasks.panel.noteJiraHint") : undefined} error={error || undefined}>
          <Textarea rows={3} maxLength={2000} value={draft.note} disabled={saving} placeholder={t("tasks.panel.notePlaceholder")} onChange={event => update({ note: event.target.value })} />
        </Field>
        <Dl items={[
          { label: t("tasks.panel.created"), value: task.created_by ? t("tasks.panel.createdBy", { when: format.date(task.created_at), actor: task.created_by }) : format.date(task.created_at) },
          { label: t("tasks.panel.updated"), value: format.date(task.updated_at) },
        ]} />
        <TaskHistory detail={detail} />
      </PanelBody>
      <PanelFooter dirty={dirty} saving={saving} warning={blocked} onSave={() => void save()} onDiscard={discard} />
    </Panel>
  )
}

function TaskHistory({ detail }: { detail: TaskDetail }) {
  const { t } = useT("project")
  const format = useFormat()
  const labels = useTaskLabels()
  return <>
    {detail.events.length > 0 && (
      <section className="section">
        <h3 className="h3">{t("tasks.panel.history")}</h3>
        <List>
          {detail.events.map(event => {
            const text = event.detail?.note ?? event.detail?.text
            return <Row key={event.id} title={labels.eventLabel(event)} sub={text ? `${event.actor} · ${text}` : event.actor} meta={<span className="xs t3">{format.date(event.created_at)}</span>} />
          })}
        </List>
      </section>
    )}
    {detail.notes.length > 0 && (
      <section className="section">
        <h3 className="h3">{t("tasks.panel.agentNotes")}</h3>
        <List>
          {detail.notes.map(note => (
            <Row
              key={note.id}
              lead={<Avatar name={note.agent_label} small />}
              title={note.text}
              sub={[note.agent_label, labels.finishReason(note)].filter(Boolean).join(" · ")}
              meta={<Chip tone={note.state === "working" ? "info" : note.state === "blocked" ? "warn" : "off"}>{labels.noteState(note)}</Chip>}
            />
          ))}
        </List>
      </section>
    )}
    {detail.evidence.length > 0 && (
      <section className="section">
        <h3 className="h3">{t("tasks.panel.evidence")}</h3>
        <List>
          {detail.evidence.map(fragment => (
            <RowLink key={fragment.id} to={`/memory/entities/${fragment.entity_id}?version=${fragment.version_id}&fragment=${fragment.id}`} title={fragment.title} sub={fragment.text.slice(0, 200)} />
          ))}
        </List>
      </section>
    )}
  </>
}
