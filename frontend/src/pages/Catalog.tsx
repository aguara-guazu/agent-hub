/** Mis MCP servers.
 *
 *  Una sola audiencia: cada persona administra los suyos, y no hay rol que cambie
 *  eso. Un MCP server corre en la maquina de quien lo agrego, asi que no existe
 *  nadie con autoridad para publicarselo, aprobarselo ni quitarselo.
 *
 *  Agregar un server ya alcanza para tenerlo: por defecto queda expuesto en todos
 *  los clientes MCP de la persona. Donde NO se quiere, se apaga en la matriz.
 */

import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Badge } from '../components/Badge'
import { DataTable, shortHash } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { errorMessage } from '../components/ErrorState'
import { ConfirmDialog, Modal } from '../components/Modal'
import { ServerForm } from '../components/ServerForm'
import type { ServerFormPayload } from '../components/ServerForm'
import { Spinner } from '../components/Spinner'
import { useToast } from '../components/Toast'
import { api } from '../lib/api'
import { invalidateAfterCatalogChange, useServers } from '../lib/queries'
import type { McpServer, McpTool } from '../lib/types'
import '../styles/pages.css'

const TRANSPORT_LABELS: Record<string, string> = {
  stdio: 'stdio',
  http: 'http',
}

/** Resumen del endpoint al que apunta el server, para el tooltip de la celda. */
function endpointOf(server: McpServer): string {
  if (server.transport === 'http') return server.url || '(sin URL)'
  const args = server.args.length > 0 ? ` ${server.args.join(' ')}` : ''
  return `${server.command || '(sin comando)'}${args}`
}

function quarantinedTools(server: McpServer): McpTool[] {
  return server.tools.filter((tool) => tool.quarantined)
}

export function Catalog() {
  const servers = useServers()
  const toast = useToast()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<McpServer | null>(null)
  const [probed, setProbed] = useState<McpServer | null>(null)
  const [toDelete, setToDelete] = useState<McpServer | null>(null)

  const rows = useMemo(() => {
    const all = servers.data ?? []
    const needle = search.trim().toLowerCase()
    return all.filter((server) => {
      if (needle === '') return true
      return (
        server.slug.includes(needle) ||
        server.display_name.toLowerCase().includes(needle) ||
        server.description.toLowerCase().includes(needle) ||
        server.tools.some((tool) => tool.exposed_name.includes(needle) || tool.name.includes(needle))
      )
    })
  }, [servers.data, search])

  /* ----------------------------------------------------------------- mutaciones */

  const save = useMutation<McpServer, Error, { id: string | null; payload: ServerFormPayload }>({
    mutationFn: ({ id, payload }) =>
      id === null
        ? api.post<McpServer>('/catalog/servers', payload)
        : api.patch<McpServer>(`/catalog/servers/${id}`, payload),
    onSuccess: async (server) => {
      await invalidateAfterCatalogChange(queryClient)
      setFormOpen(false)
      setEditing(null)
      toast.success(`${server.slug} guardado`, 'Sondea el server para descubrir sus herramientas.')
    },
    onError: (error) => toast.error('No se pudo guardar el server', errorMessage(error)),
  })

  const probe = useMutation<McpServer, Error, McpServer>({
    mutationFn: (server) => api.post<McpServer>(`/catalog/servers/${server.id}/probe`),
    onSuccess: async (server) => {
      await invalidateAfterCatalogChange(queryClient)
      setProbed(server)
      // El endpoint responde 200 aunque la conexion falle: el fallo viene en el cuerpo.
      if (server.last_probe_error) toast.error(`El sondeo de ${server.slug} falló`, server.last_probe_error)
    },
    onError: (error) => toast.error('No se pudo sondear', errorMessage(error)),
  })

  /** No es una aprobacion de catalogo: no hay quien apruebe por encima del dueno.
   *  Es aceptar la definicion nueva de un server que cambio una tool que ya usabas. */
  const accept = useMutation<McpServer, Error, McpServer>({
    mutationFn: (server) => api.post<McpServer>(`/catalog/servers/${server.id}/approve`),
    onSuccess: async (server) => {
      await invalidateAfterCatalogChange(queryClient)
      toast.success(`Definiciones de ${server.slug} aceptadas`)
    },
    onError: (error) => toast.error('No se pudo aceptar la definición', errorMessage(error)),
  })

  const remove = useMutation<void, Error, McpServer>({
    mutationFn: (server) => api.delete<void>(`/catalog/servers/${server.id}`),
    onSuccess: async (_data, server) => {
      await invalidateAfterCatalogChange(queryClient)
      setToDelete(null)
      toast.success(`${server.slug} eliminado`)
    },
    onError: (error) => toast.error('No se pudo eliminar', errorMessage(error)),
  })

  function toggleExpanded(id: string): void {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /* -------------------------------------------------------------------- columnas */

  const columns: Column<McpServer>[] = [
    {
      key: 'server',
      header: 'Server',
      className: 'wrap',
      render: (server) => (
        <div className="cell-stack">
          <div className="row gap-1">
            <strong>{server.display_name}</strong>
            <code className="faint">{server.slug}</code>
          </div>
          {server.description && <span className="muted">{server.description}</span>}
        </div>
      ),
    },
    {
      key: 'transport',
      header: 'Transporte',
      render: (server) => (
        <span title={endpointOf(server)}>
          <Badge tone="neutral">{TRANSPORT_LABELS[server.transport] ?? server.transport}</Badge>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Sondeo',
      render: (server) =>
        server.last_probe_error ? (
          <Badge tone="off" title={server.last_probe_error}>
            con error
          </Badge>
        ) : server.tools.length > 0 ? (
          <Badge tone="on">ok</Badge>
        ) : (
          <span className="faint">sin sondear</span>
        ),
    },
    {
      key: 'tools',
      header: 'Herramientas',
      className: 'num',
      render: (server) => {
        const quarantined = quarantinedTools(server).length
        return (
          <button
            type="button"
            className="link-button"
            onClick={() => toggleExpanded(server.id)}
            aria-expanded={expanded.has(server.id)}
          >
            {server.tools.length}
            {quarantined > 0 && (
              <Badge tone="off" title={`${quarantined} en cuarentena`}>
                {quarantined} en cuarentena
              </Badge>
            )}
          </button>
        )
      },
    },
    {
      key: 'actions',
      header: <span className="sr-only">Acciones</span>,
      className: 'cell-tight',
      render: (server) => (
        <div className="row gap-1 actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => probe.mutate(server)}
            disabled={probe.isPending}
            title="Conecta al server real y lista sus herramientas"
          >
            {probe.isPending && probe.variables?.id === server.id ? <Spinner size={12} label="Sondeando" /> : null}
            Sondear
          </button>
          {quarantinedTools(server).length > 0 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => accept.mutate(server)}
              disabled={accept.isPending}
              title="Acepta la definición nueva y saca las herramientas de cuarentena"
            >
              Aceptar cambios
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setEditing(server)
              setFormOpen(true)
            }}
          >
            Editar
          </button>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => setToDelete(server)}>
            Eliminar
          </button>
        </div>
      ),
    },
  ]

  function renderDetail(server: McpServer) {
    if (!expanded.has(server.id)) return null
    return (
      <div className="detail">
        <div className="detail-head">
          <strong>Herramientas de {server.slug}</strong>
          <span className="faint mono" title={server.definition_hash}>
            hash {shortHash(server.definition_hash)}
          </span>
        </div>
        {server.last_probe_error && (
          <p className="callout callout-error">Último sondeo: {server.last_probe_error}. Mientras el server esté habilitado se reintenta solo cada 30 s.</p>
        )}
        {server.tools.length === 0 ? (
          <p className="muted">
            Todavía no se descubrió ninguna herramienta. Usá «Sondear» para conectarse al server real.
          </p>
        ) : (
          <ul className="tool-list">
            {server.tools.map((tool) => (
              <li key={tool.id} className={tool.quarantined ? 'tool quarantined' : 'tool'}>
                <code>{tool.exposed_name}</code>
                <span className="faint">({tool.name})</span>
                {tool.quarantined && (
                  <Badge tone="off" title={tool.quarantine_reason}>
                    cuarentena
                  </Badge>
                )}
                {tool.quarantined && <span className="quarantine-reason">{tool.quarantine_reason}</span>}
                {!tool.quarantined && tool.description && <span className="muted">{tool.description}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  /* ---------------------------------------------------------------------- render */

  const quarantinedTotal = (servers.data ?? []).reduce(
    (total, server) => total + quarantinedTools(server).length,
    0,
  )

  return (
    <section className="section">
      <div className="page-header">
        <div>
          <h1 className="page-title">Mis MCP servers</h1>
          <p className="page-subtitle">
            Los que administrás desde el hub. Corren en tu máquina; el hub solo decide a qué cliente se
            expone cada uno. Un server nuevo queda prendido en todos: se apaga donde molesta, en la matriz.
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            Nuevo MCP server
          </button>
        </div>
      </div>

      {quarantinedTotal > 0 && (
        <p className="callout callout-warning">
          Hay {quarantinedTotal} herramienta(s) en cuarentena: su definición cambió desde la última vez.
          No se exponen a ningún cliente hasta que las mires y aceptes los cambios.
        </p>
      )}

      <div className="toolbar">
        <div className="field">
          <label className="sr-only" htmlFor="catalog-search">
            Buscar
          </label>
          <input
            id="catalog-search"
            type="search"
            placeholder="Buscar por slug, nombre o herramienta"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <span className="grow" />
        <span className="faint">
          {rows.length} de {(servers.data ?? []).length}
        </span>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(server) => server.id}
        loading={servers.isPending}
        loadingLabel="Cargando el catálogo…"
        error={servers.isError ? servers.error : undefined}
        onRetry={() => void servers.refetch()}
        empty={
          (servers.data ?? []).length === 0
            ? 'Todavía no agregaste ningún MCP server.'
            : 'Ningún server coincide con el filtro.'
        }
        renderDetail={renderDetail}
        caption="Mis MCP servers"
      />

      <ServerForm
        open={formOpen}
        server={editing}
        busy={save.isPending}
        onClose={() => {
          setFormOpen(false)
          setEditing(null)
        }}
        onSubmit={(payload) => save.mutate({ id: editing?.id ?? null, payload })}
      />

      <Modal
        open={probed !== null}
        title={probed ? `Sondeo de ${probed.slug}` : 'Sondeo'}
        onClose={() => setProbed(null)}
        footer={
          <button type="button" className="btn btn-primary" onClick={() => setProbed(null)}>
            Cerrar
          </button>
        }
      >
        {probed && probed.last_probe_error && <p className="callout callout-error">{probed.last_probe_error}</p>}
        {probed && probed.tools.length === 0 ? (
          <p className="muted">El server no devolvió ninguna herramienta.</p>
        ) : (
          <ul className="tool-list">
            {(probed?.tools ?? []).map((tool) => (
              <li key={tool.id} className={tool.quarantined ? 'tool quarantined' : 'tool'}>
                <code>{tool.exposed_name}</code>
                <span className="faint">({tool.name})</span>
                {tool.quarantined && <Badge tone="off">cuarentena: {tool.quarantine_reason}</Badge>}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          Las herramientas descubiertas quedan guardadas. Las que cambiaron de definición entran en
          cuarentena hasta que aceptes los cambios.
        </p>
      </Modal>

      <ConfirmDialog
        open={toDelete !== null}
        title="Eliminar el MCP server"
        destructive
        busy={remove.isPending}
        confirmLabel="Eliminar"
        message={
          <>
            Se elimina <code>{toDelete?.slug}</code>, sus herramientas y las reglas de exposición que las
            mencionan. Los CLIs dejan de verlo en cuanto baje el próximo snapshot.
          </>
        }
        onConfirm={() => toDelete && remove.mutate(toDelete)}
        onClose={() => setToDelete(null)}
      />

</section>
  )
}

export default Catalog
