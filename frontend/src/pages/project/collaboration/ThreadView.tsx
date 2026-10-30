import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { Avatar, Empty, ErrorState, IconButton, SkeletonRows, Tag } from "../../../components/ui"
import { useFormat, useT } from "../../../i18n"
import { useMemory } from "../../../lib/memory"
import { MESSAGE_PAGE, Pager, agentInitials } from "./chatShared"
import { isInterhub } from "./interhubData"
import { messageKind, type BoardChannel, type BoardMessage, type ThreadRead } from "./collabData"

// Distancia al fondo (px) que todavía cuenta como «al fondo»: absorbe redondeos del scroll.
const PIN_SLACK = 24

/** Los mensajes llegan en orden: el hilo muestra los últimos MESSAGE_PAGE, con el último al fondo. */
function latestOffset(total: number): number {
  return Math.max(0, total - MESSAGE_PAGE)
}

/** Debate de un hilo, solo lectura: mensajes tipados de los agentes. La X cierra la columna (limpia `?thread=`). */
export function ThreadView({ threadId, channel, onClose }: { threadId: string; channel: BoardChannel; onClose: () => void }) {
  const { t } = useT("project")
  const format = useFormat()
  // null sigue los últimos mensajes (también cuando el hilo crece); un número es la página que eligió la persona.
  const [page, setPage] = useState<number | null>(null)
  const probe = useMemory<ThreadRead>("chat_read", { thread_id: threadId, limit: 1, offset: 0 }, page === null)
  const offset = page ?? (probe.data ? latestOffset(probe.data.total) : undefined)
  const read = useMemory<ThreadRead>("chat_read", { thread_id: threadId, limit: MESSAGE_PAGE, offset: offset ?? 0 }, offset !== undefined)
  // Al pasar de página se sigue viendo la anterior hasta que llega la nueva, sin parpadeo de carga.
  const kept = useRef<ThreadRead | undefined>(undefined)
  if (read.data) kept.current = read.data
  const data = read.data ?? kept.current
  const error = read.error ?? (page === null ? probe.error : null)

  // Los mensajes arrancan al fondo y lo siguen mientras la persona no haya subido a leer.
  const list = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const lastId = data?.items.at(-1)?.id
  const hasMessages = Boolean(data?.items.length)
  useLayoutEffect(() => {
    const element = list.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [lastId, data?.offset])
  useEffect(() => {
    const element = list.current
    if (!element || typeof ResizeObserver === "undefined") return
    // Si la ventana o los mensajes cambian de tamaño, el último mensaje sigue a la vista.
    const observer = new ResizeObserver(() => { if (pinned.current) element.scrollTop = element.scrollHeight })
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  }, [hasMessages])
  function onScroll() {
    const element = list.current
    if (element) pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight <= PIN_SLACK
  }
  function goTo(next: number) {
    pinned.current = true
    setPage(probe.data && next >= latestOffset(probe.data.total) ? null : next)
  }

  const close = <IconButton icon="close" label={t("collaboration.board.closeThread")} small variant="ghost" onClick={onClose} />
  if (!data && !error) return <><div className="collab-head" style={{ alignItems: "flex-end" }}>{close}</div><SkeletonRows count={3} label={t("collaboration.board.loadingThread")} /></>
  const thread = data?.thread
  if (!data || !thread) return <><div className="collab-head" style={{ alignItems: "flex-end" }}>{close}</div><ErrorState error={error} title={t("collaboration.board.threadError")} onRetry={() => { void probe.refetch(); void read.refetch() }} /></>

  const started = thread.created_at ?? data.items[0]?.created_at ?? thread.updated_at
  const first = data.offset === 0 ? data.items[0] : undefined
  const shared = isInterhub(channel)
  const author = thread.author_label || first?.author_label || ""
  // El hub de quien abrió el hilo solo se conoce por su primer mensaje, que es el de la primera página.
  const authorHub = shared && first && first.author_label === author ? first.origin_hub?.name : undefined

  return <>
    <div className="collab-head" style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" }}>
      <div className="row-main" style={{ gap: "var(--sp-2)" }}>
        <span className="h3 clamp2" title={thread.title}>{thread.title}</span>
        <span className="xs t3">{t(shared ? "collaboration.interhub.origin" : "collaboration.board.origin", { channel: channel.name, author: authorHub ? t("collaboration.interhub.authorHub", { author, hub: authorHub }) : author, when: when(started, format, time => t("collaboration.board.today", { time })) })}</span>
      </div>
      {close}
    </div>

    {data.items.length === 0
      ? <div className="msgs"><Empty icon="collaboration" title={t("collaboration.board.noMessages")} /></div>
      : (
        <div className="msgs" ref={list} onScroll={onScroll}>
          <ol aria-label={t("collaboration.board.messagesLabel")} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "inherit" }}>
            {data.items.map(message => <MessageItem key={message.id} message={message} />)}
          </ol>
          <Pager total={data.total} offset={data.offset} limit={MESSAGE_PAGE} onChange={goTo} />
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
  const hub = message.origin_hub
  return (
    <li id={`chat-${message.id}`} className="msg">
      <Avatar name={message.author_label} text={agentInitials(message.author_label, message.cli_kind)} small />
      <div className="msg-body">
        <div className="msg-meta">
          <b className="trunc" style={{ maxWidth: "18ch" }} title={message.author_label}>{message.author_label}</b>
          {message.author_role === "leader" && <Tag>{t("collaboration.interhub.leader")}</Tag>}
          {hub && <span className={hub.is_local ? "chip c-ok" : "chip c-off"} style={{ maxWidth: "22ch" }} title={hub.name}><span className="trunc">{hub.name}</span></span>}
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
