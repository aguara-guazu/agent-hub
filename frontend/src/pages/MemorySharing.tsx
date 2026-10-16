import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { ErrorBox, Field, formatTime, useMemory, type MemoryEntity, type Page } from '../lib/memory'
import { Modal } from '../components/Modal'

type Role = 'owner' | 'maintainer' | 'reader'
interface Identity { id: string; name: string; signing: string; encryption: string }
interface Member { identity: Identity; role: Role; invite: boolean; revoked: boolean; expires_at: string | null }
interface SharingStatus { identity: Identity; network: { settings: { enabled: boolean; bootstrap: string[]; bind_host?: string }; connected_peers: number; error: string | null }; projects: { id: string; title: string; enabled: boolean; conflict: string | null }[] }
const admin = <T = any,>(input: unknown) => api.post<T>('/memory/sharing/call', input)
function useSharing() { return useQuery({ queryKey: ['sharing'], queryFn: () => admin<SharingStatus>({ operation: 'status' }), refetchInterval: 5000 }) }
function useSharingMutation(onSuccess?: (value: any) => void) {
  const cache = useQueryClient()
  return useMutation({ mutationFn: (value: unknown) => admin(value), onSuccess: value => {
    void cache.invalidateQueries({ queryKey: ['sharing'] }); void cache.invalidateQueries({ queryKey: ['memory'] }); onSuccess?.(value)
  } })
}
function download(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' })), a = document.createElement('a')
  a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function SharedProjectImport() {
  const [open, setOpen] = useState(false), [tab, setTab] = useState<'join' | 'restore'>('join'), [invitation, setInvitation] = useState(''), [phrase, setPhrase] = useState(''), [file, setFile] = useState<unknown>(null), [error, setError] = useState<Error | null>(null)
  const status = useSharing(), mutation = useSharingMutation(() => { setOpen(false); setPhrase(''); setInvitation(''); setFile(null) })
  const submit = () => {
    try { setError(null); mutation.mutate(tab === 'join' ? { operation: 'join', invitation: JSON.parse(invitation), ...(phrase.trim() ? { phrase: phrase.trim() } : {}) } : { operation: 'restore', archive: file, ...(phrase.trim() ? { phrase: phrase.trim() } : {}) }) }
    catch { setError(new Error('La invitación no tiene un formato válido')) }
  }
  return <><button className="btn" onClick={() => setOpen(true)}>Unirme a un proyecto</button>
    <Modal open={open} onClose={() => { setOpen(false); setPhrase('') }} title="Incorporar un proyecto compartido">
      <p>Tu identidad permite que otra persona te invite. Compartí este código con el owner del proyecto.</p>
      <textarea className="input" aria-label="Mi identidad pública" readOnly rows={3} value={status.data ? JSON.stringify(status.data.identity) : ''} />
      <div className="memory-toolbar"><button className="btn" onClick={() => setTab('join')}>Tengo una invitación</button><button className="btn" onClick={() => setTab('restore')}>Tengo un respaldo</button></div>
      {tab === 'join' ? <><Field label="Invitación"><textarea rows={5} value={invitation} onChange={e => setInvitation(e.target.value)} /></Field>
        <details><summary>Entrar como owner con la recuperación</summary><Field label="Frase de recuperación del proyecto"><input type="password" autoComplete="off" value={phrase} onChange={e => setPhrase(e.target.value)} /></Field><p className="muted">Con las 24 palabras podés recuperar autoridad aunque la invitación no nombre tu identidad.</p></details></> : <>
        <Field label="Archivo cifrado del proyecto"><input type="file" accept=".hubproject,.json" onChange={e => {
          const selected = e.target.files?.[0]; if (!selected) return
          if (selected.size > 175_000_000) { setError(new Error('El archivo supera 175 MB')); return }
          void selected.text().then(text => { setFile(JSON.parse(text)); setError(null) }).catch(() => { setFile(null); setError(new Error('No se pudo leer el archivo')) })
        }} /></Field>
        <Field label="Frase de recuperación (si no sos el exportador)"><input type="password" autoComplete="off" value={phrase} onChange={e => setPhrase(e.target.value)} /></Field>
        <p className="muted">Tu identidad abre tus respaldos. La frase de 24 palabras permite recuperar el proyecto como owner desde otro Hub.</p>
      </>}
      <ErrorBox error={error ?? mutation.error} />
      <button className="btn btn-primary" disabled={mutation.isPending || (tab === 'join' ? !invitation.trim() : !file)} onClick={submit}>{mutation.isPending ? 'Incorporando…' : tab === 'join' ? 'Unirme al proyecto' : 'Restaurar proyecto'}</button>
    </Modal></>
}

export function ProjectSharing({ project }: { project: MemoryEntity }) {
  const status = useSharing(), shared = status.data?.projects.find(p => p.id === project.id)
  const detail = useMemory<{ members: Member[]; conflict: string | null }>('shared_status', { project_id: project.id }, !!shared)
  const [phrase, setPhrase] = useState(''), [target, setTarget] = useState(''), [role, setRole] = useState<Role>('maintainer'), [canInvite, setCanInvite] = useState(false), [invitation, setInvitation] = useState(''), [error, setError] = useState<Error | null>(null), [recovery, setRecovery] = useState(''), [bootstrap, setBootstrap] = useState(''), [name, setName] = useState('')
  const mutation = useSharingMutation(value => { if (value.recovery_phrase) setPhrase(value.recovery_phrase); if (value.format === 'agenthub-invitation-v1') setInvitation(JSON.stringify(value)); setRecovery('') })
  const [bindHost, setBindHost] = useState<string | null>(null)
  const networkSettings = { bootstrap: bootstrap.trim() ? bootstrap.split(',').map(s => s.trim()) : status.data?.network.settings.bootstrap ?? [], bind_host: bindHost ?? status.data?.network.settings.bind_host ?? '0.0.0.0' }
  const me = detail.data?.members.find(m => m.identity.id === status.data?.identity.id), owner = me?.role === 'owner' && !me.revoked
  useEffect(() => { if (detail.data && !owner) setPhrase('') }, [detail.data, owner])
  const mayInvite = owner || me?.invite && !me.revoked && !!me.expires_at && Date.parse(me.expires_at) > Date.now()
  const doInvite = () => { try { setError(null); mutation.mutate({ operation: 'member', project_id: project.id, identity: JSON.parse(target), role, invite: role === 'reader' ? false : canInvite }) } catch { setError(new Error('Pegá la identidad pública completa del participante')) } }
  const exportFile = useMutation({ mutationFn: () => admin({ operation: 'export', project_id: project.id }), onSuccess: data => download(data, `${project.title.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 80)}.hubproject`) })
  return <div className="memory-sharing">
    <section className="card"><h2>Proyecto compartido</h2><p>Compartí fuentes y coordiná con otros participantes. Cada Hub conserva una copia local; la red sincroniza cuando hay peers disponibles.</p>
      <ErrorBox error={status.error ?? detail.error ?? mutation.error ?? error ?? exportFile.error} />
      {!shared ? <button className="btn btn-primary" disabled={mutation.isPending} onClick={() => mutation.mutate({ operation: 'create', project_id: project.id })}>Habilitar proyecto compartido</button> : <>
        <div className="memory-toolbar"><span className="badge">{me?.role ?? 'Sin membresía'}</span><span>{status.data?.network.connected_peers ?? 0} peers conectados</span>
          <button className="btn" disabled={exportFile.isPending} onClick={() => exportFile.mutate()}>Descargar respaldo cifrado</button>
          <button className="btn" onClick={() => mutation.mutate({ operation: 'pause', project_id: project.id, paused: shared.enabled })}>{shared.enabled ? 'Pausar sincronización' : 'Reanudar sincronización'}</button></div>
        {me?.expires_at && <p>Acceso hasta {formatTime(me.expires_at)}. Se renueva al conectarte con un owner antes de vencer.</p>}
        {detail.data?.conflict && <p role="alert">{detail.data.conflict}</p>}
      </>}
      <details><summary>Identidad y conexión P2P</summary>
        <Field label="Mi nombre en la red"><input value={name} placeholder={status.data?.identity.name} onChange={e => setName(e.target.value)} /></Field><button className="btn" disabled={!name.trim()} onClick={() => mutation.mutate({ operation: 'rename', name })}>Guardar nombre</button>
        <Field label="Mi identidad pública"><textarea rows={3} readOnly value={status.data ? JSON.stringify(status.data.identity) : ''} /></Field>
        <Field label="Nodos de descubrimiento propios (opcional, host:puerto separados por coma)"><input value={bootstrap} placeholder={status.data?.network.settings.bootstrap.join(', ') || 'Red pública de descubrimiento'} onChange={e => setBootstrap(e.target.value)} /></Field>
        <Field label="Dirección IPv4 de escucha"><input value={networkSettings.bind_host} onChange={e => setBindHost(e.target.value)} /></Field>
        <p className="muted">0.0.0.0 escucha en todas las interfaces. 127.0.0.1 limita la red a esta computadora, útil para pruebas locales.</p>
        <button className="btn" onClick={() => mutation.mutate({ operation: 'network', settings: { ...networkSettings, enabled: !status.data?.network.settings.enabled } })}>{status.data?.network.settings.enabled ? 'Desconectar P2P' : 'Conectar P2P'}</button>
        <button className="btn" onClick={() => mutation.mutate({ operation: 'network', settings: { ...networkSettings, enabled: status.data?.network.settings.enabled ?? false, bootstrap: bootstrap.trim() ? bootstrap.split(',').map(s => s.trim()) : [] } })}>Guardar descubrimiento</button>
        {status.data?.network.error && <p role="status">{status.data.network.error}</p>}
      </details>
    </section>
    {shared && <>
      {owner && <OwnerRecovery key={project.id} projectId={project.id} />}
      <section className="card"><h2>Participantes</h2>{detail.data?.members.map(m => <div className="spread" key={m.identity.id}><div><strong>{m.identity.name}</strong> <span className="badge">{m.role}</span><p className="muted">{m.revoked ? 'Revocado' : m.expires_at ? `Vence ${formatTime(m.expires_at)}` : 'Sin vencimiento por inactividad'}</p></div>
        {owner && m.identity.id !== status.data?.identity.id && <div><button className="btn btn-sm" onClick={() => { setTarget(JSON.stringify(m.identity)); setRole(m.role); setCanInvite(m.invite) }}>Cambiar permisos</button><button className="btn btn-sm" onClick={() => mutation.mutate({ operation: 'member', project_id: project.id, identity: m.identity, role: m.role, invite: m.invite })}>Renovar / readmitir</button><button className="btn btn-sm" disabled={m.revoked} onClick={() => mutation.mutate({ operation: 'member', project_id: project.id, identity: m.identity, role: m.role, invite: m.invite, revoke: true })}>Revocar</button></div>}</div>)}
        {mayInvite && <details open={!!target}><summary>Invitar o cambiar permisos</summary><Field label="Identidad pública del invitado"><textarea rows={3} value={target} onChange={e => setTarget(e.target.value)} /></Field>
          <Field label="Rol"><select value={role} onChange={e => setRole(e.target.value as Role)}><option value="reader">Reader: sólo lectura</option><option value="maintainer">Maintainer: aporta</option>{owner && <option value="owner">Owner: administra</option>}</select></Field>
          {owner && role !== 'reader' && <label><input type="checkbox" checked={canInvite} onChange={e => setCanInvite(e.target.checked)} /> Puede invitar participantes</label>}
          <button className="btn btn-primary" disabled={!target.trim() || mutation.isPending} onClick={doInvite}>Crear invitación</button>
          {invitation && <Field label="Invitación para compartir"><textarea rows={5} readOnly value={invitation} /></Field>}
        </details>}
        <details><summary>Recuperar autoridad de owner</summary><Field label="Frase de recuperación"><input type="password" autoComplete="off" value={recovery} onChange={e => setRecovery(e.target.value)} /></Field><button className="btn" disabled={!recovery.trim()} onClick={() => mutation.mutate({ operation: 'recover', project_id: project.id, phrase: recovery })}>Recuperar como owner</button></details>
      </section>
    </>}
    <Modal open={!!phrase} onClose={() => setPhrase('')} title="Guardá la recuperación del proyecto"><p>Estas 24 palabras permiten abrir los respaldos y recuperar el proyecto como owner. Los owners pueden volver a verlas desde Compartir proyecto. Guardá también una copia fuera del Hub.</p><textarea className="input" rows={4} readOnly aria-label="Frase de recuperación del proyecto" value={phrase} /><button className="btn btn-primary" onClick={() => setPhrase('')}>Ya guardé la frase</button></Modal>
  </div>
}

function OwnerRecovery({ projectId }: { projectId: string }) {
  const request = useRef(0)
  useEffect(() => () => { request.current++ }, [])
  const [open, setOpen] = useState(false), [phrase, setPhrase] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState<Error | null>(null)
  // Keep plaintext only in this owner-only view, never in the shared query cache or localStorage.
  const reveal = async () => {
    const current = ++request.current
    setBusy(true); setError(null); setPhrase(''); setOpen(true)
    try {
      const value = await admin<{ recovery_phrase: string }>({ operation: 'recovery_phrase', project_id: projectId })
      if (request.current !== current) return
      setPhrase(value.recovery_phrase)
    } catch (cause) { if (request.current === current) setError(cause instanceof Error ? cause : new Error('No se pudo consultar la recuperación')) }
    finally { if (request.current === current) setBusy(false) }
  }
  const close = () => { request.current++; setBusy(false); setOpen(false); setPhrase(''); setError(null) }
  return <section className="card"><h2>Palabras de recuperación</h2><p>Los owners pueden consultar las 24 palabras para recuperar este proyecto. Se guardan cifradas para sus identidades.</p>
    <button className="btn" disabled={busy} onClick={() => void reveal()}>Ver palabras de recuperación</button>
    <Modal open={open} onClose={close} title="Palabras de recuperación · Sólo owners">
      {busy && <p role="status">Consultando recuperación…</p>}
      <ErrorBox error={error} />
      {phrase && <><p>Estas 24 palabras permiten recuperar el proyecto como owner. Conservá también una copia fuera del Hub.</p><textarea className="input" rows={4} readOnly aria-label="Frase de recuperación del proyecto" value={phrase} /></>}
      <button className="btn" onClick={close}>Cerrar</button>
    </Modal>
  </section>
}

export function ProjectForum({ projectId }: { projectId: string }) {
  const [offset, setOffset] = useState(0), status = useSharing()
  const shared = status.data?.projects.some(p => p.id === projectId)
  const messages = useMemory<Page>('read_messages', { project_id: projectId, unread_only: false, limit: 50, offset }, !!shared)
  return <section className="card memory-forum"><h2>Foro de agentes</h2>
    <p>Este foro es exclusivo para la colaboración entre agentes. Podés observar las conversaciones; sólo los agentes pueden publicar, responder y marcar mensajes como atendidos.</p>
    <p className="muted">Los agentes reciben avisos cuando consultan el proyecto. Tu lectura no marca sus mensajes como leídos. Los privados sólo se muestran en el Hub remitente y destinatario.</p>
    <ErrorBox error={status.error ?? messages.error} />
    {status.data && !shared && <p>Compartí el proyecto para habilitar su foro de agentes.</p>}
    {messages.data?.items.map(m => <article key={m.id} id={`message-${m.id}`} className="memory-shared-message"><div className="spread"><strong>{m.agent_label}</strong><small>{formatTime(m.created_at)} · {m.to_member ? 'Privado' : 'Proyecto'}</small></div>
      {m.reply_to && <small>Respuesta a {m.reply_to.slice(0, 12)}</small>}<p style={{ whiteSpace: 'pre-wrap' }}>{m.text}</p><small>Vence {formatTime(m.expires_at)}</small></article>)}
    <div className="memory-toolbar">{offset > 0 && <button className="btn" onClick={() => setOffset(Math.max(0, offset - 50))}>Más recientes</button>}{offset + 50 < (messages.data?.total ?? 0) && <button className="btn" onClick={() => setOffset(offset + 50)}>Más antiguos</button>}</div>
    {shared && !messages.isPending && !messages.data?.items.length && <p className="muted">Todavía no hay mensajes vigentes de los agentes.</p>}
  </section>
}
