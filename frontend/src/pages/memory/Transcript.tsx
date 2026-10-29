import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Avatar, Button } from "../../components/ui/basics"
import { EmptyFiltered, ErrorState, Seg, SkeletonRows } from "../../components/ui/display"
import { SearchInput, Select } from "../../components/ui/fields"
import { useToast } from "../../components/ui/Toast"
import { useFormat, useT } from "../../i18n/useT"
import { fragmentOffset, useMemoryPages, useMemoryQuery, type Fragment, type MemoryEntity, type TranscriptPage } from "../../lib/memory-view"
import { Highlight, LoadMore } from "./shared"

const PAGE = 100

/** Fragmentos de la versión elegida: filtro por hablante, búsqueda local y acciones al pasar el cursor o con foco. */
export function Transcript({ entity, versionId, onAssign }: { entity: MemoryEntity; versionId: string | undefined; onAssign: (fragment: Fragment) => void }) {
  const { t } = useT("memory"), { t: common } = useT("common")
  const [params, setParams] = useSearchParams()
  const focusId = params.get("fragment") ?? ""
  const [person, setPerson] = useState(""), [text, setText] = useState("")
  const focus = useMemoryQuery<Fragment>("get_evidence", { fragment_id: focusId }, Boolean(focusId))
  const start = focus.data && !person ? Math.floor(focus.data.ordinal / PAGE) * PAGE : 0
  const ready = !focusId || Boolean(focus.data) || Boolean(focus.error)
  const input = { entity_id: entity.id, ...(versionId ? { version_id: versionId } : {}), ...(person ? { person_id: person } : {}) }
  const pages = useMemoryPages<Fragment>("transcript", input, PAGE, ready, start)
  const items = useMemo(() => pages.data?.pages.flatMap(page => page.items) ?? [], [pages.data])
  const speakers = (pages.data?.pages[0] as TranscriptPage | undefined)?.speakers ?? []
  const query = text.trim().toLowerCase()
  const shown = query ? items.filter(fragment => fragment.text.toLowerCase().includes(query) || (fragment.speaker_name ?? "").toLowerCase().includes(query)) : items

  useEffect(() => {
    if (focusId && items.some(fragment => fragment.id === focusId)) document.getElementById(`fragment-${focusId}`)?.scrollIntoView?.({ block: "center", behavior: "smooth" })
  }, [focusId, items])

  const speakerOptions = speakers.map(speaker => ({ value: speaker.id, label: speaker.title }))
  const firstName = (name: string) => name.split(/\s+/)[0] ?? name
  const cite = (fragment: Fragment) => setParams(current => {
    const next = new URLSearchParams(current)
    next.set("version", fragment.version_id); next.set("fragment", fragment.id)
    return next
  }, { replace: true })

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)", minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }}>
        {speakers.length > 1 && speakers.length <= 4
          ? <Seg label={t("transcript.speaker")} value={person || "all"} onChange={value => setPerson(value === "all" ? "" : value)}
              options={[{ value: "all", label: t("filter.all") }, ...speakers.map(speaker => ({ value: speaker.id, label: firstName(speaker.title) }))]} />
          : speakers.length > 4 && <Select label={t("transcript.speaker")} value={person} placeholder={t("filter.all")} onChange={setPerson} options={[{ value: "", label: t("filter.all") }, ...speakerOptions]} />}
        <div style={{ maxWidth: 260, flex: "1 1 200px" }}>
          <SearchInput label={t("transcript.search")} value={text} onChange={event => setText(event.target.value)} />
        </div>
      </div>
      {pages.isPending || !ready
        ? <SkeletonRows count={4} label={t("transcript.loading")} />
        : pages.error ? <ErrorState error={pages.error} onRetry={() => void pages.refetch()} />
        : !items.length ? <EmptyFiltered text={t("transcript.emptyFilter")} onClear={() => { setPerson(""); setText("") }} />
        : <>
          {pages.hasPreviousPage && <div><Button small disabled={pages.isFetchingPreviousPage} onClick={() => void pages.fetchPreviousPage()}>{t("transcript.previous")}</Button></div>}
          <div style={{ display: "flex", flexDirection: "column" }}>
            {shown.map(fragment => <Utterance key={fragment.id} fragment={fragment} query={text} focused={fragment.id === focusId} onCite={() => cite(fragment)} onAssign={() => onAssign(fragment)} />)}
            {!shown.length && <EmptyFiltered text={t("transcript.noMatch", { query: text.trim() })} onClear={() => setText("")} />}
          </div>
          {pages.hasNextPage && <LoadMore loading={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />}
          {focus.error && <span className="xs t3">{common("error.title")}</span>}
        </>}
    </div>
  )
}

function Utterance({ fragment, query, focused, onCite, onAssign }: { fragment: Fragment; query: string; focused: boolean; onCite: () => void; onAssign: () => void }) {
  const { t, plural } = useT("memory"), format = useFormat(), toast = useToast()
  const [active, setActive] = useState(false)
  const speaker = fragment.speaker_name ?? generatedLabel(fragment, t)
  const time = fragment.start_time ? format.date(fragment.start_time, "time")
    : fragmentOffset(fragment) ?? fragment.metadata?.timestamp_label ?? `#${fragment.ordinal + 1}`
  const copy = () => {
    onCite()
    const quote = `${t("cite.open")}${fragment.text}${t("cite.close")}${fragment.speaker_name ? ` (${fragment.speaker_name}, ${time})` : ""}`
    void navigator.clipboard?.writeText(quote).then(() => toast.success(t("transcript.citeCopied")), () => toast.info(t("transcript.citeMarked")))
  }
  return (
    <article
      id={`fragment-${fragment.id}`}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(false) }}
      style={{ display: "flex", gap: "var(--sp-3)", padding: "var(--sp-3)", margin: "0 calc(-1 * var(--sp-3))", borderRadius: "var(--r)", borderBottom: "1px solid var(--border)",
        background: focused ? "var(--surface-2)" : active ? "var(--surface)" : undefined, boxShadow: focused ? "inset 2px 0 0 var(--accent)" : undefined }}
    >
      <Avatar name={speaker} small round />
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)", minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "baseline", minWidth: 0, flexWrap: "wrap" }}>
          {fragment.speaker_id
            ? <Link to={`/memory/entities/${fragment.speaker_id}`} style={{ fontWeight: 600, color: "var(--text)" }} className="trunc">{speaker}</Link>
            : <span className="t2 trunc">{speaker}</span>}
          <span className="mono t3">{time}</span>
          {Boolean(fragment.project_ids?.length) && <span className="xs t3">{plural("transcript.projects", fragment.project_ids!.length)}</span>}
          <span style={{ marginLeft: "auto", display: "flex", gap: "var(--sp-1)", opacity: active || focused ? 1 : 0 }}>
            <Button small variant="ghost" onClick={copy}>{t("transcript.cite")}</Button>
            <Button small variant="ghost" onClick={onAssign}>{t("transcript.assign")}</Button>
          </span>
        </div>
        <p className="prose" style={{ lineHeight: 1.6, margin: 0, overflowWrap: "anywhere" }}><Highlight text={fragment.text} query={query} /></p>
      </div>
    </article>
  )
}

/** Origen de un fragmento sin hablante: texto de PDF, OCR, transcripción automática o contexto del documento. */
function generatedLabel(fragment: Fragment, t: ReturnType<typeof useT<"memory">>["t"]): string {
  const meta = fragment.metadata ?? {}
  if (meta.generated === "pdf_text") return t("transcript.generated.pdf", { page: meta.page ?? "—" })
  if (meta.generated === "ocr") return t("transcript.generated.ocr")
  if (meta.generated === "transcription") return t("transcript.generated.transcription")
  if (meta.generated === "media") return t("transcript.generated.media")
  if (typeof meta.format === "string" && meta.format.startsWith("google-docs")) return t("transcript.generated.document")
  return t("transcript.generated.unknown")
}
