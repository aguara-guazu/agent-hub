import { useMemo, useState } from "react"
import { Combobox } from "../../components/ui/fields"
import type { Option } from "../../components/ui/fields"
import { useToast } from "../../components/ui/Toast"
import { useT } from "../../i18n/useT"
import { useMemoryAction, useMemoryQuery, type MemoryEntity, type Page } from "../../lib/memory-view"

type PickKind = "project" | "person" | "company"

/** Opciones de entidades de un tipo, con avatar. `exclude` saca las ya vinculadas. */
export function useEntityOptions(kind: PickKind | undefined, exclude: readonly string[] = [], enabled = true) {
  const list = useMemoryQuery<Page<MemoryEntity>>("list_entities", { ...(kind ? { kind } : {}), limit: 200 }, enabled)
  const options = useMemo<Option[]>(() => (list.data?.items ?? [])
    .filter(item => !exclude.includes(item.id) && !item.data.merged_into)
    .map(item => ({ value: item.id, label: item.title, avatar: item.title, round: item.kind === "person", detail: kind === "person" ? item.data.email ?? undefined : undefined })), [list.data, exclude, kind])
  return { options, items: list.data?.items ?? [], isPending: list.isPending }
}

/**
 * Combobox de proyecto, persona o empresa que ofrece «Crear «X»».
 * Al crear, la entidad nueva se elige sola; `onChange` recibe su id.
 */
export function EntityCombobox({ kind, value, onChange, label, placeholder, exclude, disabled }: {
  kind: PickKind; value: string; onChange: (id: string, entity?: MemoryEntity) => void; label: string; placeholder?: string; exclude?: readonly string[]; disabled?: boolean
}) {
  const { t } = useT("memory"), toast = useToast()
  const { options } = useEntityOptions(kind, exclude)
  const [created, setCreated] = useState<Option[]>([])
  const create = useMemoryAction<MemoryEntity>("create_entity", entity => {
    setCreated(current => [...current, { value: entity.id, label: entity.title, avatar: entity.title, round: kind === "person" }])
    onChange(entity.id, entity)
    toast.success(t(`picker.created.${kind}`, { name: entity.title }))
  })
  const all = useMemo(() => [...options, ...created.filter(extra => !options.some(option => option.value === extra.value))], [options, created])
  return (
    <Combobox
      value={value}
      options={all}
      label={label}
      placeholder={placeholder}
      disabled={disabled || create.isPending}
      onChange={id => onChange(id)}
      onCreate={text => create.mutate({ kind, title: text, project_ids: [], data: kind === "project" ? { status: "discovery" } : {} })}
    />
  )
}
