import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button, IconButton } from "../../components/ui/basics"
import { Field, Input, Select, Textarea } from "../../components/ui/fields"
import { Panel, PanelBody, PanelHeader } from "../../components/ui/Panel"
import { useToast } from "../../components/ui/Toast"
import { useT } from "../../i18n/useT"
import { entityHref, useMemoryAction, type MemoryEntity } from "../../lib/memory-view"
import { EntityCombobox } from "./pickers"

export const COLUMN_TYPES = ["text", "number", "boolean", "date", "datetime", "entity", "json"] as const
export type ColumnType = typeof COLUMN_TYPES[number]
export interface Column { key: string; label: string; type: ColumnType; required: boolean }

export const COLUMN_KEY = /^[a-z][a-z0-9_]{0,63}$/

/** Identificador estable a partir de la etiqueta: «Zona horaria» → `zona_horaria`. */
export function columnKey(label: string): string {
  const base = label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  const key = /^[a-z]/.test(base) ? base : `campo_${base}`
  return key.slice(0, 64) || "campo"
}

/** Crear una colección con columnas. Va en panel porque el formulario es largo y técnico. */
export function NewCollectionPanel({ onClose }: { onClose: () => void }) {
  const { t } = useT("memory"), { t: common } = useT("common"), toast = useToast(), navigate = useNavigate()
  const [title, setTitle] = useState(""), [description, setDescription] = useState(""), [project, setProject] = useState("")
  const [columns, setColumns] = useState<(Column & { touched: boolean })[]>([{ key: "detalle", label: t("collection.defaultColumn"), type: "text", required: true, touched: false }])
  const create = useMemoryAction<MemoryEntity>("create_entity", entity => {
    onClose()
    toast.success(t("collection.created"))
    navigate(entityHref(entity))
  })
  const keys = columns.map(column => column.key)
  const invalidColumn = columns.some(column => !column.label.trim() || !COLUMN_KEY.test(column.key)) || new Set(keys).size !== keys.length
  const valid = title.trim().length > 0 && columns.length > 0 && !invalidColumn
  const dirty = title.trim().length > 0 || description.trim().length > 0
  const update = (index: number, patch: Partial<Column> & { touched?: boolean }) => setColumns(current => current.map((column, i) => {
    if (i !== index) return column
    const next = { ...column, ...patch }
    if (patch.label !== undefined && !column.touched) next.key = columnKey(patch.label)
    return next
  }))
  const typeOptions = COLUMN_TYPES.map(type => ({ value: type, label: t(`columnType.${type}`) }))
  const requiredOptions = [{ value: "no", label: t("collection.optional") }, { value: "yes", label: t("collection.required") }] as const
  const submit = () => {
    if (!valid) return
    create.mutate({ kind: "collection", title: title.trim(), project_ids: project ? [project] : [],
      data: { description: description.trim(), fields: columns.map(({ touched: _touched, ...column }) => ({ ...column, label: column.label.trim() })) } })
  }
  return (
    <Panel label={t("collection.newTitle")} onClose={onClose} wide dirty={dirty && !create.isPending} onBlockedClose={() => toast.info(common("states.unsaved"))}>
      <PanelHeader title={t("collection.newTitle")} />
      <PanelBody>
        <Field label={t("field.name")} hint={title.trim() ? undefined : t("collection.nameHint")}>
          <Input value={title} maxLength={500} onChange={event => setTitle(event.target.value)} />
        </Field>
        <Field label={t("field.description")}>
          <Textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} />
        </Field>
        <Field label={t("field.project")}>
          <EntityCombobox kind="project" value={project} onChange={setProject} label={t("field.project")} placeholder={t("picker.projectPlaceholder")} />
        </Field>
        <section className="section">
          <div className="section-h"><h3 className="h3">{t("collection.columns")}</h3></div>
          {columns.map((column, index) => (
            <div key={index} className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
              <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "flex-end" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Field label={t("collection.columnLabel")}>
                    <Input value={column.label} maxLength={100} onChange={event => update(index, { label: event.target.value })} />
                  </Field>
                </div>
                <IconButton icon="close" small variant="ghost" label={t("collection.removeColumn", { name: column.label || index + 1 })} disabled={columns.length === 1} onClick={() => setColumns(columns.filter((_, i) => i !== index))} />
              </div>
              <Field label={t("collection.columnKey")} error={COLUMN_KEY.test(column.key) ? (keys.indexOf(column.key) !== index ? t("collection.keyDuplicate") : undefined) : t("collection.keyInvalid")}>
                <Input mono value={column.key} maxLength={64} onChange={event => update(index, { key: event.target.value, touched: true })} />
              </Field>
              <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
                <Select label={t("collection.columnType")} value={column.type} options={typeOptions} onChange={type => update(index, { type })} />
                <Select label={t("collection.columnRequired")} value={column.required ? "yes" : "no"} options={requiredOptions} onChange={value => update(index, { required: value === "yes" })} />
              </div>
            </div>
          ))}
          <div><Button small icon="add" disabled={columns.length >= 64} onClick={() => setColumns([...columns, { key: `campo_${columns.length + 1}`, label: "", type: "text", required: false, touched: false }])}>{t("collection.addColumn")}</Button></div>
        </section>
      </PanelBody>
      <div className="panel-f">
        <Button variant="ghost" onClick={onClose} disabled={create.isPending}>{common("actions.cancel")}</Button>
        <Button disabled={!valid || create.isPending} onClick={submit}>{t("collection.submit")}</Button>
      </div>
    </Panel>
  )
}
