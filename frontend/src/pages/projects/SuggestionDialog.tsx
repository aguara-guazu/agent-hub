import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button, Dialog, Field, Input, Select, Textarea, useToast } from "../../components/ui"
import { useT } from "../../i18n"
import { memoryCall, useMemory, type MemoryEntity, type Page } from "../../lib/memory"
import { useErrorText, useMemoryAction } from "../project/shared"
import { CompanyCombobox, NO_COMPANY, companyPayload, type CompanyChoice } from "./CompanyCombobox"

/** Fila de `list_project_suggestions`: el hecho `project_match` + datos de la fuente. */
export interface ProjectSuggestion extends MemoryEntity { source_title: string; source_kind: string; occurred_at: string | null }

/** Sugerencias pendientes; vacío si la operación falla (la variante del menú solo se oculta). */
export function usePendingSuggestions(enabled = true) {
  return useMemory<Page<ProjectSuggestion>>("list_project_suggestions", { state: "pending", limit: 50, offset: 0 }, enabled)
}

/** `review_project_suggestion` con `decision: "create"`: crea el proyecto y le asigna la fuente. */
export function SuggestionDialog({ open, onClose, suggestions }: { open: boolean; onClose: () => void; suggestions: readonly ProjectSuggestion[] }) {
  const { t } = useT("projects")
  const common = useT("common").t
  const navigate = useNavigate()
  const toast = useToast()
  const errorText = useErrorText()
  const review = useMemoryAction<{ project_id: string }>("review_project_suggestion", { quiet: true })
  const [selected, setSelected] = useState("")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [company, setCompany] = useState<CompanyChoice>(NO_COMPANY)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const current = useMemo(() => suggestions.find(item => item.id === selected), [suggestions, selected])

  useEffect(() => {
    if (open && !selected && suggestions[0]) choose(suggestions[0].id)
  }, [open, suggestions, selected])

  function choose(id: string) {
    const item = suggestions.find(entry => entry.id === id)
    setSelected(id)
    setTitle(item?.data.suggested_title || item?.source_title || "")
    setDescription(item?.data.suggested_description ?? "")
    if (item?.data.company_id) setCompany({ id: item.data.company_id, newName: "" })
  }
  function close() {
    if (busy) return
    setSelected(""); setTitle(""); setDescription(""); setCompany(NO_COMPANY); setError("")
    onClose()
  }

  async function submit() {
    if (!current || !title.trim() || busy) return
    setBusy(true); setError("")
    try {
      const result = await review.mutateAsync({ id: current.id, decision: "create", title: title.trim(), description: description.trim(), ...(company.id ? { company_id: company.id } : {}) })
      const payload = company.id ? null : companyPayload(company)
      if (payload) {
        try {
          const detail = await memoryCall<{ entity: MemoryEntity }>("get_entity", { id: result.project_id })
          await memoryCall("save_project_company", { project_id: result.project_id, expected_updated_at: detail.entity.updated_at, ...payload })
        } catch (companyError) { toast.error(errorText(companyError)) }
      }
      toast.success(t("suggestion.done", { source: current.source_title }))
      setSelected("")
      onClose()
      navigate(`/projects/${result.project_id}`)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      title={t("suggestion.title")}
      onClose={close}
      onSubmit={() => void submit()}
      busy={busy}
      footer={<>
        <Button variant="ghost" onClick={close} disabled={busy}>{common("actions.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={!current || !title.trim() || busy}>{t("suggestion.submit")}</Button>
      </>}
    >
      <Field label={t("suggestion.source")} hint={t("suggestion.sourceHint")}>
        <Select bare label={t("suggestion.source")} value={selected} onChange={choose} options={suggestions.map(item => ({ value: item.id, label: item.source_title }))} />
      </Field>
      <Field label={t("suggestion.name")}>
        <Input value={title} maxLength={500} onChange={event => setTitle(event.target.value)} />
      </Field>
      <Field label={t("suggestion.description")}>
        <Textarea rows={3} maxLength={4000} value={description} onChange={event => setDescription(event.target.value)} />
      </Field>
      <Field label={t("suggestion.company")}>
        <CompanyCombobox value={company} onChange={setCompany} placeholder={t("create.companyPlaceholder")} disabled={busy} />
      </Field>
      {error && <p className="xs" role="alert" style={{ color: "var(--danger)" }}>{error}</p>}
    </Dialog>
  )
}
