/** Auditoria: el ledger encadenado de la organizacion y las llamadas a herramientas.
 *
 *  Las llamadas DENEGADAS se destacan a proposito: son la senal de que alguien
 *  esta pidiendo algo que el panel tiene apagado, y es lo primero que se mira
 *  cuando una persona reporta que "una herramienta dejo de andar".
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import Badge from '../components/Badge'
import DataTable, { formatDateTime, shortHash, type Column } from '../components/DataTable'
import { api } from '../lib/api'
import { useAuditEvents, useToolCalls } from '../lib/queries'
import type { AuditEvent, ToolCallLog } from '../lib/types'
import '../styles/pages.css'

type Tab = 'events' | 'calls'

interface VerifyResult {
  ok: boolean
  broken_at: string | null
}

function ChainVerifier() {
  const [enabled, setEnabled] = useState(false)
  const q = useQuery<VerifyResult, Error>({
    queryKey: ['audit', 'verify'],
    queryFn: () => api.get<VerifyResult>('/audit/verify'),
    enabled,
    gcTime: 0,
  })

  return (
    <div className="row">
      <button
        className="btn btn-sm"
        onClick={() => {
          setEnabled(true)
          void q.refetch()
        }}
        disabled={q.isFetching}
      >
        {q.isFetching ? 'Verificando…' : 'Verificar la cadena de hashes'}
      </button>
      {q.isError && <Badge tone="off">No se pudo verificar: {q.error.message}</Badge>}
      {q.data?.ok && <Badge tone="on">Cadena intacta</Badge>}
      {q.data && !q.data.ok && (
        <Badge tone="off" title={`Primer evento roto: ${q.data.broken_at ?? 'desconocido'}`}>
          Cadena rota en {shortHash(q.data.broken_at)}
        </Badge>
      )}
    </div>
  )
}

function eventColumns(
  open: ReadonlySet<string>,
  toggle: (id: string) => void,
): readonly Column<AuditEvent>[] {
  return [
    ...EVENT_COLUMNS,
    {
      key: 'detail',
      header: '',
      className: 'num',
      render: (r) =>
        Object.keys(r.detail ?? {}).length === 0 ? null : (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-expanded={open.has(r.id)}
            onClick={() => toggle(r.id)}
          >
            {open.has(r.id) ? 'Ocultar' : 'Detalle'}
          </button>
        ),
    },
  ]
}

const EVENT_COLUMNS: readonly Column<AuditEvent>[] = [
  { key: 'when', header: 'Cuándo', render: (r) => formatDateTime(r.created_at) },
  { key: 'actor', header: 'Quién', render: (r) => r.actor_label || <span className="faint">sistema</span> },
  { key: 'action', header: 'Acción', render: (r) => <code>{r.action}</code> },
  {
    key: 'target',
    header: 'Sobre qué',
    className: 'wrap',
    render: (r) =>
      r.target_type ? (
        <span>
          {r.target_type} <span className="faint mono">{shortHash(r.target_id)}</span>
        </span>
      ) : (
        <span className="faint">—</span>
      ),
  },
]

const CALL_COLUMNS: readonly Column<ToolCallLog>[] = [
  { key: 'when', header: 'Cuándo', render: (r) => formatDateTime(r.created_at) },
  {
    key: 'tool',
    header: 'Herramienta',
    render: (r) => (
      <span>
        <span className="faint">{r.server_slug}/</span>
        {r.tool_name}
      </span>
    ),
  },
  { key: 'exposed', header: 'Nombre expuesto', render: (r) => <code>{r.exposed_name}</code> },
  {
    key: 'decision',
    header: 'Decisión',
    render: (r) =>
      r.decision === 'allow' ? (
        <Badge tone="on">permitida</Badge>
      ) : (
        <Badge tone="off" title={r.denial_reason}>
          denegada
        </Badge>
      ),
  },
  { key: 'ms', header: 'ms', className: 'num', render: (r) => r.duration_ms || '—' },
  {
    key: 'error',
    header: 'Error',
    className: 'wrap',
    render: (r) => (r.error ? <span className="badge badge-off">{r.error}</span> : <span className="faint">—</span>),
  },
]

export function Audit() {
  const [tab, setTab] = useState<Tab>('events')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [action, setAction] = useState('')
  const [onlyDenied, setOnlyDenied] = useState(false)

  const events = useAuditEvents({ limit: 200, action: action || undefined })
  const calls = useToolCalls({ limit: 200 })

  const callRows = (calls.data ?? []).filter((c) => !onlyDenied || c.decision !== 'allow')

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Auditoría</h1>
          <p className="muted">
            Quién cambió qué en la política, y qué herramienta se invocó contra qué cuenta.
          </p>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'events'}
          className={tab === 'events' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('events')}
        >
          Eventos del ledger
        </button>
        <button
          role="tab"
          aria-selected={tab === 'calls'}
          className={tab === 'calls' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('calls')}
        >
          Llamadas a herramientas
        </button>
      </nav>

      {tab === 'events' ? (
        <section className="card page-section">
          <div className="spread page-toolbar">
            <div className="field">
              <label htmlFor="audit-action">Filtrar por acción</label>
              <input
                id="audit-action"
                value={action}
                placeholder="policy.rule.set"
                onChange={(e) => setAction(e.target.value)}
              />
            </div>
            <ChainVerifier />
          </div>
          <DataTable
            caption="Eventos de auditoría"
            columns={eventColumns(open, (id) =>
              setOpen((prev) => {
                const next = new Set(prev)
                if (!next.delete(id)) next.add(id)
                return next
              }),
            )}
            rows={events.data ?? []}
            rowKey={(r) => r.id}
            loading={events.isLoading}
            error={events.error}
            onRetry={() => void events.refetch()}
            empty="Todavía no hay eventos registrados."
            renderDetail={(r) =>
              open.has(r.id) ? (
                <pre className="detail-json">{JSON.stringify(r.detail, null, 2)}</pre>
              ) : null
            }
          />
        </section>
      ) : (
        <section className="card page-section">
          <div className="spread page-toolbar">
            <label className="row">
              <input type="checkbox" checked={onlyDenied} onChange={(e) => setOnlyDenied(e.target.checked)} />
              Mostrar solo las denegadas
            </label>
            <span className="muted">
              {callRows.length} de {calls.data?.length ?? 0} llamadas
            </span>
          </div>
          <DataTable
            caption="Llamadas a herramientas"
            columns={CALL_COLUMNS}
            rows={callRows}
            rowKey={(r) => r.id}
            loading={calls.isLoading}
            error={calls.error}
            onRetry={() => void calls.refetch()}
            empty="Todavía no pasó ninguna llamada por el gateway."
            rowClassName={(r) => (r.decision === 'allow' ? undefined : 'row-denied')}
          />
        </section>
      )}
    </div>
  )
}

export default Audit
