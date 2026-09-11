/** Selector del nivel en el que se escriben las reglas.
 *
 *  Ahora hay exactamente dos, y las dos son de la persona: "todos mis clientes" y
 *  "este cliente". No existe un nivel de organizacion ni de squad, porque los MCP
 *  servers corren en la maquina de su dueno y nadie manda sobre ellos desde afuera.
 *
 *  La barra se mantiene igual de explicita que cuando habia cuatro niveles: elegir
 *  mal sigue siendo el error mas facil de esta pantalla —apagar algo en todas
 *  partes cuando solo molestaba en un cliente— y el texto dice a quien afecta lo
 *  proximo que se toque.
 */

import type { MatrixResponse, RuleScope } from '../lib/types'
import { SCOPE_LABELS } from './ToggleCell'

export interface ScopeOption {
  /** Identificador estable del boton: `scope:scope_id`. */
  key: string
  scope: RuleScope
  /** Lo que viaja como `scope_id` en PUT /policy/rules. Vacio en los dos casos:
   *  en `user` el backend usa a quien escribe, y en `client` el id lo aporta la
   *  columna que se toca. */
  scopeId: string
  label: string
  /** A quien afecta. Se muestra siempre, no solo en el tooltip. */
  hint: string
}

export function scopeKeyOf(scope: RuleScope, scopeId: string): string {
  return `${scope}:${scopeId}`
}

/** Niveles disponibles para una matriz concreta.
 *
 *  El orden es de mas general a mas especifico, el mismo de la cadena de
 *  precedencia, para que la barra se lea como se resuelve. */
export function buildScopeOptions(_matrix: MatrixResponse, agentCount: number): ScopeOption[] {
  const cuantos = agentCount === 1 ? 'mi único cliente' : `mis ${agentCount} clientes`
  return [
    {
      key: scopeKeyOf('user', ''),
      scope: 'user',
      scopeId: '',
      label: 'Todos mis clientes',
      hint: `afecta a ${cuantos}`,
    },
    {
      key: scopeKeyOf('client', ''),
      scope: 'client',
      scopeId: '',
      label: 'Este cliente',
      hint: 'afecta solo a la columna que toques',
    },
  ]
}

export interface ScopeSelectorProps {
  options: readonly ScopeOption[]
  value: string
  onChange: (key: string) => void
  /** Motivo opcional que acompaña a cada escritura y queda en el ledger. */
  reason: string
  onReasonChange: (reason: string) => void
}

export function ScopeSelector({ options, value, onChange, reason, onReasonChange }: ScopeSelectorProps) {
  const active = options.find((option) => option.key === value) ?? options[options.length - 1]

  return (
    <section className="matrix-scope" aria-label="Nivel de escritura">
      <div className="matrix-scope-head">
        <span className="matrix-scope-label">Escribiendo en el nivel</span>
        <strong className="matrix-scope-current" data-testid="scope-actual">
          {active.label}
        </strong>
        <span className="matrix-scope-hint">— {active.hint}</span>
      </div>

      <div className="matrix-scope-options" role="group" aria-label="Elegir nivel de escritura">
        {options.map((option) => (
          <button
            key={option.key}
            type="button"
            className="scope-option"
            aria-pressed={option.key === value}
            title={option.hint}
            onClick={() => onChange(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="matrix-scope-extra">
        <div className="field">
          <label htmlFor="matrix-reason">Motivo (opcional, queda en la auditoría)</label>
          <input
            id="matrix-reason"
            type="text"
            value={reason}
            maxLength={500}
            placeholder={`Por qué se cambia en ${SCOPE_LABELS[active.scope]}`}
            onChange={(event) => onReasonChange(event.target.value)}
          />
        </div>
      </div>
    </section>
  )
}

export default ScopeSelector
