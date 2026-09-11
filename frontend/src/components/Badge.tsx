/** Etiqueta compacta de estado. El color sale de tokens.css; el tono se elige aca. */

import type { ReactNode } from 'react'

import type { PropagationState, RuleState } from '../lib/types'

export type BadgeTone = 'neutral' | 'on' | 'off' | 'stale' | 'locked' | 'accent' | 'inherit'

export interface BadgeProps {
  tone?: BadgeTone
  children: ReactNode
  /** Tooltip nativo: la matriz lo usa para explicar la celda sin abrir nada. */
  title?: string
  className?: string
}

export function Badge({ tone = 'neutral', children, title, className }: BadgeProps) {
  const classes = ['badge']
  if (tone !== 'neutral') classes.push(`badge-${tone}`)
  if (className) classes.push(className)
  return (
    <span className={classes.join(' ')} title={title}>
      {children}
    </span>
  )
}

/** Tono para el estado de propagacion de un cambio hacia un agente.
 *  `applied_stale_list` va en tono de alerta a proposito: el gateway ya deniega
 *  pero el CLI sigue listando la herramienta, y eso hay que verlo. */
export function badgeToneForPropagation(state: PropagationState): BadgeTone {
  switch (state) {
    case 'applied_live':
      return 'on'
    case 'applied_stale_list':
    case 'pending_restart':
    case 'pending_sync':
      return 'stale'
    default:
      return 'neutral'
  }
}

export function badgeToneForRule(state: RuleState | null): BadgeTone {
  if (state === 'on') return 'on'
  if (state === 'off') return 'off'
  return 'inherit'
}

export const PROPAGATION_LABELS: Record<PropagationState, string> = {
  applied_live: 'Aplicado',
  applied_stale_list: 'Lista desactualizada',
  pending_restart: 'Requiere reinicio',
  pending_sync: 'Pendiente de sync',
  unknown: 'Sin datos',
}

export default Badge
