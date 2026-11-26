import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Avatar, Button, Chip, Empty, ErrorState, IconButton, SkeletonRows, Textarea, useToast } from "../../components/ui"
import { Markdown } from "../../components/Markdown"
import { useFormat, useT } from "../../i18n"
import { api } from "../../lib/api"
import { ownerDismissed, safeLink, scoreTone, useChat, type ChatMessage, type Discussion, type Issue, type Work } from "./data"
import { SourceLink, Sources, useFailure, useLabels } from "./shared"

// Distance to the bottom (px) that still counts as «at the bottom»; absorbs scroll rounding.
const PIN_SLACK = 24
const BLOCK = /^\s*([-*+]|\d{1,9}[.)])\s+|^\s{0,3}(#{1,6}\s|>|```|~~~)|\|/

/** Replies arrive as plain lines as often as Markdown: consecutive text lines become separate paragraphs. */
function paragraphs(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const out: string[] = []
  let fenced = false
  lines.forEach((line, index) => {
    out.push(line)
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced
    const next = lines[index + 1]
    if (!fenced && line.trim() && next?.trim() && !BLOCK.test(line) && !BLOCK.test(next)) out.push("")
  })
  return out.join("\n")
}

export interface AssistantPanelProps {
  /** Projects the assistant is following. */
  tracked: number
  /** Issue on screen: it travels with every message as the subject of the conversation. */
  issue: Issue | null | undefined
  issueProject: string
  issueActive: boolean
  issueError: unknown
  work: Work | undefined
  connections: boolean
  onClose: () => void
  onDismiss: (ids: string[]) => void
  onRestore: (ids: string[]) => void
  onRetry: (work: Work) => void
  busy: boolean
}

/** The assistant column: the element on screen as context, the single conversation and its composer. */
export function AssistantPanel(props: AssistantPanelProps) {
  const { tracked, issue, issueProject, issueActive, issueError, work, connections, onClose } = props
  const { t, plural } = useT("assistants")
  const cache = useQueryClient()
  const fail = useFailure()
  const chat = useChat()
  const [text, setText] = useState("")
  const ready = !!issue && issue.state === "open" && issue.kind === "slack" && issueActive && connections
  const send = useMutation({
    mutationFn: (input: { text: string; mode: "chat" | "rewrite" }) =>
      api.post<Discussion>("/assistants/chat", { ...input, ...(issue ? { case_id: issue.id, revision: issue.revision } : {}) }),
    onSuccess: (discussion) => {
      cache.setQueryData(["assistants", "chat"], discussion)
      setText("")
    },
    onError: fail,
    onSettled: () => cache.invalidateQueries({ queryKey: ["assistants"] }),
  })
  const submit = (mode: "chat" | "rewrite") => {
    const body = text.trim()
    if (body && !send.isPending) send.mutate({ text: body, mode })
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit("chat")
  }
  return (
    <aside className="assistant-chat" aria-label={t("assistant")}>
      <div className="assistant-chat-h">
        <Avatar name={t("assistant")} text="AS" small />
        <span className="h3 trunc">{t("assistant")}</span>
        <Chip tone={tracked ? "ok" : "off"}>{tracked ? plural("following", tracked) : t("followingNone")}</Chip>
      </div>
      {issue && <IssueCard {...props} issue={issue} project={issueProject} ready={ready} />}
      {!issue && !!issueError && (
        <div className="assistant-ctx">
          <ErrorState error={issueError} action={<Button small onClick={onClose}>{t("closeContext")}</Button>} />
        </div>
      )}
      {!issue && work && <WorkCard work={work} onClose={onClose} onRetry={props.onRetry} busy={props.busy} />}
      <Messages
        messages={chat.data?.messages}
        error={chat.error}
        onRetry={() => void chat.refetch()}
        pending={send.isPending ? send.variables?.text : undefined}
      />
      <form
        className="assistant-composer"
        onSubmit={(event) => {
          event.preventDefault()
          submit("chat")
        }}
      >
        {issue && (
          <span className="xs t3 trunc" title={issue.title}>
            {t("about", { title: issue.title })}
          </span>
        )}
        <Textarea
          rows={2}
          maxLength={4000}
          value={text}
          aria-label={t("composeLabel")}
          placeholder={t("composePlaceholder")}
          disabled={!tracked}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="assistant-composer-f">
          {ready && (
            <Button small disabled={!text.trim() || send.isPending} onClick={() => submit("rewrite")}>
              {t("rewrite")}
            </Button>
          )}
          <Button small type="submit" icon="arrow" disabled={!text.trim() || send.isPending || !tracked}>
            {t("send")}
          </Button>
        </div>
      </form>
    </aside>
  )
}

function Card({ title, sub, onClose, children, footer }: { title: string; sub: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const { t } = useT("assistants")
  return (
    <section className="assistant-ctx" aria-label={title}>
      <div className="assistant-ctx-h">
        <div className="row-main">
          <span className="h3 clamp2" title={title}>
            {title}
          </span>
          <span className="xs t3 trunc" title={sub}>
            {sub}
          </span>
        </div>
        <IconButton icon="close" small variant="ghost" label={t("closeContext")} onClick={onClose} />
      </div>
      <div className="assistant-ctx-b">{children}</div>
      {footer && <div className="assistant-ctx-f">{footer}</div>}
    </section>
  )
}

function IssueCard({
  issue,
  project,
  ready,
  onClose,
  onDismiss,
  onRestore,
  busy,
}: AssistantPanelProps & { issue: Issue; project: string; ready: boolean }) {
  const { t } = useT("assistants")
  const format = useFormat()
  const labels = useLabels()
  const toast = useToast()
  const fail = useFailure()
  const cache = useQueryClient()
  const approve = useMutation({
    mutationFn: () => api.post("/assistants/slack/" + issue.id + "/approve", { revision: issue.revision }),
    onSuccess: () => {
      toast.success(t("sentDone"))
    },
    onError: fail,
    onSettled: () => cache.invalidateQueries({ queryKey: ["assistants"] }),
  })
  const chip = labels.issue(issue)
  const source = issue.source ?? {}
  const original = safeLink(source.url)
  const receipt =
    issue.receipt && typeof source.channel === "string"
      ? "https://app.slack.com/archives/" + source.channel + "/p" + issue.receipt.replace(".", "")
      : undefined
  const sub = [project, labels.kind(issue.kind), issue.updated_at && format.date(issue.updated_at, "datetime")].filter(Boolean).join(" · ")
  return (
    <Card
      title={issue.title}
      sub={sub}
      onClose={onClose}
      footer={
        <>
          {ready && issue.draft && (
            <Button variant="primary" small disabled={approve.isPending || busy} onClick={() => approve.mutate()}>
              {t("approve")}
            </Button>
          )}
          {issue.state === "open" && (
            <Button small disabled={busy || approve.isPending} onClick={() => onDismiss([issue.id])}>
              {t("dismiss")}
            </Button>
          )}
          {ownerDismissed(issue) && (
            <Button small disabled={busy} onClick={() => onRestore([issue.id])}>
              {t("restore")}
            </Button>
          )}
          {original && (
            <SourceLink url={original} className="btn btn-sm btn-ghost">
              {t("source")}
            </SourceLink>
          )}
          {receipt && (
            <SourceLink url={receipt} className="btn btn-sm btn-ghost">
              {t("receipt")}
            </SourceLink>
          )}
        </>
      }
    >
      <div className="assistant-ctx-chips">
        <Chip tone={scoreTone(issue.score)} title={t("urgency", { score: issue.score })} className="num">
          {issue.score}/10
        </Chip>
        {chip && <Chip tone={chip.tone}>{chip.label}</Chip>}
      </div>
      <p className="assistant-text">{issue.reason}</p>
      {issue.kind === "slack" && (
        <span className="xs t3">
          {t("destination", { channel: source.channel_name || source.channel, team: source.team })}
          {source.sender && <> · {t("sender", { sender: source.sender })}</>}
        </span>
      )}
      {issue.draft && (
        <div className="assistant-draft">
          <span className="eyebrow">{t("proposal")}</span>
          <p className="assistant-text">{issue.draft}</p>
        </div>
      )}
      <Sources items={issue.evidence ?? []} />
    </Card>
  )
}

function WorkCard({ work, onClose, onRetry, busy }: { work: Work; onClose: () => void; onRetry: (work: Work) => void; busy: boolean }) {
  const { t } = useT("assistants")
  const labels = useLabels()
  const chip = labels.work(work.state)
  const result = work.result
  return (
    <Card
      title={work.objective}
      sub={[work.project_title, t(work.role)].filter(Boolean).join(" · ")}
      onClose={onClose}
      footer={
        work.state === "blocked" ? (
          <Button small disabled={busy} onClick={() => onRetry(work)}>
            {t("retry")}
          </Button>
        ) : undefined
      }
    >
      <div className="assistant-ctx-chips">
        <Chip tone={chip.tone}>{chip.label}</Chip>
      </div>
      {result && (
        <>
          <p className="assistant-text">{result.summary}</p>
          {!!result.criteria?.length && <Detail label={t("criteria")}>{result.criteria.join(" · ")}</Detail>}
          {!!result.missing?.length && <Detail label={t("missing")}>{result.missing.join(" · ")}</Detail>}
          {result.sha && (
            <Detail label={t("review")}>
              <span className="mono">
                {result.base} → {result.sha}
              </span>
              {result.worktree && <span className="mono assistant-break">{result.worktree}</span>}
            </Detail>
          )}
          {!!result.verification?.length && (
            <Detail label={t("verification")}>
              <span className="mono assistant-break">{result.verification.join(" ")}</span>
            </Detail>
          )}
        </>
      )}
    </Card>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="assistant-detail">
      <span className="eyebrow">{label}</span>
      {children}
    </div>
  )
}

function Messages({
  messages,
  error,
  onRetry,
  pending,
}: {
  messages: ChatMessage[] | undefined
  error: unknown
  onRetry: () => void
  pending: string | undefined
}) {
  const { t } = useT("assistants")
  const list = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const last = messages?.at(-1)?.seq
  useLayoutEffect(() => {
    const element = list.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [last, pending])
  useEffect(() => {
    const element = list.current
    if (!element || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      if (pinned.current) element.scrollTop = element.scrollHeight
    })
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  }, [messages === undefined])
  function onScroll() {
    const element = list.current
    if (element) pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight <= PIN_SLACK
  }
  if (!messages)
    return (
      <div className="msgs">
        {error ? <ErrorState error={error} onRetry={onRetry} /> : <SkeletonRows count={3} label={t("conversation")} />}
      </div>
    )
  if (!messages.length && !pending)
    return (
      <div className="msgs">
        <Empty icon="sparkles" title={t("emptyChat")} detail={t("emptyChatDetail")} />
      </div>
    )
  return (
    <div className="msgs" ref={list} onScroll={onScroll}>
      <ol className="assistant-thread" aria-label={t("conversation")}>
        {messages.map((message) => (
          <Message key={message.seq} message={message} />
        ))}
        {pending && (
          <>
            <Message message={{ seq: -1, role: "owner", body: pending, evidence: [], created_at: "" }} />
            <li className="xs t3" role="status">
              {t("thinking")}
            </li>
          </>
        )}
      </ol>
    </div>
  )
}

function Message({ message }: { message: ChatMessage }) {
  const { t } = useT("assistants")
  const format = useFormat()
  const own = message.role === "owner"
  const author = own ? t("owner") : t("assistant")
  return (
    <li className="msg">
      <Avatar name={author} {...(own ? {} : { text: "AS" })} small />
      <div className="msg-body">
        <div className="msg-meta">
          <b>{author}</b>
          {message.created_at && (
            <time className="xs t3" dateTime={message.created_at} title={format.date(message.created_at, "datetime")}>
              {format.relative(message.created_at)}
            </time>
          )}
          {own && message.case_title && (
            <span className="tag assistant-about" title={message.case_title}>
              <span className="trunc">{t("about", { title: message.case_title })}</span>
            </span>
          )}
        </div>
        {own ? <p className="assistant-text">{message.body}</p> : <Markdown source={paragraphs(message.body)} />}
        <Sources items={message.evidence ?? []} />
      </div>
    </li>
  )
}
