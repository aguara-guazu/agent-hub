import { useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { Button, Chip, ConfirmDialog, Dl, ErrorState, Input, Kbd, Loading, MoreMenu, Panel, PanelBody, PanelHeader, useToast } from "../../components/ui"
import type { ChipTone } from "../../components/ui"
import { Markdown } from "../../components/Markdown"
import { useFormat, useT } from "../../i18n"
import { ApiError } from "../../lib/api"
import { RETRY_ERROR_CODES, STORE_ITEM_TO_PUBLIC, markRunRead, useDecision, useDecisionActions, useRetryDelivery, useRun } from "../../lib/automations"
import type { DeliveryTarget, DeliveryView, ItemKind, ItemState, PublicItem, RunDetail, RunListItem } from "../../lib/automations"
import { ARTIFACTS, RUN_TONES, runWhen, useActionError, useDayText, useScheduleText } from "./shared"

/** Ítems cuyo efecto no se corrige después: se confirman viendo el efecto exacto. */
const SENSITIVE_KINDS: readonly ItemKind[] = ["git_push", "jira_transition", "jira_comment"]
const RETRYABLE: readonly DeliveryTarget[] = ["gmail_self", "slack_self"]
const CHANNEL_TONES: Record<DeliveryView["state"], ChipTone> = { pending: "info", sending: "info", sent: "ok", failed: "danger", uncertain: "warn", skipped: "off" }
const ITEM_TONES: Record<ItemState, ChipTone> = {
  proposed: "warn", approved: "info", dispatching: "info", succeeded: "ok", rejected: "off", expired: "off", superseded: "off", uncertain: "warn", unverifiable: "warn",
}
const LATE_MINUTES = 10

type GeneratedNote = "manual" | "misfire" | "late" | "notGenerated" | null

/** «Generada»: solo con un disparo especial o un retraso real. */
export function generatedNote(run: Pick<RunListItem, "trigger" | "scheduled_for" | "started_at" | "state">): GeneratedNote {
  if (run.trigger === "run_now") return "manual"
  if (!run.started_at) return run.state === "deferred" ? "notGenerated" : null
  if (run.trigger === "misfire") return "misfire"
  return (Date.parse(run.started_at) - Date.parse(run.scheduled_for)) / 60_000 > LATE_MINUTES ? "late" : null
}

interface MergedItem { ordinal: number; kind: ItemKind; summary: string; state: ItemState; estimate: PublicItem["estimate"] }

function ItemsBlock({ run }: { run: RunDetail }) {
  const { t, plural } = useT("automations")
  const ts = useT("status").t
  const text = useScheduleText()
  const toast = useToast()
  const actionError = useActionError()
  const decision = useDecision(run.run_id, run.has_decision)
  const actions = useDecisionActions(run.run_id)
  const [selected, setSelected] = useState<Set<number> | null>(null)
  const [hours, setHours] = useState<Record<number, string>>({})
  const [confirming, setConfirming] = useState<"approve" | "reject" | null>(null)

  // El estado público del run manda; el del almacén solo corrige un ítem que el run aún marca como propuesto.
  // Un propuesto que la solicitud cargada no contiene no se puede aprobar.
  const stored = new Map((decision.data?.items ?? []).map(item => [item.ordinal, item]))
  const merged: MergedItem[] = run.items.map(item => {
    const live = stored.get(item.ordinal)
    const published = item.state ?? "proposed"
    const unmatched = published === "proposed" && decision.data !== undefined && !live
    const state: ItemState = unmatched ? "unverifiable" : published === "proposed" && live && live.state !== "pending" ? STORE_ITEM_TO_PUBLIC[live.state] : published
    return { ordinal: item.ordinal, kind: live?.kind ?? item.kind, summary: live?.summary ?? item.summary, state, estimate: item.estimate }
  })
  if (merged.length === 0) return null

  const proposed = merged.filter(item => item.state === "proposed")
  const chosen = selected ?? new Set(proposed.map(item => item.ordinal))
  const request = decision.data
  const open = request?.state === "open"
  const verified = request?.authority === "verified"
  const chosenItems = merged.filter(item => chosen.has(item.ordinal) && item.state === "proposed")
  const sensitive = chosenItems.some(item => SENSITIVE_KINDS.includes(item.kind))
  const notice = request && ["locked", "revoked", "superseded"].includes(request.state) ? t(`decision.errors.${request.state as "locked" | "revoked" | "superseded"}`)
    : request?.authority === "authority_unavailable" ? t("decision.errors.authority_unavailable")
    : request?.state === "expired" ? t("decision.errors.expired")
    : null

  function toggle(ordinal: number) {
    const next = new Set(chosen)
    if (next.has(ordinal)) next.delete(ordinal)
    else next.add(ordinal)
    setSelected(next)
  }
  function approve() {
    if (!request) return
    const ordinals = [...chosen].filter(ordinal => proposed.some(item => item.ordinal === ordinal)).sort((a, b) => a - b)
    actions.approve.mutate({ ordinals, digest: request.digest }, {
      onSuccess: () => { setSelected(null); setConfirming(null); toast.success(plural("decision.approved", ordinals.length)) },
      onError: error => { setConfirming(null); toast.error(t("decision.failed"), actionError(error)) },
    })
  }
  function reject() {
    actions.reject.mutate({ ordinals: proposed.map(item => item.ordinal) }, {
      onSuccess: () => { setConfirming(null); toast.success(t("decision.rejected")) },
      onError: error => { setConfirming(null); toast.error(t("decision.failed"), actionError(error)) },
    })
  }
  function revise(ordinal: number) {
    const value = Number((hours[ordinal] ?? "").replace(",", "."))
    if (!(value >= 0.5)) return
    actions.revise.mutate({ ordinal, seconds: Math.round(value * 2) * 1800 }, {
      onSuccess: () => { setSelected(null); setHours({}); toast.info(t("decision.revised"), t("decision.revisedDetail")) },
      onError: error => toast.error(t("decision.failed"), actionError(error)),
    })
  }

  return (
    <section className="section" style={{ gap: "var(--sp-3)" }}>
      <span className="label">{t("decision.title")}</span>
      {notice && <span className="xs" role="status" style={{ color: "var(--warn)" }}>{notice}</span>}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
        {merged.map(item => {
          const mutable = item.state === "proposed" && open
          const estimate = item.estimate
          const details = estimate ? [
            t("decision.estimate", { hours: text.hours(estimate.seconds), confidence: ts(`confidence.${estimate.confidence}`) }),
            t("decision.basis", { basis: estimate.basis }),
            estimate.assumptions?.length ? t("decision.assumptions", { list: estimate.assumptions.join("; ") }) : null,
            estimate.would_change ? t("decision.wouldChange", { text: estimate.would_change }) : null,
            estimate.approved_seconds !== undefined ? t("decision.approvedHours", { hours: text.hours(estimate.approved_seconds) }) : null,
            estimate.sent_seconds !== undefined ? t("decision.sentHours", { hours: text.hours(estimate.sent_seconds) }) : null,
          ].filter(Boolean).join(" · ") : undefined
          // Lo que alcanza para decidir en la línea; el detalle completo de la estimación queda en el título.
          const hint = estimate
            ? [t("decision.estimatedInline", { hours: text.hours(estimate.seconds) }), estimate.assumptions?.[0]].filter(Boolean).join(" · ")
            : ts(`item.${item.kind}`)
          const revisable = mutable && item.kind === "jira_worklog"
          return (
            <div key={item.ordinal} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
              <label style={{ display: "flex", gap: "var(--sp-3)", alignItems: "flex-start", cursor: mutable ? "pointer" : undefined }} title={details}>
                <input
                  className="check"
                  type="checkbox"
                  aria-label={t("decision.select", { ordinal: item.ordinal })}
                  style={{ marginTop: "var(--sp-1)" }}
                  disabled={!mutable}
                  checked={mutable && chosen.has(item.ordinal)}
                  onChange={() => toggle(item.ordinal)}
                />
                <span style={{ minWidth: 0, flex: 1 }}>
                  {item.summary} <span className="t3 xs">· {hint}</span>
                </span>
                {item.state !== "proposed" && <Chip tone={ITEM_TONES[item.state]}>{ts(`itemState.${item.state}`)}</Chip>}
              </label>
              {revisable && (
                <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", paddingLeft: "calc(var(--sp-4) + var(--sp-3))" }}>
                  <Input
                    mono
                    inputMode="decimal"
                    aria-label={t("decision.reviseLabel", { ordinal: item.ordinal })}
                    style={{ width: 76 }}
                    value={hours[item.ordinal] ?? ""}
                    onChange={event => setHours(current => ({ ...current, [item.ordinal]: event.target.value }))}
                    onKeyDown={event => { if (event.key === "Enter") revise(item.ordinal) }}
                  />
                  <Button small variant="ghost" disabled={actions.revise.isPending || !(Number((hours[item.ordinal] ?? "").replace(",", ".")) >= 0.5)} onClick={() => revise(item.ordinal)}>{t("decision.revise")}</Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {open && request && (
        <>
          <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
            <Button small variant="primary" disabled={actions.approve.isPending || chosenItems.length === 0 || !verified} onClick={() => (sensitive ? setConfirming("approve") : approve())}>
              {chosenItems.length > 0 ? plural("decision.approveCount", chosenItems.length) : t("decision.approve")}
            </Button>
            <Button small variant="ghost" disabled={actions.reject.isPending || proposed.length === 0} onClick={() => setConfirming("reject")}>{t("decision.rejectAll")}</Button>
          </div>
          {merged.some(item => item.kind === "jira_worklog") && <span className="hint">{t("decision.reviseHint")}</span>}
          <span className="hint">{t("decision.codeHint")}</span>
        </>
      )}
      {request?.state === "expired" && (
        <Button style={{ alignSelf: "flex-start" }} disabled={actions.repropose.isPending} onClick={() => actions.repropose.mutate(undefined, {
          onSuccess: () => toast.success(t("decision.reproposed")),
          onError: error => toast.error(t("decision.failed"), actionError(error)),
        })}>{t("decision.repropose")}</Button>
      )}
      <ConfirmDialog
        open={confirming === "approve"}
        title={t("decision.confirmApproveTitle")}
        destructive={false}
        busy={actions.approve.isPending}
        confirmLabel={t("decision.confirmApproveAction")}
        onClose={() => setConfirming(null)}
        onConfirm={approve}
        message={<>
          <p className="t2">{t("decision.confirmApprove")}</p>
          <ul style={{ margin: 0, paddingLeft: "var(--sp-5)", display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
            {chosenItems.map(item => <li key={item.ordinal}><b>{ts(`item.${item.kind}`)}</b>: {item.summary}</li>)}
          </ul>
        </>}
      />
      <ConfirmDialog
        open={confirming === "reject"}
        title={t("decision.confirmRejectTitle")}
        busy={actions.reject.isPending}
        confirmLabel={t("decision.confirmRejectAction")}
        onClose={() => setConfirming(null)}
        onConfirm={reject}
        message={plural("decision.confirmReject", proposed.length)}
      />
    </section>
  )
}

/** Canales de la entrega con su estado; los fallidos o inciertos de Gmail y Slack se pueden reintentar. */
function Channels({ run }: { run: RunDetail }) {
  const { t } = useT("automations")
  const ts = useT("status").t
  const toast = useToast()
  const retry = useRetryDelivery(run.run_id)
  const [asking, setAsking] = useState<DeliveryView | null>(null)
  const channels = (run.deliveries ?? []).filter(item => item.target !== "hub_inbox")
  if (channels.length === 0) return null

  function send(item: DeliveryView) {
    if (!item.id) return
    retry.mutate(item.id, {
      onSuccess: result => {
        setAsking(null)
        if (result.state === "sent") toast.success(t("delivery.retried"), result.may_duplicate ? t("delivery.retriedMaybeTwice") : undefined)
        else toast.info(t("delivery.retryPending", { state: t(`delivery.channelState.${result.state}`) }))
      },
      onError: error => {
        setAsking(null)
        const code = error instanceof ApiError ? error.code : undefined
        const known = (RETRY_ERROR_CODES as readonly string[]).includes(code ?? "") ? code as typeof RETRY_ERROR_CODES[number] : null
        toast.error(t("delivery.retryFailed"), known ? t(`delivery.retryErrors.${known}`) : undefined)
      },
    })
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      {channels.map(item => {
        const label = ts(`deliveryTarget.${item.target}`)
        const retryable = Boolean(item.id) && RETRYABLE.includes(item.target) && (item.state === "failed" || item.state === "uncertain")
        return (
          <div key={item.target} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap" }}>
            <span className="trunc">{label}</span>
            <Chip tone={CHANNEL_TONES[item.state]} title={item.error_code ?? undefined}>{t(`delivery.channelState.${item.state}`)}</Chip>
            {retryable && (
              <Button small variant="ghost" disabled={retry.isPending} onClick={() => (item.state === "uncertain" ? setAsking(item) : send(item))}>
                {t("delivery.retry")}
              </Button>
            )}
          </div>
        )
      })}
      <ConfirmDialog
        open={asking !== null}
        title={t("delivery.retryUncertainTitle", { channel: asking ? ts(`deliveryTarget.${asking.target}`) : "" })}
        destructive={false}
        busy={retry.isPending}
        confirmLabel={t("delivery.retryConfirm")}
        message={t("delivery.retryUncertain")}
        onClose={() => setAsking(null)}
        onConfirm={() => asking && send(asking)}
      />
    </div>
  )
}

export interface DeliveryPanelProps {
  runId: string
  projectName: (id: string | null) => string | null
  onClose: () => void
  /** Entrega anterior de la lista visible (K); sin valor, el botón queda deshabilitado. */
  onPrevious?: (() => void) | undefined
  /** Siguiente entrega sin ver de la lista visible (J). */
  onNextUnread?: (() => void) | undefined
  onMarkUnread: (run: RunDetail) => void
}

/** Detalle de una entrega (`/automations/deliveries/:runId`): resumen, acciones propuestas, canales y navegación J/K. */
export function DeliveryPanel({ runId, projectName, onClose, onPrevious, onNextUnread, onMarkUnread }: DeliveryPanelProps) {
  const { t } = useT("automations")
  const ts = useT("status").t
  const format = useFormat()
  const days = useDayText()
  const cache = useQueryClient()
  const navigate = useNavigate()
  const run = useRun(runId)
  // Una sola vez por apertura: «Marcar como no vista» no debe deshacerse sola con el siguiente refresco.
  const marked = useRef(false)
  const unread = run.data !== undefined && run.data.read_at === null
  useEffect(() => {
    if (!unread || marked.current) return
    marked.current = true
    void markRunRead(runId).then(() => cache.invalidateQueries({ queryKey: ["schedule-runs"] })).catch(() => { marked.current = false })
  }, [unread, runId, cache])

  const data = run.data
  const note = data ? generatedNote(data) : null
  const project = data ? projectName(data.project_id) : null
  const inApp = data?.deliveries?.some(item => item.target === "hub_inbox" && item.state === "sent") ?? false
  const title = data ? t("delivery.titleAt", { title: data.title, when: days.when(runWhen(data)) }) : t("delivery.label")
  return (
    <Panel label={data?.title ?? t("delivery.label")} onClose={onClose} wide>
      <PanelHeader
        title={title}
        status={data && (
          <span className="xs t3 trunc" style={{ display: "block" }}>
            {data.project_id && project ? <Link to={`/projects/${encodeURIComponent(data.project_id)}`}>{project}</Link> : t("scope.owner")}
            {" · "}{inApp ? t("delivery.inApp") : ts(`delivery.${data.state}`)}
          </span>
        )}
        actions={data && <MoreMenu small ghost items={[
          { label: t("delivery.markUnread"), onSelect: () => onMarkUnread(data) },
          { label: t("delivery.viewAutomation"), onSelect: () => navigate(`/automations?focus=${encodeURIComponent(data.schedule_id)}`) },
        ]} />}
      />
      <PanelBody>
        {run.isPending ? <Loading />
          : run.error || !data ? <ErrorState error={run.error} title={t("delivery.errorTitle")} onRetry={() => void run.refetch()} />
          : <>
              <section className="section" style={{ gap: "var(--sp-2)" }}>
                <span className="label">{t("delivery.summary")}</span>
                {data.body_md.trim() ? <div className="prose t2"><Markdown source={data.body_md} /></div> : <span className="t3">{t("delivery.emptyBody")}</span>}
              </section>
              <ItemsBlock run={data} />
              {data.incidents?.map(incident => <span key={incident.observed_at} className="xs" style={{ color: "var(--warn)" }}>{t("delivery.incident", { action: incident.action })}</span>)}
              <hr className="divider" />
              <section className="section" style={{ gap: "var(--sp-3)" }}>
                <span className="label">{t("panel.details")}</span>
                <Dl items={[
                  { label: t("delivery.state"), value: <Chip tone={RUN_TONES[data.state]}>{ts(`delivery.${data.state}`)}</Chip> },
                  ...(data.artifact_kind && (ARTIFACTS as readonly string[]).includes(data.artifact_kind) ? [{ label: t("panel.kind"), value: t(`artifact.${data.artifact_kind}`) }] : []),
                  { label: t("delivery.scheduled"), value: format.date(data.scheduled_for, "datetime") },
                  { label: t("delivery.generated"), value: data.started_at || note
                    ? [data.started_at ? format.date(data.started_at, "datetime") : null, note ? t(`delivery.${note}`) : null].filter(Boolean).join(" · ")
                    : null },
                  ...((data.deliveries ?? []).some(item => item.target !== "hub_inbox") ? [{ label: t("delivery.channels"), value: <Channels run={data} /> }] : []),
                ]} />
              </section>
            </>}
      </PanelBody>
      <div className="panel-f" style={{ justifyContent: "space-between" }}>
        <Button small variant="ghost" disabled={!onPrevious} onClick={onPrevious} aria-keyshortcuts="K">{t("history.previous")} <Kbd>K</Kbd></Button>
        <Button small disabled={!onNextUnread} onClick={onNextUnread} aria-keyshortcuts="J">{t("history.nextUnread")} <Kbd>J</Kbd></Button>
      </div>
    </Panel>
  )
}
