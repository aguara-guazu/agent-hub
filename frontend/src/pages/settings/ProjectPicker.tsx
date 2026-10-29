import { useState } from "react"
import { Combobox, IconButton, Tag } from "../../components/ui"
import { useT } from "../../i18n"
import { useMemory, type MemoryEntity, type Page } from "../../lib/memory"

/** Proyectos de una fuente: tags quitables + combobox para sumar otro. Va dentro de un `Field`, que le da id y etiqueta. */
export function ProjectPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useT("settings")
  const projects = useMemory<Page<MemoryEntity>>("list_entities", { kind: "project", limit: 200 })
  const items = projects.data?.items ?? []
  const [picking, setPicking] = useState("")
  const name = (projectId: string) => items.find(project => project.id === projectId)?.title ?? projectId
  const options = items.filter(project => !value.includes(project.id)).map(project => ({ value: project.id, label: project.title, avatar: project.title }))
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      {value.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-1)" }}>
          {value.map(projectId => (
            <span key={projectId} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
              <Tag title={name(projectId)}>{name(projectId)}</Tag>
              <IconButton small variant="ghost" icon="close" label={t("sources.editor.removeProject", { name: name(projectId) })} onClick={() => onChange(value.filter(item => item !== projectId))} />
            </span>
          ))}
        </div>
      )}
      <Combobox
        key={value.length}
        value={picking}
        options={options}
        placeholder={projects.isPending ? t("sources.editor.projectsLoading") : t("sources.editor.projectsPlaceholder")}
        disabled={projects.isPending}
        onChange={projectId => { onChange([...value, projectId]); setPicking("") }}
      />
    </div>
  )
}
