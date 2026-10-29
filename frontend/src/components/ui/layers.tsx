import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react"
import { createPortal } from "react-dom"
import { useTheme } from "../../lib/theme"

export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ")
}

export type LayerKind = "menu" | "modal" | "panel" | "palette"

interface LayerEntry { id: number; kind: LayerKind; onEscape: () => void }

const stack: LayerEntry[] = []
let nextId = 0
let listening = false

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.isComposing) return
  const top = stack.at(-1)
  if (!top) return
  event.preventDefault()
  event.stopPropagation()
  top.onEscape()
}

/** Registra una capa mientras `active`: Escape cierra solo la capa superior. */
export function useLayer(active: boolean, kind: LayerKind, onEscape: () => void): void {
  const handler = useRef(onEscape)
  handler.current = onEscape
  useEffect(() => {
    if (!active) return
    const entry: LayerEntry = { id: ++nextId, kind, onEscape: () => handler.current() }
    stack.push(entry)
    if (!listening) {
      document.addEventListener("keydown", onKeyDown, true)
      listening = true
    }
    return () => {
      const index = stack.findIndex(item => item.id === entry.id)
      if (index >= 0) stack.splice(index, 1)
    }
  }, [active, kind])
}

/** Hay un diálogo o la paleta abiertos: no se abre otro encima. */
export function hasBlockingLayer(): boolean {
  return stack.some(entry => entry.kind === "modal" || entry.kind === "palette")
}

/** Capa flotante: un contenedor propio al final de `body`, con la base `.ah` y el tema activo. */
export function Layer({ children }: { children: ReactNode }) {
  const { className } = useTheme()
  const [root] = useState(() => document.createElement("div"))
  root.className = `ah ${className}`
  root.style.background = "transparent"
  useLayoutEffect(() => {
    document.body.appendChild(root)
    return () => root.remove()
  }, [root])
  return createPortal(children, root)
}

const FOCUSABLE = "a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex=\"-1\"])"

export function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => element.getClientRects().length > 0)
}

/** Mantiene Tab dentro de `root`. */
export function trapTab(event: ReactKeyboardEvent, root: HTMLElement | null): void {
  if (event.key !== "Tab") return
  const items = focusableIn(root)
  if (items.length === 0) { event.preventDefault(); return }
  const first = items[0]!, last = items.at(-1)!
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}

/** Hash estable de un texto, para elegir tonos de avatar. */
export function hashText(text: string): number {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) | 0
  return Math.abs(hash)
}
