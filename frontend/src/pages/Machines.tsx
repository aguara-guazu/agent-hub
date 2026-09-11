/** Maquinas con daemon y agentes detectados en cada una.
 *
 *  Quien no es admin ve solo sus maquinas; el backend ya filtra, la consola no
 *  vuelve a decidirlo.
 *
 *  El token de enrolamiento se muestra UNA sola vez: el control plane guarda su
 *  hash y no puede volver a mostrarlo. Esa es la razon de que el dialogo insista.
 */

import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Badge } from '../components/Badge'
import { DataTable, formatDateTime, shortHash, timeAgo } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { errorMessage } from '../components/ErrorState'
import { ConfirmDialog, Modal } from '../components/Modal'
import { Spinner } from '../components/Spinner'
import { useToast } from '../components/Toast'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { invalidateAfterMachineChange, useMachines } from '../lib/queries'
import { CLI_LABELS } from '../lib/types'
import type { AgentInstance, Machine } from '../lib/types'
import '../styles/pages.css'

/** Respuesta de POST /machines/enroll. El token viaja en claro una unica vez. */
interface EnrollResponse {
  machine: Machine
  token: string
}

/**
 * Comando que la persona pega en la maquina nueva.
 *
 * `agenthub` es el CLI TypeScript incluido en la aplicación de escritorio. El token
 * opaco se muestra una sola vez y el comando lo guarda con permisos restrictivos.
 */
export function installCommand(token: string, baseUrl: string): string {
  return `agenthub enroll --url ${baseUrl} --token ${token}`
}

function controlPlaneUrl(): string {
  return typeof window === 'undefined' ? '' : window.location.origin
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Sin permiso de portapapeles, o navegador sin soporte: el texto sigue visible.
    return false
  }
}

function driftingAgents(machine: Machine): AgentInstance[] {
  return machine.agents.filter((agent) => agent.drift_detected)
}

export function Machines() {
  const { isAdmin } = useAuth()
  const machines = useMachines()
  const toast = useToast()
  const queryClient = useQueryClient()

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [enrollOpen, setEnrollOpen] = useState(false)
  const [hostname, setHostname] = useState('')
  const [os, setOs] = useState('')
  const [daemonVersion, setDaemonVersion] = useState('')
  const [enrolled, setEnrolled] = useState<EnrollResponse | null>(null)
  const [toRevoke, setToRevoke] = useState<Machine | null>(null)

  const rows = machines.data ?? []
  const withDrift = useMemo(() => rows.filter((machine) => driftingAgents(machine).length > 0), [rows])

  /* ----------------------------------------------------------------- mutaciones */

  const enroll = useMutation<EnrollResponse, Error, { hostname: string; os: string; daemon_version: string }>({
    mutationFn: (payload) => api.post<EnrollResponse>('/machines/enroll', payload),
    onSuccess: async (response) => {
      await invalidateAfterMachineChange(queryClient)
      setEnrollOpen(false)
      setEnrolled(response)
      setHostname('')
      setOs('')
      setDaemonVersion('')
    },
    onError: (error) => toast.error('No se pudo enrolar la máquina', errorMessage(error)),
  })

  const revoke = useMutation<void, Error, Machine>({
    mutationFn: (machine) => api.delete<void>(`/machines/${machine.id}`),
    onSuccess: async (_data, machine) => {
      await invalidateAfterMachineChange(queryClient)
      setToRevoke(null)
      toast.success(`${machine.hostname} revocada`, 'El daemon de esa máquina ya no puede sincronizar.')
    },
    onError: (error) => toast.error('No se pudo revocar la máquina', errorMessage(error)),
  })

  const setAgentEnabled = useMutation<AgentInstance, Error, { agent: AgentInstance; enabled: boolean }>({
    mutationFn: ({ agent, enabled }) => api.patch<AgentInstance>(`/machines/agents/${agent.id}`, { enabled }),
    onSuccess: async (_data, { agent, enabled }) => {
      await invalidateAfterMachineChange(queryClient)
      toast.success(
        `${CLI_LABELS[agent.cli_kind]} ${enabled ? 'habilitado' : 'deshabilitado'}`,
      )
    },
    onError: (error) => toast.error('No se pudo cambiar el agente', errorMessage(error)),
  })

  function toggleExpanded(id: string): void {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function onEnrollSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (hostname.trim() === '') return
    enroll.mutate({ hostname: hostname.trim(), os: os.trim(), daemon_version: daemonVersion.trim() })
  }

  async function copy(text: string, what: string): Promise<void> {
    const ok = await copyToClipboard(text)
    if (ok) toast.success(`${what} copiado al portapapeles`)
    else toast.info('No se pudo usar el portapapeles', 'Selecciona el texto y cópialo a mano.')
  }

  /* -------------------------------------------------------------------- columnas */

  const columns: Column<Machine>[] = [
    {
      key: 'hostname',
      header: 'Máquina',
      className: 'wrap',
      render: (machine) => (
        <div className="cell-stack">
          <div className="row gap-1">
            <strong>{machine.hostname}</strong>
            {machine.os && <span className="faint">{machine.os}</span>}
          </div>
          {isAdmin && <span className="muted">{machine.user_email}</span>}
        </div>
      ),
    },
    {
      key: 'daemon',
      header: 'Daemon',
      render: (machine) => <code className="faint">{machine.daemon_version || '—'}</code>,
    },
    {
      key: 'seen',
      header: 'Último contacto',
      render: (machine) => (
        <span title={formatDateTime(machine.last_seen_at)}>{timeAgo(machine.last_seen_at)}</span>
      ),
    },
    {
      key: 'snapshot',
      header: 'Snapshot',
      render: (machine) => (
        <code className="faint" title={machine.last_snapshot_hash ?? 'nunca bajó un snapshot'}>
          {shortHash(machine.last_snapshot_hash)}
        </code>
      ),
    },
    {
      key: 'agents',
      header: 'Agentes',
      className: 'num',
      render: (machine) => (
        <button
          type="button"
          className="link-button"
          onClick={() => toggleExpanded(machine.id)}
          aria-expanded={expanded.has(machine.id)}
        >
          {machine.agents.length}
        </button>
      ),
    },
    {
      key: 'drift',
      header: 'Deriva',
      render: (machine) => {
        const drifting = driftingAgents(machine)
        if (drifting.length === 0) return <Badge tone="on">sin deriva</Badge>
        return (
          <Badge tone="stale" title={drifting.map((agent) => agent.drift_detail).join(' | ')}>
            {drifting.length} agente(s)
          </Badge>
        )
      },
    },
    {
      key: 'actions',
      header: <span className="sr-only">Acciones</span>,
      className: 'cell-tight',
      render: (machine) => (
        <div className="row gap-1 actions">
          <button type="button" className="btn btn-sm btn-danger" onClick={() => setToRevoke(machine)}>
            Revocar
          </button>
        </div>
      ),
    },
  ]

  function renderDetail(machine: Machine) {
    if (!expanded.has(machine.id)) return null
    if (machine.agents.length === 0) {
      return (
        <div className="detail">
          <p className="muted">
            El daemon todavía no reportó ningún CLI en esta máquina. Se detectan al arrancar el daemon.
          </p>
        </div>
      )
    }
    return (
      <div className="detail">
        <div className="detail-head">
          <strong>Agentes detectados en {machine.hostname}</strong>
        </div>
        <ul className="agent-list">
          {machine.agents.map((agent) => (
            <li key={agent.id} className="agent">
              <div className="row gap-1">
                <strong>{CLI_LABELS[agent.cli_kind]}</strong>
                {agent.cli_version && <span className="faint">{agent.cli_version}</span>}
                {agent.hot_reload ? (
                  <Badge tone="on" title="Refresca la lista de herramientas sin reiniciar">
                    recarga en caliente
                  </Badge>
                ) : (
                  <Badge tone="stale" title="Sigue mostrando la lista vieja hasta que se reinicie">
                    requiere reinicio
                  </Badge>
                )}
                {agent.enabled ? <Badge tone="on">habilitado</Badge> : <Badge tone="off">deshabilitado</Badge>}
                <span className="faint" title={formatDateTime(agent.last_connected_at)}>
                  {timeAgo(agent.last_connected_at)}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={setAgentEnabled.isPending}
                  onClick={() => setAgentEnabled.mutate({ agent, enabled: !agent.enabled })}
                >
                  {agent.enabled ? 'Deshabilitar' : 'Habilitar'}
                </button>
              </div>
              {agent.drift_detected && (
                <div className="callout callout-warning">
                  <strong>Configuración modificada fuera del hub.</strong>
                  <pre className="preview">{agent.drift_detail || 'El daemon no detalló qué cambió.'}</pre>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  /* ---------------------------------------------------------------------- render */

  const token = enrolled?.token ?? ''
  const command = token === '' ? '' : installCommand(token, controlPlaneUrl())

  return (
    <section className="section">
      <div className="page-header">
        <div>
          <h1 className="page-title">Máquinas</h1>
          <p className="page-subtitle">
            {isAdmin
              ? 'Todas las máquinas de la organización con daemon enrolado.'
              : 'Tus máquinas con daemon enrolado.'}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => setEnrollOpen(true)}>
            Enrolar una máquina
          </button>
        </div>
      </div>

      {withDrift.length > 0 && (
        <p className="callout callout-warning">
          {withDrift.length} máquina(s) con configuración modificada fuera del hub. Abre la fila para ver qué
          archivo cambió.
        </p>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(machine) => machine.id}
        loading={machines.isPending}
        loadingLabel="Cargando las máquinas…"
        error={machines.isError ? machines.error : undefined}
        onRetry={() => void machines.refetch()}
        empty="No hay máquinas enroladas. Enrola la primera para que el daemon pueda sincronizar."
        renderDetail={renderDetail}
        caption="Máquinas con daemon"
      />

      {/* Alta: pide los datos de la maquina. */}
      <Modal
        open={enrollOpen}
        title="Enrolar una máquina"
        onClose={() => setEnrollOpen(false)}
        busy={enroll.isPending}
      >
        <form className="form-grid" onSubmit={onEnrollSubmit} noValidate>
          <div className="field">
            <label htmlFor="machine-hostname">Hostname</label>
            <input
              id="machine-hostname"
              value={hostname}
              required
              placeholder="mbp-de-alguien.local"
              onChange={(event) => setHostname(event.target.value)}
            />
          </div>
          <div className="field-row">
            <div className="field grow">
              <label htmlFor="machine-os">Sistema operativo</label>
              <input
                id="machine-os"
                value={os}
                placeholder="darwin"
                onChange={(event) => setOs(event.target.value)}
              />
            </div>
            <div className="field grow">
              <label htmlFor="machine-daemon-version">Versión del daemon</label>
              <input
                id="machine-daemon-version"
                value={daemonVersion}
                placeholder="0.1.0"
                onChange={(event) => setDaemonVersion(event.target.value)}
              />
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setEnrollOpen(false)} disabled={enroll.isPending}>
              Cancelar
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={enroll.isPending || hostname.trim() === ''}
            >
              {enroll.isPending && <Spinner size={12} label="Enrolando" />}
              Generar token
            </button>
          </div>
        </form>
      </Modal>

      {/* Unica vez que el token existe en claro. */}
      <Modal
        open={enrolled !== null}
        title="Token de la máquina"
        onClose={() => setEnrolled(null)}
        width={640}
        footer={
          <button type="button" className="btn btn-primary" onClick={() => setEnrolled(null)}>
            Ya lo guardé
          </button>
        }
      >
        <p className="callout callout-error" role="alert">
          <strong>Este token se muestra una sola vez.</strong> El control plane guarda únicamente su hash: si
          se cierra este diálogo sin copiarlo, hay que revocar la máquina y enrolarla de nuevo. No lo guardes
          en un archivo del repositorio ni en un gestor personal.
        </p>

        <div className="field">
          <span className="field-label">Token</span>
          <pre className="preview token" data-testid="enroll-token">
            {token}
          </pre>
          <button type="button" className="btn btn-sm" onClick={() => void copy(token, 'Token')}>
            Copiar el token
          </button>
        </div>

        <div className="field">
          <span className="field-label">Comando de instalación</span>
          <pre className="preview">{command}</pre>
          <button type="button" className="btn btn-sm" onClick={() => void copy(command, 'Comando')}>
            Copiar el comando
          </button>
          <span className="field-hint">
            Se ejecuta en {enrolled?.machine.hostname ?? 'la máquina'}. El daemon guarda el token en el
            almacén de credenciales del sistema operativo.
          </span>
        </div>
      </Modal>

      <ConfirmDialog
        open={toRevoke !== null}
        title="Revocar la máquina"
        destructive
        busy={revoke.isPending}
        confirmLabel="Revocar"
        message={
          <>
            Se revoca el token de <strong>{toRevoke?.hostname}</strong> y se borran sus agentes. El daemon de
            esa máquina deja de sincronizar en el acto; las configuraciones que ya escribió quedan como
            están hasta que alguien las limpie.
          </>
        }
        onConfirm={() => toRevoke && revoke.mutate(toRevoke)}
        onClose={() => setToRevoke(null)}
      />
    </section>
  )
}

export default Machines
