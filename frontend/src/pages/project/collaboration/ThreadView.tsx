import { Fragment, useState } from "react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { Avatar, Empty, ErrorState, SkeletonRows, Tag } from "../../../components/ui"
import { useFormat, useT } from "../../../i18n"
import { useMemory } from "../../../lib/memory"
import { MESSAGE_PAGE, Pager } from "./chatShared"
import { messageKind, type BoardChannel, type BoardMessage, type Resolution, type ThreadRead } from "./collabData"

/**
 * Debate de un hilo, solo lectura: mensajes tipados de los agentes y la resolución que proponen.
 * La persona aprueba en la terminal con el agente líder; acá no hay acciones.
 */
export function ThreadView({ threadId, channel }: { threadId: string; channel: BoardChannel }) {
  const { t } = useT("project")
  const format = useFormat()
  const [offset, setOffset] = useState(0)
  const read = useMemory<ThreadRead>("chat_read", { thread_id: threadId, limit: MESSAGE_PAGE, offset })
  const thread = read.data?.thread

  if (read.isPending) return <SkeletonRows count={3} label={t("collaboration.board.loadingThread")} />
  if (read.error || !thread) return <ErrorState error={read.error} title={t("collaboration.board.threadError")} onRetry={() => void read.refetch()} />

  const started = thread.created_at ?? read.data.items[0]?.created_at ?? thread.updated_at
  const resolution = thread.state !== "resolved" && read.data.resolution?.state === "pending" ? read.data.resolution : null

  return <>
    <div className="collab-head">
      <div className="row-main" style={{ gap: "var(--sp-2)" }}>
        <span className="h3 clamp2" title={thread.title}>{thread.title}</span>
        <span className="xs t3">{t("collaboration.board.origin", { channel: channel.name, author: thread.author_label, when: when(started, format, time => t("collaboration.board.today", { time })) })}</span>
      </div>
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

    {resolution && <ResolutionBlock resolution={resolution} />}
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
      <Avatar name={message.author_label} small />
      <div className="msg-body">
        <div className="msg-meta">
          <b className="trunc" title={message.author_label}>{message.author_label}</b>
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

function ResolutionBlock({ resolution }: { resolution: Resolution }) {
  const { t } = useT("project")
  return (
    <div className="resolution" role="note" aria-label={t("collaboration.board.resolutionLabel")}>
      <span className="eyebrow" style={{ color: "var(--accent-text)" }}>
        {t("collaboration.board.resolutionEyebrow", { agree: resolution.agreed_count, total: resolution.participant_count })}
      </span>
      <span className="md" style={{ fontWeight: 500, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{resolution.text}</span>
      <span className="xs t3">{t("collaboration.board.approveInTerminal")}</span>
    </div>
  )
}
