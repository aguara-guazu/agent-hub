/** Pruebas de las funciones puras del optimismo de la matriz.
 *  Son las que deciden si un toggle miente o no mientras vuelve el PUT. */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { errorMessage } from '../components/ErrorState'
import { ToastProvider } from '../components/Toast'
import { ApiError } from './api'
import { applyRuleToMatrix, restoreMatrixCells, snapshotCells, useMatrix, useSetRule } from './queries'
import type { SetRuleVars } from './queries'
import type { MatrixCell, MatrixResponse } from './types'

const AGENT_CLAUDE = 'agent-claude'
const AGENT_CODEX = 'agent-codex'
const SERVER_ID = 'srv-github'
const TOOL_ID = 'tool-delete-repo'

function cell(overrides: Partial<MatrixCell> = {}): MatrixCell {
  return {
    agent_id: AGENT_CLAUDE,
    exposed: true,
    source: 'user',
    detail: 'regla tuya para todos los clientes',
    own_rule: null,
    propagation: 'applied_live',
    ...overrides,
  }
}

function matrix(): MatrixResponse {
  return {
    user_id: 'u-1',
    agents: [],
    rows: [
      {
        resource_type: 'mcp_server',
        resource_id: SERVER_ID,
        slug: 'github',
        label: 'GitHub',
        parent_id: null,
        description: '',
        user_rule: null,
        cells: {
          [AGENT_CLAUDE]: cell({ agent_id: AGENT_CLAUDE }),
          [AGENT_CODEX]: cell({ agent_id: AGENT_CODEX, propagation: 'pending_restart' }),
        },
      },
      {
        resource_type: 'mcp_tool',
        resource_id: TOOL_ID,
        slug: 'github/delete_repo',
        label: 'delete_repo',
        parent_id: SERVER_ID,
        description: '',
        user_rule: null,
        cells: { [AGENT_CLAUDE]: cell({ agent_id: AGENT_CLAUDE }) },
      },
    ],
  }
}

function vars(overrides: Partial<SetRuleVars> = {}): SetRuleVars {
  return {
    scope: 'client',
    scope_id: AGENT_CLAUDE,
    resource_type: 'mcp_server',
    resource_id: SERVER_ID,
    state: 'off',
    ...overrides,
  }
}

describe('applyRuleToMatrix', () => {
  it('apaga solo la celda del agente cuando el scope es agent', () => {
    const before = matrix()
    const after = applyRuleToMatrix(before, vars())

    const row = after.rows[0]
    expect(row.cells[AGENT_CLAUDE].exposed).toBe(false)
    expect(row.cells[AGENT_CLAUDE].own_rule).toBe('off')
    expect(row.cells[AGENT_CODEX].exposed).toBe(true)
    expect(after.rows[1]).toBe(before.rows[1])
  })

  it('no muta la matriz recibida', () => {
    const before = matrix()
    applyRuleToMatrix(before, vars())
    expect(before.rows[0].cells[AGENT_CLAUDE].exposed).toBe(true)
    expect(before.rows[0].cells[AGENT_CLAUDE].own_rule).toBeNull()
  })

  it('una regla de nivel user pinta todas las celdas del recurso sin tocar own_rule', () => {
    const before = applyRuleToMatrix(matrix(), vars())
    const after = applyRuleToMatrix(before, vars({ scope: 'user', scope_id: 'u-1', state: 'on' }))

    expect(after.rows[0].cells[AGENT_CLAUDE].exposed).toBe(true)
    expect(after.rows[0].cells[AGENT_CODEX].exposed).toBe(true)
    // own_rule es la regla propia del agente: una escritura de nivel user no la cambia.
    expect(after.rows[0].cells[AGENT_CLAUDE].own_rule).toBe('off')
  })

  it('inherit borra la regla del agente pero no adivina la exposicion efectiva', () => {
    const before = applyRuleToMatrix(matrix(), vars())
    const after = applyRuleToMatrix(before, vars({ state: 'inherit' }))

    expect(after.rows[0].cells[AGENT_CLAUDE].own_rule).toBeNull()
    expect(after.rows[0].cells[AGENT_CLAUDE].exposed).toBe(false)
  })

  it('baja la propagacion a pending_sync salvo en las celdas que nunca se conectaron', () => {
    const before = matrix()
    before.rows[0].cells[AGENT_CODEX] = cell({ agent_id: AGENT_CODEX, propagation: 'unknown' })

    const after = applyRuleToMatrix(before, vars({ scope: 'user', scope_id: '', state: 'off' }))
    expect(after.rows[0].cells[AGENT_CLAUDE].propagation).toBe('pending_sync')
    expect(after.rows[0].cells[AGENT_CODEX].propagation).toBe('unknown')
  })

  it('escribir el nivel de persona deja anotada la regla de la fila', () => {
    const before = matrix()
    const after = applyRuleToMatrix(before, vars({ scope: 'user', scope_id: '', state: 'off' }))
    expect(after.rows[0].user_rule).toBe('off')
    // La regla es de la persona, no de una columna: `own_rule` no se toca.
    expect(after.rows[0].cells[AGENT_CLAUDE].own_rule).toBeNull()
    expect(after.rows[0].cells[AGENT_CLAUDE].exposed).toBe(false)
  })

  it('volver a heredar en el nivel de persona borra la regla de la fila', () => {
    const before = matrix()
    before.rows[0].user_rule = 'off'
    const after = applyRuleToMatrix(before, vars({ scope: 'user', scope_id: '', state: 'inherit' }))
    expect(after.rows[0].user_rule).toBeNull()
  })

  it('devuelve la misma referencia si el recurso no esta en la matriz', () => {
    const before = matrix()
    expect(applyRuleToMatrix(before, vars({ resource_id: 'no-existe' }))).toBe(before)
  })
})

describe('snapshotCells y restoreMatrixCells', () => {
  it('revierten solo el recurso tocado y dejan el resto como esta', () => {
    const before = matrix()
    const saved = snapshotCells(before, 'mcp_server', SERVER_ID)
    expect(saved).not.toBeNull()

    const optimistic = applyRuleToMatrix(
      applyRuleToMatrix(before, vars()),
      vars({ resource_type: 'mcp_tool', resource_id: TOOL_ID }),
    )
    const reverted = restoreMatrixCells(optimistic, 'mcp_server', SERVER_ID, saved!)

    expect(reverted.rows[0].cells[AGENT_CLAUDE].exposed).toBe(true)
    expect(reverted.rows[0].cells[AGENT_CLAUDE].own_rule).toBeNull()
    // El toggle de la otra fila sobrevive: revertir uno no puede pisar al otro.
    expect(reverted.rows[1].cells[AGENT_CLAUDE].exposed).toBe(false)
  })

  it('snapshotCells devuelve null si el recurso no esta', () => {
    expect(snapshotCells(matrix(), 'skill', 'no-existe')).toBeNull()
  })
})

describe('errorMessage', () => {
  it('respeta el mensaje del backend en los 4xx', () => {
    expect(errorMessage(new ApiError(403, 'solo admin puede bloquear'))).toBe('solo admin puede bloquear')
  })

  it('reemplaza los 5xx por un texto util', () => {
    expect(errorMessage(new ApiError(500, 'Internal Server Error'))).toContain('Error del servidor (500)')
  })

  it('traduce la falla de red de fetch', () => {
    expect(errorMessage(new TypeError('Failed to fetch'))).toContain('control plane')
  })
})

/* -------------------------------------------------------------------------- */
/* Integracion: useSetRule contra un control plane simulado                     */
/* -------------------------------------------------------------------------- */

/** Estado del servidor simulado. Las respuestas del GET salen de aca, asi que el
 *  refetch posterior a la mutacion devuelve lo que el backend realmente guardo. */
let serverMatrix: MatrixResponse
/** Respuesta pendiente del PUT: permite mirar la matriz mientras el toggle vuela. */
let resolvePut: (response: Response) => void

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, String(value)),
  } as unknown as Storage
}

function MatrixProbe() {
  const { data } = useMatrix()
  const setRule = useSetRule()
  const target = data?.rows.find((row) => row.resource_id === SERVER_ID)?.cells[AGENT_CLAUDE]

  return (
    <div>
      <span id="exposed">{target ? String(target.exposed) : 'sin-datos'}</span>
      <span id="propagation">{target?.propagation ?? '-'}</span>
      <button
        type="button"
        onClick={() =>
          setRule.mutate({
            scope: 'client',
            scope_id: AGENT_CLAUDE,
            resource_type: 'mcp_server',
            resource_id: SERVER_ID,
            state: 'off',
          })
        }
      >
        apagar
      </button>
    </div>
  )
}

async function mountProbe(): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MatrixProbe />
        </ToastProvider>
      </QueryClientProvider>,
    )
  })
  // La primera carga de la matriz necesita un tick: sin esto el probe todavia
  // esta en "sin datos" y el optimismo no tendria nada que pintar.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return {
    container,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

function textOf(container: HTMLElement, id: string): string {
  return container.querySelector(`#${id}`)?.textContent ?? ''
}

/** `onMutate` es asincrono (espera a `cancelQueries`), asi que el pintado optimista
 *  cae uno o dos ticks despues del click. Se drena la cola antes de mirar el DOM. */
async function clickToggle(container: HTMLElement): Promise<void> {
  const button = container.querySelector('button')
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('useSetRule', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal('localStorage', memoryStorage())
    serverMatrix = matrix()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('/api/policy/matrix')) return jsonResponse(serverMatrix)
        if (url.endsWith('/api/policy/rules') && init?.method === 'PUT') {
          return new Promise<Response>((resolve) => {
            resolvePut = resolve
          })
        }
        return jsonResponse([])
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pinta la celda antes de que responda el PUT y la deja si sale bien', async () => {
    const view = await mountProbe()
    expect(textOf(view.container, 'exposed')).toBe('true')

    await clickToggle(view.container)
    // El PUT sigue en vuelo: esto es lo unico que ve la persona hasta que responda.
    expect(textOf(view.container, 'exposed')).toBe('false')
    expect(textOf(view.container, 'propagation')).toBe('pending_sync')

    serverMatrix = applyRuleToMatrix(serverMatrix, vars())
    await act(async () => {
      resolvePut(new Response(null, { status: 204 }))
    })

    expect(textOf(view.container, 'exposed')).toBe('false')
    expect(view.container.textContent).not.toContain('No se pudo aplicar el cambio')
    view.unmount()
  })

  it('revierte la celda y avisa por toast si el PUT falla', async () => {
    const view = await mountProbe()

    await clickToggle(view.container)
    expect(textOf(view.container, 'exposed')).toBe('false')

    await act(async () => {
      resolvePut(jsonResponse({ detail: 'solo admin puede escribir en scope org' }, 403))
    })
    // React Query batches notifications on its scheduler, after the fetch promise settles.
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(textOf(view.container, 'exposed')).toBe('true')
      expect(view.container.textContent).toContain('No se pudo aplicar el cambio')
    })
    expect(textOf(view.container, 'exposed')).toBe('true')
    expect(textOf(view.container, 'propagation')).toBe('applied_live')
    expect(view.container.textContent).toContain('No se pudo aplicar el cambio')
    expect(view.container.textContent).toContain('solo admin puede escribir en scope org')
    view.unmount()
  })
})
