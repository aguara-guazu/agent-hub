import { useState } from "react"
import { Link } from "react-router-dom"
import {
  Avatar, Button, Combobox, Field, IconButton, Input, List, Panel, PanelBody, PanelFooter, PanelHeader, Select, Switch, Textarea, useToast,
} from "../../components/ui"
import { useFormat, useT } from "../../i18n"
import { entityPath, memoryCall, useMemory, type MemoryEntity, type Page } from "../../lib/memory"
import { RELATION_CHOICES, STAGE_CHOICES, isRelation, projectStage, type Relation, type Stage } from "../../lib/projects"
import { ProjectAutomationPanel } from "../automations/ProjectAutomationPanel"
import { CompanyCombobox, companyPayload, type CompanyChoice } from "../projects/CompanyCombobox"
import { useErrorText, useKindLabel, useMemoryAction } from "./shared"

/** Vínculo tal como lo devuelve `get_entity`: la fila de `links` con la entidad del otro extremo. */
export interface EntityLink { id: string; from_id: string; to_id: string; type: string; created_at: string; entity: MemoryEntity }
export interface ProjectDetail { entity: MemoryEntity; links: EntityLink[]; changes: { id: number | string; action: string; actor: string; created_at: string }[] }

interface Draft { title: string; description: string; warnings?: string[]; coverage?: { sampled_sources: number; available_sources: number }; sources?: { id: string; href: string; title: string }[] }

/** `draft_profile`: genera sin guardar; la persona decide si lo usa. */
function DraftBlock({ projectId, kind, onUse }: { projectId: string; kind: "project" | "company"; onUse: (draft: Draft) => void }) {
  const { t } = useT("project")
  const errorText = useErrorText()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function generate() {
    setBusy(true); setError("")
    try { setDraft(await memoryCall<Draft>("draft_profile", { project_id: projectId, kind })) }
    catch (failure) { setError(errorText(failure)) }
    finally { setBusy(false) }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <Button small variant="ghost" icon="sparkles" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => void generate()}>
        {busy ? t("header.details.drafting") : t("header.details.draft")}
      </Button>
      {error && <span className="xs" role="alert" style={{ color: "var(--danger)" }}>{error}</span>}
      {draft && (
        <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <span className="label">{t("header.details.draftLabel")}</span>
          {kind === "company" && draft.title && <span className="h3">{draft.title}</span>}
          <p className="t2 prose" style={{ whiteSpace: "pre-wrap" }}>{draft.description}</p>
          {draft.coverage && <span className="xs t3">{t("header.details.draftCoverage", { sampled: draft.coverage.sampled_sources, available: draft.coverage.available_sources })}</span>}
          {draft.warnings?.map(warning => <span key={warning} className="xs t3">{warning}</span>)}
          {!!draft.sources?.length && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
              {draft.sources.slice(0, 5).map(source => <Link key={source.id} className="xs trunc" to={source.href} title={source.title}>{source.title}</Link>)}
            </div>
          )}
          <Button small style={{ alignSelf: "flex-start" }} disabled={!draft.description.trim()} onClick={() => { onUse(draft); setDraft(null) }}>{t("header.details.draftUse")}</Button>
        </div>
      )}
    </div>
  )
}

type Remote = "allowed" | "blocked"
const EDITABLE_KEYS = ["description", "status", "folders", "remote_processing", "company_id"]

/** Editar detalles: guardado explícito. La empresa se guarda con `save_project_company` después de `update_entity`. */
export function DetailsPanel({ project, onClose }: { project: MemoryEntity; onClose: () => void }) {
  const { t } = useT("project")
  const status = useT("status").t
  const toast = useToast()
  const errorText = useErrorText()
  const common = useT("common").t
  // Base fija al abrir: si el proyecto cambia mientras se edita, `expected_updated_at` devuelve 409 en lugar de pisar el cambio ajeno.
  const [baseUpdatedAt] = useState(project.updated_at)
  const [initial] = useState(() => {
    const extra = Object.fromEntries(Object.entries(project.data).filter(([key]) => !EDITABLE_KEYS.includes(key)))
    return {
      description: typeof project.data.description === "string" ? project.data.description : "",
      stage: projectStage(project),
      folders: Array.isArray(project.data.folders) ? project.data.folders.join("\n") : "",
      remote: (project.data.remote_processing === false ? "blocked" : "allowed") as Remote,
      company: { id: typeof project.data.company_id === "string" ? project.data.company_id : "", newName: "" } as CompanyChoice,
      extra: JSON.stringify(extra, null, 2),
    }
  })
  const [description, setDescription] = useState(initial.description)
  const [stage, setStage] = useState<Stage>(initial.stage)
  const [folders, setFolders] = useState(initial.folders)
  const [remote, setRemote] = useState<Remote>(initial.remote)
  const [company, setCompany] = useState<CompanyChoice>(initial.company)
  const [companyDescription, setCompanyDescription] = useState("")
  const [extra, setExtra] = useState(initial.extra)
  const [saving, setSaving] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState("")
  const companyChanged = company.id !== initial.company.id || Boolean(company.newName)
  const fieldsChanged = description !== initial.description || stage !== initial.stage || folders !== initial.folders || remote !== initial.remote || extra !== initial.extra
  const dirty = fieldsChanged || companyChanged
  let parsedExtra: Record<string, unknown> | null = null
  try { const value = JSON.parse(extra); parsedExtra = value && typeof value === "object" && !Array.isArray(value) ? value : null } catch { parsedExtra = null }

  function discard() {
    setDescription(initial.description); setStage(initial.stage); setFolders(initial.folders); setRemote(initial.remote)
    setCompany(initial.company); setCompanyDescription(""); setExtra(initial.extra); setError(""); setBlocked(false)
  }
  async function save() {
    if (!dirty || saving || !parsedExtra) return
    setSaving(true); setError("")
    try {
      let updatedAt = baseUpdatedAt
      if (fieldsChanged) {
        const data = {
          ...(extra !== initial.extra ? parsedExtra : {}),
          description: description.trim(),
          status: stage,
          folders: folders.split("\n").map(folder => folder.trim()).filter(Boolean),
          remote_processing: remote === "allowed",
        }
        const updated = await memoryCall<MemoryEntity>("update_entity", { id: project.id, expected_updated_at: updatedAt, data })
        updatedAt = updated.updated_at
      }
      const payload = companyChanged ? companyPayload(company, companyDescription) : null
      if (payload) await memoryCall("save_project_company", { project_id: project.id, expected_updated_at: updatedAt, ...payload })
      toast.success(common("states.saved"))
      onClose()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel label={t("header.details.title")} onClose={onClose} wide dirty={dirty} onBlockedClose={() => setBlocked(true)}>
      <PanelHeader title={t("header.details.title")} status={<span className="xs t3 trunc" title={project.title}>{project.title}</span>} />
      <PanelBody>
        <Field label={t("header.details.description")}>
          <Textarea rows={6} maxLength={4000} value={description} onChange={event => setDescription(event.target.value)} />
        </Field>
        <DraftBlock projectId={project.id} kind="project" onUse={draft => setDescription(draft.description)} />
        <Field label={t("header.details.company")} hint={company.newName ? t("header.details.companyNew", { name: company.newName }) : undefined}>
          <CompanyCombobox value={company} onChange={setCompany} placeholder={t("header.details.companyPlaceholder")} disabled={saving} />
        </Field>
        {company.newName && <>
          <Field label={t("header.details.companyDescription")}>
            <Textarea rows={3} maxLength={4000} value={companyDescription} onChange={event => setCompanyDescription(event.target.value)} />
          </Field>
          <DraftBlock projectId={project.id} kind="company" onUse={draft => { setCompanyDescription(draft.description); if (draft.title) setCompany({ id: "", newName: draft.title }) }} />
        </>}
        <Field label={t("header.details.stage")}>
          <Select bare label={t("header.details.stage")} value={stage} onChange={setStage} options={STAGE_CHOICES.map(value => ({ value, label: status(`stage.${value}`) }))} />
        </Field>
        <Field label={t("header.details.folders")} hint={t("header.details.foldersHint")}>
          <Textarea mono rows={3} value={folders} onChange={event => setFolders(event.target.value)} />
        </Field>
        <Field label={t("header.details.remote")} hint={t("header.details.remoteHint")}>
          <Select<Remote> bare label={t("header.details.remote")} value={remote} onChange={setRemote}
            options={[{ value: "allowed", label: t("header.aside.remoteAllowed") }, { value: "blocked", label: t("header.aside.remoteBlocked") }]} />
        </Field>
        <details>
          <summary className="xs t2" style={{ cursor: "pointer" }}>{t("header.details.advanced")}</summary>
          <div style={{ marginTop: "var(--sp-3)" }}>
            <Field label={t("header.details.extra")} error={parsedExtra ? undefined : t("header.details.invalidJson")}>
              <Textarea mono rows={10} value={extra} onChange={event => setExtra(event.target.value)} />
            </Field>
          </div>
        </details>
        {error && <p className="xs" role="alert" style={{ color: "var(--danger)" }}>{error}</p>}
      </PanelBody>
      <PanelFooter dirty={dirty && Boolean(parsedExtra)} saving={saving} warning={blocked && dirty} onDiscard={discard} onSave={() => void save()} />
    </Panel>
  )
}

/** Vincular: agregar y quitar vínculos al instante (guardado automático); quitar ofrece Deshacer. */
export function LinkPanel({ project, links, onClose }: { project: MemoryEntity; links: readonly EntityLink[]; onClose: () => void }) {
  const { t } = useT("project")
  const status = useT("status").t
  const toast = useToast()
  const kindLabel = useKindLabel()
  const [target, setTarget] = useState("")
  const [relation, setRelation] = useState<Relation>("related")
  const choices = useMemory<Page<MemoryEntity>>("list_entities", { limit: 200, offset: 0 })
  const link = useMemoryAction("link_entities")
  const unlink = useMemoryAction("unlink_entities")
  const own = links.filter(item => item.type !== "project" || item.from_id === project.id)
  const options = (choices.data?.items ?? []).filter(item => item.id !== project.id).map(item => ({ value: item.id, label: item.title, detail: kindLabel(item), avatar: item.title, round: item.kind === "person" }))
  const relationLabel = (type: string) => isRelation(type) ? status(`relation.${type}`) : type
  function add() {
    const entity = choices.data?.items.find(item => item.id === target)
    if (!entity) return
    link.mutate({ from_id: project.id, to_id: target, type: relation }, { onSuccess: () => { toast.success(t("header.linking.added", { name: entity.title })); setTarget("") } })
  }
  function remove(item: EntityLink) {
    unlink.mutate({ id: item.id }, {
      onSuccess: () => toast.show({
        kind: "success",
        message: t("header.linking.removed", { name: item.entity.title }),
        undo: () => link.mutate({ from_id: item.from_id, to_id: item.to_id, type: item.type }),
      }),
    })
  }
  return (
    <Panel label={t("header.linking.title")} onClose={onClose}>
      <PanelHeader title={t("header.linking.title")} status={<span className="xs t3 trunc" title={project.title}>{project.title}</span>} />
      <PanelBody>
        <Field label={t("header.linking.entity")}>
          <Combobox value={target} options={options} onChange={setTarget} placeholder={t("header.linking.entityPlaceholder")} />
        </Field>
        <Field label={t("header.linking.relation")}>
          <Select<Relation> bare label={t("header.linking.relation")} value={relation} onChange={setRelation} options={RELATION_CHOICES.map(value => ({ value, label: status(`relation.${value}`) }))} />
        </Field>
        <Button icon="add" style={{ alignSelf: "flex-start" }} disabled={!target || link.isPending} onClick={add}>{t("header.linking.submit")}</Button>
        <section className="section">
          <h3 className="h3">{t("header.linking.current")}</h3>
          {own.length === 0 ? <span className="t3">{t("header.linking.none")}</span> : (
            <List>
              {own.map(item => (
                <div className="row" key={item.id}>
                  <Avatar name={item.entity.title} small round={item.entity.kind === "person"} />
                  <div className="row-main">
                    <Link className="row-title" to={entityPath(item.entity)} title={item.entity.title}>{item.entity.title}</Link>
                    <span className="row-sub">{relationLabel(item.type)}</span>
                  </div>
                  <IconButton icon="close" small variant="ghost" label={t("header.linking.remove", { name: item.entity.title })} disabled={unlink.isPending} onClick={() => remove(item)} />
                </div>
              ))}
            </List>
          )}
        </section>
      </PanelBody>
      <PanelFooter autosave />
    </Panel>
  )
}

const HISTORY_ACTIONS = ["created", "updated", "linked", "unlinked", "merged", "reprocessed"] as const
type HistoryAction = typeof HISTORY_ACTIONS[number]

/** Historial: cambios registrados y datos guardados de solo lectura (antes «Información adicional e historial»). */
export function HistoryPanel({ detail, onClose }: { detail: ProjectDetail; onClose: () => void }) {
  const { t } = useT("project")
  const format = useFormat()
  const label = (action: string) => (HISTORY_ACTIONS as readonly string[]).includes(action) ? t(`header.history.action.${action as HistoryAction}`) : null
  return (
    <Panel label={t("header.history.title")} onClose={onClose} wide>
      <PanelHeader title={t("header.history.title")} status={<span className="xs t3 trunc" title={detail.entity.title}>{detail.entity.title}</span>} />
      <PanelBody>
        <section className="section">
          <h3 className="h3">{t("header.history.changes")}</h3>
          {detail.changes.length === 0 ? <span className="t3">{t("header.history.none")}</span> : (
            <List>
              {detail.changes.map(change => (
                <div className="row" key={change.id}>
                  <div className="row-main">
                    <span className="row-title">{label(change.action) ?? <span className="mono">{change.action}</span>}</span>
                    <span className="row-sub">{t("header.history.by", { actor: change.actor })}</span>
                  </div>
                  <span className="xs t3">{format.date(change.created_at, "datetime")}</span>
                </div>
              ))}
            </List>
          )}
        </section>
        <section className="section">
          <h3 className="h3">{t("header.history.data")}</h3>
          <pre className="mono xs t2 scroll-x card card-pad" style={{ margin: 0, whiteSpace: "pre" }}>{JSON.stringify(detail.entity.data, null, 2)}</pre>
        </section>
      </PanelBody>
    </Panel>
  )
}

/** Brief y cierre: delegación, canal, equipo y repositorios del proyecto. */
export function AutomationPanel({ project, onClose }: { project: MemoryEntity; onClose: () => void }) {
  return <ProjectAutomationPanel project={project} onClose={onClose} />
}

type FieldType = "text" | "number" | "boolean" | "date" | "datetime" | "entity" | "json"
const FIELD_TYPES: readonly FieldType[] = ["text", "number", "boolean", "date", "datetime", "entity", "json"]
interface Column { key: string; label: string; type: FieldType; required: boolean }
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

/** Nueva colección del proyecto: creación larga → panel (no modal). Columnas con el esquema `fieldsSchema` de la memoria. */
export function CollectionPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useT("project")
  const common = useT("common").t
  const toast = useToast()
  const errorText = useErrorText()
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [columns, setColumns] = useState<Column[]>(() => [{ key: "detalle", label: t("header.collection.defaultLabel"), type: "text", required: true }])
  const [error, setError] = useState("")
  const create = useMemoryAction<MemoryEntity>("create_entity", { quiet: true })
  const duplicate = new Set(columns.map(column => column.key)).size !== columns.length
  const invalidKey = columns.some(column => !KEY_PATTERN.test(column.key))
  const valid = title.trim().length > 0 && columns.every(column => column.label.trim()) && !duplicate && !invalidKey
  const edit = (index: number, patch: Partial<Column>) => setColumns(columns.map((column, position) => position === index ? { ...column, ...patch } : column))
  function submit() {
    if (!valid || create.isPending) return
    create.mutate({ kind: "collection", title: title.trim(), project_ids: [projectId], data: { description: description.trim(), fields: columns.map(column => ({ ...column, label: column.label.trim() })) } }, {
      onSuccess: () => { toast.success(t("header.collection.done")); onClose() },
      onError: failure => setError(errorText(failure)),
    })
  }
  return (
    <Panel label={t("header.collection.title")} onClose={onClose} wide>
      <PanelHeader title={t("header.collection.title")} />
      <PanelBody>
        <Field label={t("header.collection.name")}><Input value={title} maxLength={500} onChange={event => setTitle(event.target.value)} /></Field>
        <Field label={t("header.collection.description")}><Textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} /></Field>
        <section className="section">
          <div className="section-h">
            <h3 className="h3">{t("header.collection.columns")}</h3>
            <Button small variant="ghost" icon="add" disabled={columns.length >= 64} onClick={() => setColumns([...columns, { key: `campo_${columns.length + 1}`, label: t("header.collection.newLabel"), type: "text", required: false }])}>{t("header.collection.addColumn")}</Button>
          </div>
          {(duplicate || invalidKey) && <span className="xs" role="alert" style={{ color: "var(--danger)" }}>{duplicate ? t("header.collection.duplicateKey") : t("header.collection.keyHint")}</span>}
          <List>
            {columns.map((column, index) => (
              <div className="row" key={index} style={{ flexWrap: "wrap", alignItems: "flex-end", gap: "var(--sp-3)" }}>
                <div style={{ flex: "1 1 140px", minWidth: 0 }}>
                  <Field label={t("header.collection.label")}><Input value={column.label} maxLength={100} onChange={event => edit(index, { label: event.target.value })} /></Field>
                </div>
                <div style={{ flex: "1 1 120px", minWidth: 0 }}>
                  <Field label={t("header.collection.key")}><Input mono value={column.key} maxLength={64} onChange={event => edit(index, { key: event.target.value })} /></Field>
                </div>
                <div style={{ flex: "1 1 140px", minWidth: 0 }}>
                  <Field label={t("header.collection.type")}>
                    <Select<FieldType> bare label={t("header.collection.type")} value={column.type} onChange={type => edit(index, { type })} options={FIELD_TYPES.map(value => ({ value, label: t(`header.collection.types.${value}`) }))} />
                  </Field>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", height: "var(--control-h)" }}>
                  <span className="xs t2">{t("header.collection.required")}</span>
                  <Switch checked={column.required} label={t("header.collection.required")} onChange={required => edit(index, { required })} />
                  <IconButton icon="close" small variant="ghost" label={t("header.collection.removeColumn", { name: column.label || column.key })} disabled={columns.length === 1} onClick={() => setColumns(columns.filter((_, position) => position !== index))} />
                </div>
              </div>
            ))}
          </List>
        </section>
        {error && <p className="xs" role="alert" style={{ color: "var(--danger)" }}>{error}</p>}
      </PanelBody>
      <div className="panel-f">
        <Button variant="ghost" onClick={onClose} disabled={create.isPending}>{common("actions.cancel")}</Button>
        <Button disabled={!valid || create.isPending} onClick={submit}>{t("header.collection.submit")}</Button>
      </div>
    </Panel>
  )
}
