import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from "react"
import { Icon, type IconName } from "../Icon"
import { Layer, cx, useLayer } from "./layers"

export type PopAlign = "start" | "end"

function usePosition(anchor: RefObject<HTMLElement | null>, open: boolean, align: PopAlign, matchWidth: boolean) {
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", visibility: "hidden" })
  const pop = useRef<HTMLDivElement>(null)
  const update = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect()
    const own = pop.current?.getBoundingClientRect()
    if (!rect) return
    const height = own?.height ?? 0, width = own?.width ?? 0, gap = 4
    const below = rect.bottom + gap + height <= window.innerHeight || rect.top - gap - height < 0
    const top = below ? rect.bottom + gap : rect.top - gap - height
    let left = align === "end" ? rect.right - width : rect.left
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
    setStyle({ position: "fixed", top, left, zIndex: 60, minWidth: matchWidth ? rect.width : undefined, maxHeight: Math.max(160, window.innerHeight - 24), overflowY: "auto" })
  }, [anchor, align, matchWidth])
  useLayoutEffect(() => {
    if (!open) return
    update()
    const frame = requestAnimationFrame(update)
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true) }
  }, [open, update])
  return { pop, style }
}

export interface PopProps {
  open: boolean
  onClose: () => void
  anchor: RefObject<HTMLElement | null>
  children: ReactNode
  align?: PopAlign
  /** Al menos tan ancho como el control que lo abre (selectores, combobox). */
  matchWidth?: boolean
  className?: string
  role?: string
  id?: string
  label?: string
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
}

/** Capa flotante anclada a un control. Escape y click afuera la cierran. */
export function Pop({ open, onClose, anchor, children, align = "start", matchWidth = false, className, role, id, label, onKeyDown }: PopProps) {
  const { pop, style } = usePosition(anchor, open, align, matchWidth)
  useLayer(open, "menu", onClose)
  useEffect(() => {
    if (!open) return
    const listener = (event: MouseEvent) => {
      const target = event.target as Node
      if (pop.current?.contains(target) || anchor.current?.contains(target)) return
      onClose()
    }
    document.addEventListener("mousedown", listener)
    return () => document.removeEventListener("mousedown", listener)
  }, [open, onClose, anchor, pop])
  if (!open) return null
  return (
    <Layer>
      <div ref={pop} id={id} role={role} aria-label={label} className={cx("pop", className)} style={style} onKeyDown={onKeyDown}>
        {children}
      </div>
    </Layer>
  )
}

export interface MenuItem {
  label: string
  onSelect: () => void
  icon?: IconName
  /** Destructivo: va último, separado y en rojo. */
  danger?: boolean
  disabled?: boolean
  hint?: string
}

export interface MenuTriggerProps {
  ref: RefObject<HTMLButtonElement | null>
  onClick: () => void
  "aria-haspopup": "menu"
  "aria-expanded": boolean
  "aria-controls": string
}

export interface MenuProps {
  items: readonly MenuItem[]
  label: string
  trigger: (props: MenuTriggerProps) => ReactNode
  align?: PopAlign
}

/** Acciones secundarias de un elemento. Lo destructivo se ordena último, tras un separador. */
export function Menu({ items, label, trigger, align = "end" }: MenuProps) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()
  const regular = items.filter(item => !item.danger), danger = items.filter(item => item.danger)
  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) anchor.current?.focus()
  }, [])
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>(".menu-item:not(:disabled)")?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)") ?? [])]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const go = (next: number) => { event.preventDefault(); buttons[(next + buttons.length) % buttons.length]?.focus() }
    if (event.key === "ArrowDown") go(index + 1)
    else if (event.key === "ArrowUp") go(index - 1)
    else if (event.key === "Home") go(0)
    else if (event.key === "End") go(buttons.length - 1)
    else if (event.key === "Tab") close(false)
  }
  const render = (item: MenuItem) => (
    <button
      key={item.label}
      type="button"
      role="menuitem"
      className={cx("menu-item", item.danger && "danger")}
      disabled={item.disabled}
      title={item.hint}
      onClick={() => { close(); item.onSelect() }}
    >
      {item.icon && <Icon name={item.icon} />}
      <span className="trunc" style={{ flex: 1 }}>{item.label}</span>
    </button>
  )
  return <>
    {trigger({ ref: anchor, onClick: () => setOpen(value => !value), "aria-haspopup": "menu", "aria-expanded": open, "aria-controls": id })}
    <Pop open={open} onClose={() => close()} anchor={anchor} align={align} className="menu" role="menu" id={id} label={label} onKeyDown={onKeyDown}>
      <div ref={list} style={{ display: "contents" }}>
        {regular.map(render)}
        {regular.length > 0 && danger.length > 0 && <div className="menu-sep" role="separator" />}
        {danger.map(render)}
      </div>
    </Pop>
  </>
}
