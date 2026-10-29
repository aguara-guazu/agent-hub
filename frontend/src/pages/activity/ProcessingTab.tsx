import { useCallback, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import {
  Avatar, Button, Chip, Empty, EmptyFiltered, ErrorState, List, Row, RowHead, Seg, Select, SkeletonRows, TabPanel, Tag, useToast,
} from "../../components/ui"
import { useT } from "../../i18n"
import { errorKey } from "../../i18n/errors"
import {
  JOB_KINDS, commitAllCancels, commitCancel, jobProgress, jobTone, scheduleCancel, undoCancel,
  type Job, type JobState, type ProcessingStatus,
} from "../../lib/activity"
import { useMemoryAction, useMemoryPages, useMemoryQuery, type MemoryEntity, type Page } from "../../lib/memory-view"
import { JobPanel } from "./JobPanel"
import { ProposalPanel } from "./ProposalPanel"
import { useJobLabels, useProposalLabels } from "./labels"
import { Bar, Col, useListTime } from "./shared"

type Registry = "jobs" | "identities" | "duplicates"
type JobFilter = "active" | "failed" | "completed" | "cancelled" | "all"
type Review = "accepted" | "rejected"

const JOB_LIMIT = 30
const PROPOSAL_LIMIT = 30
const ROW_MIN = 640

/** Procesamiento · cola de trabajos de la memoria e historial de propuestas ya resueltas (las pendientes viven en Inicio). */
export default function ProcessingTab({ header, counts }: { header: ReactNode; counts?: ProcessingStatus["states"] }) {
  const { t } = useT("activity")
  const [registry, setRegistry] = useState<Registry>("jobs")
  const [selected, setSelected] = useState<string | null>(null)
  const registrySelect = (
    <Select<Registry>
      label={t("registry.label")}
      value={registry}
      onChange={value => { setRegistry(value); setSelected(null) }}
      options={[
        { value: "jobs", label: t("registry.jobs") },
        { value: "identities", label: t("registry.identities") },
        { value: "duplicates", label: t("registry.duplicates") },
      ]}
    />
  )
  if (registry === "jobs") return <Jobs header={header} counts={counts} registrySelect={registrySelect} selected={selected} onSelect={setSelected} />
  return <Proposals key={registry} kind={registry === "identities" ? "identity" : "duplicate"} header={header} registrySelect={registrySelect} selected={selected} onSelect={setSelected} />
}

interface RegistryProps { header: ReactNode; registrySelect: ReactNode; selected: string | null; onSelect: (id: string | null) => void }

function Layout({ header, bar, content, panel }: { header: ReactNode; bar: ReactNode; content: ReactNode; panel: ReactNode }) {
  return (
    <div className="split">
      <div className="page">
        {header}
        <TabPanel idPrefix="activity" value="procesamiento">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
            <Bar>{bar}</Bar>
            {content}
          </div>
        </TabPanel>
      </div>
      {panel}
    </div>
  )
}

function Jobs({ header, counts, registrySelect, selected, onSelect }: RegistryProps & { counts?: ProcessingStatus["states"] }) {
  const { t } = useT("activity")
  const te = useT("errors").t
  const toast = useToast()
  const cache = useQueryClient()
  const labels = useJobLabels()
  const listTime = useListTime()
  const [filter, setFilter] = useState<JobFilter>("active")
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set())
  const state = filter === "all" ? undefined : filter
  const jobs = useMemoryQuery<Page<Job>>("list_jobs", { kind: JOB_KINDS, ...(state ? { state } : {}), limit: JOB_LIMIT, offset: 0 })
  const [extra, setExtra] = useState(0)
  const more = useMemoryQuery<Page<Job>>("list_jobs", { kind: JOB_KINDS, ...(state ? { state } : {}), limit: extra, offset: JOB_LIMIT }, extra > 0)

  const retry = useMemoryAction("retry_job")

  const all = useMemo(() => [...(jobs.data?.items ?? []), ...(more.data?.items ?? [])], [jobs.data, more.data])
  const current = all.find(job => job.id === selected) ?? null
  const total = jobs.data?.total ?? 0
  const count = (key: JobState) => counts?.[key] ?? 0

  const unmark = useCallback((id: string) => setCancelling(set => { const next = new Set(set); next.delete(id); return next }), [])

  // Al salir de la vista, las cancelaciones en espera se envían: nunca se descartan en silencio.
  useEffect(() => () => { void commitAllCancels() }, [])

  function cancel(job: Job) {
    const name = labels.title(job)
    setCancelling(set => new Set(set).add(job.id))
    scheduleCancel(
      job.id,
      error => { unmark(job.id); toast.error(t("jobs.toast.cancelFailed", { name }), te(errorKey(error))) },
      () => { unmark(job.id); void cache.invalidateQueries({ queryKey: ["memory"] }) },
    )
    toast.show({
      message: t("jobs.toast.cancelled", { name }),
      undo: () => { undoCancel(job.id); unmark(job.id) },
      onCommit: () => void commitCancel(job.id),
    })
  }

  function retryJob(job: Job) {
    const name = labels.title(job)
    retry.mutate({ id: job.id }, {
      onSuccess: () => toast.success(t("jobs.toast.retried", { name })),
      onError: error => toast.error(t("jobs.toast.retryFailed", { name }), te(errorKey(error))),
    })
  }

  function clearFilters() { setFilter("active") }

  let content: ReactNode
  if (jobs.isPending) content = <SkeletonRows avatar={false} label={t("jobs.loading")} />
  else if (jobs.error) content = <List><ErrorState error={jobs.error} title={t("jobs.empty.errorTitle")} onRetry={() => void jobs.refetch()} /></List>
  else if (all.length === 0 && filter === "active") content = <List><Empty icon="activity" title={t("jobs.empty.title")} detail={t("jobs.empty.detail")} action={count("failed") > 0 ? <Button small onClick={() => setFilter("failed")}>{t("jobs.empty.action")}</Button> : undefined} /></List>
  else if (all.length === 0) content = <List><EmptyFiltered text={t("jobs.empty.filtered")} onClear={clearFilters} /></List>
  else content = <>
    <List className="scroll-x">
      <RowHead style={{ minWidth: ROW_MIN }}>
        <span style={{ flex: 1 }}>{t("jobs.columns.job")}</span>
        <Col width={150}>{t("jobs.columns.mode")}</Col>
        <Col width={140}>{t("jobs.columns.state")}</Col>
        <Col width={64} right>{t("jobs.columns.progress")}</Col>
        <Col width={80} right>{t("jobs.columns.time")}</Col>
      </RowHead>
      {all.map(job => {
        const marked = cancelling.has(job.id)
        const progress = jobProgress(job)
        const time = listTime(job.progress?.started_at ?? job.created_at)
        const title = labels.title(job)
        return (
          <Row
            key={job.id}
            style={{ minWidth: ROW_MIN }}
            selected={job.id === selected}
            onOpen={() => onSelect(job.id === selected ? null : job.id)}
            title={title}
            sub={job.state === "failed" && job.error ? job.error : labels.stage(job)}
            meta={<>
              <Col width={150}><Tag>{labels.mode(job)}</Tag></Col>
              <Col width={140}><Chip tone={marked ? "off" : jobTone(job)}>{labels.state(job, marked)}</Chip></Col>
              <Col width={64} right className="xs t3 num">{progress && job.state !== "completed" ? `${progress.percent} %` : "—"}</Col>
              <Col width={80} right className="xs t3 num" title={time.title}>{time.text}</Col>
            </>}
          />
        )
      })}
    </List>
    {total > JOB_LIMIT + extra && (
      <div><Button small disabled={more.isFetching} onClick={() => setExtra(value => value + JOB_LIMIT)}>{t("jobs.more")}</Button></div>
    )}
  </>

  const active = count("queued") + count("running") + count("waiting")
  return (
    <Layout
      header={header}
      bar={<>
        {registrySelect}
        <Seg<JobFilter>
          label={t("jobs.filter.label")}
          value={filter}
          onChange={value => { setFilter(value); setExtra(0); onSelect(null) }}
          options={[
            { value: "active", label: t("jobs.filter.active"), count: active },
            { value: "failed", label: t("jobs.filter.failed"), count: count("failed") },
            { value: "completed", label: t("jobs.filter.completed") },
            { value: "cancelled", label: t("jobs.filter.cancelled") },
            { value: "all", label: t("jobs.filter.all") },
          ]}
        />
      </>}
      content={content}
      panel={current && (
        <JobPanel
          key={current.id}
          job={current}
          cancelling={cancelling.has(current.id)}
          retrying={retry.isPending}
          onRetry={() => retryJob(current)}
          onCancel={() => cancel(current)}
          onClose={() => onSelect(null)}
        />
      )}
    />
  )
}

function Proposals({ kind, header, registrySelect, selected, onSelect }: RegistryProps & { kind: "identity" | "duplicate" }) {
  const { t } = useT("activity")
  const navigate = useNavigate()
  const listTime = useListTime()
  const [review, setReview] = useState<Review>("accepted")
  const operation = kind === "identity" ? "list_identity_proposals" : "list_duplicate_proposals"
  const pages = useMemoryPages<MemoryEntity>(operation, { state: review }, PROPOSAL_LIMIT)
  const accepted = useMemoryQuery<Page<MemoryEntity>>(operation, { state: "accepted", limit: 1, offset: 0 })
  const rejected = useMemoryQuery<Page<MemoryEntity>>(operation, { state: "rejected", limit: 1, offset: 0 })
  const all = useMemo(() => pages.data?.pages.flatMap(page => page.items) ?? [], [pages.data])
  const current = all.find(item => item.id === selected) ?? null
  const labels = useProposalLabels(kind)
  const totalReviewed = (accepted.data?.total ?? 0) + (rejected.data?.total ?? 0)

  let content: ReactNode
  if (pages.isPending) content = <SkeletonRows label={t("proposals.loading")} />
  else if (pages.error) content = <List><ErrorState error={pages.error} title={t("proposals.empty.errorTitle")} onRetry={() => void pages.refetch()} /></List>
  else if (all.length === 0 && totalReviewed === 0 && !accepted.isPending && !rejected.isPending) content = (
    <List><Empty icon="person" title={kind === "identity" ? t("proposals.empty.identities") : t("proposals.empty.duplicates")} detail={t("proposals.empty.detail")} action={<Button small onClick={() => navigate("/home")}>{t("proposals.empty.action")}</Button>} /></List>
  )
  else if (all.length === 0) content = <List><EmptyFiltered text={t("proposals.empty.filtered")} onClear={() => setReview(review === "accepted" ? "rejected" : "accepted")} /></List>
  else content = <>
    <List className="scroll-x">
      <RowHead style={{ minWidth: ROW_MIN }}>
        <span style={{ flex: 1 }}>{t("proposals.columns.proposal")}</span>
        <Col width={150}>{t("proposals.columns.resolver")}</Col>
        <Col width={120}>{t("proposals.columns.result")}</Col>
        <Col width={80} right>{t("proposals.columns.time")}</Col>
      </RowHead>
      {all.map(proposal => {
        const time = listTime(proposal.updated_at ?? proposal.created_at)
        const title = labels.title(proposal)
        return (
          <Row
            key={proposal.id}
            style={{ minWidth: ROW_MIN }}
            selected={proposal.id === selected}
            onOpen={() => onSelect(proposal.id === selected ? null : proposal.id)}
            lead={<Avatar name={labels.person(proposal)} round small />}
            title={title}
            sub={labels.outcome(proposal)}
            meta={<>
              <Col width={150} className="xs t2 trunc">{labels.resolver(proposal)}</Col>
              <Col width={120}><Chip tone={proposal.data.review_state === "accepted" ? "ok" : "off"}>{labels.chip(proposal)}</Chip></Col>
              <Col width={80} right className="xs t3 num" title={time.title}>{time.text}</Col>
            </>}
          />
        )
      })}
    </List>
    {pages.hasNextPage && <div><Button small disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>{t("proposals.more")}</Button></div>}
  </>

  return (
    <Layout
      header={header}
      bar={<>
        {registrySelect}
        <Seg<Review>
          label={t("proposals.filter.label")}
          value={review}
          onChange={value => { setReview(value); onSelect(null) }}
          options={[
            { value: "accepted", label: kind === "identity" ? t("proposals.filter.accepted") : t("proposals.filter.acceptedDuplicate"), count: accepted.data?.total },
            { value: "rejected", label: t("proposals.filter.rejected"), count: rejected.data?.total },
          ]}
        />
      </>}
      content={content}
      panel={current && <ProposalPanel key={current.id} kind={kind} proposal={current} onClose={() => onSelect(null)} />}
    />
  )
}
