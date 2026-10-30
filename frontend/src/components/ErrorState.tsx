/** Compatibilidad: el estado de error vive en el kit (ui/display), que traduce con `errorKey`. */

import { ApiError } from "../lib/api"
import { ErrorState as KitErrorState } from "./ui/display"

/** Mensaje de las vistas previas al rediseño (prioriza el texto del servidor); las vistas nuevas usan `errorKey`. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "La sesión venció o el token no es válido. Volvé a iniciar sesión."
    if (error.status === 403) return error.message || "No tenés permisos para esta operación."
    if (error.status === 404) return error.message || "El recurso no existe."
    if (error.status >= 500) return `Error del servidor (${error.status}). Volvé a intentarlo.`
    return error.message || `Error ${error.status}.`
  }
  if (error instanceof TypeError) return "No se pudo contactar al control plane. Verificá que esté levantado."
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Error desconocido."
}

export interface ErrorStateProps {
  error: unknown
  title?: string
  onRetry?: () => void
}

export function ErrorState(props: ErrorStateProps) {
  return <KitErrorState {...props} />
}

export default ErrorState
