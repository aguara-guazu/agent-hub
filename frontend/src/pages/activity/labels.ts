import { useT } from "../../i18n"
import { jobLocked, jobMode, jobTitle, resolverOf, type Job } from "../../lib/activity"
import type { MemoryEntity } from "../../lib/memory-view"

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

