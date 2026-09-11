/** Pruebas de la celda de la matriz.
 *
 *  La celda es donde el producto puede mentir: si dice ON mientras el CLI sigue
 *  listando la herramienta, o si deja tocar algo que el backend va a rechazar, el
 *  resto de la consola no importa. Por eso se prueban las dos mitades: la lectura
 *  del estado (las funciones puras) y lo que termina en el DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SCOPE_LABELS,
  ToggleCell,
  VISUAL_LABELS,
  cellVisual,
  nextRuleState,
  ownRuleAtScope,
  propagationMessage,
  rowOwnRuleAtScope,
} from './ToggleCell'
import type {
  AgentInstance,
  MatrixCell,
  MatrixRow,
  PropagationState,
  RuleScope,
  RuleState,
} from '../lib/types'
import {
  click,
  need,
  qa,
  renderWithProviders,
  setupDom,
  teardownDom,
  titleOf,
} from '../test-utils'

const AGENT_ID = 'agent-codex'

const AGENT: AgentInstance = {
  id: AGENT_ID,
  machine_id: 'm-1',
  machine_hostname: 'mbp-luciano',
  cli_kind: 'codex_cli',
  cli_version: '0.14.0',
  enabled: true,
  last_connected_at: '2026-09-08T10:00:00Z',
  drift_detected: false,
  drift_detail: '',
  hot_reload: false,
}

function cell(overrides: Partial<MatrixCell> = {}): MatrixCell {
  return {
    agent_id: AGENT_ID,
    exposed: true,
    source: 'user',
    detail: 'regla tuya para todos los clientes',
    own_rule: null,
    propagation: 'applied_live',
    ...overrides,
  }
}

function row(overrides: Partial<MatrixRow> = {}): MatrixRow {
  return {
    resource_type: 'mcp_tool',
    resource_id: 'tool-delete-repo',
    slug: 'github/delete_repo',
    label: 'delete_repo',
    parent_id: 'srv-github',
    description: 'Borra un repositorio',
    user_rule: null,
    cells: {},
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/* Lectura del estado                                                           */
/* -------------------------------------------------------------------------- */

describe('cellVisual', () => {
  const fila = row()

  it('distingue prendido propio, heredado y por defecto', () => {
    expect(cellVisual(fila, cell({ own_rule: 'on', source: 'client' }), 'client')).toBe('on_own')
    expect(cellVisual(fila, cell({ own_rule: null, source: 'user' }), 'client')).toBe('on_inherited')
    expect(cellVisual(fila, cell({ own_rule: null, source: 'default_on' }), 'client')).toBe('on_default')
  })

  it('una tool que hereda de su server prendido cuenta como prendida por defecto', () => {
    expect(cellVisual(fila, cell({ source: 'inherited_from_server' }), 'client')).toBe('on_default')
  })

  it('distingue apagado propio de heredado', () => {
    expect(
      cellVisual(fila, cell({ exposed: false, own_rule: 'off', source: 'client' }), 'client'),
    ).toBe('off_own')
    expect(cellVisual(fila, cell({ exposed: false, own_rule: null, source: 'user' }), 'client')).toBe(
      'off_inherited',
    )
  })

  it('en el nivel de persona lo propio sale de user_rule, no de la celda', () => {
    const apagada = row({ user_rule: 'off' })
    expect(cellVisual(apagada, cell({ exposed: false, source: 'user' }), 'user')).toBe('off_own')
    // La misma celda leida desde el nivel de cliente es heredada, no propia.
    expect(cellVisual(apagada, cell({ exposed: false, source: 'user' }), 'client')).toBe('off_inherited')
  })

  it('la cuarentena gana sobre todo', () => {
    expect(cellVisual(fila, cell({ exposed: false, source: 'quarantine' }), 'client')).toBe('quarantined')
    expect(cellVisual(fila, cell({ exposed: false, source: 'quarantine' }), 'user')).toBe('quarantined')
  })
})

describe('ownRuleAtScope y rowOwnRuleAtScope', () => {
  it('en scope client devuelve el override de esa columna tal cual', () => {
    expect(ownRuleAtScope(cell({ own_rule: 'off' }), 'client')).toBe('off')
    expect(ownRuleAtScope(cell({ own_rule: null }), 'client')).toBeNull()
  })

  it('en scope user devuelve la regla de la fila, sin mirar la celda', () => {
    const fila = row({ user_rule: 'on' })
    expect(ownRuleAtScope(cell({ own_rule: 'off' }), 'user', fila)).toBe('on')
    expect(rowOwnRuleAtScope(fila, 'user')).toBe('on')
    expect(rowOwnRuleAtScope(row(), 'user')).toBeNull()
  })

  it('en scope client, si las columnas discrepan la fila se lee como apagada', () => {
    const mixed = row({
      cells: {
        a: cell({ agent_id: 'a', own_rule: 'on' }),
        b: cell({ agent_id: 'b', own_rule: 'off' }),
      },
    })
    expect(rowOwnRuleAtScope(mixed, 'client')).toBe('off')
  })
})

describe('nextRuleState', () => {
  it('cicla heredar, apagado, prendido', () => {
    // Arranca en OFF: lo propio ya viene prendido, asi que lo unico que falta
    // hacer sobre algo que nunca tocaste es apagarlo.
    const cycle: (RuleState | null)[] = [null, 'off', 'on']
    expect(cycle.map(nextRuleState)).toEqual(['off', 'on', 'inherit'])
  })
})

describe('propagationMessage', () => {
  it('applied_stale_list dice que el CLI sigue listando y que el gateway deniega', () => {
    const text = propagationMessage('applied_stale_list', 'Codex CLI')
    expect(text).toContain('Codex CLI sigue mostrando la herramienta')
    expect(text).toContain('el gateway la deniega')
  })

  it('cada estado tiene un mensaje propio y no vacio', () => {
    const states: PropagationState[] = [
      'applied_live',
      'applied_stale_list',
      'pending_restart',
      'pending_sync',
      'unknown',
    ]
    const messages = states.map((state) => propagationMessage(state, 'Codex CLI'))
    expect(new Set(messages).size).toBe(states.length)
    for (const message of messages) expect(message.length).toBeGreaterThan(10)
  })
})

/* -------------------------------------------------------------------------- */
/* Render                                                                       */
/* -------------------------------------------------------------------------- */

interface CellCase {
  row?: Partial<MatrixRow>
  cell?: Partial<MatrixCell> | null
  scope?: RuleScope
}

const onToggle = vi.fn()
const onExplain = vi.fn()

async function mountCell(options: CellCase = {}) {
  const target = row(options.row)
  const value = options.cell === null ? undefined : cell(options.cell ?? {})
  const view = await renderWithProviders(
    <table>
      <tbody>
        <tr>
          <ToggleCell
            row={target}
            cell={value}
            agent={AGENT}
            scope={options.scope ?? 'client'}
            scopeLabel={SCOPE_LABELS[options.scope ?? 'client']}
            onToggle={onToggle}
            onExplain={onExplain}
          />
        </tr>
      </tbody>
    </table>,
  )
  return { ...view, td: need(view.container, 'td.matrix-cell') }
}

describe('<ToggleCell>', () => {
  beforeEach(() => {
    setupDom()
    onToggle.mockClear()
    onExplain.mockClear()
  })

  afterEach(() => {
    teardownDom()
  })

  it('una celda normal es un boton que avisa que va a hacer el click', async () => {
    const { td } = await mountCell({ cell: { own_rule: 'on', source: 'client' } })

    expect(td.dataset.state).toBe('on_own')
    const toggle = need<HTMLButtonElement>(td, 'button.cell-toggle')
    expect(toggle.textContent).toContain(VISUAL_LABELS.on_own)
    expect(titleOf(toggle)).toContain('Un click en «este cliente»: volver a heredar.')

    await click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle.mock.calls[0][1]).toBe(AGENT)
  })

  it('sobre algo que nunca tocaste, el click ofrece apagarlo', async () => {
    const { td } = await mountCell({ cell: { own_rule: null, source: 'default_on' } })
    expect(td.dataset.state).toBe('on_default')
    expect(titleOf(need(td, 'button.cell-toggle'))).toContain('apagarlo')
  })

  it('una celda en cuarentena no es interactiva y dice por que', async () => {
    const { td } = await mountCell({
      cell: {
        exposed: false,
        source: 'quarantine',
        detail: 'la descripcion de la tool cambio desde la ultima vez',
      },
    })

    expect(td.dataset.state).toBe('quarantined')
    expect(td.querySelector('button.cell-toggle')).toBeNull()

    const bloqueada = need(td, 'span.cell-static')
    expect(bloqueada.getAttribute('aria-disabled')).toBe('true')
    expect(bloqueada.textContent).toContain(VISUAL_LABELS.quarantined)
    expect(titleOf(bloqueada)).toContain('la descripcion de la tool cambio desde la ultima vez')
    expect(titleOf(bloqueada)).toContain('Tocar el toggle no va a servir')

    await click(bloqueada)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('con la lista desactualizada el estado del CLI se dice completo, tambien para lectores de pantalla', async () => {
    const { td } = await mountCell({ cell: { propagation: 'applied_stale_list' } })

    expect(td.dataset.propagation).toBe('applied_stale_list')
    const propagation = need<HTMLButtonElement>(td, 'button.cell-prop')
    expect(propagation.textContent).toContain('Lista desactualizada')
    expect(titleOf(propagation)).toContain('Codex CLI sigue mostrando la herramienta')

    const readerText = qa(td, '.sr-only').map((node) => node.textContent ?? '')
    expect(readerText.join(' ')).toContain('el gateway la deniega')

    // El boton de propagacion nunca escribe: abre la explicacion.
    await click(propagation)
    expect(onExplain).toHaveBeenCalledTimes(1)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('sin celda para ese agente la matriz lo dice en vez de inventar un estado', async () => {
    const { td } = await mountCell({ cell: null })

    expect(td.dataset.state).toBeUndefined()
    expect(td.textContent).toContain('—')
    expect(td.querySelector('button')).toBeNull()
  })
})
