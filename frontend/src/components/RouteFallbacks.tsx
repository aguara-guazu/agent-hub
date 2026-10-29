/** Piezas temporales del árbol de rutas: envuelven las vistas previas al rediseño hasta que la fase 2 las reemplace. */

import type { ReactNode } from "react"
import { useMutation } from "@tanstack/react-query"
import { Navigate, useLocation, useParams, useSearchParams } from "react-router-dom"
import { CLI_LABELS } from "../lib/types"
import { Avatar, Button } from "./ui/basics"
import { Empty, List, Row, RowHead } from "./ui/display"
import { useToast } from "./ui/Toast"
import { uiText } from "./ui/strings"
import { useShellStatus } from "./useShellStatus"

/** Vista aún sin migrar: ocupa la zona de contenido con el ancho y los márgenes de `.page`. */
export function LegacyPage({ children }: { children: ReactNode }) {
  return <div className="page">{children}</div>
}

export function RouteStub({ title }: { title: string }) {
  return (
    <div className="page">
      <div className="ph"><div className="ph-text"><h1 className="h1">{title}</h1></div></div>
      <List><Empty icon="info" title={uiText("stub.title")} detail={uiText("stub.detail")} /></List>
    </div>
  )
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

function RestartRows() {
  const status = useShellStatus()
  const toast = useToast()
  const restart = useMutation({
    mutationFn: (cliKind: string) => window.agentHub!.restartClient(cliKind),
    onSuccess: (result, cliKind) => result.ok
      ? toast.success(uiText("home.restart.done", { client: CLI_LABELS[cliKind as keyof typeof CLI_LABELS] ?? cliKind }))
      : toast.error(uiText("home.restart.failed"), result.detail),
    onError: error => toast.error(uiText("home.restart.failed"), error instanceof Error ? error.message : undefined),
  })
  if (status.restartPending.length === 0) return null
  return (
    <section className="section">
      <div className="section-h"><h2 className="h2">{uiText("home.pending")}</h2></div>
      <List>
        <RowHead>{uiText("nav.group.connections")}</RowHead>
        {status.restartPending.map(client => {
          const name = CLI_LABELS[client.cli_kind] ?? client.cli_kind
          return (
            <Row
              key={client.id}
              lead={<Avatar name={name} small />}
              title={uiText("home.restart.title", { client: name })}
              sub={uiText("home.restart.detail")}
              action={window.agentHub && <Button small disabled={restart.isPending} onClick={() => restart.mutate(client.cli_kind)}>{uiText("home.restart.action")}</Button>}
            />
          )
        })}
      </List>
    </section>
  )
}

/** Inicio provisorio: los reinicios pendientes de clientes y la revisión de memoria existente. */
export function InterimHome({ review }: { review: ReactNode }) {
  return (
    <div className="page">
      <div className="ph"><div className="ph-text"><h1 className="h1">{uiText("nav.home")}</h1></div></div>
      <RestartRows />
      {review}
    </div>
  )
}
