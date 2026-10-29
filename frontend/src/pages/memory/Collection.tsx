import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Button, Chip, Switch } from "../../components/ui/basics"
import { Dialog } from "../../components/ui/Dialog"
import { Empty, EmptyFiltered, ErrorState, SkeletonRows } from "../../components/ui/display"
import { Combobox, Field, Input, Select, Textarea } from "../../components/ui/fields"
import type { Option } from "../../components/ui/fields"
import { Panel, PanelBody, PanelFooter, PanelHeader } from "../../components/ui/Panel"
import { useToast } from "../../components/ui/Toast"
import { useFormat, useT } from "../../i18n/useT"
import { useMemoryAction, useMemoryPages, useMemoryQuery, type Fragment, type MemoryEntity, type Page } from "../../lib/memory-view"
import { COLUMN_KEY, COLUMN_TYPES, columnKey, type Column } from "./NewCollectionPanel"
import { EntityCombobox } from "./pickers"
import { LoadMore } from "./shared"

export interface CollectionRecord { id: string; values: Record<string, any>; evidence_ids?: string[]; stale?: boolean }
interface Rule { id: string; collection_id: string; name: string; instructions: string; enabled: boolean; processed_versions?: number }

const CELL = { width: 180, flex: "none", minWidth: 0 } as const

function useCellText() {
  const { t } = useT("memory"), format = useFormat()
  return (column: Column, value: unknown): string => {
    if (value === undefined || value === null || value === "") return "—"
    if (column.type === "boolean") return value ? t("collection.yes") : t("collection.no")
    if (column.type === "datetime") return format.date(String(value))
    if (column.type === "date") return format.date(`${String(value)}T00:00:00`, "date")
    if (column.type === "number" && typeof value === "number") return format.number(value)
    if (typeof value === "object") return JSON.stringify(value)
    return String(value)
  }
}

/** Filas de una colección con filtro exacto por columna, evidencia por fila y seguimientos automáticos. */
export function CollectionRecords({ entity, onOpen }: { entity: MemoryEntity; onOpen: (record: CollectionRecord) => void }) {
  const { t, plural } = useT("memory")
  const fields: Column[] = entity.data.fields ?? []
  const [filterField, setFilterField] = useState(""), [filterValue, setFilterValue] = useState("")
  const field = fields.find(item => item.key === filterField)
  const filter = filterField && filterValue ? { [filterField]: field?.type === "number" ? Number(filterValue) : field?.type === "boolean" ? filterValue === "true" : filterValue } : {}
  const records = useMemoryPages<CollectionRecord>("list_records", { collection_id: entity.id, filter }, 50)
  const rows = useMemo(() => records.data?.pages.flatMap(page => page.items) ?? [], [records.data])
  const cellText = useCellText()
  const filterOptions = [{ value: "", label: t("collection.noFilter") }, ...fields.filter(item => item.type !== "json").map(item => ({ value: item.key, label: item.label }))]
  const total = records.data?.pages[0]?.total ?? 0
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)", minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }}>
        <Select label={t("collection.filterColumn")} value={filterField} options={filterOptions} onChange={value => { setFilterField(value); setFilterValue("") }} />
        {filterField && (field?.type === "boolean"
          ? <Select label={t("collection.filterValue")} value={filterValue as "" | "true" | "false"} onChange={setFilterValue} options={[{ value: "true", label: t("collection.yes") }, { value: "false", label: t("collection.no") }]} />
          : <div style={{ maxWidth: 240 }}><Input aria-label={t("collection.filterValue")} placeholder={t("collection.filterValue")} value={filterValue} onChange={event => setFilterValue(event.target.value)} /></div>)}
        <span className="xs t3" style={{ marginLeft: "auto" }} role="status">{plural("collection.rows", total)}</span>
      </div>
      {records.isPending ? <SkeletonRows count={3} avatar={false} />
        : records.error ? <ErrorState error={records.error} onRetry={() => void records.refetch()} />
        : !rows.length ? (filterValue
          ? <div className="list"><EmptyFiltered text={t("collection.emptyFilter")} onClear={() => { setFilterField(""); setFilterValue("") }} /></div>
          : <div className="list"><Empty icon="note" title={t("collection.emptyTitle")} detail={t("collection.emptyDetail")} /></div>)
        : <div className="list scroll-x">
          <div style={{ minWidth: fields.length * 194 + 220 }}>
            <div className="row-head">
              {fields.map(item => <span key={item.key} className="trunc" style={CELL} title={item.label}>{item.label}</span>)}
              <span style={{ ...CELL, width: 160 }}>{t("collection.evidence")}</span>
            </div>
            {rows.map(row => (
              <div key={row.id} className="row" role="button" tabIndex={0} style={{ cursor: "pointer" }} onClick={() => onOpen(row)}
                onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(row) } }}>
                {fields.map(item => {
                  const value = row.values[item.key]
                  return <span key={item.key} className="trunc" style={CELL} title={cellText(item, value)}>
                    {item.type === "entity" && value ? <Link to={`/memory/entities/${value}`} onClick={event => event.stopPropagation()}>{t("collection.viewEntity")}</Link> : cellText(item, value)}
                  </span>
                })}
                <span style={{ ...CELL, width: 160, display: "flex", gap: "var(--sp-2)", alignItems: "center" }}>
                  <span className="xs t3">{row.evidence_ids?.length ? plural("collection.sources", row.evidence_ids.length) : "—"}</span>
                  {row.stale && <Chip tone="warn">{t("collection.stale")}</Chip>}
                </span>
              </div>
            ))}
          </div>
        </div>}
      {records.hasNextPage && <LoadMore loading={records.isFetchingNextPage} onMore={() => void records.fetchNextPage()} />}
    </div>
  )
}

/** Seguimientos automáticos de la colección (reglas de extracción). Pausar y activar aplica al instante. */
export function CollectionRules({ entity }: { entity: MemoryEntity }) {
  const { t, plural } = useT("memory"), toast = useToast()
  const rules = useMemoryQuery<Rule[]>("list_rules")
  const update = useMemoryAction("update_rule")
  const own = (rules.data ?? []).filter(rule => rule.collection_id === entity.id)
  if (!own.length) return null
  return (
    <section className="section">
      <div className="section-h" style={{ minHeight: 0 }}><h2 className="h3">{t("rule.title")}</h2></div>
      {own.map(rule => (
        <div key={rule.id} style={{ display: "flex", gap: "var(--sp-3)", alignItems: "flex-start", minWidth: 0 }}>
          <div className="row-main">
            <span className="trunc" title={rule.name}>{rule.name}</span>
            <span className="xs t3 clamp2" title={rule.instructions}>{rule.instructions}</span>
            <span className="xs t3">{plural("rule.processed", rule.processed_versions ?? 0)}</span>
          </div>
          <Switch checked={rule.enabled} label={rule.name} disabled={update.isPending}
            onChange={enabled => update.mutate({ id: rule.id, enabled }, { onSuccess: () => toast.show({ message: enabled ? t("rule.resumed", { name: rule.name }) : t("rule.paused", { name: rule.name }), undo: () => update.mutate({ id: rule.id, enabled: !enabled }) }) })} />
        </div>
      ))}
    </section>
  )
}

function EvidenceLinks({ ids }: { ids: string[] }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>{ids.map((id, index) => <EvidenceLink key={id} id={id} index={index} />)}</div>
}
function EvidenceLink({ id, index }: { id: string; index: number }) {
  const { t } = useT("memory")
  const evidence = useMemoryQuery<Fragment>("get_evidence", { fragment_id: id })
  const label = t("collection.sourceN", { n: index + 1 })
  return evidence.data
    ? <Link className="trunc" to={`/memory/entities/${evidence.data.entity_id}?tab=content&version=${evidence.data.version_id}&fragment=${id}`} title={evidence.data.text}>{evidence.data.title ? `${label} · ${evidence.data.title}` : label}</Link>
    : <span className="t3">{label}</span>
}

function toInput(column: Column, value: unknown): string {
  if (value === undefined || value === null) return ""
  if (column.type === "json") return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)
  if (column.type === "datetime") { const date = new Date(String(value)); return Number.isNaN(date.getTime()) ? "" : new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace("T", " ") }
  if (column.type === "boolean") return value ? "true" : "false"
  return String(value)
}

/** Crear o editar una fila. Guardado explícito; valida al guardar los tipos de fecha, número y JSON. */
export function RecordPanel({ entity, record, onClose }: { entity: MemoryEntity; record: CollectionRecord | null; onClose: () => void }) {
  const { t } = useT("memory"), toast = useToast()
  const fields: Column[] = entity.data.fields ?? []
  const initial = Object.fromEntries(fields.map(column => [column.key, toInput(column, record?.values[column.key])]))
  const [values, setValues] = useState<Record<string, string>>(initial), [warn, setWarn] = useState(false), [invalid, setInvalid] = useState("")
  const dirty = fields.some(column => values[column.key] !== initial[column.key])
  const entities = useMemoryQuery<Page<MemoryEntity>>("list_entities", { limit: 200 }, fields.some(column => column.type === "entity"))
  const entityOptions = useMemo<Option[]>(() => (entities.data?.items ?? []).map(item => ({ value: item.id, label: item.title })), [entities.data])
  const save = useMemoryAction(record ? "update_record" : "add_record", () => { toast.success(record ? t("record.saved") : t("record.added")); onClose() })
  const missing = fields.filter(column => column.required && !values[column.key])
  const submit = () => {
    const parsed: Record<string, unknown> = {}
    for (const column of fields) {
      const raw = values[column.key]
      if (raw === undefined || raw === "") continue
      if (column.type === "number") { const value = Number(raw); if (Number.isNaN(value)) return setInvalid(column.key); parsed[column.key] = value }
      else if (column.type === "boolean") parsed[column.key] = raw === "true"
      else if (column.type === "json") { try { parsed[column.key] = JSON.parse(raw) } catch { return setInvalid(column.key) } }
      else if (column.type === "datetime") { const date = new Date(raw.trim().replace(" ", "T")); if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(raw.trim()) || Number.isNaN(date.getTime())) return setInvalid(column.key); parsed[column.key] = date.toISOString() }
      else if (column.type === "date") { if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) || Number.isNaN(new Date(`${raw.trim()}T00:00:00`).getTime())) return setInvalid(column.key); parsed[column.key] = raw.trim() }
      else parsed[column.key] = raw
    }
    setInvalid("")
    save.mutate({ ...(record ? { id: record.id } : { collection_id: entity.id }), values: parsed, evidence_ids: record?.evidence_ids ?? [] })
  }
  const title = record ? t("record.editTitle") : t("record.newTitle")
  return (
    <Panel label={title} onClose={onClose} dirty={dirty} onBlockedClose={() => setWarn(true)}>
      <PanelHeader title={title} />
      <PanelBody>
        {fields.map(column => {
          const value = values[column.key] ?? "", set = (next: string) => setValues(current => ({ ...current, [column.key]: next }))
          const label = column.required ? t("record.requiredLabel", { label: column.label }) : column.label
          return (
            <Field key={column.key} label={label} error={invalid === column.key ? t(`record.invalid.${column.type === "json" ? "json" : column.type === "number" ? "number" : "date"}`) : undefined}>
              {column.type === "boolean"
                ? <Select bare label={column.label} value={value as "" | "true" | "false"} onChange={set} placeholder={t("record.noValue")} options={[{ value: "", label: t("record.noValue") }, { value: "true", label: t("collection.yes") }, { value: "false", label: t("collection.no") }]} />
                : column.type === "entity" ? <Combobox value={value} options={entityOptions} onChange={set} label={column.label} />
                : column.type === "json" ? <Textarea mono rows={4} value={value} onChange={event => set(event.target.value)} />
                : <Input mono={column.type !== "text"} inputMode={column.type === "number" ? "decimal" : undefined} placeholder={column.type === "date" ? t("record.datePlaceholder") : column.type === "datetime" ? t("record.datetimePlaceholder") : undefined} value={value} onChange={event => set(event.target.value)} />}
            </Field>
          )
        })}
        {Boolean(record?.evidence_ids?.length) && <Field label={t("collection.evidence")}><EvidenceLinks ids={record!.evidence_ids!} /></Field>}
        {missing.length > 0 && <span className="hint">{t("record.missing", { fields: missing.map(column => column.label).join(", ") })}</span>}
      </PanelBody>
      <PanelFooter dirty={dirty && !missing.length} saving={save.isPending} warning={warn} onDiscard={() => { setValues(initial); setWarn(false) }} onSave={submit} />
    </Panel>
  )
}

/** Crear una columna (opcional, para conservar las filas existentes). */
export function AddColumnDialog({ entity, onClose }: { entity: MemoryEntity; onClose: () => void }) {
  const { t } = useT("memory"), { t: common } = useT("common"), toast = useToast()
  const [label, setLabel] = useState(""), [key, setKey] = useState(""), [touched, setTouched] = useState(false), [type, setType] = useState<typeof COLUMN_TYPES[number]>("text")
  const fields: Column[] = entity.data.fields ?? []
  const finalKey = touched ? key : columnKey(label)
  const keyError = !label ? undefined : !COLUMN_KEY.test(finalKey) ? t("collection.keyInvalid") : fields.some(column => column.key === finalKey) ? t("collection.keyDuplicate") : undefined
  const valid = Boolean(label.trim()) && !keyError
  const save = useMemoryAction("update_entity", () => { toast.success(t("collection.columnAdded")); onClose() })
  return (
    <Dialog open title={t("collection.addColumnTitle")} onClose={onClose} busy={save.isPending}
      onSubmit={() => { if (valid) save.mutate({ id: entity.id, expected_updated_at: entity.updated_at, data: { fields: [...fields, { key: finalKey, label: label.trim(), type, required: false }] } }) }}
      footer={<><Button variant="ghost" onClick={onClose}>{common("actions.cancel")}</Button><Button variant="primary" type="submit" disabled={!valid || save.isPending}>{t("collection.addColumnSubmit")}</Button></>}>
      <Field label={t("collection.columnLabel")}><Input value={label} maxLength={100} onChange={event => setLabel(event.target.value)} /></Field>
      <Field label={t("collection.columnKey")} error={keyError} hint={t("collection.keyHint")}><Input mono value={finalKey} onChange={event => { setTouched(true); setKey(event.target.value) }} /></Field>
      <Field label={t("collection.columnType")}><Select bare label={t("collection.columnType")} value={type} onChange={setType} options={COLUMN_TYPES.map(value => ({ value, label: t(`columnType.${value}`) }))} /></Field>
    </Dialog>
  )
}

/** Crear un seguimiento automático: la regla recorre lo importado y se aplica a fuentes nuevas. */
export function NewRuleDialog({ entity, onClose }: { entity: MemoryEntity; onClose: () => void }) {
  const { t } = useT("memory"), { t: common } = useT("common"), toast = useToast()
  const [name, setName] = useState(""), [instructions, setInstructions] = useState(""), [project, setProject] = useState("")
  const valid = Boolean(name.trim() && instructions.trim())
  const create = useMemoryAction("create_rule", () => { toast.success(t("rule.created")); onClose() })
  return (
    <Dialog open title={t("rule.newTitle")} onClose={onClose} busy={create.isPending}
      onSubmit={() => { if (valid) create.mutate({ collection_id: entity.id, name: name.trim(), instructions: instructions.trim(), project_ids: project ? [project] : [], enabled: true }) }}
      footer={<><Button variant="ghost" onClick={onClose}>{common("actions.cancel")}</Button><Button variant="primary" type="submit" disabled={!valid || create.isPending}>{t("rule.submit")}</Button></>}>
      <Field label={t("field.name")}><Input value={name} maxLength={200} placeholder={t("rule.namePlaceholder")} onChange={event => setName(event.target.value)} /></Field>
      <Field label={t("rule.instructions")} hint={t("rule.instructionsHint")}><Textarea rows={5} value={instructions} placeholder={t("rule.instructionsPlaceholder")} onChange={event => setInstructions(event.target.value)} /></Field>
      <Field label={t("field.project")}><EntityCombobox kind="project" value={project} onChange={setProject} label={t("field.project")} placeholder={t("picker.projectPlaceholder")} /></Field>
    </Dialog>
  )
}
