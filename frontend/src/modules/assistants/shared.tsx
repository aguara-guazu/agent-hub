import type { CSSProperties, ReactNode } from "react"
import { Link } from "react-router-dom"
import type { CaseRow, Evidence } from "@agenthub/shared/assistants"
import { describeError, useToast, type ChipTone } from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import { ownerDismissed, safeLink, type Work } from "./data"

export interface StateChip {
  tone: ChipTone
  label: string
}
export type Kind = CaseRow["kind"] | "work"

export const BARE_BUTTON: CSSProperties = {
  border: 0,
  background: "transparent",
  padding: 0,
  font: "inherit",
  color: "inherit",
  textAlign: "left",
  cursor: "pointer",
  maxWidth: "100%",
}

const WORK_TONE: Record<Work["state"], ChipTone> = {
  queued: "off",
  running: "info",
  done: "ok",
  blocked: "warn",
  cancelled: "off",
  paused: "off",
}

export function useLabels() {
  const { t } = useT("assistants")
  return {
    kind: (kind: Kind) => (kind === "jira" ? t("jiraKind") : kind === "work" ? t("workKind") : t(kind)),
    /** Chip of an issue whose state says more than «pending»; null when the urgency alone describes it. */
    issue(issue: CaseRow): StateChip | null {
      if (ownerDismissed(issue)) return { tone: "off", label: t("dismissedState") }
      if (issue.state === "open") return issue.draft ? { tone: "info", label: t("draftReady") } : null
      if (issue.state === "uncertain") return { tone: "warn", label: t("uncertain") }
      if (issue.state === "sending") return { tone: "info", label: t("sending") }
      if (issue.state === "sent" || issue.state === "handled") return { tone: "ok", label: t(issue.state) }
      return { tone: "off", label: t("closed") }
    },
    work: (state: Work["state"]): StateChip => ({ tone: WORK_TONE[state], label: t(state === "paused" ? "pausedState" : state) }),
  }
}

/** Mutation failures: the general cause as the message and the server's own text as detail. */
export function useFailure() {
  const toast = useToast()
  return (error: unknown) => {
    toast.error(describeError(error), error instanceof Error ? error.message : undefined)
  }
}

/** Evidence and case links: Hub routes stay in the window, anything else opens outside. Unsafe targets render as text. */
export function SourceLink({ url, children, className }: { url: unknown; children: ReactNode; className?: string }) {
  const safe = safeLink(url)
  if (!safe) return <span className={className}>{children}</span>
  if (safe.startsWith("/#/"))
    return (
      <Link className={className} to={safe.slice(2)}>
        {children}
      </Link>
    )
  return (
    <a className={className} href={safe} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  )
}

export function Sources({ items }: { items: Evidence[] }) {
  const { t } = useT("assistants")
  const format = useFormat()
  if (!items.length) return null
  return (
    <details className="assistant-sources">
      <summary className="xs t3">
        {t("evidence")} ({items.length})
      </summary>
      <ul>
        {items.map((e) => (
          <li key={e.id}>
            <span className="assistant-source-h">
              <SourceLink url={e.url} className="trunc">
                {e.title}
              </SourceLink>
              <time className="xs t3" dateTime={e.at}>
                {format.date(e.at)}
              </time>
            </span>
            <span className="xs t2 clamp2">{e.text}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}
