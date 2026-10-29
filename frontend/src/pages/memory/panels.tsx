import { useState } from "react"
import { Button, IconButton } from "../../components/ui/basics"
import { Dl } from "../../components/ui/display"
import { Field, Input, Select, Textarea } from "../../components/ui/fields"
import { Panel, PanelBody, PanelFooter, PanelHeader } from "../../components/ui/Panel"
import { useToast } from "../../components/ui/Toast"
import { useFormat, useT } from "../../i18n/useT"
import { useMemoryAction, type EntityDetail, type Fragment, type MemoryEntity } from "../../lib/memory-view"
import { EntityCombobox, useEntityOptions } from "./pickers"

/** Lista de proyectos elegidos, cada uno con X, más un combobox para agregar o crear. */
function ProjectList({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useT("memory")
  const { items } = useEntityOptions("project")
  const [adding, setAdding] = useState("")
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      {value.map(id => {
        const name = items.find(item => item.id === id)?.title ?? t("assign.unknownProject")
        return (
          <div key={id} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", minWidth: 0 }}>
            <span className="trunc" style={{ flex: 1 }} title={name}>{name}</span>
            <IconButton icon="close" small variant="ghost" label={t("assign.removeProject", { name })} onClick={() => onChange(value.filter(item => item !== id))} />
          </div>
        )
      })}
      <EntityCombobox key={value.length} kind="project" value={adding} exclude={value} label={t("assign.addProject")} placeholder={t("picker.projectPlaceholder")}
        onChange={id => { setAdding(""); if (!value.includes(id)) onChange([...value, id]) }} />
    </div>
  )
}

/** Corregir el contexto de un fragmento: proyectos y hablante. Guardado explícito. */
export function AssignPanel({ fragment, onClose }: { fragment: Fragment; onClose: () => void }) {
  const { t } = useT("memory"), toast = useToast()
  const initialProjects = fragment.project_ids ?? [], initialPerson = fragment.speaker_id ?? ""
  const [projects, setProjects] = useState<string[]>(initialProjects), [person, setPerson] = useState(initialPerson), [warn, setWarn] = useState(false)
  const dirty = person !== initialPerson || projects.length !== initialProjects.length || projects.some(id => !initialProjects.includes(id))
  const save = useMemoryAction("assign_fragment", () => { toast.success(t("assign.saved")); onClose() })
  return (
    <Panel label={t("assign.title")} onClose={onClose} dirty={dirty} onBlockedClose={() => setWarn(true)}>
      <PanelHeader title={t("assign.title")} />
      <PanelBody>
        <blockquote className="prose t2" style={{ margin: 0, paddingLeft: "var(--sp-3)", borderLeft: "1px solid var(--border-strong)" }}>{fragment.text}</blockquote>
        <Field label={t("assign.projects")}><ProjectList value={projects} onChange={setProjects} /></Field>
        <Field label={t("assign.speaker")} hint={t("assign.speakerHint")}>
          <EntityCombobox kind="person" value={person} onChange={setPerson} label={t("assign.speaker")} placeholder={t("picker.personPlaceholder")} />
        </Field>
        {person && <div><Button small variant="ghost" onClick={() => setPerson("")}>{t("assign.clearSpeaker")}</Button></div>}
      </PanelBody>
      <PanelFooter dirty={dirty} saving={save.isPending} warning={warn}
        onDiscard={() => { setProjects(initialProjects); setPerson(initialPerson); setWarn(false) }}
        onSave={() => save.mutate({ fragment_id: fragment.id, project_ids: projects, person_id: person || null })} />
    </Panel>
  )
}

const IDENTITY = ["unresolved", "verified"] as const

/** Editar los detalles de la entidad (nombre, descripción, contenido, email, identidad, extracción remota). Guardado explícito. */
export function EditPanel({ entity, onClose }: { entity: MemoryEntity; onClose: () => void }) {
  const { t } = useT("memory"), toast = useToast()
  const [expected] = useState(entity.updated_at)
  const initial = {
    title: entity.title, description: entity.data.description ?? "", text: entity.data.text ?? "", email: entity.data.email ?? "",
    identity: entity.data.identity_status === "verified" ? "verified" : "unresolved", remote: entity.data.remote_processing !== false ? "yes" : "no",
    extra: JSON.stringify(entity.data, null, 2),
  }
  const [form, setForm] = useState(initial), [warn, setWarn] = useState(false), [jsonError, setJsonError] = useState(false)
  const set = (patch: Partial<typeof initial>) => setForm(current => ({ ...current, ...patch }))
  const dirty = (Object.keys(initial) as (keyof typeof initial)[]).some(key => form[key] !== initial[key])
  const save = useMemoryAction("update_entity", () => { toast.success(t("edit.saved")); onClose() })
  const isPerson = entity.kind === "person", hasText = ["note", "fact"].includes(entity.kind)
  const canRemote = ["meeting", "document", "message", "issue", "note"].includes(entity.kind)
  const submit = () => {
    let extra: Record<string, unknown>
    try { extra = JSON.parse(form.extra) } catch { setJsonError(true); return }
    setJsonError(false)
    save.mutate({ id: entity.id, expected_updated_at: expected, title: form.title.trim(), data: {
      ...extra, description: form.description,
      ...(canRemote ? { remote_processing: form.remote === "yes" } : {}),
      ...(isPerson ? { email: form.email.trim() || null, identity_status: entity.data.identity_status === "merged" ? "merged" : form.identity, identity_verified: form.identity === "verified" } : {}),
      ...(hasText && form.text ? { text: form.text } : {}),
    } })
  }
  return (
    <Panel label={t("edit.title")} onClose={onClose} wide dirty={dirty} onBlockedClose={() => setWarn(true)}>
      <PanelHeader title={t("edit.title")} />
      <PanelBody>
        <Field label={t("field.name")} error={form.title.trim() ? undefined : t("edit.nameRequired")}><Input value={form.title} maxLength={500} onChange={event => set({ title: event.target.value })} /></Field>
        <Field label={t("field.description")}><Textarea rows={3} value={form.description} onChange={event => set({ description: event.target.value })} /></Field>
        {hasText && <Field label={t("field.content")}><Textarea rows={6} value={form.text} onChange={event => set({ text: event.target.value })} /></Field>}
        {isPerson && <>
          <Field label={t("field.email")}><Input type="email" value={form.email} onChange={event => set({ email: event.target.value })} /></Field>
          <Field label={t("edit.identity")}>
            <Select bare label={t("edit.identity")} value={form.identity as typeof IDENTITY[number]} onChange={identity => set({ identity })} options={IDENTITY.map(value => ({ value, label: t(`identity.${value}`) }))} />
          </Field>
        </>}
        {canRemote && <Field label={t("edit.remote")} hint={t("edit.remoteHint")}>
          <Select bare label={t("edit.remote")} value={form.remote as "yes" | "no"} onChange={remote => set({ remote })} options={[{ value: "yes", label: t("edit.remoteYes") }, { value: "no", label: t("edit.remoteNo") }]} />
        </Field>}
        <details>
          <summary className="xs t3" style={{ cursor: "pointer" }}>{t("edit.advanced")}</summary>
          <div style={{ marginTop: "var(--sp-3)" }}>
            <Field label={t("edit.extra")} error={jsonError ? t("edit.jsonInvalid") : undefined}><Textarea mono rows={10} value={form.extra} onChange={event => set({ extra: event.target.value })} /></Field>
          </div>
        </details>
      </PanelBody>
      <PanelFooter dirty={dirty && Boolean(form.title.trim())} saving={save.isPending} warning={warn} onDiscard={() => { setForm(initial); setWarn(false); setJsonError(false) }} onSave={submit} />
    </Panel>
  )
}

/** Historial de cambios y datos técnicos de la entidad, de solo lectura. */
export function HistoryPanel({ detail, onClose }: { detail: EntityDetail; onClose: () => void }) {
  const { t } = useT("memory"), format = useFormat()
  const known = ["created", "updated", "linked", "unlinked", "imported", "identity_proposed", "identity_confirmed", "identity_reviewed", "duplicate_proposed", "duplicate_reviewed", "person_merged", "person_merged_into", "company_associated", "project_reviewed", "memory_archive", "memory_restore", "memory_pin", "memory_unpin"] as const
  const actionLabel = (action: string) => {
    const key = action.replace(".", "_")
    return (known as readonly string[]).includes(key) ? t(`history.action.${key as typeof known[number]}`) : action
  }
  const source = detail.sources[0]
  return (
    <Panel label={t("history.title")} onClose={onClose} wide>
      <PanelHeader title={t("history.title")} />
      <PanelBody>
        {detail.changes.length
          ? <div className="list">{detail.changes.map(change => (
            <div key={change.id} className="row">
              <div className="row-main">
                <span className="row-title">{actionLabel(change.action)}</span>
                <span className="row-sub mono">{change.actor}</span>
              </div>
              <span className="xs t3">{format.date(change.created_at)}</span>
            </div>
          ))}</div>
          : <span className="t3">{t("history.empty")}</span>}
        <section className="section">
          <h3 className="h3">{t("history.technical")}</h3>
          <Dl items={[
            { label: t("history.id"), value: <span className="mono">{detail.entity.id}</span> },
            { label: t("history.created"), value: format.date(detail.entity.created_at) },
            { label: t("history.updated"), value: format.date(detail.entity.updated_at) },
            ...(source ? [{ label: t("history.externalId"), value: <span className="mono trunc" title={source.external_id}>{source.external_id}</span> }] : []),
          ]} />
          <div className="scroll-x card card-pad"><pre className="mono xs" style={{ margin: 0 }}>{JSON.stringify(detail.entity.data, null, 2)}</pre></div>
        </section>
      </PanelBody>
    </Panel>
  )
}
