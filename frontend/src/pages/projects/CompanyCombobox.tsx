import { useMemo } from "react"
import { Combobox, type Option } from "../../components/ui"
import { useCompanies } from "../../lib/projects"

/** Empresa elegida: una existente (`id`) o una nueva que se crea al guardar (`newName`). */
export interface CompanyChoice { id: string; newName: string }

export const NO_COMPANY: CompanyChoice = { id: "", newName: "" }

/** Combobox de empresas con «Crear «X»»; la creación se difiere hasta enviar el formulario. */
export function CompanyCombobox({ value, onChange, placeholder, disabled }: { value: CompanyChoice; onChange: (value: CompanyChoice) => void; placeholder: string; disabled?: boolean }) {
  const companies = useCompanies()
  const options = useMemo<Option[]>(() => (companies.data?.items ?? []).map(company => ({ value: company.id, label: company.title, avatar: company.title })), [companies.data])
  return (
    <Combobox
      value={value.id}
      options={options}
      placeholder={placeholder}
      disabled={disabled}
      onChange={id => onChange({ id, newName: "" })}
      onCreate={name => onChange({ id: "", newName: name })}
    />
  )
}

/** Cuerpo de `save_project_company`, o `null` si no hay empresa elegida. */
export function companyPayload(choice: CompanyChoice, description = ""): { company_id: string } | { company: { title: string; description: string } } | null {
  if (choice.id) return { company_id: choice.id }
  if (choice.newName.trim()) return { company: { title: choice.newName.trim(), description: description.trim() } }
  return null
}
