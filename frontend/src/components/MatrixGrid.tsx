/** La grilla: recursos en filas, agentes en columnas.
 *
 *  Las filas son jerarquicas (cada mcp_server con sus mcp_tool anidadas y
 *  colapsables, y despues las skills) y vienen ya filtradas y ordenadas por la
 *  pagina: este componente no decide que se ve, solo lo dibuja.
 *
 *  Sin virtualizacion a proposito. El caso de referencia son 40 recursos por 4
 *  agentes, o sea 160 celdas; un DOM de ese tamano no necesita ventana y meterla
 *  a mano romperia los encabezados pegajosos y el buscador del navegador.
 */

import type { AgentInstance, MatrixRow , RuleScope } from '../lib/types'
import { CLI_LABELS } from '../lib/types'
import { Badge } from './Badge'
import { ToggleCell } from './ToggleCell'

/** Clave estable de una fila. El id solo no alcanza: los tipos de recurso son
 *  tablas distintas y podrian repetir id. */
export function rowKey(row: MatrixRow): string {
  return `${row.resource_type}:${row.resource_id}`
}

export interface MatrixGridProps {
  agents: readonly AgentInstance[]
  /** Filas ya filtradas y con las tools de servers colapsados removidas. */
  rows: readonly MatrixRow[]
  /** Cuantas tools tiene cada server DESPUES del filtro, para el contador y el
   *  chevron: un server sin tools visibles no se colapsa. */
  toolCounts: Readonly<Record<string, number>>
  collapsed: ReadonlySet<string>
  onToggleCollapse: (serverId: string) => void
  selected: ReadonlySet<string>
  onToggleSelected: (key: string) => void
  onSelectAll: (select: boolean) => void
  /** Servers con una escritura en vuelo: sus tools todavia muestran el estado viejo. */
  recalculating: ReadonlySet<string>
  scope: RuleScope
  scopeLabel: string
  onToggleCell: (row: MatrixRow, agent: AgentInstance) => void
  onExplain: (row: MatrixRow, agent: AgentInstance) => void
}

function AgentHeader({ agent }: { agent: AgentInstance }) {
  return (
    <div className="matrix-agent">
      <span className="matrix-agent-cli">{CLI_LABELS[agent.cli_kind]}</span>
      <span className="matrix-agent-host" title={`Máquina ${agent.machine_hostname}`}>
        {agent.machine_hostname}
      </span>
      <span className="matrix-agent-flags">
        {agent.hot_reload ? (
          <Badge tone="on" title="Refresca su lista de herramientas sin reiniciar.">
            en caliente
          </Badge>
        ) : (
          <Badge
            tone="stale"
            title="No refresca en caliente: sigue listando lo que tenía hasta que se reinicie."
          >
            requiere reinicio
          </Badge>
        )}
        {!agent.enabled && (
          <Badge tone="off" title="El agente está deshabilitado desde la consola.">
            apagado
          </Badge>
        )}
        {agent.drift_detected && (
          <Badge tone="locked" title={agent.drift_detail || 'Alguien editó la configuración a mano.'}>
            deriva
          </Badge>
        )}
      </span>
    </div>
  )
}

export function MatrixGrid({
  agents,
  rows,
  toolCounts,
  collapsed,
  onToggleCollapse,
  selected,
  onToggleSelected,
  onSelectAll,
  recalculating,
  scope,
  scopeLabel,
  onToggleCell,
  onExplain,
}: MatrixGridProps) {
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(rowKey(row)))

  return (
    <div className="matrix-wrap">
      <table className="matrix-table">
        <thead>
          <tr>
            <th scope="col" className="matrix-col-pick matrix-sticky-left">
              <input
                type="checkbox"
                checked={allSelected}
                aria-label="Seleccionar todas las filas visibles"
                onChange={(event) => onSelectAll(event.target.checked)}
              />
            </th>
            <th scope="col" className="matrix-col-resource matrix-sticky-left">
              Recurso
            </th>
            {agents.map((agent) => (
              <th key={agent.id} scope="col">
                <AgentHeader agent={agent} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row)
            const isTool = row.resource_type === 'mcp_tool'
            const tools = row.resource_type === 'mcp_server' ? (toolCounts[row.resource_id] ?? 0) : 0
            const isCollapsed = collapsed.has(row.resource_id)
            const recalc = isTool && row.parent_id !== null && recalculating.has(row.parent_id)
            const classes = ['matrix-row', `matrix-row-${row.resource_type.replace('_', '-')}`]
            if (selected.has(key)) classes.push('matrix-row-selected')
            if (recalc) classes.push('matrix-row-recalc')

            return (
              <tr key={key} className={classes.join(' ')} data-row={key}>
                <td className="matrix-col-pick matrix-sticky-left">
                  <input
                    type="checkbox"
                    checked={selected.has(key)}
                    aria-label={`Seleccionar ${row.label}`}
                    onChange={() => onToggleSelected(key)}
                  />
                </td>
                <td className="matrix-col-resource matrix-sticky-left">
                  <div className="matrix-resource">
                    {tools > 0 ? (
                      <button
                        type="button"
                        className="matrix-chevron"
                        aria-expanded={!isCollapsed}
                        aria-label={`${isCollapsed ? 'Mostrar' : 'Ocultar'} las ${tools} herramientas de ${row.label}`}
                        onClick={() => onToggleCollapse(row.resource_id)}
                      >
                        {isCollapsed ? '+' : '−'}
                      </button>
                    ) : (
                      <span className="matrix-chevron-spacer" />
                    )}
                    <span className="matrix-resource-name">
                      <span className="matrix-resource-label" title={row.description || row.label}>
                        {row.label}
                        {tools > 0 && <span className="muted"> · {tools} tools</span>}
                      </span>
                      <span className="matrix-resource-slug">{row.slug}</span>
                    </span>
                    {row.user_rule !== null && (
                      <Badge
                        tone={row.user_rule === 'on' ? 'on' : 'off'}
                        title={`Tenés una regla propia para todos tus clientes: ${row.user_rule.toUpperCase()}.`}
                      >
                        {row.user_rule.toUpperCase()} en todos
                      </Badge>
                    )}
                    {recalc && (
                      <Badge tone="stale" title="El MCP server que la contiene está cambiando; el valor real llega con el refresco.">
                        recalculando
                      </Badge>
                    )}
                  </div>
                </td>
                {agents.map((agent) => (
                  <ToggleCell
                    key={agent.id}
                    row={row}
                    cell={row.cells[agent.id]}
                    agent={agent}
                    scope={scope}
                    scopeLabel={scopeLabel}
                    pending={recalc}
                    onToggle={onToggleCell}
                    onExplain={onExplain}
                  />
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default MatrixGrid
