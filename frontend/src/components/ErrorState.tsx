/** Presentacion de errores de la API y traduccion de excepciones a texto. */

import { ApiError } from '../lib/api'

/** Convierte cualquier cosa lanzada en un mensaje mostrable.
 *  Los mensajes del backend ya vienen en espanol; los de red no, y los reemplazamos. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'La sesión venció o el token no es válido. Vuelve a iniciar sesión.'
    if (error.status === 403) return error.message || 'No tienes permisos para esta operación.'
    if (error.status === 404) return error.message || 'El recurso no existe.'
    if (error.status >= 500) return `Error del servidor (${error.status}). Vuelve a intentarlo.`
    return error.message || `Error ${error.status}.`
  }
  if (error instanceof TypeError) return 'No se pudo contactar al control plane. Verifica que esté levantado.'
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Error desconocido.'
}

/** Codigo HTTP cuando el error viene de la API, o null. */
export function errorStatus(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null
}

export interface ErrorStateProps {
  error: unknown
  /** Encabezado. Por defecto describe un fallo de carga. */
  title?: string
  /** Si viene, se muestra el boton de reintentar. */
  onRetry?: () => void
}

export function ErrorState({ error, title = 'No se pudo cargar', onRetry }: ErrorStateProps) {
  const status = errorStatus(error)
  return (
    <div className="error-state" role="alert">
      <h3>{title}</h3>
      <p>{errorMessage(error)}</p>
      {status !== null && <pre>HTTP {status}</pre>}
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Reintentar
        </button>
      )}
    </div>
  )
}

export default ErrorState
