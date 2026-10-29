import { forwardRef } from "react"
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react"
import { Icon, type IconName } from "../Icon"
import { cx, hashText } from "./layers"

export type ButtonVariant = "default" | "primary" | "ghost" | "danger"

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  small?: boolean
  icon?: IconName
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", small = false, icon, className, type = "button", children, ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("btn", variant !== "default" && `btn-${variant}`, small && "btn-sm", className)}
      {...rest}
    >
      {icon && <Icon name={icon} small={small} />}
      {children}
    </button>
  )
})

export interface IconButtonProps extends Omit<ButtonProps, "icon" | "children"> {
  icon: IconName
  /** Obligatorio: el botón no tiene texto visible. */
  label: string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, className, title, ...rest }, ref,
) {
  return <Button ref={ref} className={cx("btn-icon", className)} aria-label={label} title={title ?? label} {...rest}><Icon name={icon} small={rest.small} /></Button>
})

export function BtnGroup({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div role="group" className={cx("btn-group", className)} {...rest}>{children}</div>
}

export type ChipTone = "ok" | "warn" | "danger" | "locked" | "info" | "off"

/** Estado: siempre punto + texto (1 a 3 palabras). */
export function Chip({ tone, children, title, className }: { tone: ChipTone; children: ReactNode; title?: string; className?: string }) {
  return <span className={cx("chip", `c-${tone}`, className)} title={title}>{children}</span>
}

/** Tipo de una cosa (Reunión, HTTP, v2): neutro. */
export function Tag({ children, title }: { children: ReactNode; title?: string }) {
  return <span className="tag" title={title}>{children}</span>
}

/** Contador junto a un ítem de navegación; `attention` solo si el número pide atención. */
export function Badge({ count, attention = false, label }: { count: number; attention?: boolean; label?: string }) {
  if (count <= 0) return null
  return <span className={cx("badge", attention && "attn")} aria-label={label}>{count > 99 ? "99+" : count}</span>
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>
}

export type Hue = 1 | 2 | 3 | 4 | 5 | 6

export function hueFor(name: string): Hue {
  return ((hashText(name.trim().toLowerCase()) % 6) + 1) as Hue
}

export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean)
  if (words.length === 0) return "—"
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

export interface AvatarProps {
  name: string
  /** Texto propio (por ejemplo, un número) en lugar de las iniciales. */
  text?: string
  small?: boolean
  /** Personas: redondo. Proyectos, clientes, servidores: cuadrado. */
  round?: boolean
  hue?: Hue
}

export function Avatar({ name, text, small = false, round = false, hue }: AvatarProps) {
  return <span className={cx("av", small && "av-sm", round && "av-round", `hue${hue ?? hueFor(name)}`)} title={name} aria-hidden="true">{text ?? initials(name)}</span>
}

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Nombre de lo que activa; no se muestra, lo lee el lector de pantalla. */
  label: string
  disabled?: boolean
}

/** Aplica al instante: sin botón Guardar ni texto «Habilitado» al lado. */
export function Switch({ checked, onChange, label, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={event => { event.stopPropagation(); onChange(!checked) }}
    />
  )
}
