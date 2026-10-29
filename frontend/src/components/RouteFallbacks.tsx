/** Piezas temporales del árbol de rutas: envuelven las vistas previas al rediseño hasta que la fase 2 las reemplace. */

import type { ReactNode } from "react"
import { Navigate, useLocation, useParams, useSearchParams } from "react-router-dom"

/** Vista aún sin migrar: ocupa la zona de contenido con el ancho y los márgenes de `.page`. */
export function LegacyPage({ children }: { children: ReactNode }) {
  return <div className="page">{children}</div>
}

/** Redirección que conserva la consulta (`?focus=`, `?plan=`, `?q=`) y agrega la propia. */
export function Redirect({ to, keepSearch = true }: { to: string | ((params: Record<string, string | undefined>) => string); keepSearch?: boolean }) {
  const params = useParams()
  const location = useLocation()
  const target = typeof to === "function" ? to(params) : to
  const [path, own = ""] = target.split("?")
  const search = new URLSearchParams(keepSearch ? location.search : "")
  new URLSearchParams(own).forEach((value, key) => search.set(key, value))
  const query = search.toString()
  return <Navigate to={`${path}${query ? `?${query}` : ""}`} replace />
}

/** Elige la vista según un parámetro de la consulta, mientras dos vistas previas comparten un destino nuevo. */
export function BySearchParam({ name, cases, fallback }: { name: string; cases: Record<string, ReactNode>; fallback: ReactNode }) {
  const [params] = useSearchParams()
  const value = params.get(name)
  return <>{value !== null && value in cases ? cases[value] : fallback}</>
}
