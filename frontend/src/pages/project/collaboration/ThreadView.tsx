import { Fragment, useState } from "react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { Avatar, Empty, ErrorState, IconButton, SkeletonRows, Tag } from "../../../components/ui"
import { useFormat, useT } from "../../../i18n"
import { useMemory } from "../../../lib/memory"
import { MESSAGE_PAGE, Pager, agentInitials } from "./chatShared"
import { messageKind, type BoardChannel, type BoardMessage, type ThreadRead } from "./collabData"

/** Debate de un hilo, solo lectura: mensajes tipados de los agentes. La X cierra la columna (limpia `?thread=`). */
export function ThreadView({ threadId, channel, onClose }: { threadId: string; channel: BoardChannel; onClose: () => void }) {
  const { t } = useT("project")
  const format = useFormat()
  const [offset, setOffset] = useState(0)
  const read = useMemory<ThreadRead>("chat_read", { thread_id: threadId, limit: MESSAGE_PAGE, offset })
  const thread = read.data?.thread

  const close = <IconButton icon="close" label={t("collaboration.board.closeThread")} small variant="ghost" onClick={onClose} />
  if (read.isPending) return <><div className="collab-head" style={{ alignItems: "flex-end" }}>{close}</div><SkeletonRows count={3} label={t("collaboration.board.loadingThread")} /></>
  if (read.error || !thread) return <><div className="collab-head" style={{ alignItems: "flex-end" }}>{close}</div><ErrorState error={read.error} title={t("collaboration.board.threadError")} onRetry={() => void read.refetch()} /></>

  const started = thread.created_at ?? read.data.items[0]?.created_at ?? thread.updated_at

  return <>
    <div className="collab-head" style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" }}>
      <div className="row-main" style={{ gap: "var(--sp-2)" }}>
        <span className="h3 clamp2" title={thread.title}>{thread.title}</span>
        <span className="xs t3">{t("collaboration.board.origin", { channel: channel.name, author: thread.author_label || read.data.items[0]?.author_label || "", when: when(started, format, time => t("collaboration.board.today", { time })) })}</span>
      </div>
      {close}
    </div>

    {read.data.items.length === 0
      ? <div className="msgs"><Empty icon="collaboration" title={t("collaboration.board.noMessages")} /></div>
      : (
        <div className="msgs">
          <ol aria-label={t("collaboration.board.messagesLabel")} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "inherit" }}>
            {read.data.items.map(message => <MessageItem key={message.id} message={message} />)}
          </ol>
          <Pager total={read.data.total} offset={offset} limit={MESSAGE_PAGE} onChange={setOffset} />
        </div>
      )}

  </>
}

type Format = ReturnType<typeof useFormat>

/** «hoy 13:52» si es de hoy; fecha y hora si no. */
function when(value: string, format: Format, today?: (time: string) => string): string {
  const date = new Date(value)
  if (date.toDateString() !== new Date().toDateString()) return format.date(date, "datetime")
  const time = format.date(date, "time")
  return today ? today(time) : time
}

function MessageItem({ message }: { message: BoardMessage }) {
  const { t } = useT("project")
  const format = useFormat()
  const kind = messageKind(message.kind)
  return (
    <li id={`chat-${message.id}`} className="msg">
      <Avatar name={message.author_label} text={agentInitials(message.author_label, message.cli_kind)} small />
      <div className="msg-body">
        <div className="msg-meta">
          <b className="trunc" style={{ maxWidth: "18ch" }} title={message.author_label}>{message.author_label}</b>
          {kind && <Tag>{t(`collaboration.board.kind.${kind}`)}</Tag>}
          <time className="xs t3" dateTime={message.created_at} title={format.date(message.created_at)}>{when(message.created_at, format)}</time>
        </div>
        <p className="prose" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{linkify(message.text)}</p>
      </div>
    </li>
  )
}

// Enlaces markdown [texto](destino) y URLs sueltas; solo http(s) y rutas internas («/…»), nunca otros esquemas.
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g

function linkify(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(LINK)) {
    const index = match.index ?? 0
    if (index > last) parts.push(text.slice(last, index))
    const label = match[1] ?? match[3]!
    const target = match[2] ?? match[3]!
    parts.push(<Fragment key={index}>{anchor(label, target) ?? match[0]}</Fragment>)
    last = index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

function anchor(label: string, target: string): ReactNode | null {
  if (target.startsWith("/") && !target.startsWith("//")) return <Link to={target}>{label}</Link>
  if (/^https?:\/\//i.test(target)) return <a href={target} target="_blank" rel="noreferrer noopener">{label}</a>
  return null
}
