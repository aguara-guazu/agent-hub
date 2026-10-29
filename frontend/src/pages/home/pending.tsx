import { useState } from "react"
import type { ReactNode } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Icon } from "../../components/Icon"
import { Avatar, Button, Chip } from "../../components/ui/basics"
import { Row, RowHead } from "../../components/ui/display"
import { Menu, type MenuItem } from "../../components/ui/Menu"
import { useToast } from "../../components/ui/Toast"
import { relativeTime } from "../../components/ui/time"
import { errorKey } from "../../i18n/errors"
import { useFormat, useT } from "../../i18n"
import type { PendingInbox, ProjectSuggestion } from "../../lib/home"
import { memoryCall, type MemoryEntity } from "../../lib/memory"

export type PendingGroup = "connections" | "agents" | "memory"

export interface PendingRow { id: string; group: PendingGroup; node: ReactNode }

const BLOCKED_REASONS = ["different_verified_emails", "shared_transcript", "auto_merge_disabled"] as const
const FACT_CATEGORIES = ["summary", "decision", "commitment", "finding", "risk"] as const
const CONFIDENCES = ["high", "medium", "low"] as const

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? value as T : undefined
}

/** Botón compacto que navega; la fila es un `div` porque contiene el control (U15). */
function LinkAction({ to, children }: { to: string; children: ReactNode }) {
  return <Link className="btn btn-sm" to={to}>{children}</Link>
}

/** Una sola acción por fila: un botón que abre las decisiones posibles del pendiente. */
function DecideMenu({ label, items }: { label: string; items: readonly MenuItem[] }) {
  return (
    <Menu
      items={items}
      label={label}
      trigger={props => <Button {...props} small>{label}<Icon name="down" small /></Button>}
    />
  )
}

/** Mutación de memoria que avisa con el sistema de toasts y refresca las consultas de memoria. */
function useMemoryDecision() {
  const cache = useQueryClient()
  const toast = useToast()
  const { t } = useT("errors")
  const { t: tc } = useT("common")
  return useMutation({
    mutationFn: ({ operation, input }: { operation: string; input: unknown; done: string }) => memoryCall(operation, input),
    onSuccess: async (_result, { done }) => {
      toast.success(done)
      await cache.invalidateQueries({ queryKey: ["memory"] })
    },
    onError: error => toast.error(tc("toast.actionFailed"), t(errorKey(error))),
  })
}

function useRestartClient() {
  const toast = useToast()
  const cache = useQueryClient()
  const { t } = useT("home")
  return useMutation({
    mutationFn: async (client: string) => ({ client, result: await window.agentHub!.restartClient("claude_desktop") }),
    onSuccess: async ({ client, result }) => {
      if (result.ok) toast.success(t("restart.done", { client }))
      else toast.error(t("restart.failed", { client }), result.detail)
      await cache.invalidateQueries({ queryKey: ["local-overview"] })
    },
    onError: (error, client) => toast.error(t("restart.failed", { client }), error instanceof Error ? error.message : undefined),
  })
}

function useQueueJob() {
  const toast = useToast()
  const navigate = useNavigate()
  const cache = useQueryClient()
  const { t: te } = useT("errors")
  const { t: tc } = useT("common")
  return useMutation({
    mutationFn: async ({ operation }: { operation: "infer_identities" | "infer_projects"; message: (queued: number) => string }) => memoryCall<{ queued?: number }>(operation, {}),
    onSuccess: async (result, { message }) => {
      toast.show({ kind: "info", message: message(result.queued ?? 0), action: { label: tc("actions.viewInActivity"), onClick: () => navigate("/activity?tab=procesamiento") } })
      await cache.invalidateQueries({ queryKey: ["memory"] })
    },
    onError: error => toast.error(tc("toast.actionFailed"), te(errorKey(error))),
  })
}

/** Filas de Pendientes con su grupo. Cada fila: identidad, título que dice qué pasa, detalle con la consecuencia, chip y una acción. */
export function usePendingRows(inbox: PendingInbox, projectNames: Map<string, string>): PendingRow[] {
  const { t, plural } = useT("home")
  const { t: tc } = useT("common")
  const { t: ts } = useT("status")
  const format = useFormat()
  const decide = useMemoryDecision()
  const restart = useRestartClient()
  const queue = useQueueJob()
  const navigate = useNavigate()
  const rows: PendingRow[] = []
  const { connections: c, agents: a, memory: m } = inbox
  const busy = decide.isPending

  if (c.oauthServers.length > 0) {
    const names = c.oauthServers.map(server => server.display_name)
    const first = names[0]!
    rows.push({ id: "oauth", group: "connections", node: (
      <Row
        key="oauth"
        lead={<Avatar name={first} text={c.oauthServers.length > 1 ? String(c.oauthServers.length) : undefined} small />}
        title={plural("servers.title", names.length, { name: first })}
        sub={t("servers.detail", { names: format.list(names) })}
        meta={<Chip tone="warn">{ts("chip.requiresAuth")}</Chip>}
        action={<LinkAction to="/servers">{t("servers.action")}</LinkAction>}
      />
    ) })
  }

  for (const client of c.restartClients) {
    const name = ts("client.claude_desktop")
    const added = client.pending?.servers.added.length ?? 0
    rows.push({ id: `restart-${client.id}`, group: "connections", node: (
      <Row
        key={`restart-${client.id}`}
        lead={<Avatar name={name} small />}
        title={t("restart.title", { client: name })}
        sub={added > 0 ? plural("restart.detailServers", added) : t("restart.detail")}
        meta={<Chip tone="warn">{ts("chip.restartPending")}</Chip>}
        action={window.agentHub
          ? <Button small disabled={restart.isPending} onClick={() => restart.mutate(name)}>{tc("actions.restart")}</Button>
          : <LinkAction to="/clients">{t("restart.viewClients")}</LinkAction>}
      />
    ) })
  }

  if (c.gmailScopeMissing) {
    const destination = c.gmailScopeMissing.destination
    rows.push({ id: "gmail", group: "connections", node: (
      <Row
        key="gmail"
        lead={<Avatar name="Gmail" small />}
        title={t("gmail.title")}
        sub={destination ? t("gmail.detail", { destination }) : t("gmail.detailNoDestination")}
        meta={<Chip tone="warn">{ts("chip.requiresAuth")}</Chip>}
        action={<LinkAction to="/settings?section=fuentes">{t("servers.action")}</LinkAction>}
      />
    ) })
  }

  for (const connector of c.failingConnectors) {
    rows.push({ id: `source-${connector.id}`, group: "connections", node: (
      <Row
        key={`source-${connector.id}`}
        lead={<Avatar name={connector.name} small />}
        title={t("source.title", { name: connector.name })}
        sub={t("source.detail")}
        meta={<Chip tone="danger" title={connector.last_error ?? undefined}>{ts("chip.error")}</Chip>}
        action={<LinkAction to="/settings?section=fuentes">{tc("actions.review")}</LinkAction>}
      />
    ) })
  }

  for (const run of a.decisions) {
    const project = run.project_id ? projectNames.get(run.project_id) : undefined
    const when = [project, relativeTime(run.started_at ?? run.scheduled_for)].filter(Boolean).join(" · ")
    const expires = run.decision?.expires_at
    rows.push({ id: `run-${run.run_id}`, group: "agents", node: (
      <Row
        key={`run-${run.run_id}`}
        lead={<Avatar name={project ?? run.title} small />}
        title={plural("decision.title", run.decision?.total ?? 0, { title: run.title })}
        sub={expires ? t("decision.detailExpires", { when, expires: relativeTime(expires) }) : t("decision.detail", { when })}
        meta={<Chip tone="warn">{ts("chip.awaitingDecision")}</Chip>}
        action={<LinkAction to={`/automations/deliveries/${encodeURIComponent(run.run_id)}`}>{tc("actions.review")}</LinkAction>}
      />
    ) })
  }

  if (a.unreadOther > 0) {
    rows.push({ id: "unread", group: "agents", node: (
      <Row
        key="unread"
        lead={<Avatar name="unread" text={String(a.unreadOther)} small />}
        title={plural("unread.title", a.unreadOther)}
        sub={t("unread.detail")}
        meta={<Chip tone="info">{ts("chip.unread")}</Chip>}
        action={<LinkAction to="/automations?view=history">{t("unread.action")}</LinkAction>}
      />
    ) })
  }

  for (const proposal of m.duplicates) rows.push({ id: `dup-${proposal.id}`, group: "memory", node: duplicateRow(proposal) })
  for (const proposal of m.identities) rows.push({ id: `idn-${proposal.id}`, group: "memory", node: identityRow(proposal) })
  for (const item of m.suggestions) rows.push({ id: `sug-${item.id}`, group: "memory", node: suggestionRow(item) })
  for (const fact of m.facts) rows.push({ id: `fact-${fact.id}`, group: "memory", node: factRow(fact) })

  if (m.unresolvedPeople > 0) {
    rows.push({ id: "people", group: "memory", node: (
      <Row
        key="people"
        lead={<Avatar name="people" text={String(m.unresolvedPeople)} small round />}
        title={plural("people.title", m.unresolvedPeople)}
        sub={t("people.detail")}
        meta={<Chip tone="warn">{ts("chip.needsReview")}</Chip>}
        action={<Button small disabled={queue.isPending} onClick={() => queue.mutate({ operation: "infer_identities", message: queued => plural("people.queued", queued) })}>{t("people.action")}</Button>}
      />
    ) })
  }

  if (m.unassignedSources > 0) {
    rows.push({ id: "unassigned", group: "memory", node: (
      <Row
        key="unassigned"
        lead={<Avatar name="sources" text={String(m.unassignedSources)} small />}
        title={plural("unassigned.title", m.unassignedSources)}
        sub={t("unassigned.detail")}
        meta={<Chip tone="warn">{ts("chip.unassigned")}</Chip>}
        action={<Button small disabled={queue.isPending} onClick={() => queue.mutate({ operation: "infer_projects", message: queued => plural("unassigned.queued", queued) })}>{t("unassigned.action")}</Button>}
      />
    ) })
  }

  return rows

  function duplicateRow(proposal: MemoryEntity) {
    const p = proposal.data
    const blocked = oneOf(BLOCKED_REASONS, p.blocked)
    const confidence = oneOf(CONFIDENCES, p.confidence)
    const detail = blocked ? t(`duplicate.blocked.${blocked}`) : p.basis === "same_email" ? t("duplicate.sameEmail") : confidence ? ts(`confidence.${confidence}`) : undefined
    return (
      <Row
        key={proposal.id}
        lead={<Avatar name={String(p.from_name ?? "")} small round />}
        title={t("duplicate.title", { from: p.from_name, into: p.into_name })}
        sub={detail}
        meta={<Chip tone="warn">{p.verdict === "conflict" ? ts("chip.emailConflict") : ts("chip.possibleDuplicate")}</Chip>}
        action={<DecideMenu label={tc("actions.compare")} items={[
          { label: t("duplicate.merge", { name: p.into_name }), disabled: busy, onSelect: () => decide.mutate({ operation: "review_duplicate", input: { id: proposal.id, decision: "accepted" }, done: t("duplicate.merged", { name: p.into_name }) }) },
          { label: t("duplicate.distinct"), disabled: busy, onSelect: () => decide.mutate({ operation: "review_duplicate", input: { id: proposal.id, decision: "rejected" }, done: t("duplicate.kept") }) },
          { label: t("identity.viewEvidence"), onSelect: () => navigate(`/memory/entities/${proposal.id}`) },
          { label: t("duplicate.viewPerson", { name: p.from_name }), onSelect: () => navigate(`/memory/entities/${p.from_id}`) },
          { label: t("duplicate.viewPerson", { name: p.into_name }), onSelect: () => navigate(`/memory/entities/${p.into_id}`) },
        ]} />}
      />
    )
  }

  function identityRow(proposal: MemoryEntity) {
    const p = proposal.data
    const known = Array.isArray(p.candidate?.origins) && p.candidate.origins.some((origin: { kind?: string }) => origin.kind === "known_person")
    const confidence = oneOf(CONFIDENCES, p.confidence)
    return (
      <Row
        key={proposal.id}
        lead={<Avatar name={String(p.speaker_name ?? "")} small round />}
        title={t("identity.title", { name: p.speaker_name, email: p.candidate?.email })}
        sub={p.stale ? t("identity.staleHint") : confidence ? ts(`confidence.${confidence}`) : undefined}
        meta={<Chip tone="warn">{p.stale ? ts("chip.sourceChanged") : ts("chip.inferred")}</Chip>}
        action={<DecideMenu label={tc("actions.review")} items={[
          { label: known ? t("identity.confirmMerge") : t("identity.confirmEmail"), disabled: busy || Boolean(p.stale), hint: p.stale ? t("identity.staleHint") : undefined, onSelect: () => decide.mutate({ operation: "review_identity", input: { id: proposal.id, decision: "accepted" }, done: t("identity.confirmed", { name: p.speaker_name }) }) },
          { label: t("identity.discard"), disabled: busy, onSelect: () => decide.mutate({ operation: "review_identity", input: { id: proposal.id, decision: "rejected" }, done: t("identity.discarded") }) },
          { label: t("identity.viewEvidence"), onSelect: () => navigate(`/memory/entities/${proposal.id}`) },
          { label: t("identity.viewSpeaker"), onSelect: () => navigate(`/memory/entities/${p.speaker_id}`) },
        ]} />}
      />
    )
  }

  function suggestionRow(item: ProjectSuggestion) {
    const d = item.data
    const confidence = oneOf(CONFIDENCES, d.confidence)
    const kind = oneOf(["meeting", "document", "message", "issue", "note"] as const, item.source_kind)
    const when = item.occurred_at ? relativeTime(item.occurred_at) : undefined
    const detail = d.candidate_project_title
      ? t("suggestion.detailCandidate", { project: d.candidate_project_title, confidence: confidence ? ts(`confidence.${confidence}`) : tc("states.none") })
      : d.suggested_title ? t("suggestion.detailNew", { project: d.suggested_title }) : t("suggestion.detailNone")
    const items: MenuItem[] = []
    if (d.candidate_project_id && d.candidate_project_title) {
      const project = d.candidate_project_title
      items.push({ label: t("suggestion.associate", { project }), disabled: busy, onSelect: () => decide.mutate({ operation: "review_project_suggestion", input: { id: item.id, decision: "assign", project_id: d.candidate_project_id }, done: t("suggestion.associated", { project }) }) })
    }
    if (d.suggested_title) {
      const project = d.suggested_title
      items.push({ label: t("suggestion.createNamed", { project }), disabled: busy, onSelect: () => decide.mutate({ operation: "review_project_suggestion", input: { id: item.id, decision: "create", title: project, description: d.suggested_description ?? "" }, done: t("suggestion.created", { project }) }) })
    }
    items.push({ label: t("suggestion.choose"), onSelect: () => navigate(`/memory/entities/${d.source_entity_id}`) })
    items.push({ label: t("suggestion.leave"), disabled: busy, onSelect: () => decide.mutate({ operation: "review_project_suggestion", input: { id: item.id, decision: "none" }, done: t("suggestion.left") }) })
    return (
      <Row
        key={item.id}
        lead={<Avatar name={item.source_title} small />}
        title={t("suggestion.title", { title: item.source_title })}
        sub={[kind ? ts(`entity.${kind}`) : undefined, when, detail].filter(Boolean).join(" · ")}
        meta={<Chip tone="warn">{ts("chip.unassigned")}</Chip>}
        action={<DecideMenu label={tc("actions.assign")} items={items} />}
      />
    )
  }

  function factRow(fact: MemoryEntity) {
    const category = oneOf(FACT_CATEGORIES, fact.data.category) ?? "other"
    const text = typeof fact.data.text === "string" && fact.data.text.trim() ? fact.data.text.trim() : fact.title || t("fact.titleFallback")
    const when = relativeTime(fact.updated_at)
    const stale = fact.data.stale === true || fact.data.stale === "true"
    const update = (state: "accepted" | "rejected", done: string) => decide.mutate({ operation: "update_entity", input: { id: fact.id, data: { review_state: state, stale: false } }, done })
    return (
      <Row
        key={fact.id}
        lead={<Avatar name={text} small />}
        title={text}
        sub={stale ? t("fact.detailStale", { when }) : t("fact.detail", { category: t(`fact.category.${category}`), when })}
        meta={<Chip tone="warn">{stale ? ts("chip.sourceChanged") : ts("chip.needsReview")}</Chip>}
        action={<DecideMenu label={tc("actions.review")} items={[
          { label: t("fact.markReviewed"), disabled: busy, onSelect: () => update("accepted", t("fact.reviewed")) },
          { label: t("fact.view"), onSelect: () => navigate(`/memory/entities/${fact.id}`) },
          { label: t("fact.discard"), disabled: busy, onSelect: () => update("rejected", t("fact.discarded")) },
        ]} />}
      />
    )
  }
}

/** Grupo de la bandeja con su cabecera y, si es largo, las primeras filas y «Ver todos». */
export function PendingSection({ label, rows, first, limit = 5 }: { label: string; rows: readonly PendingRow[]; first: boolean; limit?: number }) {
  const { t, plural } = useT("home")
  const [expanded, setExpanded] = useState(false)
  if (rows.length === 0) return null
  const visible = expanded ? rows : rows.slice(0, limit)
  const hidden = rows.length - visible.length
  return <>
    <RowHead style={first ? undefined : { borderTop: "1px solid var(--border)" }}>{label}</RowHead>
    {visible.map(row => row.node)}
    {hidden > 0 && (
      <Row
        title={plural("more", hidden)}
        action={<Button small variant="ghost" onClick={() => setExpanded(true)}>{t("pending.showAll")}</Button>}
      />
    )}
  </>
}
