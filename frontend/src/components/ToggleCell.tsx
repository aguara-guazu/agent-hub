/** Una celda de la matriz: el estado de un recurso en un agente.
 *
 *  La celda tiene dos partes con responsabilidades distintas, y esa separacion es
 *  el punto del componente:
 *
 *  - QUE DECIDIO el hub (prendido, apagado, congelado, no elegible), que es lo que
 *    el usuario cambia con un click.
 *  - QUE ESTA PASANDO de verdad en el CLI, que es lo que devuelve `propagation` y
 *    puede contradecir a lo anterior. Un toggle en verde mientras Codex sigue
 *    listando la herramienta es una mentira, asi que los dos datos se dibujan
 *    siempre, nunca uno solo.
 *
 *  Ningun estado se distingue solo por color: cada uno tiene icono propio y texto.
 */

import type {
  AgentInstance,
  MatrixCell,
  MatrixRow,
  PropagationState,
  RuleScope,
  RuleState,
} from '../lib/types'
import { CLI_LABELS } from '../lib/types'
import { PROPAGATION_LABELS } from './Badge'

/** Los cinco estados que puede mostrar una celda.
 *
 *  Se fueron `locked` y `ineligible`: no hay quien congele una decision sobre tu
 *  propia maquina, y todo lo que aparece en la matriz es tuyo, asi que no existe
 *  celda que no puedas tocar. Queda `quarantined`, que no es autoridad de nadie
 *  sino integridad: el server cambio la definicion de una tool que ya usabas. */
export type CellVisual =
  | 'on_own'
  | 'on_inherited'
  | 'on_default'
  | 'off_own'
  | 'off_inherited'
  | 'quarantined'

/** Orden de la cadena de precedencia, el mismo de `resolver.LEVEL_ORDER`. */
export const WRITE_LEVELS: readonly RuleScope[] = ['user', 'client']

export const SCOPE_LABELS: Record<RuleScope, string> = {
  user: 'todos mis clientes',
  client: 'este cliente',
}

export const VISUAL_LABELS: Record<CellVisual, string> = {
  on_own: 'ON propio',
  on_inherited: 'ON heredado',
  on_default: 'ON por defecto',
  off_own: 'OFF propio',
  off_inherited: 'OFF heredado',
  quarantined: 'En cuarentena',
}

const VISUAL_HINTS: Record<CellVisual, string> = {
  on_own: 'lo prendiste en este nivel',
  on_inherited: 'lo prendiste para todos tus clientes',
  on_default: 'es tuyo y no lo apagaste en ningún lado',
  off_own: 'lo apagaste en este nivel',
  off_inherited: 'lo apagaste para todos tus clientes',
  quarantined: 'el server cambió su definición y espera que la mires',
}

/** Motivos del resolver que no son un nivel de la cadena. */
const GATE_REASONS: Record<string, string> = {
  quarantine: 'la herramienta está en cuarentena',
  server_off: 'el MCP server que la contiene no está expuesto',
  not_found: 'el recurso ya no existe',
  default_on: 'es tuyo y no lo apagaste en ningún nivel',
  inherited_from_server: 'hereda la decisión de su MCP server',
}

/** Regla propia en el nivel donde se esta escribiendo.
 *
 *  Los dos niveles son exactos y vienen en la respuesta: `own_rule` es la regla de
 *  ESTE cliente y `user_rule` la de la persona. Ya no hace falta deducir nada de
 *  `source`, que era la aproximacion conservadora que exigian los cuatro niveles.
 */
export function ownRuleAtScope(cell: MatrixCell, scope: RuleScope, row?: MatrixRow): RuleState | null {
  if (scope === 'client') return cell.own_rule
  return row ? row.user_rule : null
}

/** Regla propia de una FILA entera en el nivel de persona.
 *
 *  Escribir el nivel de persona no es por columna: toca la fila completa. Ese dato
 *  viene directo en `user_rule`, asi que no hay que reconciliar columnas.
 */
export function rowOwnRuleAtScope(row: MatrixRow, scope: RuleScope): RuleState | null {
  if (scope === 'user') return row.user_rule
  let seen: RuleState | null = null
  for (const cell of Object.values(row.cells)) {
    if (cell.own_rule === 'off') return 'off'
    if (cell.own_rule === 'on') seen = 'on'
  }
  return seen
}

export function cellVisual(row: MatrixRow, cell: MatrixCell, scope: RuleScope): CellVisual {
  if (cell.source === 'quarantine') return 'quarantined'
  const own = ownRuleAtScope(cell, scope, row)
  if (cell.exposed) {
    if (own === 'on') return 'on_own'
    return cell.source === 'default_on' || cell.source === 'inherited_from_server'
      ? 'on_default'
      : 'on_inherited'
  }
  return own === 'off' ? 'off_own' : 'off_inherited'
}

/** El ciclo del click: heredar -> OFF -> ON -> heredar.
 *
 *  Arranca en OFF y no en ON porque lo propio ya viene prendido: el primer click
 *  sobre algo que nunca tocaste tiene que hacer lo unico que falta hacer. */
export function nextRuleState(own: RuleState | null): RuleState {
  if (own === 'off') return 'on'
  if (own === 'on') return 'inherit'
  return 'off'
}

const NEXT_LABELS: Record<RuleState, string> = {
  on: 'prenderlo',
  off: 'apagarlo',
  inherit: 'volver a heredar',
}

/** Que esta mostrando el CLI de verdad, dicho sin eufemismos. */
export function propagationMessage(state: PropagationState, cliLabel: string): string {
  switch (state) {
    case 'applied_live':
      return `Aplicado en el hub y ${cliLabel} ya refrescó su lista.`
    case 'applied_stale_list':
      return `Aplicado en el hub; ${cliLabel} sigue mostrando la herramienta hasta que lo reinicies. Si el modelo la llama, el gateway la deniega.`
    case 'pending_restart':
      return `Aplicado en el hub; ${cliLabel} no va a ver el cambio hasta que lo reinicies.`
    case 'pending_sync':
      return `El daemon todavía no bajó el snapshot nuevo: ${cliLabel} sigue con la lista anterior.`
    case 'unknown':
      return `${cliLabel} nunca se conectó al hub: no hay forma de saber qué está mostrando.`
  }
}

/* -------------------------------------------------------------------------- */
/* Iconos                                                                       */
/* -------------------------------------------------------------------------- */

/** Cada estado tiene forma propia ademas de color: circulo lleno, circulo
 *  punteado, candado, prohibido. Sirven en escala de grises. */
function StateIcon({ visual }: { visual: CellVisual }) {
  const common = { width: 13, height: 13, viewBox: '0 0 16 16', 'aria-hidden': true } as const
  const stroke = 'currentColor'
  switch (visual) {
    case 'on_own':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="7" fill={stroke} />
          <path d="M4.5 8.4l2.4 2.4 4.6-5.2" fill="none" stroke="var(--surface)" strokeWidth="2" />
        </svg>
      )
    case 'on_inherited':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.5" fill="none" stroke={stroke} strokeWidth="1.5" strokeDasharray="3 2" />
          <path d="M4.5 8.4l2.4 2.4 4.6-5.2" fill="none" stroke={stroke} strokeWidth="1.8" />
        </svg>
      )
    case 'off_own':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="7" fill={stroke} />
          <path d="M5 5l6 6M11 5l-6 6" fill="none" stroke="var(--surface)" strokeWidth="2" />
        </svg>
      )
    case 'off_inherited':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.5" fill="none" stroke={stroke} strokeWidth="1.5" strokeDasharray="3 2" />
          <path d="M5 5l6 6M11 5l-6 6" fill="none" stroke={stroke} strokeWidth="1.8" />
        </svg>
      )
    case 'on_default':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.5" fill="none" stroke={stroke} strokeWidth="1.4" strokeDasharray="1 2" />
          <path d="M4.8 8.4l2.3 2.3 4.3-4.9" fill="none" stroke={stroke} strokeWidth="1.6" />
        </svg>
      )
    case 'quarantined':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.5" fill="none" stroke={stroke} strokeWidth="1.6" />
          <path d="M8 4.4v4.2" fill="none" stroke={stroke} strokeWidth="1.8" />
          <circle cx="8" cy="11.4" r="0.95" fill={stroke} />
        </svg>
      )
  }
}

function PropagationIcon({ state }: { state: PropagationState }) {
  const common = { width: 11, height: 11, viewBox: '0 0 16 16', 'aria-hidden': true } as const
  const stroke = 'currentColor'
  switch (state) {
    case 'applied_live':
      return (
        <svg {...common}>
          <path d="M3 8.6l3 3 7-7.6" fill="none" stroke={stroke} strokeWidth="2.2" />
        </svg>
      )
    case 'applied_stale_list':
      // Triangulo de alerta: el gateway ya deniega pero el CLI sigue listando.
      return (
        <svg {...common}>
          <path d="M8 1.5L15 14H1z" fill="none" stroke={stroke} strokeWidth="1.6" />
          <path d="M8 6v4" fill="none" stroke={stroke} strokeWidth="1.6" />
          <circle cx="8" cy="12" r="0.9" fill={stroke} />
        </svg>
      )
    case 'pending_restart':
      return (
        <svg {...common}>
          <path d="M13 8a5 5 0 11-1.8-3.8" fill="none" stroke={stroke} strokeWidth="1.8" />
          <path d="M13 1.5V5H9.5" fill="none" stroke={stroke} strokeWidth="1.8" />
        </svg>
      )
    case 'pending_sync':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.5" fill="none" stroke={stroke} strokeWidth="1.5" />
          <path d="M8 4v4.4l2.8 1.8" fill="none" stroke={stroke} strokeWidth="1.6" />
        </svg>
      )
    case 'unknown':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.5" fill="none" stroke={stroke} strokeWidth="1.4" strokeDasharray="2 2" />
          <path d="M6.2 6.2a1.9 1.9 0 113 1.6c-.7.5-1.2.8-1.2 1.6" fill="none" stroke={stroke} strokeWidth="1.4" />
          <circle cx="8" cy="12" r="0.8" fill={stroke} />
        </svg>
      )
  }
}

/* -------------------------------------------------------------------------- */
/* Celda                                                                        */
/* -------------------------------------------------------------------------- */

export interface ToggleCellProps {
  row: MatrixRow
  cell: MatrixCell | undefined
  agent: AgentInstance
  /** Nivel en el que se escribe. Decide que se lee como propio y que como heredado. */
  scope: RuleScope
  /** Nombre del nivel tal como lo muestra el selector, para los textos de ayuda. */
  scopeLabel: string
  /** True mientras hay una escritura en vuelo que afecta a esta fila. */
  pending?: boolean
  onToggle: (row: MatrixRow, agent: AgentInstance) => void
  onExplain: (row: MatrixRow, agent: AgentInstance) => void
}

export function ToggleCell({
  row,
  cell,
  agent,
  scope,
  scopeLabel,
  pending = false,
  onToggle,
  onExplain,
}: ToggleCellProps) {
  const cliLabel = CLI_LABELS[agent.cli_kind]

  if (cell === undefined) {
    return (
      <td className="matrix-cell">
        <span className="cell-empty" title="La matriz no trae este agente para este recurso.">
          —
        </span>
      </td>
    )
  }

  const visual = cellVisual(row, cell, scope)
  const interactive = visual !== 'quarantined'
  const own = ownRuleAtScope(cell, scope, row)
  const label = VISUAL_LABELS[visual]

  const reasons: string[] = [`${label}: ${VISUAL_HINTS[visual]}.`]
  if (visual === 'quarantined') {
    if (cell.detail) reasons.push(cell.detail)
    reasons.push('Tocar el toggle no va a servir: revisá la definición nueva en el catálogo.')
  } else {
    if (cell.detail) reasons.push(cell.detail)
    else if (GATE_REASONS[cell.source]) reasons.push(GATE_REASONS[cell.source])
    reasons.push(`Un click en «${scopeLabel}»: ${NEXT_LABELS[nextRuleState(own)]}.`)
  }
  const toggleTitle = reasons.join(' ')

  const propagationText = propagationMessage(cell.propagation, cliLabel)
  const boxClass = `cell-box${pending ? ' cell-pending' : ''}`
  const stateClass = `cell-${visual.replace('_', '-')}`

  return (
    <td className="matrix-cell" data-state={visual} data-propagation={cell.propagation}>
      <div className={boxClass}>
        {interactive ? (
          <button
            type="button"
            className={`cell-toggle ${stateClass}`}
            title={toggleTitle}
            aria-label={`${row.label} en ${cliLabel}: ${label}. Cambiar en «${scopeLabel}».`}
            onClick={() => onToggle(row, agent)}
          >
            <span className="cell-icon">
              <StateIcon visual={visual} />
            </span>
            <span className="cell-text">{label}</span>
          </button>
        ) : (
          // En cuarentena no es un boton deshabilitado, directamente no es un
          // control. Un boton apagado invita a insistir.
          <span className={`cell-static ${stateClass}`} title={toggleTitle} aria-disabled="true">
            <span className="cell-icon">
              <StateIcon visual={visual} />
            </span>
            <span className="cell-text">{label}</span>
          </span>
        )}

        <button
          type="button"
          className={`cell-prop cell-prop-${cell.propagation}`}
          title={propagationText}
          aria-label={`Explicar ${row.label} en ${cliLabel}. ${propagationText}`}
          onClick={() => onExplain(row, agent)}
        >
          <span className="cell-icon">
            <PropagationIcon state={cell.propagation} />
          </span>
          <span className="cell-prop-label">{PROPAGATION_LABELS[cell.propagation]}</span>
        </button>
      </div>
      <span className="sr-only">{propagationText}</span>
    </td>
  )
}

/** Muestra de un estado para la leyenda. */
export function CellLegendItem({ visual }: { visual: CellVisual }) {
  return (
    <span className="matrix-legend-item">
      <span className={`cell-icon cell-${visual.replace('_', '-')}`} style={{ border: 'none', background: 'none' }}>
        <StateIcon visual={visual} />
      </span>
      {VISUAL_LABELS[visual]}
    </span>
  )
}

export default ToggleCell
