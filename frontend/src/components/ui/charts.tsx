import { useEffect, useRef, useState } from "react"

const HEIGHT = 96
const BASE = 80
const TOP = 4
const DEFAULT_WIDTH = 480

/** Ancho real del contenedor para que el SVG no deforme el texto ni los trazos. */
function useWidth() {
  const ref = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const update = () => { if (node.clientWidth > 0) setWidth(node.clientWidth) }
    update()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

/** Marcas del eje: primera, central y última etiqueta. */
function axisIndexes(count: number): number[] {
  if (count <= 1) return count === 1 ? [0] : []
  if (count === 2) return [0, 1]
  return [0, Math.floor((count - 1) / 2), count - 1]
}

function anchorFor(position: number, last: number): "start" | "middle" | "end" {
  if (position === 0) return "start"
  return position === last ? "end" : "middle"
}

export interface BarChartPoint { label: string; value: number; tooltip: string }

export interface BarChartProps {
  title: string
  value: string
  subtitle?: string
  points: readonly BarChartPoint[]
  ariaLabel: string
}

/** Barras de una sola serie. Cada barra lleva `<title>` con valor y momento. */
export function BarChart({ title, value, subtitle, points, ariaLabel }: BarChartProps) {
  const { ref, width } = useWidth()
  const max = Math.max(0, ...points.map(point => point.value))
  const slot = points.length > 0 ? width / points.length : width
  const barWidth = Math.max(1, slot * 0.7)
  const marks = axisIndexes(points.length)
  return (
    <figure className="chart" style={{ margin: 0 }}>
      <div className="chart-h"><span>{title}</span><strong>{value}</strong></div>
      {subtitle && <div className="chart-s">{subtitle}</div>}
      <svg ref={ref} className="chart-svg" viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={ariaLabel}>
        <line className="chart-base" x1={0} y1={BASE} x2={width} y2={BASE} />
        {points.map((point, index) => {
          if (point.value <= 0 || max <= 0) return null
          const height = Math.max(1, (point.value / max) * (BASE - TOP))
          return (
            <rect key={`${point.label}:${index}`} className="chart-bar" x={index * slot + (slot - barWidth) / 2} y={BASE - height} width={barWidth} height={height}>
              <title>{point.tooltip}</title>
            </rect>
          )
        })}
        {marks.map((index, position) => {
          const point = points[index]
          if (!point) return null
          const x = position === 0 ? 0 : position === marks.length - 1 ? width : index * slot + slot / 2
          return <text key={index} className="chart-axis" x={x} y={HEIGHT - 2} textAnchor={anchorFor(position, marks.length - 1)}>{point.label}</text>
        })}
      </svg>
    </figure>
  )
}

export interface LineChartProps {
  points: readonly { x: string; y: number | null }[]
  marks: readonly { x: string; label: string }[]
  threshold?: { y: number; label: string }
  ariaLabel: string
}

/** Curva de una sola serie con marcas verticales de eventos y una línea de referencia opcional. */
export function LineChart({ points, marks, threshold, ariaLabel }: LineChartProps) {
  const { ref, width } = useWidth()
  const values = points.flatMap(point => (point.y === null ? [] : [point.y]))
  const max = Math.max(threshold?.y ?? 0, ...values, 1)
  const step = points.length > 1 ? width / (points.length - 1) : 0
  const xAt = (index: number) => (points.length > 1 ? index * step : width / 2)
  const yAt = (value: number) => BASE - (value / max) * (BASE - TOP)

  // Un valor nulo corta la línea en tramos.
  const segments: string[] = []
  let current: string[] = []
  points.forEach((point, index) => {
    if (point.y === null) {
      if (current.length) segments.push(current.join(" "))
      current = []
      return
    }
    current.push(`${current.length ? "L" : "M"}${xAt(index).toFixed(1)} ${yAt(point.y).toFixed(1)}`)
  })
  if (current.length) segments.push(current.join(" "))

  const axis = axisIndexes(points.length)
  return (
    <svg ref={ref} className="chart-svg" viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={ariaLabel}>
      <line className="chart-base" x1={0} y1={BASE} x2={width} y2={BASE} />
      {threshold && (
        <>
          <line className="chart-limit" x1={0} y1={yAt(threshold.y)} x2={width} y2={yAt(threshold.y)} />
          <text className="chart-axis" x={width} y={Math.max(10, yAt(threshold.y) - 3)} textAnchor="end">{threshold.label}</text>
        </>
      )}
      {marks.map(mark => {
        const index = points.findIndex(point => point.x === mark.x)
        if (index < 0) return null
        return (
          <line key={`${mark.x}:${mark.label}`} className="chart-mark" x1={xAt(index)} y1={TOP} x2={xAt(index)} y2={BASE}>
            <title>{mark.label}</title>
          </line>
        )
      })}
      {segments.map(path => <path key={path} className="chart-line" d={path} />)}
      {axis.map((index, position) => {
        const point = points[index]
        if (!point) return null
        return <text key={index} className="chart-axis" x={position === 0 ? 0 : position === axis.length - 1 ? width : xAt(index)} y={HEIGHT - 2} textAnchor={anchorFor(position, axis.length - 1)}>{point.x}</text>
      })}
    </svg>
  )
}

export interface BarListItem { label: string; value: string; ratio: number }

/** Barras horizontales de mayor a menor. `ratio` va de 0 a 1. */
export function BarList({ items }: { items: readonly BarListItem[] }) {
  return (
    <ul className="barlist">
      {items.map(item => (
        <li key={item.label} className="barlist-row">
          <span title={item.label}>{item.label}</span>
          <span>{item.value}</span>
          <span className="barlist-track" aria-hidden="true"><span className="barlist-fill" style={{ width: `${Math.round(Math.min(1, Math.max(0, item.ratio)) * 100)}%` }} /></span>
        </li>
      ))}
    </ul>
  )
}
