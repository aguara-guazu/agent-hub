import { Navigate, useLocation, useParams } from "react-router-dom"

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
