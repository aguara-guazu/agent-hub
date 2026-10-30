import { useRef } from "react"
import type { AnchorHTMLAttributes, CSSProperties, HTMLAttributes, KeyboardEvent, ReactNode } from "react"
import { Link, type LinkProps } from "react-router-dom"
import i18n from "i18next"
import { errorKey } from "../../i18n/errors"
import { useT } from "../../i18n"
import { Icon, type IconName } from "../Icon"
import { Button } from "./basics"
import { cx } from "./layers"

/** Botón sin apariencia propia, para pestañas y títulos clicables. */
const BARE_BUTTON: CSSProperties = { border: 0, background: "transparent", padding: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" }

/** `badge`: pendientes que piden atención (por ejemplo, sin ver); reemplaza a `count`. */
export interface SegOption<T extends string> { value: T; label: string; count?: number; badge?: { count: number; label: string } }

/** Filtra la misma lista: de 2 a 5 opciones. */
export function Seg<T extends string>({ options, value, onChange, label }: { options: readonly SegOption<T>[]; value: T; onChange: (value: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.slice(0, 5).map(option => (
        <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
          {option.badge && option.badge.count > 0
            ? <span className="badge attn" aria-label={option.badge.label}>{option.badge.count > 99 ? "99+" : option.badge.count}</span>
            : option.count !== undefined && <span className="count">{option.count}</span>}
        </button>
      ))}
    </div>
  )
}

export interface TabItem<T extends string> { value: T; label: string; count?: number }

/** Cambia el contenido de una ficha. Máximo 5: las demás se ignoran. */
/** Máximo cinco pestañas; `max` solo para una excepción acordada con la persona (ficha de proyecto: seis). */
export function Tabs<T extends string>({ tabs, value, onChange, label, idPrefix = "tab", max = 5 }: { tabs: readonly TabItem<T>[]; value: T; onChange: (value: T) => void; label: string; idPrefix?: string; max?: number }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const visible = tabs.slice(0, max)
  function onKeyDown(event: KeyboardEvent, index: number) {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
    if (!delta) return
    event.preventDefault()
    const next = (index + delta + visible.length) % visible.length
    refs.current[next]?.focus()
    onChange(visible[next]!.value)
  }
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {visible.map((tab, index) => (
        <button
          key={tab.value}
          ref={element => { refs.current[index] = element }}
          type="button"
          role="tab"
          id={`${idPrefix}-${tab.value}`}
          aria-selected={tab.value === value}
          aria-controls={`${idPrefix}-${tab.value}-panel`}
          tabIndex={tab.value === value ? 0 : -1}
          className={cx("tab", tab.value === value && "is-active")}
          style={{ border: 0, background: "transparent", font: "inherit", cursor: "pointer" }}
          onClick={() => onChange(tab.value)}
          onKeyDown={event => onKeyDown(event, index)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="count">{tab.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function TabPanel({ idPrefix = "tab", value, className, children }: { idPrefix?: string; value: string; className?: string; children: ReactNode }) {
  return <div role="tabpanel" id={`${idPrefix}-${value}-panel`} aria-labelledby={`${idPrefix}-${value}`} className={className}>{children}</div>
}

export type BannerTone = "neutral" | "warn" | "danger"

/** Un aviso por vista, arriba del contenido, que agrupa los casos y ofrece una acción. */
export function Banner({ tone = "warn", children, action }: { tone?: BannerTone; children: ReactNode; action?: ReactNode }) {
  const icon: IconName = tone === "danger" ? "error" : tone === "warn" ? "warning" : "info"
  return (
    <div className={cx("banner", tone !== "neutral" && `banner-${tone}`)} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={icon} />
      <div className="banner-body">{children}</div>
      {action}
    </div>
  )
}

export interface EmptyProps {
  icon?: IconName
  title: string
  /** Una oración: cuándo aparece o qué hacer. */
  detail?: string
  action?: ReactNode
  tone?: "neutral" | "danger"
}

export function Empty({ icon = "info", title, detail, action, tone = "neutral" }: EmptyProps) {
  return (
    <div className="empty" role={tone === "danger" ? "alert" : undefined}>
      <Icon name={icon} style={tone === "danger" ? { color: "var(--danger)" } : undefined} />
      <span className="h3">{title}</span>
      {detail && <span className="t3 xs" style={{ maxWidth: 320 }}>{detail}</span>}
      {action && <div style={{ marginTop: "var(--sp-1)" }}>{action}</div>}
    </div>
  )
}

/** Vacío por filtro: una línea + «Limpiar filtros». */
export function EmptyFiltered({ text, onClear }: { text: string; onClear: () => void }) {
  const { t } = useT("common")
  return (
    <div className="empty" style={{ padding: "var(--sp-5)" }}>
      <span className="t2">{text}</span>
      <Button small onClick={onClear}>{t("actions.clearFilters")}</Button>
    </div>
  )
}

export interface DlItem { label: string; value: ReactNode }

/** Metadatos de solo lectura. Un dato faltante se muestra como «—». */
export function Dl({ items }: { items: readonly DlItem[] }) {
  return (
    <dl className="dl">
      {items.map(item => (
        <div key={item.label} style={{ display: "contents" }}>
          <dt>{item.label}</dt>
          <dd>{item.value === null || item.value === undefined || item.value === "" ? "—" : item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function List({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("list", className)} {...rest}>{children}</div>
}

export function RowHead({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div className="row-head" style={style}>{children}</div>
}

interface RowContent { title: ReactNode; titleText?: string; sub?: ReactNode; lead?: ReactNode; meta?: ReactNode; action?: ReactNode; selected?: boolean }

function RowInner({ title, titleText, sub, lead, meta }: RowContent) {
  return <>
    {lead}
    <div className="row-main">
      <span className="row-title" title={titleText ?? (typeof title === "string" ? title : undefined)}>{title}</span>
      {sub && <span className="row-sub" title={typeof sub === "string" ? sub : undefined}>{sub}</span>}
    </div>
    {meta && <div className="row-meta">{meta}</div>}
  </>
}

/** Fila que es un enlace (abre la ficha). Sin controles adentro. */
export function RowLink({ to, title, titleText, sub, lead, meta, selected, ...rest }: RowContent & Omit<LinkProps, "title">) {
  return <Link to={to} className={cx("row", selected && "is-selected")} aria-current={selected ? "true" : undefined} {...rest}><RowInner title={title} titleText={titleText} sub={sub} lead={lead} meta={meta} /></Link>
}

/** Fila que abre un panel. Con `action` (interruptor, botón), la fila es un `div` y el título queda como botón. */
export function Row({ title, titleText, sub, lead, meta, action, selected, onOpen, ...rest }: RowContent & { onOpen?: () => void } & Omit<HTMLAttributes<HTMLDivElement>, "title">) {
  const interactive = Boolean(onOpen)
  return (
    <div
      className={cx("row", selected && "is-selected")}
      role={interactive && !action ? "button" : undefined}
      tabIndex={interactive && !action ? 0 : undefined}
      aria-pressed={interactive && !action ? Boolean(selected) : undefined}
      onClick={onOpen}
      onKeyDown={interactive && !action ? event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen?.() } } : undefined}
      style={interactive ? { cursor: "pointer" } : undefined}
      {...rest}
    >
      <RowInner
        title={interactive && action
          ? <button type="button" style={{ ...BARE_BUTTON, maxWidth: "100%" }} onClick={event => { event.stopPropagation(); onOpen?.() }}>{title}</button>
          : title}
        titleText={titleText}
        sub={sub}
        lead={lead}
        meta={meta}
      />
      {action && <div onClick={event => event.stopPropagation()} style={{ flex: "none" }}>{action}</div>}
    </div>
  )
}

export function ExternalRowLink({ title, sub, lead, meta, ...rest }: RowContent & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "title">) {
  return <a className="row" {...rest}><RowInner title={title} sub={sub} lead={lead} meta={meta} /></a>
}

/** Carga: filas esqueleto con la misma altura que las reales. */
export function SkeletonRows({ count = 3, avatar = true, label }: { count?: number; avatar?: boolean; label?: string }) {
  const { t } = useT("common")
  return (
    <div className="list" role="status" aria-busy="true" aria-label={label ?? t("states.loading")}>
      {Array.from({ length: count }, (_, index) => (
        <div className="row" key={index} aria-hidden="true">
          {avatar && <span className="av" style={{ background: "var(--surface-3)" }} />}
          <div className="row-main" style={{ gap: "var(--sp-2)" }}>
            <span style={{ height: 10, width: `${60 - index * 6}%`, borderRadius: "var(--r-sm)", background: "var(--surface-3)" }} />
            <span style={{ height: 8, width: `${40 - index * 4}%`, borderRadius: "var(--r-sm)", background: "var(--surface-2)" }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Línea de carga para bloques que no son listas. */
export function Loading({ label }: { label?: string }) {
  const { t } = useT("common")
  return <div role="status" aria-busy="true" className="t3 xs" style={{ padding: "var(--sp-4)" }}>{label ?? t("states.loading")}</div>
}

/** Texto de `errors` para lo que se lanzó (causa + qué hacer). Fuera de React; sigue el idioma activo de i18next. */
export function describeError(error: unknown): string {
  return i18n.t(errorKey(error), { ns: "errors" })
}

export interface ErrorStateProps {
  error: unknown
  title?: string
  onRetry?: () => void
  /** Acción propia en lugar de «Reintentar». */
  action?: ReactNode
}

/** Error de carga: causa + una acción. */
export function ErrorState({ error, title, onRetry, action }: ErrorStateProps) {
  const { t } = useT("common")
  const { t: te } = useT("errors")
  return (
    <Empty
      tone="danger"
      icon="error"
      title={title ?? t("error.title")}
      detail={te(errorKey(error))}
      action={action ?? (onRetry && <Button small onClick={onRetry}>{t("actions.retry")}</Button>)}
    />
  )
}
