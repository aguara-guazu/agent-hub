import { Link } from "react-router-dom"
import { useT } from "../../i18n/useT"
import { excerpt, fragmentHref, fragmentOffset, type Fragment } from "../../lib/memory-view"
import { Highlight, KindTag, useListDate } from "./shared"

const TAG_COLUMN = { width: 96, flex: "none", display: "flex", justifyContent: "center", alignSelf: "flex-start", marginTop: 1 } as const
export const TALL_ROW = { alignItems: "flex-start", paddingTop: "var(--sp-3)", paddingBottom: "var(--sp-3)" } as const

/** Columna fija del tipo para que los títulos de resultados queden alineados. */
export function KindColumn({ kind }: { kind: string }) {
  return <span style={TAG_COLUMN}><KindTag kind={kind} /></span>
}

/**
 * Fila de evidencia: cita textual de un fragmento con su origen (hablante, minuto o página) y enlace al
 * fragmento dentro de su fuente. `showKind` agrega la columna de tipo (resultados mezclados).
 */
export function EvidenceCard({ fragment, query = "", showKind = false, showTitle = true }: { fragment: Fragment; query?: string; showKind?: boolean; showTitle?: boolean }) {
  const { t } = useT("memory"), listDate = useListDate()
  const date = listDate(fragment.start_time ?? fragment.occurred_at)
  const minute = fragmentOffset(fragment)
  const where = [
    fragment.speaker_name,
    minute ? t("cite.minute", { minute }) : fragment.metadata?.page ? t("cite.page", { page: fragment.metadata.page }) : null,
    fragment.current === false ? t("cite.historical") : null,
  ].filter(Boolean).join(" · ")
  return (
    <Link className="row" to={fragmentHref(fragment)} style={TALL_ROW}>
      {showKind && <KindColumn kind={fragment.kind ?? ""} />}
      <div className="row-main" style={{ gap: "var(--sp-1)" }}>
        {showTitle && <span className="row-title" title={fragment.title}>{fragment.title ?? t("cite.untitled")}</span>}
        <span className="t2 clamp2">{t("cite.open")}<Highlight text={excerpt(fragment.text, query)} query={query} />{t("cite.close")}</span>
        {where && <span className="row-sub">{where}</span>}
      </div>
      {date.title && <div className="row-meta"><span title={date.title}>{date.text}</span></div>}
    </Link>
  )
}
