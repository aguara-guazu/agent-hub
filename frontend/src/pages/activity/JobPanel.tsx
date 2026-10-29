import { useState } from "react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { useMutation } from "@tanstack/react-query"
import { Button, Chip, Dl, Field, Panel, PanelBody, PanelHeader, Textarea, useToast } from "../../components/ui"
import type { DlItem } from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import { errorKey } from "../../i18n/errors"
import { api } from "../../lib/api"
import { PROVIDERS, canRetry, isActive, jobElapsed, jobLocked, jobMode, jobProgress, jobTone, redactText, type Job } from "../../lib/activity"
import { useJobLabels } from "./labels"
import { CodeBox, useDuration } from "./shared"

interface Props {
  job: Job
  cancelling: boolean
  retrying: boolean
  onRetry: () => void
  onCancel: () => void
  onClose: () => void
}

/** Detalle de un trabajo: avance por etapa, avisos y acciones de reintento, cancelación y reporte. Sin guardado. */
export function JobPanel({ job, cancelling, retrying, onRetry, onCancel, onClose }: Props) {
  const { t, plural } = useT("activity")
  const format = useFormat()
  const duration = useDuration()
  const labels = useJobLabels()
  const p = job.progress ?? {}
  const n = (value: unknown) => (typeof value === "number" ? value : Number(value ?? 0) || 0)
  const progress = jobProgress(job)
  const elapsed = jobElapsed(job)
  const title = labels.title(job)
  const mode = jobMode(job)
  const showModel = Boolean(p.model) && "provider" in mode && Object.values(PROVIDERS).includes(mode.provider)

  const items: DlItem[] = [
    { label: t("jobs.panel.mode"), value: labels.mode(job) },
    { label: t("jobs.panel.model"), value: showModel ? <span className="mono xs">{p.model}</span> : null },
    { label: t("jobs.panel.stage"), value: labels.stage(job) },
    { label: t("jobs.panel.started"), value: format.date(p.started_at ?? job.created_at, "datetime") },
    { label: t("jobs.panel.elapsed"), value: elapsed !== null ? duration(elapsed * 1000) : null },
    { label: t("jobs.panel.attempts"), value: t("jobs.panel.attemptsValue", { done: job.attempts, max: job.max_attempts }) },
  ]
  // Dos datos de la misma etiqueta (p. ej. lotes y lote retomado) comparten fila: Dl usa la etiqueta como key.
  const add = (when: unknown, label: string, value: ReactNode) => {
    if (!when) return
    const existing = items.find(item => item.label === label)
    if (existing) existing.value = <>{existing.value}{" · "}{value}</>
    else items.push({ label, value })
  }
  add(progress && job.state !== "completed", t("jobs.panel.progress"), progress && t("jobs.panel.progressValue", progress))
  add(p.identity_only || job.payload?.identity_only, t("jobs.panel.scope"), t("jobs.panel.scopeIdentity"))
  add(p.projects_only || job.payload?.projects_only, t("jobs.panel.scope"), t("jobs.panel.scopeProjects"))
  add(PROJECT_RESULTS.includes(p.project_inference), t("jobs.panel.project"), PROJECT_RESULTS.includes(p.project_inference) && t(`jobs.panel.projectResult.${p.project_inference as ProjectResult}`))
  add(n(p.total_batches) > 0, t("jobs.panel.batches"), job.state === "running" && p.current_batch
    ? t("jobs.panel.currentBatch", { done: n(p.batch), total: n(p.total_batches), current: n(p.current_batch) })
    : t("jobs.panel.batchesValue", { done: n(p.batch), total: n(p.total_batches) }))
  add(n(p.resumed_batches) > 0, t("jobs.panel.batches"), t("jobs.panel.resumed", { batch: n(p.resumed_batches) + 1 }))
  add(n(p.identity_batches) > 0, t("jobs.panel.identityBatches"), t("jobs.panel.identityValue", { done: n(p.identity_batch), total: n(p.identity_batches), suggestions: n(p.identity_suggestions) }))
  add(n(p.identity_auto_applied) > 0, t("jobs.panel.identityApplied"), format.number(n(p.identity_auto_applied)))
  add(p.media_seconds !== undefined, t("jobs.panel.audio"), t("jobs.panel.audioValue", { done: Math.floor(n(p.media_seconds)), total: Math.ceil(n(p.media_duration_seconds)) }))
  add(p.media_page !== undefined, t("jobs.panel.pdf"), t("jobs.panel.pdfPage", { page: n(p.media_page), pages: n(p.media_pages) }))
  add(n(p.pdf_pages) > 0, t("jobs.panel.pdf"), t("jobs.panel.pdfParts", { pages: n(p.pdf_pages), parts: n(p.pdf_text_parts) }))
  add(p.media_frame !== undefined, t("jobs.panel.video"), t("jobs.panel.videoValue", { done: n(p.media_frame), total: n(p.media_frames) }))
  add(p.generated_parts !== undefined, t("jobs.panel.media"), t("jobs.panel.mediaValue", { ocr: n(p.ocr_parts), transcription: n(p.transcription_parts), embeddings: n(p.media_embeddings) }))
  add(p.processed_fragments !== undefined, t("jobs.panel.fragments"), t("jobs.panel.fragmentsValue", { done: n(p.processed_fragments), total: n(p.total_fragments) }))
  add(p.memories_reviewed !== undefined, t("jobs.panel.memories"), t("jobs.panel.memoriesValue", {
    done: n(p.memories_reviewed), total: n(p.memories_total ?? p.memories_reviewed), archived: n(p.memories_archived), duplicates: n(p.memory_duplicates), vectors: n(p.historical_vectors_removed),
  }))
  add(p.identities_total !== undefined, t("jobs.panel.identities"), t("jobs.panel.identitiesValue", { done: n(p.identities_completed), total: n(p.identities_total), emails: n(p.emails_resolved) }))
  add(p.documents_total !== undefined, t("jobs.panel.documents"), t("jobs.panel.documentsValue", { done: n(p.documents_completed), total: n(p.documents_total) }))
  add(p.dedupe_email_groups !== undefined, t("jobs.panel.emailDedupe"), [
    t("jobs.panel.emailDedupeValue", { merged: n(p.dedupe_email_merged), conflicts: n(p.dedupe_email_conflicts), applied: n(p.dedupe_identities_applied) }),
    n(p.dedupe_labels_merged) > 0 ? t("jobs.panel.labelsMerged", { count: n(p.dedupe_labels_merged) }) : "",
  ].filter(Boolean).join(" · "))
  add(p.dedupe_pairs !== undefined, t("jobs.panel.aiDedupe"), t("jobs.panel.aiDedupeValue", {
    done: n(p.dedupe_batch), batches: n(p.dedupe_batches), pairs: n(p.dedupe_pairs), merged: n(p.dedupe_auto_merged), proposals: n(p.dedupe_proposals), different: n(p.dedupe_different),
  }))
  add(p.input_tokens !== undefined || p.output_tokens !== undefined, t("jobs.panel.tokens"), <span title={t("jobs.panel.tokensHint")}>{t("jobs.panel.tokensValue", { input: n(p.input_tokens), output: n(p.output_tokens), extracted: n(p.extracted) })}</span>)

  const warnings: string[] = []
  if (p.provider_retry && job.state === "running") {
    const at = p.provider_retry_at ? format.date(p.provider_retry_at, "time") : "—"
    warnings.push(t("jobs.panel.providerRetry", { error: redactText(String(p.provider_error ?? "")), retry: n(p.provider_retry), retries: n(p.provider_retries), at }))
  }
  if (n(p.identity_rejected) > 0) warnings.push(plural("jobs.panel.identityRejected", n(p.identity_rejected)))
  if (n(p.extraction_rejected) > 0) warnings.push(plural("jobs.panel.extractionRejected", n(p.extraction_rejected)))
  for (const text of [p.identity_warning, p.document_error, ...(Array.isArray(p.media_warnings) ? p.media_warnings : [])]) {
    if (typeof text === "string" && text) warnings.push(redactText(text))
  }
  const related: { first_id: string; second_id: string; first_title: string; second_title: string }[] = Array.isArray(p.related_memories) ? p.related_memories : []
  const sourceHref = job.entity_id ? `/memory/entities/${job.entity_id}${job.payload?.version_id ? `?version=${job.payload.version_id}` : ""}` : null

  return (
    <Panel label={t("jobs.panel.label")} onClose={onClose}>
      <PanelHeader title={title} status={<Chip tone={cancelling ? "off" : jobTone(job)}>{labels.state(job, cancelling)}</Chip>} />
      <PanelBody>
        {(sourceHref || canRetry(job) || (isActive(job) && !cancelling)) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
            {canRetry(job) && <Button small disabled={retrying} onClick={onRetry}>{t("jobs.panel.retry")}</Button>}
            {isActive(job) && !cancelling && <Button small onClick={onCancel}>{t("jobs.panel.cancel")}</Button>}
            {sourceHref && <Link className="btn btn-sm" to={sourceHref}>{t("jobs.panel.openSource")}</Link>}
          </div>
        )}
        {job.state === "failed" && job.error && (
          <div className="field">
            <span className="label">{t("jobs.panel.error")}</span>
            <CodeBox tone="danger">{redactText(job.error)}</CodeBox>
          </div>
        )}
        {jobLocked(job) && <Chip tone="locked">{t("jobs.panel.locked")}</Chip>}
        <Dl items={items} />
        {warnings.length > 0 && (
          <div className="field">
            <span className="label">{t("jobs.panel.warnings")}</span>
            {warnings.map(text => <span key={text} className="xs" style={{ color: "var(--warn)" }}>{text}</span>)}
          </div>
        )}
        {related.length > 0 && (
          <div className="field">
            <span className="label">{t("jobs.panel.related")}</span>
            {related.map(pair => (
              <span key={`${pair.first_id}:${pair.second_id}`} className="xs">
                <Link to={`/memory/entities/${pair.first_id}`}>{pair.first_title}</Link>{" · "}<Link to={`/memory/entities/${pair.second_id}`}>{pair.second_title}</Link>
              </span>
            ))}
          </div>
        )}
        {job.state === "failed" && <Report id={job.id} />}
      </PanelBody>
    </Panel>
  )
}

const PROJECT_RESULTS: readonly unknown[] = ["auto_assigned", "suggested", "no_project"]
type ProjectResult = "auto_assigned" | "suggested" | "no_project"

/** El reporte se pide primero; abrir el issue queda como gesto de la persona para que el navegador no lo bloquee. */
function Report({ id }: { id: string }) {
  const { t } = useT("activity")
  const te = useT("errors").t
  const toast = useToast()
  const [ready, setReady] = useState<{ text: string; url: string } | null>(null)
  const report = useMutation({
    mutationFn: () => api.get<{ text: string; url: string }>(`/memory/jobs/${id}/report`),
    onSuccess: setReady,
    onError: error => toast.error(t("jobs.report.failed"), te(errorKey(error))),
  })
  async function copy() {
    try {
      await navigator.clipboard.writeText(ready!.text)
      toast.success(t("jobs.report.copied"))
    } catch {
      toast.error(t("jobs.report.copyFailed"))
    }
  }
  if (!ready) return <div><Button small disabled={report.isPending} onClick={() => report.mutate()}>{t("jobs.panel.report")}</Button></div>
  return (
    <Field label={t("jobs.report.title")} hint={t("jobs.report.hint")}>
      <Textarea mono readOnly rows={10} value={ready.text} aria-label={t("jobs.report.text")} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
        <Button small onClick={() => void copy()}>{t("jobs.report.copy")}</Button>
        <a className="btn btn-sm" href={ready.url} target="_blank" rel="noopener noreferrer">{t("jobs.report.open")}</a>
      </div>
    </Field>
  )
}
