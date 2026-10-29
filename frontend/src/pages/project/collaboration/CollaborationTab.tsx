import { useState } from "react"
import type { KeyboardEvent } from "react"
import { Link } from "react-router-dom"
import {
  Avatar, Button, Chip, Dl, Empty, ErrorState, Input, List, Panel, PanelBody, PanelHeader, Row, RowLink, SkeletonRows, Tag, useToast,
} from "../../../components/ui"
import { useFormat, useT } from "../../../i18n"
import { useMemory, type MemoryEntity, type Page } from "../../../lib/memory"
import { ListDate, useErrorText, useMemoryAction } from "../shared"
import { useTaskLabels } from "../tasks/labels"
import type { AgentNote } from "../tasks/types"
import { SidePanel, useWorkPanel } from "../work"
import { SharingSection } from "./SharingSection"
import { useSharingStatus, type ForumMessage } from "./sharing"

const THREADS_SHOWN = 5
const NOTES_PAGE = 10
const FORUM_PAGE = 50

interface ThreadRow { id: string; channel_id: string; title: string; state: string; messages: number; author_label: string; updated_at: string }

/** Colaboración del proyecto: hilos entre agentes (se leen en Colaboración), notas de trabajo, personas con acceso y foro compartido. */
export function CollaborationTab({ project }: { project: MemoryEntity }) {
  const sharing = useSharingStatus()
  const shared = Boolean(sharing.data?.projects.some(item => item.id === project.id))
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-5)", minWidth: 0 }}>
      <ThreadsSection projectId={project.id} />
      <NotesSection projectId={project.id} />
      <SharingSection project={project} />
      {shared && <ForumSection projectId={project.id} />}
    </div>
  )
}

function ThreadsSection({ projectId }: { projectId: string }) {
  const { t, plural } = useT("project")
  const threads = useMemory<Page<ThreadRow>>("chat_threads", { project_id: projectId, query: "", limit: THREADS_SHOWN, offset: 0 })
  const total = threads.data?.total ?? 0
  return (
    <section className="section">
      <div className="section-h">
        <h2 className="h2">{t("collaboration.threads.title")}</h2>
        <Link className="xs" to="/collaboration">{total > THREADS_SHOWN ? plural("collaboration.threads.viewAll", total) : t("collaboration.threads.open")}</Link>
      </div>
      {threads.isPending ? <SkeletonRows count={2} label={t("collaboration.threads.loading")} />
        : threads.error ? <List><ErrorState error={threads.error} title={t("collaboration.threads.errorTitle")} onRetry={() => void threads.refetch()} /></List>
        : threads.data.items.length === 0
          ? <List><Empty icon="collaboration" title={t("collaboration.threads.emptyTitle")} detail={t("collaboration.threads.emptyDetail")} action={<Link className="btn btn-sm" to="/clients">{t("collaboration.threads.emptyAction")}</Link>} /></List>
          : (
            <List>
              {threads.data.items.map(thread => (
                <RowLink
                  key={thread.id}
                  to={`/collaboration?thread=${encodeURIComponent(thread.id)}&channel=${encodeURIComponent(thread.channel_id)}`}
                  lead={<Avatar name={thread.author_label} small />}
                  title={thread.title}
                  sub={`${thread.author_label} · ${plural("collaboration.threads.messages", Number(thread.messages))}`}
                  meta={<Chip tone={thread.state === "resolved" ? "off" : "info"}>{t(thread.state === "resolved" ? "collaboration.threads.closed" : "collaboration.threads.openState")}</Chip>}
                />
              ))}
            </List>
          )}
    </section>
  )
}

/** Notas de trabajo de los agentes del proyecto; la persona puede dejar una para todos y cerrar una que quedó en curso. */
function NotesSection({ projectId }: { projectId: string }) {
  const { t } = useT("project")
  const common = useT("common").t
  const labels = useTaskLabels()
  const toast = useToast()
  const errorText = useErrorText()
  const [limit, setLimit] = useState(NOTES_PAGE)
  const [text, setText] = useState("")
  const notes = useMemory<Page<AgentNote>>("list_notes", { project_id: projectId, limit, offset: 0 })
  const write = useMemoryAction("write_note", { quiet: true })
  const close = useMemoryAction("write_note")

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
    event.preventDefault()
    const value = text.trim()
    if (!value || write.isPending) return
    write.mutate({ project_id: projectId, text: value, state: "done" }, {
      onSuccess: () => { setText(""); toast.success(t("collaboration.notes.created")) },
      onError: failure => toast.error(errorText(failure)),
    })
  }
  function finish(note: AgentNote) {
    close.mutate({ id: note.id, text: note.text, state: "done" }, {
      onSuccess: () => toast.show({ kind: "success", message: t("collaboration.notes.finished", { name: note.agent_label }), undo: () => close.mutate({ id: note.id, text: note.text, state: "working" }) }),
    })
  }

  return (
    <section className="section">
      <div className="section-h"><h2 className="h2">{t("collaboration.notes.title")}</h2></div>
      <Input aria-label={t("collaboration.notes.newLabel")} placeholder={t("collaboration.notes.newPlaceholder")} maxLength={600} value={text} disabled={write.isPending} onChange={event => setText(event.target.value)} onKeyDown={onKeyDown} />
      {notes.isPending ? <SkeletonRows count={2} label={t("collaboration.notes.loading")} />
        : notes.error ? <List><ErrorState error={notes.error} title={t("collaboration.notes.errorTitle")} onRetry={() => void notes.refetch()} /></List>
        : notes.data.items.length === 0
          ? <List><Empty icon="note" title={t("collaboration.notes.emptyTitle")} detail={t("collaboration.notes.emptyDetail")} /></List>
          : <>
              <List>
                {notes.data.items.map(note => (
                  <Row
                    key={note.id}
                    lead={<Avatar name={note.agent_label} small />}
                    title={note.text}
                    sub={[note.agent_label, note.task_key ?? note.task_title, labels.finishReason(note)].filter(Boolean).join(" · ")}
                    meta={<>
                      <Chip tone={note.state === "working" ? "info" : note.state === "blocked" ? "warn" : "off"}>{labels.noteState(note)}</Chip>
                      <ListDate value={note.updated_at} />
                    </>}
                    action={note.state === "working" ? <Button small variant="ghost" disabled={close.isPending} onClick={() => finish(note)}>{t("collaboration.notes.finish")}</Button> : undefined}
                  />
                ))}
              </List>
              {notes.data.total > notes.data.items.length && (
                <Button small variant="ghost" style={{ alignSelf: "flex-start" }} onClick={() => setLimit(value => value + NOTES_PAGE)}>{common("actions.showMore")}</Button>
              )}
            </>}
    </section>
  )
}

/** Foro entre agentes de los hubs que comparten el proyecto. La persona lo lee; publicar y responder es de los agentes. */
function ForumSection({ projectId }: { projectId: string }) {
  const { t } = useT("project")
  const common = useT("common").t
  const [limit, setLimit] = useState(FORUM_PAGE)
  const panel = useWorkPanel("message")
  const messages = useMemory<Page<ForumMessage>>("read_messages", { project_id: projectId, unread_only: false, limit, offset: 0 })
  const items = messages.data?.items ?? []
  const selected = items.find(message => message.id === panel.value)
  return (
    <section className="section">
      <div className="section-h"><h2 className="h2">{t("collaboration.forum.title")}</h2></div>
      {messages.isPending ? <SkeletonRows count={2} label={t("collaboration.forum.loading")} />
        : messages.error ? <List><ErrorState error={messages.error} title={t("collaboration.forum.errorTitle")} onRetry={() => void messages.refetch()} /></List>
        : items.length === 0
          ? <List><Empty icon="collaboration" title={t("collaboration.forum.emptyTitle")} detail={t("collaboration.forum.emptyDetail")} /></List>
          : <>
              <List>
                {items.map(message => (
                  <Row
                    key={message.id}
                    onOpen={() => panel.open(message.id)}
                    selected={panel.value === message.id}
                    lead={<Avatar name={message.agent_label} small />}
                    title={message.text}
                    sub={message.agent_label}
                    meta={<>
                      <Tag>{t(message.to_member ? "collaboration.forum.private" : "collaboration.forum.project")}</Tag>
                      <ListDate value={message.created_at} />
                    </>}
                  />
                ))}
              </List>
              {(messages.data?.total ?? 0) > items.length && (
                <Button small variant="ghost" style={{ alignSelf: "flex-start" }} onClick={() => setLimit(value => value + FORUM_PAGE)}>{common("actions.showMore")}</Button>
              )}
            </>}
      {panel.value && <MessagePanel message={selected} loading={messages.isPending} replyTo={items.find(item => item.id === selected?.reply_to)} onOpen={id => panel.open(id)} onClose={panel.close} />}
    </section>
  )
}

function MessagePanel({ message, loading, replyTo, onOpen, onClose }: { message?: ForumMessage; loading: boolean; replyTo?: ForumMessage; onOpen: (id: string) => void; onClose: () => void }) {
  const { t } = useT("project")
  const format = useFormat()
  return (
    <SidePanel>
      <Panel label={message?.agent_label ?? t("collaboration.forum.message")} onClose={onClose}>
        <PanelHeader
          lead={message ? <Avatar name={message.agent_label} /> : undefined}
          title={message?.agent_label ?? t("collaboration.forum.message")}
          status={message ? <Tag>{t(message.to_member ? "collaboration.forum.private" : "collaboration.forum.project")}</Tag> : undefined}
        />
        <PanelBody>
          {!message ? (loading ? <SkeletonRows count={1} avatar={false} /> : <Empty icon="info" title={t("collaboration.forum.goneTitle")} detail={t("collaboration.forum.goneDetail")} />) : <>
            <p className="t2 prose" style={{ whiteSpace: "pre-wrap" }}>{message.text}</p>
            <Dl items={[
              { label: t("collaboration.forum.sent"), value: format.date(message.created_at) },
              { label: t("collaboration.forum.expires"), value: format.date(message.expires_at) },
              {
                label: t("collaboration.forum.replyTo"),
                value: message.reply_to
                  ? replyTo ? <Button small variant="ghost" style={{ marginLeft: "calc(var(--sp-2) * -1)" }} onClick={() => onOpen(replyTo.id)}>{replyTo.agent_label}</Button> : <span className="mono">{message.reply_to.slice(0, 12)}</span>
                  : null,
              },
            ]} />
          </>}
        </PanelBody>
      </Panel>
    </SidePanel>
  )
}
