import { Avatar, Button, Chip, Dl, ErrorState, Loading, Panel, PanelBody, PanelHeader, absoluteTime } from "../../components/ui"
import { useT } from "../../i18n"
import { useMemory, type Page } from "../../lib/memory"
import { MESSAGE_PAGE, Pager, RECEIPT_TONE, planState, receiptState } from "./shared"
import type { Message, Thread } from "./types"

export interface ThreadPanelProps {
  threadId: string
  messageOffset: number
  onMessageOffset: (offset: number) => void
  onOpenPlan: (planId: string) => void
  onClose: () => void
}

/** Hilo completo, de solo lectura: la persona observa; escribir y confirmar lectura es de los agentes. */
export function ThreadPanel({ threadId, messageOffset, onMessageOffset, onOpenPlan, onClose }: ThreadPanelProps) {
  const { t } = useT("collaboration")
  const messages = useMemory<Page<Message> & { thread: Thread }>("chat_read", { thread_id: threadId, limit: MESSAGE_PAGE, offset: messageOffset })
  const thread = messages.data?.thread
  const resolved = thread?.state === "resolved"
  const plan = thread?.team_plan_id ? planState(thread.team_plan_state) : null

  return (
    <Panel label={thread?.title ?? t("thread.label")} onClose={onClose} wide>
      <PanelHeader
        title={thread?.title ?? t("thread.label")}
        status={thread && <Chip tone={resolved ? "off" : "ok"}>{t(resolved ? "thread.resolved" : "thread.open")}</Chip>}
      />
      <PanelBody>
        {messages.isPending && <Loading label={t("thread.loading")} />}
        {messages.error && <ErrorState error={messages.error} title={t("thread.error")} onRetry={() => void messages.refetch()} />}
        {thread && <>
          {thread.team_plan_id && (
            <div className="card" style={{ padding: "var(--sp-3)", display: "flex", flexDirection: "column", gap: "var(--sp-2)", background: "var(--surface-2)" }}>
              <span>{t(plan === "prepared" ? "thread.planPending" : "thread.planLinked")}</span>
              <div>
                <Button variant={plan === "prepared" ? "primary" : "default"} small onClick={() => onOpenPlan(thread.team_plan_id!)}>
                  {t(plan === "prepared" ? "actions.reviewTeam" : "actions.viewTeam")}
                </Button>
              </div>
            </div>
          )}
          <Dl items={[
            { label: t("thread.channel"), value: <span className="trunc" title={thread.channel_name}>#{thread.channel_name}</span> },
            { label: t("thread.author"), value: thread.author_label },
            { label: t("thread.participants"), value: thread.participants },
            { label: t("thread.awaiting"), value: thread.awaiting_labels },
            { label: t("thread.task"), value: thread.task_id ? <span className="mono trunc" title={thread.task_id}>{thread.task_id}</span> : null },
            { label: t("thread.updated"), value: absoluteTime(thread.updated_at) },
          ]} />
          <hr className="divider" />
          {messages.data!.items.length === 0
            ? <span className="t3">{t("thread.noMessages")}</span>
            : <ol aria-label={t("thread.messages")} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
              {messages.data!.items.map(message => <MessageItem key={message.id} message={message} />)}
            </ol>}
          <Pager total={messages.data!.total} offset={messageOffset} limit={MESSAGE_PAGE} onChange={onMessageOffset} />
        </>}
      </PanelBody>
    </Panel>
  )
}

function MessageItem({ message }: { message: Message }) {
  const { t } = useT("collaboration")
  return (
    <li id={`chat-${message.id}`} style={{ display: "flex", gap: "var(--sp-3)" }}>
      <Avatar name={message.author_label} small round />
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)", minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "baseline", minWidth: 0 }}>
          <span className="trunc" style={{ fontWeight: 600 }} title={message.author_label}>{message.author_label}</span>
          <time className="xs t3" dateTime={message.created_at} style={{ flex: "none" }}>{absoluteTime(message.created_at)}</time>
        </div>
        {message.reply_to && <span className="xs t3">{t("thread.replyTo", { id: message.reply_to.slice(0, 8) })}</span>}
        <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.text}</p>
        {message.mentions.length > 0 && (
          <ul aria-label={t("thread.receipts")} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
            {message.mentions.map(receipt => {
              const state = receiptState(receipt)
              return (
                <li key={receipt.recipient_id} style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }}>
                  <span className="xs t2 trunc" title={receipt.label}>@{receipt.label}</span>
                  <Chip tone={RECEIPT_TONE[state]}>{t(`receipt.${state}`)}</Chip>
                  {receipt.response_alerted_at && !receipt.response_message_id && !receipt.cancelled_at && <span className="xs t3">{t("receipt.alerted")}</span>}
                  {!receipt.cancelled_at && !receipt.read_at && receipt.attempts >= 5 && <span className="xs t3">{t("receipt.unconfirmed")}</span>}
                  {receipt.error && <span className="xs" style={{ color: "var(--danger)", overflowWrap: "anywhere" }}>{receipt.error}</span>}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </li>
  )
}
