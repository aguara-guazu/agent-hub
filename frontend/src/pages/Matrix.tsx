/** Matriz de agentes por recursos: la pantalla central del producto.
 *
 *  Es el unico lugar donde se prende y se apaga lo que ve cada CLI. Tres
 *  decisiones de diseno que no son negociables:
 *
 *  1. El nivel de escritura esta siempre a la vista: en la barra de arriba y en el
 *     encabezado pegajoso de la tabla. Escribir sin darse cuenta en el nivel
 *     equivocado es el error mas caro de la consola.
 *  2. Cada celda muestra DOS cosas: lo que decidio el hub y lo que el CLI esta
 *     mostrando de verdad. Pintar un toggle en verde mientras Codex sigue listando
 *     la herramienta es un bug de producto, no un detalle.
 *  3. El estado se pinta al instante y se revierte solo si el PUT falla; un 409 por
 *     regla congelada muestra el mensaje del servidor tal cual, sin reinterpretarlo.
 *
 *  Sin virtualizacion: el caso de referencia son 40 recursos por 4 agentes, o sea
 *  160 celdas. Lo que hace usable esa escala son los encabezados pegajosos, los
 *  filtros y el colapso de tools, no una ventana de scroll.
 */

import { useCallback, useMemo, useState } from 'react'

import { ErrorState } from '../components/ErrorState'
import { ExplainPopover } from '../components/ExplainPopover'
import type { ExplainTarget } from '../components/ExplainPopover'
import { MatrixGrid, rowKey } from '../components/MatrixGrid'
import { ScopeSelector, buildScopeOptions, scopeKeyOf } from '../components/ScopeSelector'
import type { ScopeOption } from '../components/ScopeSelector'
import { LoadingBlock } from '../components/Spinner'
import { useToast } from '../components/Toast'
import {
  CellLegendItem,
  SCOPE_LABELS,
  cellVisual,
  nextRuleState,
  ownRuleAtScope,
  rowOwnRuleAtScope,
} from '../components/ToggleCell'
import type { CellVisual } from '../components/ToggleCell'
import { useMatrix, useSetRule } from '../lib/queries'
import type { SetRuleVars } from '../lib/queries'
import type { AgentInstance, MatrixResponse, MatrixRow, RuleScope, RuleState } from '../lib/types'
import '../styles/matrix.css'

type StateFilter = 'all' | 'on' | 'off' | 'quarantined' | 'unapplied'

const STATE_FILTER_LABELS: Record<StateFilter, string> = {
  all: 'Todos los estados',
  on: 'Prendidos',
  off: 'Apagados',
  quarantined: 'En cuarentena',
  unapplied: 'Todavía no aplicados en el cliente',
}

const STATE_FILTERS: readonly StateFilter[] = ['all', 'on', 'off', 'quarantined', 'unapplied']

/** Los estados, en el orden en que conviene leerlos en la leyenda. */
const LEGEND_VISUALS: readonly CellVisual[] = [
  'on_default',
  'on_own',
  'on_inherited',
  'off_own',
  'off_inherited',
  'quarantined',
]

const BULK_LABELS: Record<RuleState, string> = {
  on: 'Prender',
  off: 'Apagar',
  inherit: 'Volver a heredar',
}

/** Una escritura pedida por la pantalla, antes de convertirse en `SetRuleVars`. */
interface Write {
  row: MatrixRow
  /** Solo en scope `client`: la columna sobre la que se escribe. */
  agentId: string | null
  next: RuleState
  /** Estado previo, para poder deshacer. */
  previous: RuleState
}

/** Lo necesario para revertir la ultima tanda de escrituras que si se aplicaron. */
interface UndoBatch {
  description: string
  entries: SetRuleVars[]
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

function rowText(row: MatrixRow): string {
  return normalize(`${row.label} ${row.slug} ${row.description}`)
}

/** True si alguna celda de la fila cae en el filtro de estado. */
function matchesState(row: MatrixRow, filter: StateFilter, scope: RuleScope): boolean {
  if (filter === 'all') return true
  const cells = Object.values(row.cells)
  if (cells.length === 0) return false
  return cells.some((cell) => {
    const visual = cellVisual(row, cell, scope)
    switch (filter) {
      case 'on':
        return visual === 'on_own' || visual === 'on_inherited' || visual === 'on_default'
      case 'off':
        return visual === 'off_own' || visual === 'off_inherited'
      case 'quarantined':
        return visual === 'quarantined'
      case 'unapplied':
        return cell.propagation !== 'applied_live'
      default:
        return true
    }
  })
}

interface FilterInput {
  rows: readonly MatrixRow[]
  search: string
  serverId: string
  stateFilter: StateFilter
  scope: RuleScope
}

/** Filtra conservando la jerarquia.
 *
 *  Una tool que sobrevive arrastra a su server aunque el server no matchee: una
 *  fila hija sin encabezado no dice a que pertenece. Al reves tambien: si el
 *  server matchea por texto, se muestran sus tools que pasen los demas filtros.
 */
export function filterRows({ rows, search, serverId, stateFilter, scope }: FilterInput): MatrixRow[] {
  const needle = normalize(search.trim())
  const textOk = (row: MatrixRow): boolean => needle === '' || rowText(row).includes(needle)
  const serverOk = (row: MatrixRow): boolean =>
    serverId === '' ||
    (row.resource_type === 'mcp_server' && row.resource_id === serverId) ||
    (row.resource_type === 'mcp_tool' && row.parent_id === serverId)
  const otherOk = (row: MatrixRow): boolean => serverOk(row) && matchesState(row, stateFilter, scope)

  const direct = new Map<string, boolean>()
  for (const row of rows) direct.set(rowKey(row), textOk(row) && otherOk(row))

  const serverMatchedByText = new Set<string>()
  const serverHasKeptTool = new Set<string>()
  for (const row of rows) {
    if (row.resource_type === 'mcp_server' && direct.get(rowKey(row)) === true) {
      serverMatchedByText.add(row.resource_id)
    }
    if (row.resource_type === 'mcp_tool' && row.parent_id !== null && direct.get(rowKey(row)) === true) {
      serverHasKeptTool.add(row.parent_id)
    }
  }

  return rows.filter((row) => {
    if (direct.get(rowKey(row)) === true) return true
    if (row.resource_type === 'mcp_server') return serverHasKeptTool.has(row.resource_id)
    if (row.resource_type === 'mcp_tool' && row.parent_id !== null) {
      return serverMatchedByText.has(row.parent_id) && otherOk(row)
    }
    return false
  })
}

export function MatrixPage() {
  const toast = useToast()
  const query = useMatrix()
  const setRule = useSetRule()

  const [scopeKey, setScopeKey] = useState<string>(scopeKeyOf('client', ''))
  const [reason, setReason] = useState('')
  const [search, setSearch] = useState('')
  const [serverId, setServerId] = useState('')
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [recalculating, setRecalculating] = useState<ReadonlySet<string>>(new Set())
  const [bulkAgentId, setBulkAgentId] = useState('')
  const [undo, setUndo] = useState<UndoBatch | null>(null)
  const [explaining, setExplaining] = useState<ExplainTarget | null>(null)

  const matrix: MatrixResponse | undefined = query.data
  const agents = useMemo<readonly AgentInstance[]>(() => matrix?.agents ?? [], [matrix])
  const allRows = useMemo<readonly MatrixRow[]>(() => matrix?.rows ?? [], [matrix])

  const scopeOptions = useMemo<ScopeOption[]>(
    () => (matrix ? buildScopeOptions(matrix, agents.length) : []),
    [matrix, agents.length],
  )
  const activeScope =
    scopeOptions.find((option) => option.key === scopeKey) ??
    scopeOptions.find((option) => option.scope === 'client')
  const scope: RuleScope = activeScope?.scope ?? 'client'
  const scopeId = activeScope?.scopeId ?? ''
  const scopeLabel = activeScope?.label ?? SCOPE_LABELS.client

  const filtered = useMemo(
    () => filterRows({ rows: allRows, search, serverId, stateFilter, scope }),
    [allRows, search, serverId, stateFilter, scope],
  )

  /** Tools visibles por server DESPUES del filtro: es lo que cuenta el chevron. */
  const toolCounts = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {}
    for (const row of filtered) {
      if (row.resource_type === 'mcp_tool' && row.parent_id !== null) {
        counts[row.parent_id] = (counts[row.parent_id] ?? 0) + 1
      }
    }
    return counts
  }, [filtered])

  const visibleRows = useMemo(
    () =>
      filtered.filter(
        (row) => row.resource_type !== 'mcp_tool' || row.parent_id === null || !collapsed.has(row.parent_id),
      ),
    [filtered, collapsed],
  )

  const servers = useMemo(() => allRows.filter((row) => row.resource_type === 'mcp_server'), [allRows])
  const rowsByKey = useMemo(() => new Map(allRows.map((row) => [rowKey(row), row])), [allRows])
  const allCollapsed = servers.length > 0 && servers.every((row) => collapsed.has(row.resource_id))

  /** Celdas donde el hub ya decidio pero el CLI todavia no lo refleja. Es el
   *  numero que hay que mirar antes de dar por cerrado un cambio de seguridad. */
  const unappliedCount = useMemo(() => {
    let count = 0
    for (const row of allRows) {
      for (const cell of Object.values(row.cells)) {
        if (cell.propagation === 'applied_stale_list' || cell.propagation === 'pending_restart') count += 1
      }
    }
    return count
  }, [allRows])

  const bulkAgent = useMemo<AgentInstance | null>(() => {
    if (scope !== 'client') return null
    return agents.find((agent) => agent.id === bulkAgentId) ?? agents[0] ?? null
  }, [scope, agents, bulkAgentId])

  const buildVars = useCallback(
    (row: MatrixRow, agentId: string | null, state: RuleState): SetRuleVars => ({
      scope,
      scope_id: scope === 'client' ? (agentId ?? '') : scopeId,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      state,
      reason,
    }),
    [scope, scopeId, reason],
  )

  /** Manda las escrituras, deja anotado como deshacerlas y marca las tools de un
   *  server tocado como pendientes de recalculo mientras el PUT esta en vuelo.
   *
   *  Devuelve cuantas se aplicaron: el error de cada una ya sale por su toast, y
   *  quien llama solo necesita saber si vale la pena confirmar algo. */
  const applyWrites = useCallback(
    async (writes: Write[], description: string): Promise<number> => {
      if (writes.length === 0) return 0

      const touchedServers = writes
        .filter((write) => write.row.resource_type === 'mcp_server')
        .map((write) => write.row.resource_id)
      if (touchedServers.length > 0) {
        setRecalculating((current) => new Set([...current, ...touchedServers]))
      }

      const results = await Promise.allSettled(
        writes.map((write) => setRule.mutateAsync(buildVars(write.row, write.agentId, write.next))),
      )

      if (touchedServers.length > 0) {
        setRecalculating((current) => {
          const next = new Set(current)
          for (const id of touchedServers) next.delete(id)
          return next
        })
      }

      // Solo se puede deshacer lo que efectivamente se escribio: si el PUT fallo,
      // no hubo cambio que revertir.
      const entries = writes
        .filter((_, index) => results[index].status === 'fulfilled')
        .map((write) => ({
          ...buildVars(write.row, write.agentId, write.previous),
          reason: `deshacer: ${description}`,
        }))
      setUndo(entries.length > 0 ? { description, entries } : null)
      return entries.length
    },
    [buildVars, setRule],
  )

  const handleToggleCell = useCallback(
    (row: MatrixRow, agent: AgentInstance) => {
      const cell = row.cells[agent.id]
      if (cell === undefined || cell.source === 'quarantine') return
      // En scope `client` el estado propio es el de esa columna; en `user` la
      // escritura toca la fila entera, asi que el ciclo parte del estado de la fila.
      const own = scope === 'client' ? ownRuleAtScope(cell, 'client') : rowOwnRuleAtScope(row, scope)
      void applyWrites(
        [{ row, agentId: agent.id, next: nextRuleState(own), previous: own ?? 'inherit' }],
        `${row.slug} en ${SCOPE_LABELS[scope]}`,
      )
    },
    [applyWrites, scope],
  )

  const handleBulk = useCallback(
    (state: RuleState) => {
      const rows = [...selected]
        .map((key) => rowsByKey.get(key))
        .filter((row): row is MatrixRow => row !== undefined)

      const writes: Write[] = []
      let skipped = 0
      for (const row of rows) {
        if (scope === 'client') {
          const agentId = bulkAgent?.id ?? ''
          const cell = row.cells[agentId]
          if (cell === undefined || cell.source === 'quarantine') {
            skipped += 1
            continue
          }
          writes.push({
            row,
            agentId,
            next: state,
            previous: ownRuleAtScope(cell, 'client') ?? 'inherit',
          })
          continue
        }
        writes.push({
          row,
          agentId: null,
          next: state,
          previous: rowOwnRuleAtScope(row, scope) ?? 'inherit',
        })
      }

      if (writes.length === 0) {
        toast.info('No se aplicó nada', 'Las filas seleccionadas están en cuarentena.')
        return
      }

      const column = scope === 'client' && bulkAgent ? ` (columna ${bulkAgent.machine_hostname})` : ''
      const description = `${BULK_LABELS[state].toLowerCase()} ${writes.length} recursos en ${SCOPE_LABELS[scope]}${column}`
      void applyWrites(writes, description).then((applied) => {
        if (applied === 0) return
        const tail = skipped > 0 ? ` ${skipped} sin tocar por cuarentena.` : ''
        toast.success(`${applied} filas cambiadas en ${SCOPE_LABELS[scope]}.${tail}`)
      })
    },
    [selected, rowsByKey, scope, bulkAgent, applyWrites, toast],
  )

  const handleUndo = useCallback(() => {
    if (undo === null) return
    const { entries, description } = undo
    setUndo(null)
    void Promise.allSettled(entries.map((vars) => setRule.mutateAsync(vars))).then(() => {
      toast.info('Cambio deshecho', description)
    })
  }, [undo, setRule, toast])

  const toggleCollapse = useCallback((serverIdToToggle: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(serverIdToToggle)) next.delete(serverIdToToggle)
      else next.add(serverIdToToggle)
      return next
    })
  }, [])

  const toggleAllCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const everyCollapsed = servers.length > 0 && servers.every((row) => current.has(row.resource_id))
      return everyCollapsed ? new Set() : new Set(servers.map((row) => row.resource_id))
    })
  }, [servers])

  const toggleSelected = useCallback((key: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const selectAll = useCallback(
    (select: boolean) => {
      setSelected(select ? new Set(visibleRows.map((row) => rowKey(row))) : new Set())
    },
    [visibleRows],
  )

  const handleExplain = useCallback((row: MatrixRow, agent: AgentInstance) => {
    setExplaining({ row, agent, cell: row.cells[agent.id] })
  }, [])

  if (query.isLoading) return <LoadingBlock label="Cargando la matriz…" />
  if (query.isError || matrix === undefined) {
    return <ErrorState error={query.error} title="No se pudo cargar la matriz" onRetry={() => void query.refetch()} />
  }

  return (
    <div className="matrix-page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Matriz de exposición</h1>
          <p className="page-subtitle">
            {allRows.length} recursos × {agents.length} agentes. Cada celda dice qué decidió el hub y qué
            está mostrando el CLI, que no siempre es lo mismo.
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={undo === null}
            title={undo === null ? 'Todavía no hay nada que deshacer.' : `Deshacer: ${undo.description}`}
            onClick={handleUndo}
          >
            Deshacer
          </button>
        </div>
      </header>

      <ScopeSelector
        options={scopeOptions}
        value={activeScope?.key ?? scopeKeyOf('client', '')}
        onChange={setScopeKey}
        reason={reason}
        onReasonChange={setReason}
      />

      {agents.length === 0 ? (
        <p className="empty">
          Esta persona no tiene agentes. Hace falta enrolar una máquina con el daemon desde la sección
          Máquinas: sin columnas, no hay nada que prender ni apagar.
        </p>
      ) : (
        <>
          {unappliedCount > 0 && (
            <p className="matrix-warning" role="status">
              {unappliedCount} celdas ya están decididas en el hub pero el CLI todavía no lo refleja: sigue
              listando lo que tenía hasta que se reinicie. El gateway igual deniega las llamadas.
            </p>
          )}

          <div className="matrix-toolbar">
            <div className="field matrix-toolbar-grow">
              <label htmlFor="matrix-search">Buscar recurso</label>
              <input
                id="matrix-search"
                type="search"
                value={search}
                placeholder="nombre, slug o descripción"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="matrix-server">MCP server</label>
              <select id="matrix-server" value={serverId} onChange={(event) => setServerId(event.target.value)}>
                <option value="">Todos los servers</option>
                {servers.map((row) => (
                  <option key={row.resource_id} value={row.resource_id}>
                    {row.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="matrix-state">Estado</label>
              <select
                id="matrix-state"
                value={stateFilter}
                onChange={(event) => setStateFilter(event.target.value as StateFilter)}
              >
                {STATE_FILTERS.map((filter) => (
                  <option key={filter} value={filter}>
                    {STATE_FILTER_LABELS[filter]}
                  </option>
                ))}
              </select>
            </div>

            <div className="matrix-toolbar-actions">
              <span className="matrix-count">
                {visibleRows.length} de {allRows.length} filas
              </span>
              <button type="button" className="btn btn-sm" onClick={toggleAllCollapsed} disabled={servers.length === 0}>
                {allCollapsed ? 'Mostrar todas las tools' : 'Colapsar todas las tools'}
              </button>
            </div>
          </div>

          {selected.size > 0 && (
            <div className="matrix-bulkbar" role="group" aria-label="Acción masiva">
              <strong>{selected.size} filas seleccionadas</strong>
              <span className="muted">
                se escriben en el nivel {SCOPE_LABELS[scope]}
                {scope === 'client' && bulkAgent ? ', sobre una sola columna' : ''}
              </span>

              {scope === 'client' && agents.length > 0 && (
                <div className="field">
                  <label htmlFor="matrix-bulk-agent">Columna</label>
                  <select
                    id="matrix-bulk-agent"
                    value={bulkAgent?.id ?? ''}
                    onChange={(event) => setBulkAgentId(event.target.value)}
                  >
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.cli_kind} · {agent.machine_hostname}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {(['on', 'off', 'inherit'] as const).map((state) => (
                <button key={state} type="button" className="btn btn-sm" onClick={() => handleBulk(state)}>
                  {BULK_LABELS[state]}
                </button>
              ))}
              <button type="button" className="btn btn-sm" onClick={() => selectAll(false)}>
                Limpiar selección
              </button>
            </div>
          )}

          {visibleRows.length === 0 ? (
            <p className="empty">Ningún recurso pasa los filtros.</p>
          ) : (
            <MatrixGrid
              agents={agents}
              rows={visibleRows}
              toolCounts={toolCounts}
              collapsed={collapsed}
              onToggleCollapse={toggleCollapse}
              selected={selected}
              onToggleSelected={toggleSelected}
              onSelectAll={selectAll}
              recalculating={recalculating}
              scope={scope}
              scopeLabel={scopeLabel}
              onToggleCell={handleToggleCell}
              onExplain={handleExplain}
            />
          )}

          <div className="matrix-legend">
            {LEGEND_VISUALS.map((visual) => (
              <CellLegendItem key={visual} visual={visual} />
            ))}
            <span className="matrix-legend-item">
              Un click cicla heredar → prendido → apagado, y escribe en el nivel {SCOPE_LABELS[scope]}.
            </span>
          </div>
        </>
      )}

      <ExplainPopover target={explaining} scope={scope} onClose={() => setExplaining(null)} />
    </div>
  )
}

export default MatrixPage
