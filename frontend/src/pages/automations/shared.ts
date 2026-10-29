import { useCallback, useMemo } from "react"
import type { ChipTone } from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import { describeError } from "../../components/ui"
import { useMemory, type MemoryEntity, type Page } from "../../lib/memory"
import { decisionErrorCode, isStaleRevision } from "../../lib/automations"
import type { DecisionSummary, Recurrence, RunListItem, RunState, ScheduleView } from "../../lib/automations"

export const RUN_TONES: Record<RunState, ChipTone> = {
  pending: "info", running: "info", deferred: "info", succeeded: "ok", partial: "warn", failed: "danger",
  uncertain: "warn", skipped: "off", cancelled: "off", interrupted: "danger",
}

export const TEMPLATES = ["daily_brief", "daily_close", "project_status", "reminder", "custom_synthesis", "team_health"] as const
export const ARTIFACTS = ["brief", "close", "notice", "status", "report"] as const
export type Artifact = typeof ARTIFACTS[number]
const SKIP_REASONS = ["overlap", "misfire_out_of_grace", "automations_off", "schedule_cancelled", "remote_processing_excluded"] as const
const DEFERRED_REASONS = ["quota", "automations_off", "delivery_unavailable"] as const
const CHANNEL_REASONS = ["not_connected", "scope_missing", "identity_unverified", "identity_is_bot", "tool_off"] as const

const DAY_MS = 24 * 60 * 60 * 1000
/** 2024-01-01 fue lunes: base para los nombres de los días 1 (lunes) a 7 (domingo) según el idioma. */
const MONDAY = Date.UTC(2024, 0, 1, 12)

function includes<T extends string>(list: readonly T[], value: string | null | undefined): value is T {
  return value !== null && value !== undefined && (list as readonly string[]).includes(value)
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Nombres de los días de la semana (1 = lunes) en el idioma activo. */
export function useWeekdays() {
  const { language } = useFormat()
  return useMemo(() => {
    const names = (weekday: "narrow" | "short" | "long") => {
      const format = new Intl.DateTimeFormat(language, { weekday, timeZone: "UTC" })
      return Array.from({ length: 7 }, (_, index) => format.format(new Date(MONDAY + index * DAY_MS)))
    }
    return { narrow: names("narrow"), short: names("short"), long: names("long") }
  }, [language])
}

/** Textos de recurrencia y próxima ejecución, ligados al idioma activo. */
export function useScheduleText() {
  const { t, plural } = useT("automations")
  const format = useFormat()
  const days = useWeekdays()

  const recurrence = useCallback((value: Recurrence): string => {
    if (value.type === "once") return t("recurrence.once", { when: format.date(value.at, "datetime") })
    if (value.type === "interval") {
      return value.minutes % 60 === 0 ? plural("recurrence.everyHours", value.minutes / 60) : plural("recurrence.everyMinutes", value.minutes)
    }
    const selected = value.weekdays ?? [1, 2, 3, 4, 5, 6, 7]
    if (selected.length === 7) return t("recurrence.everyDay", { time: value.time })
    if (selected.join(",") === "1,2,3,4,5") return t("recurrence.weekdays", { time: value.time })
    return t("recurrence.days", { days: format.list(selected.map(day => days.short[day - 1] ?? String(day))), time: value.time })
  }, [t, plural, format, days])

  /** Columna fija de 110 px: «hoy 17:30», «mañana 08:00», «vie 16:00» o «16 oct 08:00». */
  const next = useCallback((iso: string | null, now = Date.now()): string => {
    if (!iso) return "—"
    const at = new Date(iso)
    if (Number.isNaN(at.getTime())) return "—"
    if (at.getTime() < now - 60_000) return t("next.overdue")
    const time = format.date(at, "time")
    const diff = Math.round((startOfDay(at) - startOfDay(new Date(now))) / DAY_MS)
    if (diff === 0) return t("next.today", { time })
    if (diff === 1) return t("next.tomorrow", { time })
    if (diff < 7) return t("next.other", { day: days.short[(at.getDay() + 6) % 7], time })
    return t("next.other", { day: new Intl.DateTimeFormat(format.language, { day: "numeric", month: "short" }).format(at), time })
  }, [t, format, days])

  /** Lo que muestra la columna «Próxima» de una fila. */
  const nextOf = useCallback((schedule: ScheduleView, now = Date.now()): string => {
    if (schedule.state === "paused") return t("next.paused")
    if (schedule.state !== "active") return "—"
    if (schedule.deferred) return t("next.deferred")
    return next(schedule.next_run_at, now)
  }, [t, next])

  const template = useCallback((schedule: Pick<ScheduleView, "template" | "title">): string =>
    includes(TEMPLATES, schedule.template) ? t(`template.${schedule.template}`) : schedule.title, [t])

  const creator = useCallback((schedule: ScheduleView): string => {
    const { kind, label } = schedule.created_by
    if (kind === "agent") return label || t("panel.creator.agent")
    return t(kind === "human" ? "panel.creator.human" : "panel.creator.system")
  }, [t])

  const skipReason = useCallback((value: string | null | undefined): string | null =>
    value ? includes(SKIP_REASONS, value) ? t(`reason.skip.${value}`) : t("reason.other") : null, [t])

  const deferredReason = useCallback((value: string | null | undefined): string | null =>
    value ? includes(DEFERRED_REASONS, value) ? t(`reason.deferred.${value}`) : t("reason.other") : null, [t])

  const channelReason = useCallback((value: string | null | undefined): string =>
    includes(CHANNEL_REASONS, value) ? t(`reason.channel.${value}`) : t("reason.other"), [t])

  const hours = useCallback((seconds: number): string => t("decision.hours", { value: format.number(seconds / 3600, { maximumFractionDigits: 1 }) }), [t, format])

  return { recurrence, next, nextOf, template, creator, skipReason, deferredReason, channelReason, hours }
}

/** Resumen de la decisión de una entrega para una línea de detalle. `null` si el core no la informa. */
export function useDecisionSummary() {
  const { t, plural } = useT("automations")
  return useCallback((decision: DecisionSummary | undefined): string | null => {
    if (!decision) return null
    switch (decision.state) {
      case "none": return t("decision.summary.none")
      case "pending": return plural("decision.summary.pending", decision.total - decision.approved)
      case "dispatching": return t("decision.summary.dispatching", { approved: decision.approved, total: decision.total })
      case "uncertain": return t("decision.summary.uncertain")
      case "expired": return t("decision.summary.expired")
      case "done": return decision.approved === 0 ? t("decision.summary.rejected") : t("decision.summary.done", { approved: decision.approved, total: decision.total })
    }
  }, [t, plural])
}

/** Texto de error para un toast: revisión vieja, código cerrado de la decisión o el genérico de `errors`. */
export function useActionError() {
  const { t } = useT("automations")
  return useCallback((error: unknown): string => {
    if (isStaleRevision(error)) return t("toast.stale")
    const code = decisionErrorCode(error)
    if (code) return t(`decision.errors.${code}`)
    return describeError(error)
  }, [t])
}

/** Nombres de proyecto por id para filas y selectores. */
export function useProjects() {
  const projects = useMemory<Page<MemoryEntity>>("list_entities", { kind: "project", limit: 200 })
  const list = useMemo(() => projects.data?.items ?? [], [projects.data])
  const names = useMemo(() => new Map(list.map(project => [project.id, project.title])), [list])
  return { list, names }
}

export function runWhen(run: Pick<RunListItem, "started_at" | "scheduled_for">): string {
  return run.started_at ?? run.scheduled_for
}
