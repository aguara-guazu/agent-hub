/** Explicacion de una celda: la cadena de decision completa.
 *
 *  Pide `GET /policy/explain` en cada apertura en vez de reusar la celda de la
 *  matriz. Es a proposito: la matriz puede estar pintada de forma optimista y esta
 *  ventana es justamente donde alguien viene a verificar por que ve lo que ve.
 *  Por eso tampoco se cachea.
 */

import { useEffect, useState } from 'react'

import { api } from '../lib/api'
import type { AgentInstance, Explanation, MatrixCell, MatrixRow, RuleScope } from '../lib/types'
import { CLI_LABELS } from '../lib/types'
import { errorMessage } from './ErrorState'
import { Modal } from './Modal'
import { Spinner } from './Spinner'
import { SCOPE_LABELS, WRITE_LEVELS, propagationMessage } from './ToggleCell'

/** Motivos que no son un nivel de la cadena sino una compuerta anterior a ella.
 *  Refleja la cadena de decisiones de `packages/core/src/policy/resolver.ts`. */
const GATE_TITLES: Record<string, string> = {
  quarantine: 'En cuarentena',
  server_off: 'El MCP server no está expuesto',
  not_found: 'El recurso no existe',
  inherited_from_server: 'Heredado del MCP server',
  default_on: 'Prendido por defecto',
}

export interface ExplainTarget {
  row: MatrixRow
  agent: AgentInstance
  cell: MatrixCell | undefined
}

export interface ExplainPopoverProps {
  target: ExplainTarget | null
  scope: RuleScope
  onClose: () => void
}

function Step({
  level,
  state,
  text,
}: {
  level: string
  state: 'decided' | 'idle'
  text: string
}) {
  const className =
    state === 'decided' ? 'explain-step explain-step-decided' : 'explain-step explain-step-idle'
  return (
    <li className={className}>
      <span className="explain-step-level">{level}</span>
      <span>{text}</span>
    </li>
  )
}

function Chain({ explanation }: { explanation: Explanation }) {
  const gate = GATE_TITLES[explanation.source]
  const sourceIsLevel = WRITE_LEVELS.includes(explanation.source as RuleScope)

  return (
    <ol className="explain-chain">
      {gate !== undefined && !sourceIsLevel && (
        <li className={explanation.exposed ? 'explain-step' : 'explain-step explain-gate'}>
          <span className="explain-step-level">{gate}</span>
          <span>{explanation.detail || 'Decidido antes de recorrer la cadena de niveles.'}</span>
        </li>
      )}

      {WRITE_LEVELS.map((level) => {
        const label = SCOPE_LABELS[level]
        if (explanation.source === level) {
          return (
            <Step
              key={level}
              level={label}
              state="decided"
              text={`${explanation.exposed ? 'Prendió' : 'Apagó'} el recurso. ${explanation.detail}`}
            />
          )
        }
        return <Step key={level} level={label} state="idle" text="No opina." />
      })}
    </ol>
  )
}

export function ExplainPopover({ target, scope, onClose }: ExplainPopoverProps) {
  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(false)

  const agentId = target?.agent.id ?? ''
  const resourceType = target?.row.resource_type ?? ''
  const resourceId = target?.row.resource_id ?? ''

  useEffect(() => {
    if (agentId === '' || resourceId === '') return
    let cancelled = false
    setLoading(true)
    setError(null)
    setExplanation(null)
    const query = new URLSearchParams({
      agent_id: agentId,
      resource_type: resourceType,
      resource_id: resourceId,
    })
    api
      .get<Explanation>(`/policy/explain?${query.toString()}`)
      .then((data) => {
        if (!cancelled) setExplanation(data)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId, resourceType, resourceId])

  if (target === null) return null

  const cliLabel = CLI_LABELS[target.agent.cli_kind]

  return (
    <Modal open title="Cadena de decisión" onClose={onClose} width={640}>
      <div className="explain-head">
        <span className="explain-resource">{target.row.label}</span>
        <span className="mono muted">{target.row.slug}</span>
        <span className="muted">
          en {cliLabel} · {target.agent.machine_hostname}
        </span>
      </div>

      {loading && <Spinner label="Consultando /policy/explain…" />}
      {error !== null && (
        <p role="alert" className="explain-note">
          No se pudo consultar la explicación: {errorMessage(error)}
        </p>
      )}
      {explanation !== null && (
        <>
          <p className="explain-note">
            Resultado: <strong>{explanation.exposed ? 'expuesto' : 'no expuesto'}</strong>. Decidió{' '}
            <strong>{SCOPE_LABELS[explanation.source as RuleScope] ?? explanation.source}</strong>.
          </p>
          <Chain explanation={explanation} />
        </>
      )}

      {target.cell?.source === 'quarantine' && (
        <p className="explain-note">
          Fuera de la cadena: la herramienta está en cuarentena porque su definición cambió. Ningún
          toggle la expone hasta que la revises en el catálogo.
        </p>
      )}
      {target.cell !== undefined && (
        <p className="explain-note">
          Propagación: {propagationMessage(target.cell.propagation, cliLabel)}
        </p>
      )}
      <p className="explain-note">
        Estás escribiendo en <strong>{SCOPE_LABELS[scope]}</strong>.
      </p>
    </Modal>
  )
}

export default ExplainPopover
