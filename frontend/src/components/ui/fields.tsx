import { createContext, forwardRef, useContext, useId, useMemo, useRef, useState } from "react"
import type { InputHTMLAttributes, KeyboardEvent, ReactNode, TextareaHTMLAttributes } from "react"
import { Icon } from "../Icon"
import { Avatar } from "./basics"
import { cx } from "./layers"
import { Pop } from "./Menu"
import { useT } from "../../i18n/useT"

interface FieldIds { id: string; hintId?: string; invalid: boolean }
const FieldContext = createContext<FieldIds | null>(null)

export interface FieldProps {
  label: string
  /** Ayuda breve o el motivo por el que un botón de crear está deshabilitado. */
  hint?: string
  /** Error de validación: reemplaza al hint. */
  error?: string
  children: ReactNode
  id?: string
}

/** Etiqueta siempre arriba; nunca solo un placeholder. */
export function Field({ label, hint, error, children, id }: FieldProps) {
  const generated = useId()
  const fieldId = id ?? generated
  const note = error ?? hint
  const ids = useMemo(() => ({ id: fieldId, hintId: note ? `${fieldId}-hint` : undefined, invalid: Boolean(error) }), [fieldId, note, error])
  return (
    <FieldContext.Provider value={ids}>
      <div className="field">
        <label className="label" htmlFor={fieldId}>{label}</label>
        {children}
        {note && <span id={ids.hintId} className="hint" style={error ? { color: "var(--danger)" } : undefined}>{note}</span>}
      </div>
    </FieldContext.Provider>
  )
}

function useFieldProps(id?: string) {
  const field = useContext(FieldContext)
  return { id: id ?? field?.id, "aria-describedby": field?.hintId, "aria-invalid": field?.invalid || undefined }
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** URL, rutas, horas e identificadores. */
  mono?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ mono = false, className, id, ...rest }, ref) {
  return <input ref={ref} className={cx("input", mono && "mono", className)} {...useFieldProps(id)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(function Textarea({ mono = false, className, id, rows = 4, ...rest }, ref) {
  return <textarea ref={ref} rows={rows} className={cx("input", mono && "mono", className)} {...useFieldProps(id)} {...rest} />
})

export const SearchInput = forwardRef<HTMLInputElement, Omit<InputProps, "type"> & { label: string }>(function SearchInput({ label, placeholder, ...rest }, ref) {
  return (
    <div className="search">
      <Icon name="find" />
      <Input ref={ref} type="search" aria-label={label} placeholder={placeholder ?? label} {...rest} />
    </div>
  )
})

export interface Option<T extends string = string> {
  value: T
  label: string
  /** Nombre para el avatar (proyectos, personas, empresas). */
  avatar?: string
  round?: boolean
  detail?: string
}

function OptionList<T extends string>({ id, options, active, selected, onPick, onHover, extra }: { id: string; options: readonly Option<T>[]; active: number; selected?: T; onPick: (option: Option<T>) => void; onHover: (index: number) => void; extra?: ReactNode }) {
  return (
    <div role="listbox" id={id} style={{ display: "flex", flexDirection: "column" }}>
      {options.map((option, index) => (
        <div
          key={option.value}
          id={`${id}-${index}`}
          role="option"
          aria-selected={option.value === selected}
          className="menu-item"
          style={index === active ? { background: "var(--surface-2)" } : undefined}
          onMouseDown={event => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(option)}
        >
          {option.avatar && <Avatar name={option.avatar} small round={option.round} />}
          <span className="trunc" style={{ flex: 1 }}>{option.label}</span>
          {option.detail && <span className="xs t3">{option.detail}</span>}
          {option.value === selected && <Icon name="done" small />}
        </div>
      ))}
      {extra}
    </div>
  )
}

export interface SelectProps<T extends string> {
  /** Se muestra como «Etiqueta: Valor». */
  label: string
  value: T | ""
  options: readonly Option<T>[]
  onChange: (value: T) => void
  placeholder?: string
  disabled?: boolean
  /** Sin el prefijo «Etiqueta:», cuando ya hay un `Field` arriba. */
  bare?: boolean
}

/** Selector propio: reemplaza al `select` nativo. Teclado: ↑↓, Inicio/Fin, ↵, Escape. */
export function Select<T extends string>({ label, value, options, onChange, placeholder, disabled = false, bare = false }: SelectProps<T>) {
  const { t } = useT("common")
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const anchor = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const fieldProps = useFieldProps()
  const current = options.find(option => option.value === value)
  function openAt() {
    setActive(Math.max(0, options.findIndex(option => option.value === value)))
    setOpen(true)
  }
  function pick(option: Option<T>) {
    onChange(option.value)
    setOpen(false)
    anchor.current?.focus()
  }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openAt() }
      return
    }
    const move = (next: number) => { event.preventDefault(); setActive(Math.max(0, Math.min(options.length - 1, next))) }
    if (event.key === "ArrowDown") move(active + 1)
    else if (event.key === "ArrowUp") move(active - 1)
    else if (event.key === "Home") move(0)
    else if (event.key === "End") move(options.length - 1)
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); const option = options[active]; if (option) pick(option) }
    else if (event.key === "Tab") setOpen(false)
  }
  const text = current?.label ?? placeholder ?? t("select.placeholder")
  return <>
    <button
      ref={anchor}
      type="button"
      className="btn select"
      disabled={disabled}
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listId}
      aria-activedescendant={open ? `${listId}-${active}` : undefined}
      aria-label={bare ? undefined : `${label}: ${text}`}
      {...(bare ? fieldProps : {})}
      onClick={() => (open ? setOpen(false) : openAt())}
      onKeyDown={onKeyDown}
    >
      <span className="trunc">{bare ? <b>{text}</b> : <>{label}: <b>{text}</b></>}</span>
      <Icon name="down" small />
    </button>
    <Pop open={open} onClose={() => setOpen(false)} anchor={anchor} matchWidth className="menu">
      <OptionList id={listId} options={options} active={active} selected={value || undefined} onPick={pick} onHover={setActive} />
    </Pop>
  </>
}

export interface ComboboxProps<T extends string> {
  value: T | ""
  options: readonly Option<T>[]
  onChange: (value: T) => void
  /** Si viene, ofrece «Crear «X»» con el texto escrito. */
  onCreate?: (text: string) => void
  placeholder?: string
  label?: string
  disabled?: boolean
}

/** Elegir una entidad relacionada, o crearla desde el mismo control. */
export function Combobox<T extends string>({ value, options, onChange, onCreate, placeholder, label, disabled = false }: ComboboxProps<T>) {
  const { t } = useT("common")
  const current = options.find(option => option.value === value)
  const [text, setText] = useState(current?.label ?? "")
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const anchor = useRef<HTMLInputElement>(null)
  const listId = useId()
  const shown = editing ? text : current?.label ?? text
  const query = shown.trim().toLowerCase()
  const filtered = editing && query ? options.filter(option => option.label.toLowerCase().includes(query)) : options
  const canCreate = Boolean(onCreate) && editing && query.length > 0 && !options.some(option => option.label.toLowerCase() === query)
  const total = filtered.length + (canCreate ? 1 : 0)
  function pick(option: Option<T>) {
    onChange(option.value)
    setText(option.label)
    setEditing(false)
    setOpen(false)
  }
  function create() {
    onCreate?.(shown.trim())
    setEditing(false)
    setOpen(false)
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive(index => Math.min(total - 1, index + 1)) }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive(index => Math.max(0, index - 1)) }
    else if (event.key === "Enter" && open) {
      event.preventDefault()
      if (active < filtered.length) { const option = filtered[active]; if (option) pick(option) }
      else if (canCreate) create()
    }
  }
  return <>
    <input
      ref={anchor}
      className="input"
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={listId}
      aria-activedescendant={open && total > 0 ? `${listId}-${active}` : undefined}
      aria-label={label}
      placeholder={placeholder}
      disabled={disabled}
      value={shown}
      {...useFieldProps()}
      onFocus={() => setOpen(true)}
      onBlur={() => { setOpen(false); setEditing(false) }}
      onChange={event => { setText(event.target.value); setEditing(true); setOpen(true); setActive(0) }}
      onKeyDown={onKeyDown}
    />
    <Pop open={open && (total > 0 || query.length > 0)} onClose={() => setOpen(false)} anchor={anchor} matchWidth className="menu">
      <OptionList
        id={listId}
        options={filtered}
        active={active}
        selected={value || undefined}
        onPick={pick}
        onHover={setActive}
        extra={<>
          {total === 0 && <span className="xs t3" style={{ padding: "var(--sp-2) var(--sp-3)" }}>{t("select.noMatches")}</span>}
          {canCreate && (
            <div
              id={`${listId}-${filtered.length}`}
              role="option"
              aria-selected={false}
              className="menu-item"
              style={{ color: "var(--accent-text)", ...(active === filtered.length ? { background: "var(--surface-2)" } : {}) }}
              onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => setActive(filtered.length)}
              onClick={create}
            >
              <Icon name="add" small />
              <span className="trunc">{t("actions.createNamed", { name: shown.trim() })}</span>
            </div>
          )}
        </>}
      />
    </Pop>
  </>
}
