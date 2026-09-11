/** Indicadores de carga. Sin dependencias externas: es un borde girando. */

export interface SpinnerProps {
  /** Lado del cuadrado en pixeles. */
  size?: number
  /** Texto para lectores de pantalla; el spinner solo no dice nada. */
  label?: string
}

export function Spinner({ size = 14, label = 'Cargando' }: SpinnerProps) {
  return (
    <span
      className="spinner"
      role="status"
      aria-live="polite"
      style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 7)) }}
    >
      <span className="sr-only">{label}</span>
    </span>
  )
}

export interface LoadingBlockProps {
  label?: string
  /** Ocupa alto de pantalla completa. Para el arranque de la sesion y los lazy. */
  full?: boolean
}

/** Bloque centrado para reemplazar el contenido de un panel mientras carga. */
export function LoadingBlock({ label = 'Cargando…', full = false }: LoadingBlockProps) {
  return (
    <div className={full ? 'loading-block loading-page' : 'loading-block'}>
      <Spinner label={label} />
      <span>{label}</span>
    </div>
  )
}

export default Spinner
