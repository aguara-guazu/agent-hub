import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button } from "../../components/ui/basics"
import { Dialog } from "../../components/ui/Dialog"
import { Field, Input, Textarea } from "../../components/ui/fields"
import { useToast } from "../../components/ui/Toast"
import { useT } from "../../i18n/useT"
import { entityHref, useMemoryAction, type MemoryEntity } from "../../lib/memory-view"
import { EntityCombobox } from "./pickers"

/** Crear una nota: nombre, contenido y proyecto (opcional). Al crear abre la ficha. */
export function NewNoteDialog({ onClose, projectId = "" }: { onClose: () => void; projectId?: string }) {
  const { t } = useT("memory"), { t: common } = useT("common"), toast = useToast(), navigate = useNavigate()
  const [title, setTitle] = useState(""), [text, setText] = useState(""), [project, setProject] = useState(projectId)
  const create = useMemoryAction<MemoryEntity>("create_entity", entity => {
    onClose()
    toast.success(t("newNote.created"))
    navigate(entityHref(entity))
  })
  const valid = title.trim().length > 0
  const submit = () => {
    if (!valid || create.isPending) return
    create.mutate({ kind: "note", title: title.trim(), project_ids: project ? [project] : [], data: { text: text.trim() || title.trim(), description: text.trim() } })
  }
  return (
    <Dialog
      open
      title={t("newNote.title")}
      onClose={onClose}
      onSubmit={submit}
      busy={create.isPending}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={create.isPending}>{common("actions.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={!valid || create.isPending}>{t("newNote.submit")}</Button>
      </>}
    >
      <Field label={t("field.name")} hint={valid ? undefined : t("newNote.nameHint")}>
        <Input value={title} maxLength={500} onChange={event => setTitle(event.target.value)} />
      </Field>
      <Field label={t("field.content")}>
        <Textarea rows={6} value={text} onChange={event => setText(event.target.value)} />
      </Field>
      <Field label={t("field.project")} hint={t("newNote.projectHint")}>
        <EntityCombobox kind="project" value={project} onChange={setProject} label={t("field.project")} placeholder={t("picker.projectPlaceholder")} />
      </Field>
    </Dialog>
  )
}
