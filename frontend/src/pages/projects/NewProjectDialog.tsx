import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button, Dialog, Field, Input, Select, Textarea, useToast } from "../../components/ui"
import { useT } from "../../i18n"
import { memoryCall, type MemoryEntity } from "../../lib/memory"
import { STAGE_CHOICES, type Stage } from "../../lib/projects"
import { useErrorText, useMemoryAction } from "../project/shared"
import { CompanyCombobox, NO_COMPANY, companyPayload, type CompanyChoice } from "./CompanyCombobox"

/** Crear proyecto: 4 campos. La empresa nueva se crea y asocia en la misma transacción de `save_project_company`. */
export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT("projects")
  const common = useT("common").t
  const status = useT("status").t
  const navigate = useNavigate()
  const toast = useToast()
  const errorText = useErrorText()
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [company, setCompany] = useState<CompanyChoice>(NO_COMPANY)
  const [stage, setStage] = useState<Stage>("discovery")
  const [error, setError] = useState("")
  const create = useMemoryAction<MemoryEntity>("create_entity", { quiet: true })
  const [busy, setBusy] = useState(false)
  const valid = title.trim().length > 0

  function reset() {
    setTitle(""); setDescription(""); setCompany(NO_COMPANY); setStage("discovery"); setError("")
  }
  function close() { if (!busy) { reset(); onClose() } }

  async function submit() {
    if (!valid || busy) return
    setBusy(true); setError("")
    try {
      const project = await create.mutateAsync({ kind: "project", title: title.trim(), data: { description: description.trim(), status: stage } })
      const payload = companyPayload(company)
      // La empresa se asocia después: si falla, el proyecto ya existe y se informa sin perderlo.
      if (payload) {
        try { await memoryCall("save_project_company", { project_id: project.id, expected_updated_at: project.updated_at, ...payload }) }
        catch (companyError) { toast.error(errorText(companyError)) }
      }
      toast.success(t("create.done"))
      reset()
      onClose()
      navigate(`/projects/${project.id}`)
    } catch (createError) {
      setError(errorText(createError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      title={t("create.title")}
      onClose={close}
      onSubmit={() => void submit()}
      busy={busy}
      footer={<>
        <Button variant="ghost" onClick={close} disabled={busy}>{common("actions.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={!valid || busy}>{t("create.submit")}</Button>
      </>}
    >
      <Field label={t("create.name")} hint={valid ? undefined : t("create.nameHint")}>
        <Input value={title} maxLength={500} autoComplete="off" onChange={event => setTitle(event.target.value)} />
      </Field>
      <Field label={t("create.description")}>
        <Textarea rows={3} maxLength={4000} value={description} onChange={event => setDescription(event.target.value)} />
      </Field>
      <Field label={t("create.company")}>
        <CompanyCombobox value={company} onChange={setCompany} placeholder={t("create.companyPlaceholder")} disabled={busy} />
      </Field>
      <Field label={t("create.stage")}>
        <Select bare label={t("create.stage")} value={stage} onChange={setStage} options={STAGE_CHOICES.map(value => ({ value, label: status(`stage.${value}`) }))} />
      </Field>
      {error && <p className="xs" role="alert" style={{ color: "var(--danger)" }}>{error}</p>}
    </Dialog>
  )
}
