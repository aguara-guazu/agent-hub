import { useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent } from "react"
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { Button, Chip } from "../../components/ui/basics"
import { MoreMenu } from "../../components/ui/actions"
import { ConfirmDialog, Dialog } from "../../components/ui/Dialog"
import { Banner, Empty, ErrorState, List, Loading, TabPanel, Tabs } from "../../components/ui/display"
import { Field, Input, Select } from "../../components/ui/fields"
import type { MenuItem } from "../../components/ui/Menu"
import { useToast } from "../../components/ui/Toast"
import { useFormat, useT } from "../../i18n/useT"
import { isEntityKind, useMemoryAction, useMemoryPages, useMemoryQuery, type EntityDetail, type Fragment, type MemoryEntity, type SourceVersion } from "../../lib/memory-view"
import { Attachment } from "./Attachment"
import { AddColumnDialog, CollectionRecords, CollectionRules, NewRuleDialog, RecordPanel, type CollectionRecord } from "./Collection"
import { EntityAside } from "./EntityAside"
import { EvidenceCard } from "./Evidence"
import { AssignPanel, EditPanel, HistoryPanel } from "./panels"
import { useEntityOptions } from "./pickers"
import { RememberChip, RememberDetails, useRememberActions } from "./Remember"
import { KindTag, LoadMore, MemoryGate } from "./shared"
import { Transcript } from "./Transcript"

type TabValue = "summary" | "content" | "mentions"
type PanelState = { type: "edit" } | { type: "history" } | { type: "assign"; fragment: Fragment } | { type: "record"; record: CollectionRecord | null } | null
type DialogState = "delete" | "merge" | "column" | "rule" | null

const PROPOSAL_CATEGORIES = ["identity_match", "person_duplicate", "project_match"]

export default function EntityPage() {
  const { id } = useParams()
  const { t } = useT("memory")
  return (
    <MemoryGate>
      {id ? <EntityLoader key={id} id={id} /> : <div className="page"><Empty title={t("entity.missing")} /></div>}
    </MemoryGate>
  )
}

function EntityLoader({ id }: { id: string }) {
  const { t } = useT("memory"), navigate = useNavigate()
  const detail = useMemoryQuery<EntityDetail>("get_entity", { id })
  if (detail.isPending) return <div className="page"><Loading label={t("entity.loading")} /></div>
  if (detail.error || !detail.data) {
    return <div className="page"><ErrorState error={detail.error} title={t("entity.loadError")} action={<Button small onClick={() => navigate("/memory")}>{t("entity.backToMemory")}</Button>} /></div>
  }
  // Los proyectos tienen su propia ficha en /projects/:id.
  if (detail.data.entity.kind === "project") return <Navigate to={`/projects/${id}`} replace />
  return <EntityView detail={detail.data} />
}

function EntityView({ detail }: { detail: EntityDetail }) {
  const { t } = useT("memory"), format = useFormat(), toast = useToast(), navigate = useNavigate()
  const { entity, sources, evidence } = detail
  const [params, setParams] = useSearchParams()
  const [panel, setPanel] = useState<PanelState>(null), [dialog, setDialog] = useState<DialogState>(null)
  const source = sources[0]
  const isCollection = entity.kind === "collection", isPerson = entity.kind === "person"
  const hasContent = Boolean(source)
  const tabs = useMemo(() => {
    if (isCollection) return []
    const list: { value: TabValue; label: string }[] = [{ value: "summary", label: t("tab.summary") }]
    if (hasContent) list.push({ value: "content", label: entity.kind === "meeting" ? t("tab.transcript") : t("tab.content") })
    if (isPerson) list.push({ value: "mentions", label: t("tab.mentions") })
    return list
  }, [isCollection, hasContent, isPerson, entity.kind, t])
  const requested = params.get("tab") as TabValue | null
  const tab: TabValue = tabs.some(item => item.value === requested) ? requested! : params.get("fragment") && hasContent ? "content" : "summary"
  const setTab = (value: TabValue) => setParams(current => { const next = new URLSearchParams(current); if (value === "summary") next.delete("tab"); else next.set("tab", value); return next }, { replace: true })
  const versionParam = params.get("version") ?? undefined
  const versionId = versionParam && versionParam !== source?.current_version_id ? versionParam : undefined

  const remove = useMemoryAction("delete_entity", () => { toast.success(t("entity.deleted", { name: entity.title })); navigate("/memory") })
  const reprocess = useMemoryAction("reprocess", () => toast.show({ kind: "info", message: t("entity.reprocessing"), action: { label: t("file.viewActivity"), onClick: () => navigate("/activity?tab=procesamiento") } }))
  const infer = useMemoryAction("infer_identities", () => toast.show({ kind: "info", message: t("entity.inferring"), action: { label: t("entity.goHome"), onClick: () => navigate("/home") } }))
  const rememberItems = useRememberActions(entity)

  const items: MenuItem[] = [
    { label: t("menu.edit"), onSelect: () => setPanel({ type: "edit" }) },
    ...(isCollection ? [{ label: t("collection.addColumnTitle"), onSelect: () => setDialog("column") }, { label: t("rule.newTitle"), onSelect: () => setDialog("rule") }] : []),
    ...rememberItems,
    ...(source?.url ? [{ label: t("menu.openOriginal"), onSelect: () => window.open(source.url!, "_blank", "noopener,noreferrer") }] : []),
    ...(hasContent ? [{ label: t("menu.reprocess"), onSelect: () => reprocess.mutate({ entity_id: entity.id, force: true }), disabled: reprocess.isPending }] : []),
    ...(["meeting", "document"].includes(entity.kind) ? [{ label: t("menu.inferEmails"), onSelect: () => infer.mutate({ entity_id: entity.id }), disabled: infer.isPending }] : []),
    ...(isPerson && !entity.data.merged_into ? [{ label: t("menu.merge"), onSelect: () => setDialog("merge") }] : []),
    { label: t("menu.history"), onSelect: () => setPanel({ type: "history" }) },
    { label: t("menu.delete"), danger: true, onSelect: () => setDialog("delete") },
  ]

  const banner = pageBanner(detail, versionId, t)
  const kindLabel = isEntityKind(entity.kind) ? t(`kindPlural.${entity.kind}`) : t("kind.other")
  const occurred = entity.data.occurred_at ? format.date(entity.data.occurred_at) : null

  return (
    <div className="split">
      <div className="page" style={{ gap: "var(--sp-4)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <nav className="crumbs" aria-label={t("entity.crumbs")}><Link to="/memory">{t("title")}</Link><span aria-hidden="true">/</span><Link to={isEntityKind(entity.kind) ? `/memory?kind=${entity.kind}` : "/memory"}>{kindLabel}</Link></nav>
          <div className="ph" style={{ alignItems: "flex-start" }}>
            <div className="ph-text" style={{ minWidth: 0 }}>
              <InlineTitle entity={entity} />
              <div className="xs t3" style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", flexWrap: "wrap" }}>
                <KindTag kind={entity.kind} />
                {occurred && <span>{occurred}</span>}
                {entity.data.agent_memory && <RememberChip entity={entity} />}
                {isPerson && <Chip tone={entity.data.merged_into ? "off" : entity.data.identity_status === "verified" ? "ok" : "warn"}>{t(`identity.${entity.data.merged_into ? "merged" : entity.data.identity_status === "verified" ? "verified" : "unresolved"}`)}</Chip>}
                {entity.data.stale && <Chip tone="warn">{t("entity.stale")}</Chip>}
                {entity.kind === "fact" && entity.data.review_state && <Chip tone={entity.data.review_state === "accepted" ? "ok" : entity.data.review_state === "rejected" ? "off" : "warn"}>{t(`fact.state.${reviewState(entity.data.review_state)}`)}</Chip>}
              </div>
            </div>
            <div className="ph-actions">
              {isCollection && <Button variant="primary" icon="add" onClick={() => setPanel({ type: "record", record: null })}>{t("record.add")}</Button>}
              <MoreMenu items={items} />
            </div>
          </div>
        </div>
        {banner && <Banner tone="neutral" action={banner.action ? <Button small onClick={() => banner.action!.run(navigate, setParams)}>{banner.action.label}</Button> : undefined}>{banner.text}</Banner>}
        {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={setTab} label={t("entity.sections")} idPrefix="entity" />}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-6)", alignItems: "flex-start" }}>
          <div style={{ flex: "999 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
            {isCollection
              ? <><CollectionRecords entity={entity} onOpen={record => setPanel({ type: "record", record })} /><CollectionRules entity={entity} /></>
              : <TabPanel idPrefix="entity" value={tab}>
                {tab === "summary" && <Summary entity={entity} evidence={evidence} contentLabel={hasContent ? tabs.find(item => item.value === "content")?.label : undefined} onOpenContent={() => setTab("content")} />}
                {tab === "content" && <Content entity={entity} versionId={versionId} onAssign={fragment => setPanel({ type: "assign", fragment })} />}
                {tab === "mentions" && <Mentions person={entity} />}
              </TabPanel>}
          </div>
          <EntityAside detail={detail} versionId={versionId} />
        </div>
      </div>
      {panel?.type === "edit" && <EditPanel key={entity.updated_at} entity={entity} onClose={() => setPanel(null)} />}
      {panel?.type === "history" && <HistoryPanel detail={detail} onClose={() => setPanel(null)} />}
      {panel?.type === "assign" && <AssignPanel key={panel.fragment.id} fragment={panel.fragment} onClose={() => setPanel(null)} />}
      {panel?.type === "record" && <RecordPanel key={panel.record?.id ?? "new"} entity={entity} record={panel.record} onClose={() => setPanel(null)} />}
      {dialog === "column" && <AddColumnDialog entity={entity} onClose={() => setDialog(null)} />}
      {dialog === "rule" && <NewRuleDialog entity={entity} onClose={() => setDialog(null)} />}
      {dialog === "merge" && <MergeDialog person={entity} onClose={() => setDialog(null)} />}
      <ConfirmDialog open={dialog === "delete"} title={t("entity.deleteTitle", { name: entity.title })} message={t("entity.deleteMessage")} confirmLabel={t("entity.deleteConfirm")}
        busy={remove.isPending} onClose={() => setDialog(null)} onConfirm={() => remove.mutate({ id: entity.id })} />
    </div>
  )
}

type Translate = ReturnType<typeof useT<"memory">>["t"]
interface PageBanner { text: string; action?: { label: string; run: (navigate: ReturnType<typeof useNavigate>, setParams: ReturnType<typeof useSearchParams>[1]) => void } }

/** Un solo aviso por vista: elige el caso más relevante. */
function pageBanner(detail: EntityDetail, versionId: string | undefined, t: Translate): PageBanner | null {
  const { entity, sources } = detail
  if (entity.kind === "person" && entity.data.merged_into) return { text: t("banner.merged"), action: { label: t("banner.viewCurrentPerson"), run: navigate => navigate(`/memory/entities/${entity.data.merged_into}`) } }
  if (entity.kind === "fact" && PROPOSAL_CATEGORIES.includes(entity.data.category) && entity.data.review_state !== "accepted" && entity.data.review_state !== "rejected") {
    return { text: t("banner.proposal"), action: { label: t("entity.goHome"), run: navigate => navigate("/home") } }
  }
  const source = sources[0]
  if (source && source.status !== "active") return { text: t(`banner.source.${source.status === "deleted" ? "deleted" : source.status === "archived" ? "archived" : "unavailable"}`) }
  if (versionId) return { text: t("banner.historical"), action: { label: t("banner.viewCurrentVersion"), run: (_navigate, setParams) => setParams(current => { const next = new URLSearchParams(current); next.delete("version"); next.delete("fragment"); return next }, { replace: true }) } }
  return null
}

function reviewState(value: string): "accepted" | "rejected" | "pending" {
  return value === "accepted" || value === "rejected" ? value : "pending"
}

/** Título editable en línea: Enter o perder el foco guarda, Escape cancela. */
function InlineTitle({ entity }: { entity: MemoryEntity }) {
  const { t } = useT("memory"), toast = useToast()
  const [editing, setEditing] = useState(false), [value, setValue] = useState(entity.title)
  const input = useRef<HTMLInputElement>(null)
  const update = useMemoryAction("update_entity", () => toast.success(t("entity.renamed")))
  useEffect(() => { if (!editing) setValue(entity.title) }, [entity.title, editing])
  useEffect(() => { if (editing) input.current?.select() }, [editing])
  const commit = () => {
    setEditing(false)
    const next = value.trim()
    if (next && next !== entity.title) update.mutate({ id: entity.id, title: next, expected_updated_at: entity.updated_at })
    else setValue(entity.title)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); commit() }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setValue(entity.title); setEditing(false) }
  }
  if (editing) return <Input ref={input} aria-label={t("entity.titleLabel")} value={value} maxLength={500} onChange={event => setValue(event.target.value)} onBlur={commit} onKeyDown={onKeyDown} style={{ fontSize: "var(--fs-xl)", fontWeight: 600, height: 40 }} />
  return (
    <h1 className="h1 trunc" title={entity.title} style={{ margin: 0 }}>
      <button type="button" className="trunc" onClick={() => setEditing(true)} aria-label={t("entity.rename", { name: entity.title })}
        style={{ border: 0, background: "transparent", font: "inherit", color: "inherit", padding: "0 var(--sp-1)", margin: "0 calc(-1 * var(--sp-1))", borderRadius: "var(--r-sm)", cursor: "text", maxWidth: "100%", textAlign: "left" }}
        onMouseEnter={event => { event.currentTarget.style.background = "var(--surface-2)" }} onMouseLeave={event => { event.currentTarget.style.background = "transparent" }}>
        {entity.title}
      </button>
    </h1>
  )
}

function Summary({ entity, evidence, contentLabel, onOpenContent }: { entity: MemoryEntity; evidence: Fragment[]; contentLabel?: string; onOpenContent: () => void }) {
  const { t } = useT("memory"), toast = useToast()
  const review = useMemoryAction("update_entity")
  const text: string = entity.data.text && entity.data.text !== entity.data.description ? entity.data.text : ""
  const description: string = entity.data.description ?? ""
  const isFact = entity.kind === "fact" && !PROPOSAL_CATEGORIES.includes(entity.data.category)
  const attendees: { displayName?: string; email?: string; responseStatus?: string }[] = entity.kind === "event" ? entity.data.attendees ?? [] : []
  const setReview = (state: "accepted" | "rejected") => review.mutate({ id: entity.id, data: { review_state: state, stale: false } }, {
    onSuccess: () => toast.show({ message: state === "accepted" ? t("fact.accepted") : t("fact.rejected"), undo: () => review.mutate({ id: entity.id, data: { review_state: entity.data.review_state ?? "pending" } }) }),
  })
  const empty = !description && !text && !evidence.length && !entity.data.agent_memory && !attendees.length && !isFact
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
      {description && <p className="prose t2" style={{ margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{description}</p>}
      {text && <p className="prose" style={{ margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{text}</p>}
      {isFact && entity.data.review_state !== "accepted" && entity.data.review_state !== "rejected" && (
        <div style={{ display: "flex", gap: "var(--sp-2)" }}>
          <Button small disabled={review.isPending} onClick={() => setReview("accepted")}>{t("fact.accept")}</Button>
          <Button small variant="ghost" disabled={review.isPending} onClick={() => setReview("rejected")}>{t("fact.reject")}</Button>
        </div>
      )}
      {entity.data.agent_memory && <RememberDetails entity={entity} />}
      {attendees.length > 0 && (
        <section className="section">
          <div className="section-h"><h2 className="h2">{t("event.attendees")}</h2></div>
          <List>{attendees.map((person, index) => (
            <div key={index} className="row">
              <div className="row-main"><span className="row-title">{person.displayName ?? person.email ?? t("event.unknown")}</span>{person.email && <span className="row-sub">{person.email}</span>}</div>
              <span className="xs t3">{t(`event.response.${responseKey(person.responseStatus)}`)}</span>
            </div>
          ))}</List>
          <span className="hint">{t("event.hint")}</span>
        </section>
      )}
      {evidence.length > 0 && (
        <section className="section">
          <div className="section-h"><h2 className="h2">{t("evidence.title")}</h2></div>
          <List>{evidence.map(fragment => <EvidenceCard key={fragment.id} fragment={fragment} />)}</List>
        </section>
      )}
      {empty && <List><Empty icon="note" title={t("summary.emptyTitle")} detail={t("summary.emptyDetail")} action={contentLabel ? <Button small onClick={onOpenContent}>{t("summary.open", { section: contentLabel.toLowerCase() })}</Button> : undefined} /></List>}
    </div>
  )
}

function responseKey(value: string | undefined): "accepted" | "declined" | "tentative" | "needsAction" {
  return value === "accepted" || value === "declined" || value === "tentative" ? value : "needsAction"
}

function Content({ entity, versionId, onAssign }: { entity: MemoryEntity; versionId: string | undefined; onAssign: (fragment: Fragment) => void }) {
  const [params] = useSearchParams()
  const fragmentId = params.get("fragment") ?? ""
  const versions = useMemoryQuery<SourceVersion[]>("list_versions", { entity_id: entity.id, limit: 100 })
  const focus = useMemoryQuery<Fragment>("get_evidence", { fragment_id: fragmentId }, Boolean(fragmentId))
  const version = versions.data?.find(item => item.id === versionId) ?? versions.data?.[0]
  const file = version?.metadata?.attachment
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
      {version && file && <Attachment key={version.id} version={version.id} file={file} offsetMs={focus.data?.offset_ms ?? undefined} pageNumber={focus.data?.metadata?.page ?? undefined} />}
      <Transcript entity={entity} versionId={versionId} onAssign={onAssign} />
    </div>
  )
}

/** Intervenciones de una persona en todas las fuentes. */
function Mentions({ person }: { person: MemoryEntity }) {
  const { t } = useT("memory")
  const pages = useMemoryPages<Fragment>("search", { query: "", person_id: person.id }, 30)
  const items = pages.data?.pages.flatMap(page => page.items) ?? []
  if (pages.isPending) return <Loading label={t("mentions.loading")} />
  if (pages.error) return <ErrorState error={pages.error} onRetry={() => void pages.refetch()} />
  if (!items.length) return <List><Empty icon="person" title={t("mentions.emptyTitle")} detail={t("mentions.emptyDetail")} /></List>
  return <>
    <List>{items.map(fragment => <EvidenceCard key={fragment.id} fragment={fragment} showKind />)}</List>
    {pages.hasNextPage && <LoadMore loading={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />}
  </>
}

/** Unificar dos identidades de la misma persona: mueve intervenciones y vínculos; no se puede deshacer desde la app. */
function MergeDialog({ person, onClose }: { person: MemoryEntity; onClose: () => void }) {
  const { t } = useT("memory"), { t: common } = useT("common"), toast = useToast(), navigate = useNavigate()
  const { options } = useEntityOptions("person", [person.id])
  const [target, setTarget] = useState("")
  const merge = useMemoryAction<{ person_id: string }>("merge_people", result => { toast.success(t("merge.done")); onClose(); navigate(`/memory/entities/${result.person_id}`) })
  return (
    <Dialog open role="alertdialog" title={t("merge.title", { name: person.title })} onClose={onClose} busy={merge.isPending} initialFocus="[data-merge-cancel]"
      footer={<>
        <Button variant="ghost" data-merge-cancel="" onClick={onClose} disabled={merge.isPending}>{common("actions.cancel")}</Button>
        <Button variant="danger" disabled={!target || merge.isPending} onClick={() => merge.mutate({ from_id: person.id, into_id: target })}>{t("merge.confirm")}</Button>
      </>}>
      <p className="t2" style={{ margin: 0 }}>{t("merge.message")}</p>
      <Field label={t("merge.target")}><Select bare label={t("merge.target")} value={target} options={options} placeholder={t("picker.personPlaceholder")} onChange={setTarget} /></Field>
    </Dialog>
  )
}
