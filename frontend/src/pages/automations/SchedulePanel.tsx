import { useEffect, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Button, Chip, Dl, Field, Input, List, MoreMenu, Panel, PanelBody, PanelFooter, PanelHeader, Row, SkeletonRows, Switch, useToast } from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import { useRuns, useScheduleActions } from "../../lib/automations"
import type { DeliveryAvailability, DeliveryTarget, ScheduleView } from "../../lib/automations"
import { RUN_TONES, runWhen, useActionError, useDecisionSummary, useScheduleText, useWeekdays } from "./shared"

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const RECENT = "5"

/** Cuándo: días y hora de una recurrencia diaria. Guardado automático; la hora se guarda al salir del campo o con Enter. */
function WhenField({ schedule }: { schedule: ScheduleView }) {
  const { t } = useT("automations")
  const text = useScheduleText()
  const days = useWeekdays()
  const toast = useToast()
  const actionError = useActionError()
  const actions = useScheduleActions()
  const daily = schedule.recurrence.type === "daily" ? schedule.recurrence : null
  const savedTime = daily?.time ?? ""
  const savedDays = daily?.weekdays ?? [1, 2, 3, 4, 5, 6, 7]
  const [time, setTime] = useState(savedTime)
  useEffect(() => { setTime(savedTime) }, [savedTime, schedule.revision])
  const fixed = schedule.human_override.includes("recurrence")

  if (!daily) {
    return (
      <div className="field">
        <span className="label">{t("panel.when")}</span>
        <span>{text.recurrence(schedule.recurrence)}</span>
        <span className="hint">{t("panel.notDaily")}</span>
      </div>
    )
  }

  function save(nextTime: string, nextDays: number[]) {
    actions.reschedule.mutate(
      { id: schedule.id, revision: schedule.revision, recurrence: { type: "daily", time: nextTime, weekdays: nextDays } },
      { onError: error => { setTime(savedTime); toast.error(t("toast.failed"), actionError(error)) } },
    )
  }

  function toggleDay(day: number) {
    const next = savedDays.includes(day) ? savedDays.filter(item => item !== day) : [...savedDays, day].sort((a, b) => a - b)
    if (next.length === 0) { toast.info(t("panel.daysInvalid")); return }
    save(savedTime, next)
  }

  const timeValid = TIME.test(time)
  return (
    <Field label={t("panel.when")} hint={fixed ? t("panel.fixedRecurrence") : undefined} error={timeValid ? undefined : t("panel.timeInvalid")}>
      <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap" }}>
        <div className="seg" role="group" aria-label={t("panel.days")}>
          {days.narrow.map((label, index) => (
            <button
              key={index}
              type="button"
              aria-pressed={savedDays.includes(index + 1)}
              aria-label={days.long[index]}
              title={days.long[index]}
              disabled={actions.reschedule.isPending}
              onClick={() => toggleDay(index + 1)}
            >{label}</button>
          ))}
        </div>
        <Input
          mono
          aria-label={t("panel.time")}
          value={time}
          maxLength={5}
          style={{ width: 76 }}
          disabled={actions.reschedule.isPending}
          onChange={event => setTime(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter") event.currentTarget.blur()
            if (event.key === "Escape") { event.stopPropagation(); setTime(savedTime) }
          }}
          onBlur={() => { if (TIME.test(time) && time !== savedTime) save(time, savedDays) }}
        />
      </div>
    </Field>
  )
}

/** Entregar en: la app siempre; Gmail solo a la cuenta propia y cuando está listo para enviar. */
function DeliveryField({ schedule, availability }: { schedule: ScheduleView; availability: DeliveryAvailability | undefined }) {
  const { t } = useT("automations")
  const text = useScheduleText()
  const toast = useToast()
  const actionError = useActionError()
  const actions = useScheduleActions()
  const allowed = schedule.delivery_allowed?.includes("gmail_self") ?? true
  const gmail = availability?.gmail_self
  const selected = schedule.delivery.includes("gmail_self")
  const pendingValue = actions.delivery.isPending ? actions.delivery.variables?.delivery.includes("gmail_self") : undefined
  const checked = pendingValue ?? selected
  const unavailable = gmail ? !gmail.available : schedule.delivery_unavailable.includes("gmail_self")

  function setGmail(on: boolean) {
    const delivery: DeliveryTarget[] = on ? ["hub_inbox", "app_window", "gmail_self"] : ["hub_inbox", "app_window"]
    actions.delivery.mutate({ id: schedule.id, revision: schedule.revision, delivery }, { onError: error => toast.error(t("toast.failed"), actionError(error)) })
  }

  const fixed = schedule.human_override.includes("delivery")
  return (
    <div className="field">
      <span className="label">{t("panel.deliverTo")}</span>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
        <span style={{ flex: 1 }}>{t("panel.app")}</span>
        <Switch checked disabled label={t("panel.app")} onChange={() => undefined} />
      </div>
      {allowed && (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
          <div className="row-main">
            <span className="trunc" title={gmail?.destination}>{gmail?.destination ? t("panel.gmailTo", { destination: gmail.destination }) : t("panel.gmail")}</span>
            {unavailable && <span className="xs t3">{text.channelReason(gmail?.reason)}</span>}
          </div>
          {unavailable && (
            <Link className="xs" to="/settings?section=fuentes">
              {gmail?.reason === "scope_missing" ? t("panel.gmailAuthorize") : t("panel.gmailConnect")}
            </Link>
          )}
          <Switch checked={checked} disabled={actions.delivery.isPending || (unavailable && !checked)} label={t("panel.gmail")} onChange={setGmail} />
        </div>
      )}
      {(!allowed || fixed) && <span className="hint">{!allowed ? t("panel.appOnly") : t("panel.fixedDelivery")}</span>}
    </div>
  )
}

function RecentRuns({ schedule }: { schedule: ScheduleView }) {
  const { t, plural } = useT("automations")
  const ts = useT("status").t
  const tc = useT("common").t
  const format = useFormat()
  const text = useScheduleText()
  const summary = useDecisionSummary()
  const navigate = useNavigate()
  const runs = useRuns({ schedule_id: schedule.id, limit: RECENT })
  const items = runs.data?.items ?? []
  const open = (runId: string) => navigate(`/automations/deliveries/${encodeURIComponent(runId)}`)
  return (
    <section className="section" style={{ gap: "var(--sp-3)" }}>
      <div className="section-h" style={{ minHeight: 0 }}>
        <span className="label">{t("panel.recent")}</span>
        <Link className="xs" to="/automations?view=history">{t("panel.viewHistory")}</Link>
      </div>
      {runs.isPending ? <SkeletonRows count={2} avatar={false} />
        : runs.error ? <span className="xs t3" role="alert">{t("panel.recentError")}</span>
        : items.length === 0 ? <span className="xs t3">{t("panel.recentEmpty")}</span>
        : (
          <List>
            {items.map(run => {
              const pending = run.decision?.state === "pending"
              const sub = pending ? plural("panel.proposals", run.decision!.total - run.decision!.approved)
                : summary(run.decision) && run.decision?.state !== "none" ? summary(run.decision)
                : text.skipReason(run.skip_reason) ?? text.deferredReason(run.deferred_reason) ?? (run.read_at ? t("panel.read") : t("panel.unread"))
              return (
                <Row
                  key={run.run_id}
                  style={{ minHeight: 46 }}
                  onOpen={() => open(run.run_id)}
                  title={format.date(runWhen(run), "datetime")}
                  sub={sub ?? undefined}
                  action={pending ? <Button small variant="primary" onClick={() => open(run.run_id)}>{tc("actions.review")}</Button> : undefined}
                  meta={pending ? undefined : <Chip tone={RUN_TONES[run.state]}>{ts(`delivery.${run.state}`)}</Chip>}
                />
              )
            })}
          </List>
        )}
    </section>
  )
}

export interface SchedulePanelProps {
  schedule: ScheduleView
  projectName: string | null
  availability: DeliveryAvailability | undefined
  onClose: () => void
  onRunNow: (schedule: ScheduleView) => void
  onDelete: (schedule: ScheduleView) => void
}

/** Panel de una automatización. Guardado automático: horario y canales se aplican al cambiar. */
export function SchedulePanel({ schedule, projectName, availability, onClose, onRunNow, onDelete }: SchedulePanelProps) {
  const { t } = useT("automations")
  const ts = useT("status").t
  const tc = useT("common").t
  const format = useFormat()
  const text = useScheduleText()
  const last = schedule.last_run
  const lastReason = last ? text.skipReason(last.skip_reason) ?? text.deferredReason(last.deferred_reason) : null
  const pausedBy = schedule.state === "paused" && schedule.paused_by
    ? schedule.paused_by === "human" ? t("panel.creator.human") : schedule.paused_by === "system" ? t("panel.creator.system") : t("panel.creator.agent")
    : null
  return (
    <Panel label={t("panel.label")} onClose={onClose}>
      <PanelHeader
        title={schedule.title}
        status={
          <span className="xs t3 trunc" style={{ display: "block" }}>
            {schedule.project_id && projectName
              ? <Link to={`/projects/${encodeURIComponent(schedule.project_id)}`}>{projectName}</Link>
              : t("scope.owner")}
            {" · "}{t("panel.createdBy", { name: text.creator(schedule) })}
          </span>
        }
        actions={<>
          <Button small disabled={schedule.state !== "active"} onClick={() => onRunNow(schedule)}>{tc("actions.runNow")}</Button>
          <MoreMenu small ghost items={[{ label: t("panel.delete"), danger: true, onSelect: () => onDelete(schedule) }]} />
        </>}
      />
      <PanelBody>
        <WhenField schedule={schedule} />
        <DeliveryField schedule={schedule} availability={availability} />
        <hr className="divider" />
        <RecentRuns schedule={schedule} />
        <hr className="divider" />
        <section className="section" style={{ gap: "var(--sp-3)" }}>
          <span className="label">{t("panel.details")}</span>
          <Dl items={[
            { label: t("panel.template"), value: text.template(schedule) },
            { label: t("panel.kind"), value: <span title={t(schedule.kind === "notice" ? "kind.noticeHint" : "kind.synthesisHint")}>{t(`kind.${schedule.kind}`)}</span> },
            { label: t("panel.nextRun"), value: schedule.deferred
              ? t("panel.deferredUntil", { when: schedule.deferred.resets_at ?? schedule.deferred.next_attempt_at ? format.date((schedule.deferred.resets_at ?? schedule.deferred.next_attempt_at)!, "datetime") : "—" })
              : schedule.state === "active" && schedule.next_run_at ? format.date(schedule.next_run_at, "datetime") : null },
            { label: t("panel.lastRun"), value: last
              ? <span style={{ display: "inline-flex", gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap" }}>
                  <Link to={`/automations/deliveries/${encodeURIComponent(last.id)}`}>{format.date(last.scheduled_for, "datetime")}</Link>
                  <Chip tone={RUN_TONES[last.state]} title={lastReason ?? undefined}>{ts(`delivery.${last.state}`)}</Chip>
                </span>
              : null },
            ...(pausedBy ? [{ label: t("panel.pausedBy"), value: pausedBy }] : []),
            { label: t("panel.timezone"), value: <span className="mono xs">{schedule.timezone}</span> },
            { label: t("panel.admission"), value: schedule.admission_note ? <span className="t2">{schedule.admission_note}</span> : null },
          ]} />
        </section>
      </PanelBody>
      <PanelFooter autosave />
    </Panel>
  )
}
