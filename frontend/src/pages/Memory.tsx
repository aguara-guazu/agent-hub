import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Modal, ConfirmDialog } from '../components/Modal'
import { MemoryFrame, PageHeading, Field, ProjectSelect, Pager, ErrorBox, EmptyMemory, EntityRows, entityLabels, entityPath,
  formatTime, useMemory, useMemoryMutation, useMemoryStatus, type MemoryEntity, type Page } from '../lib/memory'
import { EntityForm, ImportForm } from './MemoryForms'
import { ProfileDraft, ProjectCompanyForm, SuggestedProjectSelect } from './MemoryAssistance'
import { MemoryCollection } from './MemoryCollection'
import { IdentityProposals, IdentityProposalCard, DuplicateProposals, DuplicateProposalCard } from './MemoryIdentity'
import { ProjectTasks } from './MemoryTasks'
import { ProjectSuggestions, InferProjectsButton } from './MemoryProjectSuggestions'

/** Keep list filters and project tabs in the history entry so Back restores the same context. */
function useMemoryView() {
  const [params, setParams] = useSearchParams()
  const change = (values: Record<string, string | number>) => setParams(current => {
    const next = new URLSearchParams(current)
    for (const [key, value] of Object.entries(values)) {
      if (value === '' || value === 0 || value === 'all') next.delete(key)
      else next.set(key, String(value))
    }
    return next
  }, { replace: true })
  const offset = Number(params.get('offset') ?? 0)
  return { params, change, offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0 }
}

export function MemoryProjects() { return <MemoryFrame><Projects /></MemoryFrame> }
function Projects() {
  const { params, change, offset } = useMemoryView(), query = params.get('q') ?? ''
  const setQuery = (q: string) => change({ q, offset: 0 }), setOffset = (offset: number) => change({ offset })
  const [form, setForm] = useState('')
  const status = useMemoryStatus()
  const projects = useMemory<Page<MemoryEntity>>('list_entities', { kind: 'project', query, limit: 24, offset })
  return <><PageHeading title="Proyectos" description="El contexto de cada cliente, conectado y siempre a mano."><button className="btn" onClick={() => setForm('company')}>Nueva empresa</button><button className="btn btn-primary" onClick={() => setForm('project')}>Nuevo proyecto</button></PageHeading>
    <div className="memory-stats">{[['Proyectos', status.data?.counts.project], ['Reuniones', status.data?.counts.meeting], ['Documentos', status.data?.counts.document], ['Personas', status.data?.counts.person]].map(([label, count]) => <div key={label} className="card"><strong>{count ?? 0}</strong><span>{label}</span></div>)}</div>
    <ProjectSuggestions />
    <div className="memory-toolbar"><input className="input" aria-label="Buscar proyectos" placeholder="Buscar un proyecto…" value={query} onChange={e => setQuery(e.target.value)} /><Link to="/memory/sources" className="btn">Conectar fuentes</Link><InferProjectsButton /></div>
    <ErrorBox error={projects.error} retry={projects.refetch} />
    {projects.isPending ? <p role="status">Cargando proyectos…</p> : projects.data?.items.length ? <div className="memory-project-grid">{projects.data.items.map(project => <Link key={project.id} className="memory-project-card card" to={entityPath(project)}>
      <div className="spread"><span className="memory-project-icon">P</span><span className="badge badge-accent">{project.data.status ?? 'discovery'}</span></div><h2>{project.title}</h2><p>{project.data.description || 'Agregá fuentes para comenzar a construir el contexto de este proyecto.'}</p><div className="memory-card-footer">Actualizado {formatTime(project.updated_at)} <span>→</span></div>
    </Link>)}</div> : <EmptyMemory><h2>Tu primer proyecto empieza acá</h2><p>Creá un proyecto e incorporá una reunión o conectá las fuentes de tu equipo.</p><button className="btn btn-primary" onClick={() => setForm('project')}>Crear proyecto</button></EmptyMemory>}
    {projects.data && <Pager total={projects.data.total} offset={offset} limit={24} setOffset={setOffset} />}
    {form && <EntityForm kind={form} open onClose={() => setForm('')} />}
  </>
}

export function MemoryExplore() { return <MemoryFrame><Explore /></MemoryFrame> }
function Explore() {
  const { params, change, offset } = useMemoryView(), query = params.get('q') ?? '', kind = params.get('kind') ?? ''
  const setQuery = (q: string) => change({ q, offset: 0 }), setKind = (kind: string) => change({ kind, offset: 0 }), setOffset = (offset: number) => change({ offset })
  const [form, setForm] = useState(''), [importing, setImporting] = useState(false)
  const entities = useMemory<Page<MemoryEntity>>('list_entities', { ...(kind ? { kind } : {}), query, limit: 50, offset })
  return <><PageHeading title="Explorar memoria" description="Navegá las fuentes, las personas y sus conexiones."><button className="btn" onClick={() => setForm('note')}>Nueva nota</button><button className="btn" onClick={() => setForm('collection')}>Nueva colección</button><button className="btn btn-primary" onClick={() => setImporting(true)}>Importar fuente</button></PageHeading>
    <div className="memory-toolbar"><input className="input" aria-label="Buscar entidades" placeholder="Buscar por nombre…" value={query} onChange={e => setQuery(e.target.value)} /><select className="input" aria-label="Tipo de entidad" value={kind} onChange={e => setKind(e.target.value)}><option value="">Todos los tipos</option>{Object.entries(entityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
    <ErrorBox error={entities.error} retry={entities.refetch} /><div className="card">{entities.isPending ? <p className="memory-loading" role="status">Cargando memoria…</p> : <EntityRows items={entities.data?.items ?? []} />}</div>
    {entities.data && <Pager total={entities.data.total} offset={offset} limit={50} setOffset={setOffset} />}
    {form && <EntityForm kind={form} open onClose={() => setForm('')} />}{importing && <ImportForm open onClose={() => setImporting(false)} />}
  </>
}

export function MemoryEntityPage() {
  const { id } = useParams()
  return <MemoryFrame>{id && <EntityPage key={id} entityId={id} />}</MemoryFrame>
}
function EntityPage({ entityId }: { entityId: string }) {
  const detail = useMemory<any>('get_entity', { id: entityId }), navigate = useNavigate()
  const { params, change, offset: relatedOffset } = useMemoryView(), tab = params.get('tab') ?? 'all'
  const setTab = (tab: string) => change({ tab, offset: 0 }), setRelatedOffset = (offset: number) => change({ offset })
  const [editing, setEditing] = useState(false), [importing, setImporting] = useState(false), [form, setForm] = useState(''), [deleting, setDeleting] = useState(false), [linking, setLinking] = useState(false), [companyForm, setCompanyForm] = useState(false)
  const remove = useMemoryMutation('delete_entity', () => navigate('/memory'))
  const reprocess = useMemoryMutation('reprocess'), update = useMemoryMutation('update_entity'), reviewIdentity = useMemoryMutation('review_identity'), reviewDuplicate = useMemoryMutation('review_duplicate')
  const entity: MemoryEntity | undefined = detail.data?.entity
  const related = useMemory<Page<MemoryEntity>>('list_entities', { project_id: entityId, ...(tab !== 'all' ? { kind: tab } : {}), limit: 100, offset: relatedOffset }, entity?.kind === 'project' && tab !== 'tasks')
  if (detail.isPending) return <p role="status">Abriendo contexto…</p>
  if (detail.error || !entity) return <ErrorBox error={detail.error} retry={detail.refetch} />
  const isProject = entity.kind === 'project'
  return <><div className="memory-breadcrumb"><Link to={isProject ? '/projects' : '/memory'}>{isProject ? 'Proyectos' : 'Memoria'}</Link><span>/</span><span>{entityLabels[entity.kind]}</span></div>
    <PageHeading title={entity.title} description={entity.data.description ?? entity.data.email ?? ''}>
      <button className="btn" onClick={() => setEditing(true)}>Editar</button><button className="btn" onClick={() => setLinking(true)}>Vincular</button>
      {isProject && <button className="btn" onClick={() => setCompanyForm(true)}>{entity.data.company_id ? 'Cambiar empresa' : 'Asociar empresa'}</button>}
      {isProject ? <button className="btn btn-primary" onClick={() => setImporting(true)}>Importar fuente</button> : detail.data.sources.length > 0 && <button className="btn" disabled={reprocess.isPending} onClick={() => reprocess.mutate({ entity_id: entityId, force: true })}>Reprocesar</button>}
    </PageHeading>
    <div className="memory-meta"><span className="badge">{entityLabels[entity.kind]}</span>{entity.data.status && <span className="badge badge-accent">{entity.data.status}</span>}<span>{formatTime(entity.data.occurred_at ?? entity.updated_at)}</span>
      {entity.data.timezone && <span>{entity.data.timezone}</span>}{entity.data.stale && <span className="badge badge-stale">La fuente cambió</span>}
      {isProject && !!entity.data.folders?.length && <span title="Los agentes que trabajan en estas carpetas buscan primero en este proyecto">Carpetas: {entity.data.folders.map((f: string) => <code key={f}>{f}</code>)}</span>}</div>
    {entity.kind === 'fact' && !['identity_match', 'person_duplicate'].includes(entity.data.category) && <div className="card memory-fact"><span className="badge">{entity.data.category ?? 'Nota'}</span><p>{entity.data.text}</p><div className="row"><span className="muted">{entity.data.review_state === 'accepted' ? 'Revisado' : 'Propuesta para revisar'}</span>
      <button className="btn btn-sm" onClick={() => update.mutate({ id: entityId, data: { review_state: 'accepted', stale: false } })}>Marcar revisado</button><button className="btn btn-sm" onClick={() => update.mutate({ id: entityId, data: { review_state: 'rejected', stale: false } })}>Descartar propuesta</button></div></div>}
    {entity.kind === 'fact' && entity.data.category === 'identity_match' && <><IdentityProposalCard proposal={entity} busy={reviewIdentity.isPending} onReview={(id, decision) => reviewIdentity.mutate({id,decision})} /><ErrorBox error={reviewIdentity.error} /></>}
    {entity.kind === 'fact' && entity.data.category === 'person_duplicate' && <><DuplicateProposalCard proposal={entity} busy={reviewDuplicate.isPending} onReview={(id, decision) => reviewDuplicate.mutate({id,decision})} /><ErrorBox error={reviewDuplicate.error} /></>}
    {entity.kind === 'person' && <div className="memory-callout"><span>{entity.data.merged_into ? 'Esta identidad se unificó con otra persona; sus intervenciones e identidades ya están en el perfil vigente.' : entity.data.identity_status === 'unresolved' ? 'Identidad por verificar. Los homónimos sólo se unifican con evidencia: email compartido, confianza alta de la IA o tu confirmación.' : 'Identidad registrada.'}</span>
      <p>{entity.data.email ? `${entity.data.email} · ${['manual','manual_confirmation_of_ai'].includes(entity.data.email_source) ? 'Confirmado manualmente' : entity.data.email_source === 'ai_auto_confirmed' ? 'Confirmado automáticamente por IA con confianza alta' : entity.data.email_source?.startsWith('google_people:') ? 'Asociado por el ID de Google' : 'Correo registrado'}` : entity.data.email_status === 'permission_required' ? 'Falta permiso para consultar el email: reconectá Google desde Fuentes y ajustes.' : 'Email pendiente. Google puede ocultarlo en perfiles externos o participantes anónimos; completalo sólo con una identidad confirmada.'}</p>
      {!!entity.data.email_candidates?.length && !entity.data.email && <p>Correos disponibles para verificar: {entity.data.email_candidates.join(', ')}</p>}
      {!!entity.data.merged_from?.length && <p>Incluye {entity.data.merged_from.length} {entity.data.merged_from.length === 1 ? 'identidad unificada' : 'identidades unificadas'}. El historial de cada unificación está en la información adicional.</p>}
      {entity.data.merged_into ? <Link className="btn btn-primary btn-sm" to={`/memory/entities/${entity.data.merged_into}`}>Ver identidad vigente</Link> : <><Link className="btn btn-sm" to={`/memory/search?person=${entityId}`}>Ver intervenciones</Link><MergePerson person={entity} /></>}</div>}
    {isProject && <><div className="memory-project-tabs">{[['all','Línea de tiempo'],['meeting','Reuniones'],['document','Documentos'],['tasks','Tareas'],['fact','Decisiones y hallazgos'],['collection','Colecciones']].map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key!)}>{label}</button>)}<button onClick={() => setForm('collection')}>＋ Colección</button></div>
      {tab === 'tasks' ? <ProjectTasks project={entity} /> : <><p className="memory-section-note">Estado según las fuentes importadas. Las fechas corresponden al contenido cuando están disponibles.</p><ErrorBox error={related.error} /><div className="card"><EntityRows items={related.data?.items ?? []} /></div>{related.data && <Pager total={related.data.total} offset={relatedOffset} limit={100} setOffset={setRelatedOffset} />}</>}</>}
    {entity.kind === 'collection' && <MemoryCollection entity={entity} />}
    {['meeting','document','person'].includes(entity.kind) && <IdentityProposals entityId={entityId} canInfer={entity.kind !== 'person'} />}
    {entity.kind === 'person' && !entity.data.merged_into && <DuplicateProposals entityId={entityId} />}
    {detail.data.sources.length > 0 && <SourceReader entity={entity} source={detail.data.sources[0]} />}
    {detail.data.evidence.length > 0 && <section className="memory-section"><h2>Evidencia</h2>{detail.data.evidence.map((f: any) => <EvidenceCard key={f.id} fragment={f} />)}</section>}
    <section className="memory-section"><div className="spread"><h2>Conexiones</h2><button className="btn btn-sm" onClick={() => setLinking(true)}>Agregar vínculo</button></div>
      <div className="memory-links">{detail.data.links.map((link: any) => <Link key={link.id} to={entityPath(link.entity)} className="card"><span className="muted">{entityLabels[link.entity.kind]} · {link.type}</span><strong>{link.entity.title}</strong></Link>)}{!detail.data.links.length && <p className="muted">Todavía no tiene conexiones.</p>}</div></section>
    {entity.kind === 'event' && <section className="memory-section card memory-panel"><h2>Invitados del calendario</h2><p className="muted">La invitación y su respuesta no prueban asistencia.</p>{(entity.data.attendees ?? []).map((p: any, i: number) => <div key={i} className="spread"><span>{p.displayName ?? p.email ?? 'Sin identificar'}</span><span className="muted">{p.email} · {p.responseStatus}</span></div>)}</section>}
    <details className="memory-details"><summary>Información adicional e historial</summary><pre>{JSON.stringify(entity.data, null, 2)}</pre>{detail.data.changes.map((c: any) => <p key={c.id}>{formatTime(c.created_at)} · {c.action} · {c.actor}</p>)}<button className="btn btn-danger" onClick={() => setDeleting(true)}>Eliminar de la memoria</button></details>
    {editing && <EditEntity entity={entity} onClose={() => setEditing(false)} />}{linking && <LinkEntity entity={entity} links={detail.data.links} onClose={() => setLinking(false)} />}
    {companyForm && <ProjectCompanyForm project={entity} onClose={() => setCompanyForm(false)} />}
    {importing && <ImportForm open projectId={isProject ? entityId : undefined} onClose={() => setImporting(false)} />}{form && <EntityForm kind={form} open projectId={entityId} onClose={() => setForm('')} />}
    <ConfirmDialog open={deleting} title="Eliminar de la memoria" message="Se eliminarán esta entidad, sus fuentes y los datos derivados que dependan de ellas. Los respaldos anteriores se conservan." destructive confirmLabel="Eliminar" busy={remove.isPending} onClose={() => setDeleting(false)} onConfirm={() => remove.mutate({ id: entityId })} />
  </>
}

function SourceReader({ entity, source }: { entity: MemoryEntity; source: any }) {
  const [params, setParams] = useSearchParams(), [offset, setOffset] = useState(0), [person, setPerson] = useState('')
  const selectedVersion = params.get('version') || source.current_version_id, fragmentId = params.get('fragment')
  const versions = useMemory<any[]>('list_versions', { entity_id: entity.id, limit: 100 })
  const fragments = useMemory<Page & { speakers: { id: string; title: string; email: string | null; email_status: string | null; fragments: number }[] }>('transcript', { entity_id: entity.id, ...(selectedVersion ? { version_id: selectedVersion } : {}), ...(person ? { person_id: person } : {}), limit: 100, offset })
  const focus = useMemory<any>('get_evidence', { fragment_id: fragmentId }, !!fragmentId)
  const people = useMemory<Page<MemoryEntity>>('list_entities', { kind: 'person', limit: 200 })
  const [assigning, setAssigning] = useState<any>(null)
  useEffect(() => { if (focus.data && !person) setOffset(Math.floor(focus.data.ordinal / 100) * 100) }, [focus.data, person])
  useEffect(() => { if (fragmentId && fragments.data) document.getElementById(`fragment-${fragmentId}`)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }) }, [fragmentId, fragments.data])
  return <section className="memory-section"><div className="spread"><h2>{entity.kind === 'meeting' ? 'Transcripción' : 'Contenido de la fuente'}</h2>{source.url && <a className="btn" href={source.url} target="_blank" rel="noreferrer">Abrir original ↗</a>}</div>
    {source.status !== 'active' && <p className="memory-callout">La fuente está {source.status === 'deleted' ? 'eliminada en el proveedor' : 'inaccesible'}. Estás viendo la última copia conservada en la memoria.</p>}
    <div className="memory-toolbar"><select className="input" aria-label="Versión de la fuente" value={selectedVersion ?? ''} onChange={e => { setParams({ version: e.target.value }); setOffset(0) }}>{versions.data?.map(v => <option key={v.id} value={v.id}>{formatTime(v.created_at)}{v.id === source.current_version_id ? ' · Actual' : ' · Histórica'}</option>)}</select>
      <select className="input" aria-label="Filtrar por hablante" value={person} onChange={e => { setPerson(e.target.value); setOffset(0) }}><option value="">Todas las personas</option>{fragments.data?.speakers?.map(p => <option key={p.id} value={p.id}>{p.title}{p.email ? ` · ${p.email}` : ' · Email pendiente'}</option>)}</select></div>
    {!!fragments.data?.speakers?.length && <details className="memory-speakers"><summary>Hablantes de esta fuente · {fragments.data.speakers.filter(p => p.email).length}/{fragments.data.speakers.length} con email</summary><div>{fragments.data.speakers.map(p => <Link key={p.id} to={`/memory/entities/${p.id}`}><strong>{p.title}</strong><span>{p.email ?? (p.email_status === 'permission_required' ? 'Falta permiso de Google' : p.email_status === 'ambiguous' ? 'Identidad por confirmar' : 'Google no informó el email')}</span><small>{p.fragments} intervenciones</small></Link>)}</div></details>}
    {selectedVersion !== source.current_version_id && <p className="memory-callout">Estás leyendo una versión histórica. Las citas de esta versión se conservan.</p>}
    <ErrorBox error={fragments.error ?? focus.error} /><div className="memory-transcript card">{fragments.isPending ? <p className="memory-loading" role="status">Cargando intervenciones…</p> : fragments.data?.items.map((f: any) => <article id={`fragment-${f.id}`} key={f.id} className={`memory-utterance ${fragmentId === f.id ? 'highlighted' : ''}`}>
      <div className="memory-utterance-meta"><span>{f.start_time ? new Date(f.start_time).toLocaleTimeString('es-AR', { hour12: false }) : f.offset_ms !== null ? `${f.metadata.timestamp_precision === 'section' ? 'Desde ' : ''}${Math.floor(f.offset_ms / 60000)}:${String(Math.floor(f.offset_ms / 1000) % 60).padStart(2,'0')}` : f.metadata.timestamp_label ?? `#${f.ordinal + 1}`}</span>
        {f.speaker_id ? <Link to={`/memory/entities/${f.speaker_id}`}>{f.speaker_name}</Link> : <span className="muted">{f.metadata.format?.startsWith('google-docs') ? 'Contexto del documento' : 'Hablante pendiente'}</span>}<small>{f.speaker_email ?? (f.speaker_id ? 'Email pendiente' : '')}</small>{f.metadata.timestamp_precision === 'section' && <small>Marca de sección del documento</small>}</div>
      <div className="memory-utterance-content"><p>{f.text}</p><div className="memory-utterance-actions"><button className="btn btn-ghost btn-sm" onClick={() => setParams({ version: f.version_id, fragment: f.id })}>Citar fragmento</button><button className="btn btn-ghost btn-sm" onClick={() => setAssigning(f)}>Asignar proyecto o persona</button>{f.project_ids?.length > 0 && <span className="badge">{f.project_ids.length} proyecto{f.project_ids.length > 1 ? 's' : ''}</span>}</div></div>
    </article>)}{fragments.data?.items.length === 0 && <EmptyMemory>No hay intervenciones en este filtro.</EmptyMemory>}</div>
    {fragments.data && <Pager total={fragments.data.total} offset={offset} limit={100} setOffset={setOffset} />}
    {assigning && <AssignFragment fragment={assigning} people={people.data?.items ?? []} onClose={() => setAssigning(null)} />}
  </section>
}
export function EvidenceCard({ fragment }: { fragment: any }) {
  return <Link className="memory-evidence card" to={`/memory/entities/${fragment.entity_id}?version=${fragment.version_id}&fragment=${fragment.id}`}>
    <div className="spread"><strong>{fragment.title ?? 'Ver fuente'}</strong><span className="muted">{fragment.speaker_name ?? ''} · {formatTime(fragment.start_time ?? fragment.occurred_at)}</span></div><p>{fragment.text}</p><span className="memory-inline-link">Abrir fragmento y contexto →</span>
  </Link>
}

function EditEntity({ entity, onClose }: { entity: MemoryEntity; onClose: () => void }) {
  const [expectedUpdatedAt] = useState(entity.updated_at)
  const [title, setTitle] = useState(entity.title), [data, setData] = useState(JSON.stringify(entity.data, null, 2)), [error, setError] = useState<Error | null>(null)
  const [description, setDescription] = useState(entity.data.description ?? ''), [email, setEmail] = useState(entity.data.email ?? '')
  const [text, setText] = useState(entity.data.text ?? ''), [status, setStatus] = useState(entity.data.status ?? 'discovery')
  const [remote, setRemote] = useState(entity.data.remote_processing !== false), [identity, setIdentity] = useState(entity.data.identity_status ?? 'unresolved')
  const [folders, setFolders] = useState<string>((entity.data.folders ?? []).join('\n'))
  const update = useMemoryMutation('update_entity', onClose)
  return <Modal open title="Editar información" onClose={onClose} busy={update.isPending}><form className="memory-form" onSubmit={e => { e.preventDefault(); try { update.mutate({ id: entity.id, title, data: { ...JSON.parse(data), description, remote_processing: remote,
    ...(entity.kind === 'person' ? { email: email || null, identity_status: identity, identity_verified: identity === 'verified' } : {}),
    ...(entity.kind === 'project' ? { status, folders: folders.split('\n').map(f => f.trim()).filter(Boolean) } : {}), ...(['note','fact'].includes(entity.kind) && text ? { text } : {}) }, expected_updated_at: expectedUpdatedAt }); setError(null) } catch { setError(new Error('Los campos adicionales deben ser JSON válido')) } }}>
    <Field label="Nombre"><input value={title} onChange={e => setTitle(e.target.value)} required /></Field>
    <Field label="Descripción"><textarea rows={3} value={description} onChange={e => setDescription(e.target.value)} /></Field>
    {entity.kind === 'project' && <ProfileDraft projectId={entity.id} kind="project" onUse={draft => setDescription(draft.description)} />}
    {entity.kind === 'project' && <Field label="Etapa"><select value={status} onChange={e => setStatus(e.target.value)}>{['discovery','presales','poc','delivery','support','completed','paused'].map(s => <option key={s}>{s}</option>)}</select></Field>}
    {entity.kind === 'project' && <Field label="Carpetas de trabajo (una ruta absoluta por línea)"><textarea rows={3} value={folders} onChange={e => setFolders(e.target.value)} placeholder="/Users/nombre/proyectos/cliente-api" /><span className="field-hint">Un agente (Claude Code, Codex, etc.) que trabaja dentro de estas carpetas busca primero en este proyecto y deja sus notas aquí.</span></Field>}
    {entity.kind === 'person' && <><Field label="Email"><input type="email" value={email} onChange={e => setEmail(e.target.value)} /></Field><Field label="Identidad"><select value={identity} onChange={e => setIdentity(e.target.value)}><option value="unresolved">Por verificar</option><option value="verified">Confirmada por mí</option>{identity === 'merged' && <option value="merged">Unificada</option>}</select></Field></>}
    {['note','fact'].includes(entity.kind) && <Field label="Contenido"><textarea rows={5} value={text} onChange={e => setText(e.target.value)} /></Field>}
    {['project','meeting','document','message','issue','note'].includes(entity.kind) && <label className="check"><input type="checkbox" checked={remote} onChange={e => setRemote(e.target.checked)} />Permitir extracción con proveedores remotos si está habilitada en Ajustes</label>}
    <details><summary>Campos adicionales</summary><Field label="Campos adicionales (JSON)"><textarea rows={10} value={data} onChange={e => setData(e.target.value)} /></Field></details><ErrorBox error={error ?? update.error} /><button className="btn btn-primary" disabled={update.isPending}>Guardar cambios</button></form></Modal>
}
function LinkEntity({ entity, links, onClose }: { entity: MemoryEntity; links: any[]; onClose: () => void }) {
  const source = ['meeting','document'].includes(entity.kind)
  const [target, setTarget] = useState(''), [type, setType] = useState(source ? 'project' : 'related'), [query, setQuery] = useState('')
  const choices = useMemory<Page<MemoryEntity>>('list_entities', { query, limit: 100 })
  const link = useMemoryMutation('link_entities'), unlink = useMemoryMutation('unlink_entities')
  return <Modal open title="Conectar información" onClose={onClose}><form className="memory-form" onSubmit={e => { e.preventDefault(); link.mutate({ from_id: entity.id, to_id: target, type }) }}>
    {source && type === 'project' ? <SuggestedProjectSelect sourceId={entity.id} value={target} onChange={setTarget} label="Proyecto para esta fuente" /> : <><Field label="Buscar entidad"><input value={query} onChange={e => setQuery(e.target.value)} /></Field><Field label="Entidad relacionada"><select required value={target} onChange={e => { setTarget(e.target.value); if (choices.data?.items.find(i => i.id === e.target.value)?.kind === 'project') setType('project'); else setType('related') }}><option value="">Seleccionar…</option>{choices.data?.items.filter(i => i.id !== entity.id).map(i => <option key={i.id} value={i.id}>{entityLabels[i.kind]} · {i.title}</option>)}</select></Field></>}
    <Field label="Relación"><select value={type} onChange={e => setType(e.target.value)}>{['related','project','company','participant','meeting_document','derived_from','calendar_event'].map(t => <option key={t}>{t}</option>)}</select></Field><button className="btn btn-primary" disabled={!target || link.isPending}>Agregar vínculo</button><ErrorBox error={link.error} />
    <div>{links.map(l => <div key={l.id} className="spread"><span>{l.entity.title} · {l.type}</span><button type="button" className="btn btn-ghost btn-sm" disabled={unlink.isPending} onClick={() => unlink.mutate({ id: l.id })}>Quitar</button></div>)}</div>
  </form></Modal>
}
function AssignFragment({ fragment, people, onClose }: { fragment: any; people: MemoryEntity[]; onClose: () => void }) {
  const [projects, setProjects] = useState<string[]>(fragment.project_ids ?? []), [person, setPerson] = useState(fragment.speaker_id ?? '')
  const save = useMemoryMutation('assign_fragment', onClose)
  return <Modal open title="Corregir el contexto del fragmento" onClose={onClose}><form className="memory-form" onSubmit={e => { e.preventDefault(); save.mutate({ fragment_id: fragment.id, project_ids: projects, person_id: person || null }) }}>
    <blockquote>{fragment.text}</blockquote><ProjectSelect value={projects} onChange={setProjects} /><Field label="Persona que habló"><select value={person} onChange={e => setPerson(e.target.value)}><option value="">Sin identificar</option>{people.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></Field><ErrorBox error={save.error} /><button className="btn btn-primary" disabled={save.isPending}>Guardar asignación</button></form></Modal>
}
function MergePerson({ person }: { person: MemoryEntity }) {
  const [open, setOpen] = useState(false), [target, setTarget] = useState(''), navigate = useNavigate()
  const people = useMemory<Page<MemoryEntity>>('list_entities', { kind: 'person', limit: 200 }, open)
  const merge = useMemoryMutation<any>('merge_people', result => { setOpen(false); navigate(`/memory/entities/${result.person_id}`) })
  return <><button className="btn btn-sm" onClick={() => setOpen(true)}>Vincular identidad</button><Modal open={open} title="Unificar identidades de la misma persona" onClose={() => setOpen(false)}>
    <form className="memory-form" onSubmit={e => { e.preventDefault(); merge.mutate({ from_id: person.id, into_id: target }) }}><p>Las intervenciones y las identidades externas se asociarán a la persona elegida. La corrección quedará en el historial.</p><Field label="Persona confirmada"><select value={target} onChange={e => setTarget(e.target.value)} required><option value="">Seleccionar…</option>{people.data?.items.filter(p => p.id !== person.id && !p.data.merged_into).map(p => <option key={p.id} value={p.id}>{p.title} · {p.data.email ?? 'Sin email'}</option>)}</select></Field><ErrorBox error={merge.error} /><button className="btn btn-primary" disabled={!target || merge.isPending}>Unificar identidades</button></form></Modal></>
}

export function MemorySearch() { return <MemoryFrame><Search /></MemoryFrame> }
function Search() {
  const [params] = useSearchParams(), [query, setQuery] = useState(''), [submitted, setSubmitted] = useState(''), [person, setPerson] = useState(params.get('person') ?? '')
  const [project, setProject] = useState(params.get('project') ?? ''), [kind, setKind] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState(''), [offset, setOffset] = useState(0)
  const projects = useMemory<Page<MemoryEntity>>('list_entities', { kind: 'project', limit: 200 }), people = useMemory<Page<MemoryEntity>>('list_entities', { kind: 'person', limit: 200 })
  const result = useMemory<any>('search', { query: submitted, ...(project ? { project_id: project } : {}), ...(person ? { person_id: person } : {}), ...(kind ? { kind } : {}),
    ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}), ...(to ? { to: new Date(`${to}T23:59:59.999`).toISOString() } : {}), limit: 30, offset })
  return <><PageHeading title="Buscar en tu memoria" description="Encontrá lo que se dijo, quién lo dijo y la fuente que lo respalda." />
    <form className="memory-searchbar" onSubmit={e => { e.preventDefault(); setSubmitted(query); setOffset(0) }}><input aria-label="Buscar en la memoria" placeholder="Una frase, un tema, una decisión…" value={query} onChange={e => setQuery(e.target.value)} /><button className="btn btn-primary">Buscar</button></form>
    <div className="memory-filter-grid"><Field label="Proyecto"><select value={project} onChange={e => { setProject(e.target.value); setOffset(0) }}><option value="">Todos los proyectos</option>{projects.data?.items.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></Field>
      <Field label="Persona"><select value={person} onChange={e => { setPerson(e.target.value); setOffset(0) }}><option value="">Todas las personas</option>{people.data?.items.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></Field>
      <Field label="Tipo"><select value={kind} onChange={e => { setKind(e.target.value); setOffset(0) }}><option value="">Todas las fuentes</option>{['meeting','document','message','issue','note','event'].map(k => <option key={k} value={k}>{entityLabels[k]}</option>)}</select></Field>
      <Field label="Desde"><input type="date" value={from} onChange={e => { setFrom(e.target.value); setOffset(0) }} /></Field><Field label="Hasta"><input type="date" value={to} onChange={e => { setTo(e.target.value); setOffset(0) }} /></Field></div>
    <ErrorBox error={result.error} retry={result.refetch} /><p className="memory-section-note">{result.data?.coverage}{result.data?.semantic_status === 'unavailable' ? ' · Búsqueda textual disponible; los embeddings aún no están listos.' : ''}</p>
    {result.isFetching && <p role="status">Buscando…</p>}<div className="memory-results">{result.data?.items.map((f: any) => <EvidenceCard key={f.id} fragment={f} />)}{result.data?.items.length === 0 && <EmptyMemory>No encontramos coincidencias en las fuentes importadas. Probá otro término o ampliá los filtros.</EmptyMemory>}</div>
    {result.data && <Pager total={result.data.total} offset={offset} limit={30} setOffset={setOffset} />}
  </>
}

export function MemoryReview() { return <MemoryFrame><Review /></MemoryFrame> }
function Review() {
  const [offset, setOffset] = useState(0), rows = useMemory<Page<MemoryEntity>>('review', { limit: 100, offset })
  return <><PageHeading title="Por revisar" description="Identidades por resolver, información sin proyecto y propuestas con evidencia." /><ErrorBox error={rows.error} retry={rows.refetch} />
    <DuplicateProposals canRun /><IdentityProposals canInfer /><div className="card"><EntityRows items={rows.data?.items.filter(e => !['identity_match', 'person_duplicate'].includes(e.data.category)) ?? []} /></div><div className="memory-pager"><button className="btn" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 100))}>Anterior</button><button className="btn" disabled={(rows.data?.items.length ?? 0) < 100} onClick={() => setOffset(offset + 100)}>Siguiente</button></div></>
}
