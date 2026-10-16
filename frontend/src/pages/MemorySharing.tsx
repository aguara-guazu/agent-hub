import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { ErrorBox, Field, formatTime, useMemory, type MemoryEntity, type Page } from '../lib/memory'
import { Modal } from '../components/Modal'

type Role = 'owner' | 'maintainer' | 'reader'
interface Identity { id: string; name: string; signing: string; encryption: string }
interface Member { identity: Identity; role: Role; invite: boolean; revoked: boolean; expires_at: string | null }
interface PeerProgress { project_id: string; member_id: string; total: number; confirmed: number; state: 'waiting' | 'syncing' | 'synced' }
interface SharingStatus { identity: Identity; network: { settings: { enabled: boolean; bootstrap: string[]; bind_host?: string }; connected_peers: number; peers?: PeerProgress[]; error: string | null }; projects: { id: string; title: string; enabled: boolean; conflict: string | null }[] }
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
  const mutation = useSharingMutation(() => { setOpen(false); setPhrase(''); setInvitation(''); setFile(null) })
  const submit = () => {
    try { setError(null); mutation.mutate(tab === 'join' ? { operation: 'join', invitation: JSON.parse(invitation), ...(phrase.trim() ? { phrase: phrase.trim() } : {}) } : { operation: 'restore', archive: file, ...(phrase.trim() ? { phrase: phrase.trim() } : {}) }) }
    catch { setError(new Error('La invitación no tiene un formato válido')) }
  }
  return <><button className="btn" onClick={() => setOpen(true)}>Unirme a un proyecto</button>
    <Modal open={open} onClose={() => { setOpen(false); setPhrase('') }} title="Incorporar un proyecto compartido">
      <p>Para recibir una invitación, copiá tu identidad desde <a href="#/settings">Ajustes</a> y compartila con el owner.</p>
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
  const [phrase, setPhrase] = useState(''), [target, setTarget] = useState(''), [role, setRole] = useState<Role>('maintainer'), [canInvite, setCanInvite] = useState(false), [invitation, setInvitation] = useState(''), [error, setError] = useState<Error | null>(null)
  const mutation = useSharingMutation(value => { if (value.recovery_phrase) setPhrase(value.recovery_phrase); if (value.format === 'agenthub-invitation-v1') setInvitation(JSON.stringify(value)) })
  const me = detail.data?.members.find(m => m.identity.id === status.data?.identity.id), owner = me?.role === 'owner' && !me.revoked
  useEffect(() => { if (detail.data && !owner) setPhrase('') }, [detail.data, owner])
  const mayInvite = owner || me?.invite && !me.revoked && !!me.expires_at && Date.parse(me.expires_at) > Date.now()
  const doInvite = () => { try { setError(null); mutation.mutate({ operation: 'member', project_id: project.id, identity: JSON.parse(target), role, invite: role === 'reader' ? false : canInvite }) } catch { setError(new Error('Pegá la identidad pública completa del participante')) } }
  return <div className="memory-sharing">
    <section className="card"><h2>{shared ? 'Participantes' : 'Proyecto compartido'}</h2>
      <ErrorBox error={status.error ?? detail.error ?? mutation.error ?? error} />
      {!shared ? <button className="btn btn-primary" disabled={mutation.isPending} onClick={() => mutation.mutate({ operation: 'create', project_id: project.id })}>Habilitar proyecto compartido</button> : <>
        {me?.expires_at && <p>Acceso hasta {formatTime(me.expires_at)}. Se renueva al conectarte con un owner antes de vencer.</p>}
        {detail.data?.conflict && <p role="alert">{detail.data.conflict}</p>}
        {detail.data?.members.map(m => <div className="spread memory-member" key={m.identity.id}><div className="memory-member-info"><strong>{m.identity.id === status.data?.identity.id ? status.data.identity.name : m.identity.name}</strong> <span className="badge">{m.role}</span><p className="muted">{m.revoked ? 'Revocado' : m.expires_at ? `Vence ${formatTime(m.expires_at)}` : 'Sin vencimiento por inactividad'}</p>{m.identity.id !== status.data?.identity.id && !m.revoked && (!m.expires_at || Date.parse(m.expires_at) > Date.now()) && <MemberProgress member={m} progress={status.data?.network.peers?.find(p => p.project_id === project.id && p.member_id === m.identity.id)} />}</div>
        {owner && m.identity.id !== status.data?.identity.id && <div><button className="btn btn-sm" onClick={() => { setTarget(JSON.stringify(m.identity)); setRole(m.role); setCanInvite(m.invite) }}>Cambiar permisos</button><button className="btn btn-sm" onClick={() => mutation.mutate({ operation: 'member', project_id: project.id, identity: m.identity, role: m.role, invite: m.invite })}>Renovar / readmitir</button><button className="btn btn-sm" disabled={m.revoked} onClick={() => mutation.mutate({ operation: 'member', project_id: project.id, identity: m.identity, role: m.role, invite: m.invite, revoke: true })}>Revocar</button></div>}</div>)}
        {mayInvite && <details open={!!target}><summary>Invitar o cambiar permisos</summary><Field label="Identidad pública del invitado"><textarea rows={3} value={target} onChange={e => setTarget(e.target.value)} /></Field>
          <Field label="Rol"><select value={role} onChange={e => setRole(e.target.value as Role)}><option value="reader">Reader: sólo lectura</option><option value="maintainer">Maintainer: aporta</option>{owner && <option value="owner">Owner: administra</option>}</select></Field>
          {owner && role !== 'reader' && <label><input type="checkbox" checked={canInvite} onChange={e => setCanInvite(e.target.checked)} /> Puede invitar participantes</label>}
          <button className="btn btn-primary" disabled={!target.trim() || mutation.isPending} onClick={doInvite}>Crear invitación</button>
          {invitation && <Field label="Invitación para compartir"><textarea rows={5} readOnly value={invitation} /></Field>}
        </details>}

      </>}
    </section>
    <Modal open={!!phrase} onClose={() => setPhrase('')} title="Guardá la recuperación del proyecto"><p>Estas 24 palabras permiten abrir los respaldos y recuperar el proyecto como owner. Los owners pueden volver a verlas desde Ajustes → Proyectos compartidos. Guardá también una copia fuera del Hub.</p><textarea className="input" rows={4} readOnly aria-label="Frase de recuperación del proyecto" value={phrase} /><button className="btn btn-primary" onClick={() => setPhrase('')}>Ya guardé la frase</button></Modal>
  </div>
}

function MemberProgress({ member, progress }: { member: Member; progress?: PeerProgress }) {
  const percent = progress?.state === 'synced' ? 100 : progress?.total ? Math.floor(progress.confirmed * 100 / progress.total) : 0
  const label = !progress ? 'Sin conexión' : progress.state === 'waiting' ? 'Conectado · esperando recepción' : progress.state === 'synced' ? 'Recibió todos los cambios' : `Recibiendo cambios · ${percent}%`
  return <div className="memory-member-progress" title="Recepción confirmada por el Hub del participante. No indica el progreso de análisis de sus agentes.">
    <small>{label}</small><progress aria-label={`Recepción de ${member.identity.name}`} max={100} value={percent} />
    {progress && progress.state !== 'waiting' && <small>{progress.confirmed} de {progress.total} cambios</small>}
  </div>
}

export function SharingSettings() {
  const status = useSharing(), [name, setName] = useState<string | null>(null), [bootstrap, setBootstrap] = useState<string | null>(null), [bindHost, setBindHost] = useState<string | null>(null)
  const [selected, setSelected] = useState(''), [copied, setCopied] = useState(false), [copyError, setCopyError] = useState<Error | null>(null)
  const mutation = useSharingMutation(() => { setName(null); setBootstrap(null); setBindHost(null) })
  const identity = status.data?.identity, settings = status.data?.network.settings
  const project = status.data?.projects.find(p => p.id === selected) ?? status.data?.projects[0]
  const copy = async () => {
    if (!identity) return
    try { await navigator.clipboard.writeText(JSON.stringify(identity)); setCopied(true); setCopyError(null) }
    catch { setCopyError(new Error('No se pudo copiar la identidad. Intentá nuevamente.')) }
  }
  return <div className="memory-sharing memory-sharing-settings">
    <section className="card"><h2>Mi identidad</h2>
      <Field label="Mi nombre en la red"><input value={name ?? identity?.name ?? ''} maxLength={120} onChange={e => { setName(e.target.value); setCopied(false) }} /></Field>
      <div className="memory-toolbar"><button className="btn" disabled={mutation.isPending || !name?.trim() || name.trim() === identity?.name} onClick={() => mutation.mutate({ operation: 'rename', name: name?.trim() })}>Guardar nombre</button>
        <button className="btn" disabled={!identity} onClick={() => void copy()}>Copiar identidad</button>{copied && <span role="status">Identidad copiada</span>}</div>
      <ErrorBox error={status.error ?? mutation.error ?? copyError} />
      <details><summary>Red P2P · opciones avanzadas</summary>
        <Field label="Nodos de descubrimiento propios (opcional, host:puerto separados por coma)"><input value={bootstrap ?? settings?.bootstrap.join(', ') ?? ''} placeholder="Red pública de descubrimiento" onChange={e => setBootstrap(e.target.value)} /></Field>
        <Field label="Dirección IPv4 de escucha"><input value={bindHost ?? settings?.bind_host ?? '0.0.0.0'} onChange={e => setBindHost(e.target.value)} /></Field>
        <button className="btn" disabled={!settings || mutation.isPending} onClick={() => mutation.mutate({ operation: 'network', settings: { bootstrap: (bootstrap ?? settings?.bootstrap.join(',') ?? '').split(',').map(s => s.trim()).filter(Boolean), bind_host: bindHost ?? settings?.bind_host ?? '0.0.0.0' } })}>Guardar descubrimiento</button>
        {status.data?.network.error && <p role="status">{status.data.network.error}</p>}
      </details>
    </section>
    {!!status.data?.projects.length && <section className="card"><h2>Proyectos compartidos</h2>
      <Field label="Proyecto compartido"><select value={project?.id ?? ''} onChange={e => setSelected(e.target.value)}>{status.data.projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></Field>
      {project && <SharedProjectSettings key={project.id} project={project} identityId={identity?.id} />}
    </section>}
  </div>
}

function SharedProjectSettings({ project, identityId }: { project: SharingStatus['projects'][number]; identityId?: string }) {
  const detail = useMemory<{ members: Member[] }>('shared_status', { project_id: project.id })
  const me = detail.data?.members.find(m => m.identity.id === identityId)
  const [recovery, setRecovery] = useState('')
  const mutation = useSharingMutation(() => setRecovery(''))
  const exportFile = useMutation({ mutationFn: () => admin({ operation: 'export', project_id: project.id }), onSuccess: data => download(data, `${project.title.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 80)}.hubproject`) })
  return <>
    <div className="memory-toolbar"><button className="btn" disabled={exportFile.isPending} onClick={() => exportFile.mutate()}>Descargar respaldo cifrado</button>
      {!project.enabled && <button className="btn" onClick={() => mutation.mutate({ operation: 'pause', project_id: project.id, paused: false })}>Reanudar sincronización</button>}</div>
    <ErrorBox error={detail.error ?? mutation.error ?? exportFile.error} />
    {me?.role === 'owner' && !me.revoked && <OwnerRecovery projectId={project.id} />}
    <details><summary>Recuperar autoridad de owner</summary><Field label="Frase de recuperación"><input type="password" autoComplete="off" value={recovery} onChange={e => setRecovery(e.target.value)} /></Field><button className="btn" disabled={!recovery.trim() || mutation.isPending} onClick={() => mutation.mutate({ operation: 'recover', project_id: project.id, phrase: recovery })}>Recuperar como owner</button></details>
  </>
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
  return <section className="memory-owner-recovery"><h3>Palabras de recuperación</h3><p>Los owners pueden consultar las 24 palabras para recuperar este proyecto. Se guardan cifradas para sus identidades.</p>
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
