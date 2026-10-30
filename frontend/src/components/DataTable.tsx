/** Tabla de datos de la consola y utilidades de presentacion compartidas.
 *
 *  Existe para que ninguna pantalla se olvide de los tres estados: cargando, error
 *  y vacio. El cuerpo de la tabla nunca queda en blanco; si no hay filas, se dice
 *  por que.
 *
 *  Los formateadores de fecha viven aca, y no en un lib/ nuevo, porque los usan
 *  varias pantallas de este mismo encargo y son puro formato de celda.
 */

import { Fragment } from "react"
import type { ReactNode } from "react"

import { ErrorState } from "./ErrorState"
import { LoadingBlock } from "./Spinner"

export interface Column<T> {
  /** Identificador estable de la columna; tambien es la key de React. */
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  /** Clases del `td`: `num` alinea a la derecha, `wrap` permite cortar la linea. */
  className?: string
  headerClassName?: string
}

export interface DataTableProps<T> {
  columns: readonly Column<T>[]
  rows: readonly T[]
  rowKey: (row: T) => string
  /** Primera carga. Un refetch en segundo plano no debe vaciar la tabla. */
  loading?: boolean
  loadingLabel?: string
  /** Solo se muestra como pantalla de error si ademas no hay filas que mostrar. */
  error?: unknown
  onRetry?: () => void
  empty?: ReactNode
  rowClassName?: (row: T) => string | undefined
  /** Atributo `id` de la fila, para enlazar o desplazarse hasta ella. */
  rowId?: (row: T) => string | undefined
  /** Fila extra debajo de la fila normal, para el detalle expandido. */
  renderDetail?: (row: T) => ReactNode
  /** Descripcion para lectores de pantalla. */
  caption?: string
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  loadingLabel,
  error,
  onRetry,
  empty = "No hay nada para mostrar.",
  rowClassName,
  rowId,
  renderDetail,
  caption,
}: DataTableProps<T>) {
  if (loading) return <LoadingBlock label={loadingLabel ?? "Cargando…"} />
  if (error !== undefined && error !== null && rows.length === 0) {
    return <ErrorState error={error} onRetry={onRetry} />
  }
  if (rows.length === 0) return <div className="empty">{empty}</div>

  return (
    <div className="table-wrap">
      <table className="table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={column.headerClassName}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row)
            const detail = renderDetail?.(row)
            return (
              <Fragment key={key}>
                <tr id={rowId?.(row)} className={rowClassName?.(row)}>
                  {columns.map((column) => (
                    <td key={column.key} className={column.className}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
                {detail !== undefined && detail !== null && detail !== false && (
                  <tr className="detail-row">
                    <td colSpan={columns.length} className="wrap">
                      {detail}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Formato de celdas                                                            */
/* -------------------------------------------------------------------------- */

/** Recorta un hash para la celda dejando el completo en el tooltip. */
export function shortHash(value: string | null | undefined, size = 10): string {
  if (!value) return "—"
  return value.length <= size ? value : `${value.slice(0, size)}…`
}

export default DataTable
