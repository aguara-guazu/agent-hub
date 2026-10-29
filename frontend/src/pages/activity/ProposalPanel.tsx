import { Link } from "react-router-dom"
import { Chip, Dl, Panel, PanelBody, PanelHeader } from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import { resolverOf } from "../../lib/activity"
import type { MemoryEntity } from "../../lib/memory-view"
import { useProposalLabels } from "./labels"

const CONFIDENCE = ["high", "medium", "low"] as const
type Confidence = typeof CONFIDENCE[number]
const isConfidence = (value: unknown): value is Confidence => (CONFIDENCE as readonly unknown[]).includes(value)

/** Propuesta ya resuelta, de solo lectura: quién la resolvió, cuándo, con qué evidencia y enlaces a las fichas.
 *  Resolver o revertir no va acá: las pendientes se deciden en Inicio. */
export function ProposalPanel({ kind, proposal, onClose }: { kind: "identity" | "duplicate"; proposal: MemoryEntity; onClose: () => void }) {
  const { t } = useT("activity")
  const ts = useT("status").t
  const format = useFormat()
  const labels = useProposalLabels(kind)
  const p = proposal.data
  const resolver = resolverOf(p.reviewed_by)
  const technical = resolver === "agent" || resolver === "unknown" ? p.reviewed_by : null

  const links: { to: string; label: string }[] = [{ to: `/memory/entities/${proposal.id}`, label: t("proposals.panel.evidence") }]
  if (kind === "identity") {
    if (p.speaker_id) links.push({ to: `/memory/entities/${p.speaker_id}`, label: t("proposals.panel.speaker") })
    for (const origin of Array.isArray(p.candidate?.origins) ? p.candidate.origins : []) {
      if (origin?.entity_id) links.push({ to: `/memory/entities/${origin.entity_id}`, label: origin.kind === "known_person" ? t("proposals.panel.knownPerson") : t("proposals.panel.calendar") })
    }
  } else {
    if (p.from_id) links.push({ to: `/memory/entities/${p.from_id}`, label: t("proposals.panel.person", { name: p.from_name ?? "—" }) })
    if (p.into_id) links.push({ to: `/memory/entities/${p.into_id}`, label: t("proposals.panel.person", { name: p.into_name ?? "—" }) })
  }

  const noEmail = t("proposals.panel.noEmail")
  return (
    <Panel label={t("proposals.panel.label")} onClose={onClose}>
      <PanelHeader title={labels.title(proposal)} status={<Chip tone={p.review_state === "accepted" ? "ok" : "off"}>{labels.chip(proposal)}</Chip>} />
      <PanelBody>
        <Dl items={[
          { label: t("proposals.panel.outcome"), value: labels.outcome(proposal) },
          { label: t("proposals.panel.resolver"), value: t(`proposals.resolver.${resolver}`) },
          { label: t("proposals.panel.actor"), value: technical ? <span className="mono xs">{String(technical)}</span> : null },
          { label: t("proposals.panel.when"), value: format.date(proposal.updated_at, "datetime") },
          { label: t("proposals.panel.confidence"), value: isConfidence(p.confidence) ? ts(`confidence.${p.confidence}`) : null },
          { label: t("proposals.panel.model"), value: p.model ? <span className="mono xs">{p.model}</span> : null },
          ...(kind === "duplicate" ? [
            { label: t("proposals.panel.basis"), value: p.basis === "same_email" ? t("proposals.panel.sameEmail") : null },
            { label: t("proposals.panel.emails"), value: `${p.from_email ?? noEmail} → ${p.into_email ?? noEmail}` },
            { label: t("proposals.panel.rule"), value: p.applied_rule === "medium_corroborated" ? t("proposals.panel.corroborated") : null },
          ] : []),
        ]} />
        {p.reason && (
          <div className="field">
            <span className="label">{t("proposals.panel.reason")}</span>
            <p className="prose t2" style={{ margin: 0 }}>{p.reason}</p>
          </div>
        )}
        <div className="field">
          <span className="label">{t("proposals.panel.links")}</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
            {links.map(link => <Link key={link.to} className="btn btn-sm" to={link.to}>{link.label}</Link>)}
          </div>
        </div>
      </PanelBody>
    </Panel>
  )
}
