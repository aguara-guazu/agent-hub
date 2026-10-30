import { useMemo, useState } from "react"
import type { ReactNode } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Avatar, IconButton } from "../../components/ui/basics"
import { Dl, type DlItem } from "../../components/ui/display"
import { Combobox, Select } from "../../components/ui/fields"
import type { Option } from "../../components/ui/fields"
import { useToast } from "../../components/ui/Toast"
import { useFormat, useT } from "../../i18n/useT"
import { entityHref, isEntityKind, useMemoryAction, useMemoryQuery, type EntityDetail, type EntityLink, type MemoryEntity, type Page, type SourceVersion, type TranscriptPage } from "../../lib/memory-view"
import { EntityCombobox } from "./pickers"
import { KindTag } from "./shared"

const RELATIONS = ["related", "participant", "meeting_document", "derived_from", "company"] as const
type Relation = typeof RELATIONS[number]

function Section({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-h" style={{ minHeight: 0 }}><h2 className="h3">{title}</h2>{meta && <span className="xs t3">{meta}</span>}</div>
      {children}
    </section>
  )
}

/** Vínculo con X para quitarlo; quitar es reversible con Deshacer. */
function LinkLine({ link, lead, onRemove }: { link: EntityLink; lead?: ReactNode; onRemove: () => void }) {
  const { t } = useT("memory")
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", minWidth: 0 }}>
      {lead}
      <Link to={entityHref(link.entity)} className="trunc" style={{ flex: 1, color: "var(--text)" }} title={link.entity.title}>{link.entity.title}</Link>
      <IconButton icon="close" small variant="ghost" label={t("links.remove", { name: link.entity.title })} onClick={onRemove} />
    </div>
  )
}

export function EntityAside({ detail, versionId }: { detail: EntityDetail; versionId: string | undefined }) {
  const { t, plural } = useT("memory"), { t: status } = useT("status"), format = useFormat(), toast = useToast()
  const [, setParams] = useSearchParams()
  const { entity, links, sources } = detail
  const source = sources[0]
  const versions = useMemoryQuery<SourceVersion[]>("list_versions", { entity_id: entity.id, limit: 100 }, Boolean(source))
  const speakers = useMemoryQuery<TranscriptPage>("transcript", { entity_id: entity.id, ...(versionId ? { version_id: versionId } : {}), limit: 1 }, Boolean(source))
  const link = useMemoryAction("link_entities")
  const unlink = useMemoryAction("unlink_entities")
  const remove = (item: EntityLink) => unlink.mutate({ id: item.id }, {
    onSuccess: () => toast.show({ message: t("links.removed", { name: item.entity.title }), undo: () => link.mutate({ from_id: item.from_id, to_id: item.to_id, type: item.type }) }),
  })
  const add = (to: string, type: string) => link.mutate({ from_id: entity.id, to_id: to, type })

  const projects = links.filter(item => item.type === "project" || item.entity.kind === "project")
  const people = links.filter(item => item.entity.kind === "person" && !projects.includes(item))
  const derived = links.filter(item => item.type === "derived_from" && !projects.includes(item) && !people.includes(item))
  const others = links.filter(item => !projects.includes(item) && !people.includes(item) && !derived.includes(item))
  const linked = links.map(item => item.entity.id)

  const versionList = versions.data ?? []
  const current = versionId ?? source?.current_version_id
  const versionIndex = versionList.findIndex(version => version.id === current)
  const versionOptions = versionList.map((version, index) => ({
    value: version.id,
    label: t("details.versionOption", { n: versionList.length - index, total: versionList.length, date: format.date(version.created_at, "date") }) + (version.id === source?.current_version_id ? ` · ${t("details.current")}` : ""),
  }))
  const items: DlItem[] = [
    ...(entity.data.occurred_at ? [{ label: t("details.date"), value: format.date(entity.data.occurred_at) }] : []),
    ...(source ? [{ label: t("details.source"), value: t(`provider.${providerKey(source.provider)}`) }] : []),
    ...(source && versionList.length > 1 ? [{ label: t("details.version"), value: <Select bare label={t("details.version")} value={current ?? ""} options={versionOptions}
      onChange={id => setParams(params => { const next = new URLSearchParams(params); if (id === source.current_version_id) next.delete("version"); else next.set("version", id); next.delete("fragment"); return next }, { replace: true })} /> }]
      : source ? [{ label: t("details.version"), value: t("details.single") }] : []),
    ...(versionIndex >= 0 ? [{ label: t("details.processed"), value: format.date(versionList[versionIndex]!.created_at) }] : []),
    ...(entity.data.timezone ? [{ label: t("details.timezone"), value: entity.data.timezone }] : []),
    ...(entity.kind === "person" ? [{ label: t("field.email"), value: entity.data.email ? <span className="trunc" title={entity.data.email}>{entity.data.email}</span> : t(`emailStatus.${emailStatus(entity.data.email_status)}`) }] : []),
    { label: t("details.updated"), value: format.date(entity.updated_at) },
  ]
  const speakerList = speakers.data?.speakers ?? []
  const identified = speakerList.filter(speaker => speaker.email).length

  return (
    <aside style={{ flex: "1 1 280px", maxWidth: 340, minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
      <Section title={t("details.title")}><Dl items={items} /></Section>
      {speakerList.length > 0 && <>
        <hr className="divider" />
        <Section title={t("speakers.title")} meta={t("speakers.identified", { count: identified, total: speakerList.length })}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
            {speakerList.map(speaker => (
              <Link key={speaker.id} to={`/memory/entities/${speaker.id}`} style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", color: "var(--text)", minWidth: 0 }}>
                <Avatar name={speaker.title} small round />
                <div className="row-main">
                  <span className="trunc">{speaker.title}</span>
                  <span className="xs t3 trunc">{speaker.email ?? t(`emailStatus.${emailStatus(speaker.email_status)}`)}</span>
                </div>
              </Link>
            ))}
          </div>
        </Section>
      </>}
      <hr className="divider" />
      <Section title={t("links.projects")}>
        {projects.map(item => <LinkLine key={item.id} link={item} lead={<Avatar name={item.entity.title} small />} onRemove={() => remove(item)} />)}
        <EntityCombobox key={`p-${projects.length}`} kind="project" value="" exclude={linked} label={t("links.addProject")} placeholder={t("links.addProject")} onChange={id => add(id, "project")} />
      </Section>
      {entity.kind !== "person" && <>
        <hr className="divider" />
        <Section title={t("links.people")}>
          {people.map(item => <LinkLine key={item.id} link={item} lead={<Avatar name={item.entity.title} small round />} onRemove={() => remove(item)} />)}
          <EntityCombobox key={`h-${people.length}`} kind="person" value="" exclude={linked} label={t("links.addPerson")} placeholder={t("links.addPerson")} onChange={id => add(id, "participant")} />
        </Section>
      </>}
      {derived.length > 0 && <>
        <hr className="divider" />
        <Section title={entity.kind === "meeting" ? t("links.derivedMeeting") : t("links.derived")}>
          {derived.map(item => <LinkLine key={item.id} link={item} lead={<KindTag kind={item.entity.kind} />} onRemove={() => remove(item)} />)}
        </Section>
      </>}
      <hr className="divider" />
      <Section title={t("links.others")} meta={others.length ? plural("links.count", others.length) : undefined}>
        {others.map(item => (
          <div key={item.id} style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <LinkLine link={item} lead={<KindTag kind={item.entity.kind} />} onRemove={() => remove(item)} />
            <span className="xs t3">{relationLabel(item.type, status)}</span>
          </div>
        ))}
        <AddConnection entity={entity} exclude={linked} onAdd={add} />
      </Section>
    </aside>
  )
}

function relationLabel(type: string, status: ReturnType<typeof useT<"status">>["t"]): string {
  const known = ["related", "project", "company", "belongs_to", "participant", "meeting_document", "derived_from"] as const
  return (known as readonly string[]).includes(type) ? status(`relation.${type as typeof known[number]}`) : type.replace(/_/g, " ")
}

/** Vincular con cualquier entidad: combobox de búsqueda + tipo de relación. */
function AddConnection({ entity, exclude, onAdd }: { entity: MemoryEntity; exclude: string[]; onAdd: (to: string, type: string) => void }) {
  const { t } = useT("memory"), { t: status } = useT("status")
  const [relation, setRelation] = useState<Relation>(["meeting", "document"].includes(entity.kind) ? "meeting_document" : "related")
  const list = useMemoryQuery<Page<MemoryEntity>>("list_entities", { limit: 200 })
  const options = useMemo<Option[]>(() => (list.data?.items ?? [])
    .filter(item => item.id !== entity.id && !exclude.includes(item.id) && item.kind !== "project")
    .map(item => ({ value: item.id, label: item.title, detail: isEntityKind(item.kind) ? t(`kind.${item.kind}`) : undefined })), [list.data, exclude, entity.id, t])
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <Select label={t("links.relation")} value={relation} onChange={setRelation} options={RELATIONS.map(value => ({ value, label: status(`relation.${value}`) }))} />
      <Combobox key={exclude.length} value="" options={options} label={t("links.addOther")} placeholder={t("links.addOther")} onChange={id => onAdd(id, relation)} />
    </div>
  )
}

const PROVIDERS = ["manual", "google", "notion", "slack", "jira"] as const
function providerKey(provider: string): typeof PROVIDERS[number] | "other" {
  return (PROVIDERS as readonly string[]).includes(provider) ? provider as typeof PROVIDERS[number] : "other"
}

const EMAIL_STATUS = ["permission_required", "ambiguous", "missing"] as const
function emailStatus(value: string | null | undefined): typeof EMAIL_STATUS[number] {
  return (EMAIL_STATUS as readonly string[]).includes(value ?? "") ? value as typeof EMAIL_STATUS[number] : "missing"
}
