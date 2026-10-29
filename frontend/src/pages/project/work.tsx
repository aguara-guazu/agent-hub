import { createContext, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"
import { createPortal } from "react-dom"
import { useSearchParams } from "react-router-dom"

/** Parámetros de URL de los paneles propios de Tareas, Decisiones y Colaboración; abrir uno cierra los demás y el `?panel=` de la ficha. */
const OWN_PANELS = ["task", "decision", "message", "invite", "jira", "stats"] as const
export type WorkPanel = (typeof OWN_PANELS)[number]

/**
 * Panel de una pestaña abierto por URL (`?task=<id>`, `?jira=1`…). ProjectPage solo monta sus paneles (`?panel=`):
 * si aparece uno de ellos, el de la pestaña queda oculto sin perder su parámetro.
 */
export function useWorkPanel(key: WorkPanel) {
  const [params, setParams] = useSearchParams()
  const value = params.get(key)
  const open = value !== null && value !== "" && !params.get("panel")
  const set = (next: string | null) => setParams(current => {
    const values = new URLSearchParams(current)
    for (const own of OWN_PANELS) values.delete(own)
    if (next !== null) { values.set(key, next); values.delete("panel") }
    return values
  }, { replace: true })
  return { value: open ? value : null, open: (next = "1") => set(next), close: () => set(null) }
}

/** Parámetro de filtro de la pestaña (`?view=`, `?kind=`): ProjectPage los borra al cambiar de pestaña. */
export function useWorkFilter<T extends string>(key: "view" | "kind", values: readonly T[], fallback: T) {
  const [params, setParams] = useSearchParams()
  const value = values.find(option => option === params.get(key)) ?? fallback
  const set = (next: T) => setParams(current => {
    const values = new URLSearchParams(current)
    if (next === fallback) values.delete(key)
    else values.set(key, next)
    return values
  }, { replace: true })
  return [value, set] as const
}

/**
 * Zona de paneles de la ficha que ProjectPage expone a las pestañas: `undefined` sin ficha (render aislado), `null` mientras la ficha
 * muestra uno de sus paneles (`?panel=`) o antes de montar la zona.
 */
export const PanelSlotContext = createContext<HTMLElement | null | undefined>(undefined)

/** Monta el panel de la pestaña en la zona de paneles de la ficha: columna derecha que se apila bajo 1100 px. */
export function SidePanel({ children }: { children: ReactNode }) {
  const slot = useContext(PanelSlotContext)
  if (slot === undefined) return <>{children}</>
  return slot ? createPortal(children, slot) : null
}

/** El texto de un filtro llega al servidor con una pausa para no consultar en cada tecla. */
export function useDebounced(value: string, ms = 250) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}
