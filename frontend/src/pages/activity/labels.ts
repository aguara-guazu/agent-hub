import { useFormat, useT } from "../../i18n"
import { jobLocked, jobMode, jobTitle, resolverOf, type Job } from "../../lib/activity"
import type { MemoryEntity } from "../../lib/memory-view"
import { dailyRange, parseBucket, type ConsumptionOrigin, type ConsumptionRange, type ConsumptionUnit, type SummaryRow } from "../../lib/consumption"

/** Título visible del trabajo, traducido cuando no viene de la fuente. */
export function useJobLabels() {
  const { t } = useT("activity")
  return {
    title: (job: Job) => { const title = jobTitle(job); return "text" in title ? title.text : t(`jobs.title.${title.key}`) },
    mode: (job: Job) => { const mode = jobMode(job); return "provider" in mode ? mode.provider : t(`jobs.mode.${mode.key}`) },
    state: (job: Job, cancelling = false) => (cancelling ? t("jobs.state.cancelled") : jobLocked(job) && job.state === "completed" ? t("jobs.state.locked") : t(`jobs.state.${job.state}`)),
    stage: (job: Job) => {
      const stage = job.progress?.stage
      return typeof stage === "string" && stage in STAGES ? t(`jobs.stage.${stage as Stage}`) : t("jobs.stage.waiting")
    },
  }
}

const STAGES = {
  pdf: 1, ocr: 1, transcription: 1, media_decode: 1, media_embeddings: 1, memory_maintenance: 1, identity_inference: 1, project_inference: 1,
  metadata_inference: 1, dedupe_people: 1, preparing: 1, embeddings: 1, extraction: 1, complete: 1, identities: 1, document_speakers: 1, calendar: 1, meet: 1,
} as const
type Stage = keyof typeof STAGES

/** Textos de una propuesta resuelta: quién, cómo y con qué resultado. */
export function useProposalLabels(kind: "identity" | "duplicate") {
  const { t } = useT("activity")
  return {
    title: (proposal: MemoryEntity) => {
      const p = proposal.data
      return kind === "identity"
        ? t("proposals.identityTitle", { name: p.speaker_name ?? "—", email: p.candidate?.email ?? "—" })
        : t("proposals.duplicateTitle", { from: p.from_name ?? "—", into: p.into_name ?? "—" })
    },
    person: (proposal: MemoryEntity) => String((kind === "identity" ? proposal.data.speaker_name : proposal.data.from_name) ?? proposal.title ?? "—"),
    resolver: (proposal: MemoryEntity) => t(`proposals.resolver.${resolverOf(proposal.data.reviewed_by)}`),
    chip: (proposal: MemoryEntity) => {
      const accepted = proposal.data.review_state === "accepted"
      if (kind === "identity") return accepted ? t("proposals.chip.accepted") : t("proposals.chip.rejected")
      return accepted ? t("proposals.chip.acceptedDuplicate") : t("proposals.chip.rejectedDuplicate")
    },
    outcome: (proposal: MemoryEntity) => {
      const resolver = resolverOf(proposal.data.reviewed_by)
      const accepted = proposal.data.review_state === "accepted"
      if (resolver === "merge") return t("proposals.outcome.merge")
      if (resolver === "settled") return t("proposals.outcome.settled")
      if (resolver === "agent") return t("proposals.outcome.agent")
      if (!accepted) return resolver === "ai" ? t("proposals.outcome.rejectedAi") : t("proposals.outcome.rejected")
      if (kind === "identity") return resolver === "ai" ? t("proposals.outcome.identityAcceptedAi") : t("proposals.outcome.identityAccepted")
      return resolver === "ai" ? t("proposals.outcome.duplicateAcceptedAi") : t("proposals.outcome.duplicateAccepted")
    },
  }
}


const CLI_KEYS = ["claude_code", "codex_cli", "kiro"] as const
type CliKey = (typeof CLI_KEYS)[number]

/** Textos y números del consumo: cada CLI en su unidad, el costo en dólares y lo que no se mide como «Sin dato». */
export function useConsumptionLabels() {
  const { t } = useT("activity")
  const format = useFormat()
  const compact = (value: number) => format.number(value, { notation: "compact", maximumFractionDigits: 1 })
  const credits = (value: number) => format.number(value, { maximumFractionDigits: 2 })
  const cli = (kind: string | null) => (kind && (CLI_KEYS as readonly string[]).includes(kind) ? t(`consumption.cli.${kind as CliKey}`) : t("consumption.cli.other"))
  return {
    cli,
    origin: (origin: ConsumptionOrigin) => t(`consumption.origin.${origin}`),
    range: (range: ConsumptionRange) => t(`consumption.range.${range}`),
    granularity: (range: ConsumptionRange) => t(`consumption.granularity.${range === "1y" ? "week" : range === "3y" ? "month" : dailyRange(range) ? "day" : "hour"}`),
    unit: (unit: ConsumptionUnit) => t(`consumption.unit.${unit}`),
    /** Tokens en forma compacta («1,2 M»); créditos con su unidad. */
    amount: (unit: ConsumptionUnit, value: number) => (unit === "credits" ? `${credits(value)} ${t("consumption.unit.credits")}` : compact(value)),
    exact: (value: number) => format.number(value, { maximumFractionDigits: 0 }),
    usage: (row: SummaryRow) => (row.unit === null ? "—" : row.unit === "credits" ? `${credits(row.total)} ${t("consumption.unit.credits")}` : compact(row.total)),
    money: (value: number) => format.number(value, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    /** Sin costo informado en tokens es «Sin precio», nunca cero; con modelos sin precio el monto es parcial. */
    cost: (row: SummaryRow) => {
      if (row.unit !== "tokens") return "—"
      if (row.cost_usd === null) return t("consumption.noPrice")
      const amount = format.number(row.cost_usd, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
      return row.unpriced ? `${amount} · ${t("consumption.partial")}` : amount
    },
    costHint: (row: SummaryRow) => (row.unit === "tokens" && row.cost_usd !== null && row.unpriced ? t("consumption.partialHint") : undefined),
    originCost: (value: number | null) => (value === null ? t("consumption.noPrice") : format.number(value, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })),
    percent: (value: number) => `${format.number(value, { maximumFractionDigits: 0 })} %`,
    /** Inicio de un compartimento (instante ISO) según la granularidad del período: hora, día, semana o mes. */
    bucket: (bucket: string, range: ConsumptionRange, long = false) => {
      const date = parseBucket(bucket)
      if (!date) return "—"
      if (range === "3y") return format.date(date, "month")
      if (range === "1y") return t("consumption.week", { date: format.date(date, long ? "date" : "day") })
      if (dailyRange(range)) return format.date(date, long ? "date" : "day")
      return format.date(date, long ? "datetime" : "time")
    },
    instant: (value: string, range: ConsumptionRange, long = false) => {
      const date = parseBucket(value)
      if (!date) return value
      return format.date(date, dailyRange(range) ? "date" : long ? "datetime" : "time")
    },
  }
}
