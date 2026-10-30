/** Etiqueta compacta de estado. El color sale de tokens.css; el tono se elige aca. */

import type { ReactNode } from "react"

export type BadgeTone = "neutral" | "on" | "off" | "stale" | "locked" | "accent" | "inherit"

export interface BadgeProps {
  tone?: BadgeTone
  children: ReactNode
  /** Tooltip nativo: la matriz lo usa para explicar la celda sin abrir nada. */
  title?: string
  className?: string
}

export function Badge({ tone = "neutral", children, title, className }: BadgeProps) {
  const classes = ["badge"]
  if (tone !== "neutral") classes.push(`badge-${tone}`)
  if (className) classes.push(className)
  return (
    <span className={classes.join(" ")} title={title}>
      {children}
    </span>
  )
}

export default Badge
