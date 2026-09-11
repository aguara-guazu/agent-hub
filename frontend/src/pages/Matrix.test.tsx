/** Pruebas de la matriz de exposicion.
 *
 *  Es la pantalla donde un error cuesta plata: escribir en el nivel equivocado
 *  cambia lo que ve gente que no estaba mirando. Lo que se prueba aca es, en este
 *  orden de importancia:
 *
 *  1. Que el PUT salga con el scope que muestra el selector, y que cambiar el
 *     selector cambie el scope del PUT.
 *  2. Que lo que no se puede tocar (congelado, no elegible) ni siquiera sea un
 *     control, y diga por que.
 *  3. Que la propagacion se cuente sin adornos: `applied_stale_list` significa que
 *     el CLI todavia lista la herramienta aunque el hub ya la haya apagado.
 *  4. Que un 409 vuelva la celda a como estaba y muestre el texto del servidor.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import MatrixPage, { filterRows } from './Matrix'
import type { AgentInstance, MatrixCell, MatrixResponse, MatrixRow, User } from '../lib/types'
import {
  actAsync,
  buttonByText,
  click,
  deferred,
  flush,
  installFetch,
  jsonResponse,
  need,
  noContent,
  qa,
  renderWithProviders,
  setupDom,
  teardownDom,
  titleOf,
} from '../test-utils'
import type { ApiCall } from '../test-utils'

/* -------------------------------------------------------------------------- */
/* Datos fabricados                                                             */
/* -------------------------------------------------------------------------- */

const CLAUDE = 'agent-claude'
const CODEX = 'agent-codex'
const USER_ID = 'u-1'
const SQUAD_ID = 'sq-plataforma'

const SRV_GITHUB = 'srv-github'
const TOOL_DELETE = 'tool-delete-repo'
const SRV_JIRA = 'srv-jira'
const SRV_ACME = 'srv-acme'
const SRV_NOTION = 'srv-notion'

const admin: User = {
  id: USER_ID,
  email: 'luciano.serra@craftech.io',
  full_name: 'Luciano',
  org_role: 'admin',
  is_active: true,
  squads: [{ id: SQUAD_ID, slug: 'plataforma', name: 'Plataforma', role: 'lead' }],
  organization: 'Craftech',
}

const agentClaude: AgentInstance = {
  id: CLAUDE,
  machine_id: 'm-1',
  machine_hostname: 'mbp-luciano',
  cli_kind: 'claude_code',
  cli_version: '2.0.1',
  enabled: true,
  last_connected_at: '2026-09-09T09:00:00Z',
  drift_detected: false,
  drift_detail: '',
  hot_reload: true,
}

const agentCodex: AgentInstance = {
  ...agentClaude,
  id: CODEX,
  cli_kind: 'codex_cli',
  cli_version: '0.14.0',
  hot_reload: false,
}

function cell(agentId: string, overrides: Partial<MatrixCell> = {}): MatrixCell {
  return {
    agent_id: agentId,
    exposed: true,
    source: 'user',
    detail: '',
    own_rule: null,
    propagation: 'applied_live',
    ...overrides,
  }
}

/** Una matriz con los cinco estados de celda que existen hoy. */
function baseMatrix(): MatrixResponse {
  const rows: MatrixRow[] = [
    {
      resource_type: 'mcp_server',
      resource_id: SRV_GITHUB,
      slug: 'github',
      label: 'GitHub',
      parent_id: null,
      description: 'Repositorios de la organizacion',
      user_rule: 'on',
      cells: {
        // prendido propio (regla de este cliente) …
        [CLAUDE]: cell(CLAUDE, { own_rule: 'on', source: 'client', detail: 'regla de este cliente' }),
        // … y prendido heredado de la persona, con el CLI listando la version vieja.
        [CODEX]: cell(CODEX, {
          source: 'user',
          detail: 'lo prendiste para todos tus clientes',
          propagation: 'applied_stale_list',
        }),
      },
    },
    {
      resource_type: 'mcp_tool',
      resource_id: TOOL_DELETE,
      slug: 'github/delete_repo',
      label: 'delete_repo',
      parent_id: SRV_GITHUB,
      description: 'Borra un repositorio',
      user_rule: 'off',
      cells: {
        // apagado propio de este cliente …
        [CLAUDE]: cell(CLAUDE, {
          exposed: false,
          own_rule: 'off',
          source: 'client',
          detail: 'lo apagaste en este cliente',
          propagation: 'pending_sync',
        }),
        // … y apagado heredado de la persona.
        [CODEX]: cell(CODEX, {
          exposed: false,
          source: 'user',
          detail: 'lo apagaste para todos tus clientes',
          propagation: 'pending_restart',
        }),
      },
    },
    {
      resource_type: 'mcp_server',
      resource_id: SRV_JIRA,
      slug: 'jira',
      label: 'Jira',
      parent_id: null,
      description: 'Tickets',
      user_rule: null,
      cells: {
        // prendido por defecto: es tuyo y no lo apagaste en ningun lado …
        [CLAUDE]: cell(CLAUDE, {
          source: 'default_on',
          detail: 'es tuyo y no lo apagaste en ningun nivel',
          propagation: 'unknown',
        }),
        [CODEX]: cell(CODEX, { source: 'default_on', propagation: 'unknown' }),
      },
    },
    {
      resource_type: 'mcp_server',
      resource_id: SRV_ACME,
      slug: 'acme-internal',
      label: 'ACME interno',
      parent_id: null,
      description: 'Un server que cambio su definicion',
      user_rule: null,
      cells: {
        [CLAUDE]: cell(CLAUDE, {
          exposed: false,
          source: 'quarantine',
          detail: 'la descripcion de una tool cambio desde la ultima vez',
        }),
        [CODEX]: cell(CODEX, {
          exposed: false,
          source: 'quarantine',
          detail: 'la descripcion de una tool cambio desde la ultima vez',
        }),
      },
    },
    {
      resource_type: 'mcp_server',
      resource_id: SRV_NOTION,
      slug: 'notion',
      label: 'Notion',
      parent_id: null,
      description: 'Documentos',
      user_rule: null,
      cells: {
        [CLAUDE]: cell(CLAUDE, { source: 'default_on' }),
        [CODEX]: cell(CODEX, { source: 'default_on' }),
      },
    },
  ]

  return {
    user_id: USER_ID,
    agents: [agentClaude, agentCodex],
    rows,
  }
}

/* -------------------------------------------------------------------------- */
/* Utilidades de la suite                                                       */
/* -------------------------------------------------------------------------- */

/** Columna 0 es Claude Code, columna 1 es Codex CLI, en el orden de `agents`. */
function cellAt(root: ParentNode, resourceType: string, resourceId: string, column: number): HTMLElement {
  const tr = need(root, `tr[data-row="${resourceType}:${resourceId}"]`)
  const cells = qa(tr, 'td.matrix-cell')
  const found = cells[column]
  if (found === undefined) throw new Error(`la fila ${resourceId} no tiene columna ${column}`)
  return found
}

function stateAt(root: ParentNode, resourceType: string, resourceId: string, column: number): string {
  return cellAt(root, resourceType, resourceId, column).dataset.state ?? ''
}

interface Scenario {
  matrix: MatrixResponse
  /** Respuesta del PUT. Por defecto 204. */
  rulesResponse?: () => Response | Promise<Response>
}

async function mountMatrix(scenario: Scenario) {
  const fetchMock = installFetch({
    user: admin,
    handle: (call: ApiCall) => {
      if (call.path === '/policy/matrix' && call.method === 'GET') return jsonResponse(scenario.matrix)
      if (call.path === '/policy/rules' && call.method === 'PUT') {
        return scenario.rulesResponse ? scenario.rulesResponse() : noContent()
      }
      return undefined
    },
  })
  const view = await renderWithProviders(<MatrixPage />)
  return { ...view, fetchMock }
}

/* -------------------------------------------------------------------------- */
/* Pruebas                                                                      */
/* -------------------------------------------------------------------------- */

describe('<MatrixPage>', () => {
  beforeEach(() => {
    setupDom()
  })

  afterEach(() => {
    teardownDom()
  })

  it('dibuja los cinco estados de celda con su etiqueta', async () => {
    const { container } = await mountMatrix({ matrix: baseMatrix() })

    expect(stateAt(container, 'mcp_server', SRV_GITHUB, 0)).toBe('on_own')
    expect(stateAt(container, 'mcp_server', SRV_GITHUB, 1)).toBe('on_inherited')
    expect(stateAt(container, 'mcp_tool', TOOL_DELETE, 0)).toBe('off_own')
    expect(stateAt(container, 'mcp_tool', TOOL_DELETE, 1)).toBe('off_inherited')
    expect(stateAt(container, 'mcp_server', SRV_JIRA, 0)).toBe('on_default')
    expect(stateAt(container, 'mcp_server', SRV_ACME, 0)).toBe('quarantined')

    const labels = qa(container, 'td.matrix-cell .cell-text').map((node) => node.textContent)
    expect(new Set(labels)).toEqual(
      new Set(['ON propio', 'ON heredado', 'ON por defecto', 'OFF propio', 'OFF heredado', 'En cuarentena']),
    )
    expect(container.textContent).toContain('5 recursos × 2 agentes')
  })

  it('una celda en cuarentena no es interactiva y dice por que', async () => {
    const { container, fetchMock } = await mountMatrix({ matrix: baseMatrix() })
    const bloqueada = cellAt(container, 'mcp_server', SRV_ACME, 1)

    expect(bloqueada.querySelector('button.cell-toggle')).toBeNull()
    const label = need(bloqueada, 'span.cell-static')
    expect(label.getAttribute('aria-disabled')).toBe('true')
    expect(titleOf(label)).toContain('la descripcion de una tool cambio desde la ultima vez')
    expect(titleOf(label)).toContain('Tocar el toggle no va a servir')

    await click(label)
    expect(fetchMock.callsTo('/policy/rules', 'PUT')).toHaveLength(0)
  })

  it('la fila avisa cuando hay una regla propia para todos los clientes', async () => {
    const { container } = await mountMatrix({ matrix: baseMatrix() })
    const fila = need(container, `tr[data-row="mcp_tool:${TOOL_DELETE}"]`)
    const badge = qa(fila, '.badge').find((node) => (node.textContent ?? '').includes('OFF en todos'))
    expect(badge).toBeDefined()
  })

  it('el click escribe en el nivel que muestra el selector', async () => {
    const { container, fetchMock } = await mountMatrix({ matrix: baseMatrix() })

    expect(need(container, '[data-testid="scope-actual"]').textContent).toBe('Este cliente')

    const jira = cellAt(container, 'mcp_server', SRV_JIRA, 0)
    await click(need(jira, 'button.cell-toggle'))

    const put = fetchMock.lastCall('/policy/rules', 'PUT')
    expect(put?.body).toEqual({
      scope: 'client',
      scope_id: CLAUDE,
      resource_type: 'mcp_server',
      resource_id: SRV_JIRA,
      // Venia prendido por defecto y sin regla propia: el ciclo empieza apagando.
      state: 'off',
      reason: '',
    })
  })

  it('cambiar el nivel del selector cambia el scope del PUT', async () => {
    const { container, fetchMock } = await mountMatrix({ matrix: baseMatrix() })

    await click(buttonByText(container, 'Todos mis clientes'))
    expect(need(container, '[data-testid="scope-actual"]').textContent).toBe('Todos mis clientes')
    await click(need(cellAt(container, 'mcp_server', SRV_JIRA, 0), 'button.cell-toggle'))

    expect(fetchMock.lastCall('/policy/rules', 'PUT')?.body).toMatchObject({
      scope: 'user',
      scope_id: '',
      resource_id: SRV_JIRA,
      state: 'off',
    })

    await click(buttonByText(container, 'Este cliente'))
    expect(need(container, '[data-testid="scope-actual"]').textContent).toBe('Este cliente')
    await click(need(cellAt(container, 'mcp_tool', TOOL_DELETE, 0), 'button.cell-toggle'))

    expect(fetchMock.lastCall('/policy/rules', 'PUT')?.body).toMatchObject({
      scope: 'client',
      scope_id: CLAUDE,
      resource_type: 'mcp_tool',
      resource_id: TOOL_DELETE,
      // Ya estaba apagado en este cliente: el proximo paso del ciclo es prenderlo.
      state: 'on',
    })
    expect(fetchMock.callsTo('/policy/rules', 'PUT')).toHaveLength(2)
  })

  it('una celda con propagacion applied_stale_list avisa que el CLI todavia lista la herramienta', async () => {
    const { container } = await mountMatrix({ matrix: baseMatrix() })
    const stale = cellAt(container, 'mcp_server', SRV_GITHUB, 1)

    expect(stale.dataset.propagation).toBe('applied_stale_list')
    // El estado del hub y el del CLI se muestran juntos y se contradicen a la vista.
    expect(need(stale, '.cell-text').textContent).toBe('ON heredado')
    expect(need(stale, '.cell-prop-label').textContent).toBe('Lista desactualizada')

    const explain = need(stale, 'button.cell-prop')
    expect(titleOf(explain)).toContain('Codex CLI sigue mostrando la herramienta hasta que lo reinicies')
    expect(titleOf(explain)).toContain('el gateway la deniega')
    expect(need(stale, '.sr-only').textContent).toContain('sigue mostrando la herramienta')

    // Y el encabezado cuenta cuantas celdas estan en esa situacion.
    const warning = need(container, '.matrix-warning')
    expect(warning.textContent).toContain('2 celdas ya están decididas en el hub')
    expect(warning.textContent).toContain('El gateway igual deniega las llamadas')
  })

  it('un 409 revierte la actualizacion optimista y muestra el mensaje del servidor', async () => {
    const put = deferred<Response>()
    const { container } = await mountMatrix({
      matrix: baseMatrix(),
      rulesResponse: () => put.promise,
    })

    expect(stateAt(container, 'mcp_server', SRV_JIRA, 0)).toBe('on_default')

    await click(need(cellAt(container, 'mcp_server', SRV_JIRA, 0), 'button.cell-toggle'))
    // El PUT sigue en vuelo: esto es lo unico que ve la persona hasta que responda.
    expect(stateAt(container, 'mcp_server', SRV_JIRA, 0)).toBe('off_own')

    await actAsync(() => {
      put.resolve(jsonResponse({ detail: 'el MCP server no existe' }, 409))
    })
    await flush(2)

    expect(stateAt(container, 'mcp_server', SRV_JIRA, 0)).toBe('on_default')
    const toast = need(container, '.toast-error')
    expect(toast.textContent).toContain('No se pudo aplicar el cambio')
    expect(toast.textContent).toContain('el MCP server no existe')
  })

  it('sin agentes no ofrece toggles y explica que hay que enrolar una maquina', async () => {
    const empty: MatrixResponse = { ...baseMatrix(), agents: [], rows: [] }
    const { container } = await mountMatrix({ matrix: empty })

    expect(container.querySelector('table.matrix-table')).toBeNull()
    expect(container.textContent).toContain('Esta persona no tiene agentes')
  })
})

/* -------------------------------------------------------------------------- */
/* Filtro: funcion pura                                                         */
/* -------------------------------------------------------------------------- */

describe('filterRows', () => {
  it('una tool que sobrevive arrastra a su server para no dejarla huerfana', () => {
    const rows = baseMatrix().rows
    const filtered = filterRows({
      rows,
      search: 'delete_repo',
      serverId: '',
      stateFilter: 'all',
      scope: 'client',
    })
    expect(filtered.map((row) => row.resource_id)).toEqual([SRV_GITHUB, TOOL_DELETE])
  })

  it('el filtro de cuarentena deja solo lo que ningun toggle puede cambiar', () => {
    const filtered = filterRows({
      rows: baseMatrix().rows,
      search: '',
      serverId: '',
      stateFilter: 'quarantined',
      scope: 'client',
    })
    expect(filtered.map((row) => row.resource_id)).toEqual([SRV_ACME])
  })

  it('lo apagado y lo prendido se separan mirando la celda, no la regla', () => {
    const rows = baseMatrix().rows
    const apagados = filterRows({ rows, search: '', serverId: '', stateFilter: 'off', scope: 'client' })
    expect(apagados.map((row) => row.resource_id)).toEqual([SRV_GITHUB, TOOL_DELETE])

    const prendidos = filterRows({ rows, search: '', serverId: '', stateFilter: 'on', scope: 'client' })
    expect(prendidos.map((row) => row.resource_id)).toEqual([SRV_GITHUB, SRV_JIRA, SRV_NOTION])
  })
})
