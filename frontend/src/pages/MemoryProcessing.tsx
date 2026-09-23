import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MemoryFrame, PageHeading, ErrorBox, Pager, formatTime, useMemory, useMemoryMutation } from '../lib/memory'

const states: Record<string, string> = { queued: 'En cola', running: 'Procesando', waiting: 'Esperando reintento', completed: 'Completado', failed: 'Falló', cancelled: 'Cancelado' }
const stages: Record<string, string> = { identity_inference: 'Infiriendo vínculos de hablantes', dedupe_people: 'Unificando personas duplicadas', preparing: 'Preparando contenido', embeddings: 'Generando embeddings locales', extraction: 'Extrayendo con IA', complete: 'Finalizado', identities: 'Resolviendo emails de Google', document_speakers: 'Recuperando hablantes de documentos', calendar: 'Leyendo Calendar', meet: 'Leyendo Meet' }
const number = (value: number) => value.toLocaleString('es-AR')

export function MemoryJobCard({ job, onRetry, onCancel }: { job: any; onRetry: (id: string) => void; onCancel: (id: string) => void }) {
  const p = job.progress ?? {}, active = ['queued', 'running', 'waiting'].includes(job.state)
  const total = p.stage === 'identity_inference' ? p.identity_batches : p.stage === 'dedupe_people' ? p.dedupe_batches : p.stage === 'extraction' ? p.total_batches : p.stage === 'embeddings' ? p.embedding_total : null
  const done = p.stage === 'identity_inference' ? p.identity_batch ?? 0 : p.stage === 'dedupe_people' ? p.dedupe_batch ?? 0 : p.stage === 'extraction' ? p.batch ?? 0 : p.embeddings ?? 0
  const progress = total > 0 ? Math.min(100, Math.floor(done / total * 100)) : null
  const elapsed = p.started_at ? Math.max(0, Math.floor(((p.finished_at ? Date.parse(p.finished_at) : active ? Date.now() : Date.parse(job.updated_at)) - Date.parse(p.started_at)) / 1000)) : null
  const title = job.kind === 'index_entities' ? 'Índice de búsqueda local' : job.kind === 'dedupe_people' ? 'Unificación de personas duplicadas' : job.source_title ?? p.source_title ?? (job.kind === 'sync' ? 'Sincronización de fuente' : job.kind === 'google_repair' ? 'Reparación de identidades' : job.kind === 'google_document' ? 'Importación de documento' : 'Fuente ya eliminada')
  const deepseek = p.provider ? p.provider === 'deepseek' : p.model?.startsWith('deepseek') && p.extraction !== 'not_configured'
  const mode = job.kind === 'index_entities' || p.index_only || job.payload.index_only ? 'Sólo índice local' : deepseek ? 'DeepSeek' : p.provider === 'opencode' ? 'OpenCode' : p.provider === 'ollama' ? 'Ollama' : job.kind === 'process' ? p.provider === 'disabled' ? 'Procesamiento local' : 'Por iniciar' : 'Google / fuente'
  return <article className="memory-processing-card card">
    <div className="spread"><span className="badge">{mode}</span><span className={`badge ${job.state === 'completed' ? 'badge-on' : job.state === 'failed' ? 'badge-off' : 'badge-stale'}`}>{states[job.state] ?? job.state}</span></div>
    <h3>{job.entity_id ? <Link to={`/memory/entities/${job.entity_id}${job.payload.version_id ? `?version=${job.payload.version_id}` : ''}`}>{title}</Link> : title}</h3>
    <p>{job.error ?? stages[p.stage] ?? 'Esperando al worker'}</p>
    {p.model && ['DeepSeek','Ollama','OpenCode'].includes(mode) && <span className="muted">Modelo: {p.model}</span>}
    {(p.identity_only || job.payload.identity_only) && <p>Resolución de identidades</p>}
    {p.identity_batches > 0 && <p>Lotes de identidad: {p.identity_batch ?? 0}/{p.identity_batches} · {p.identity_suggestions ?? 0} vínculos sugeridos{job.state === 'running' && p.stage === 'identity_inference' ? ` · Procesando lote ${p.identity_current_batch ?? 1}` : ''}</p>}
    {p.total_batches > 0 && <p>Lotes completados: {p.batch ?? 0}/{p.total_batches}{job.state === 'running' && p.current_batch ? ` · Enviando/procesando lote ${p.current_batch}` : ''}</p>}
    {progress !== null && job.state !== 'completed' && <div className="memory-progress"><progress aria-label={`Avance de ${title}`} value={done} max={total} /><span>{progress}%</span></div>}
    {p.processed_fragments !== undefined && <p>Fragmentos: {number(p.processed_fragments)}/{number(p.total_fragments ?? 0)}</p>}
    {p.identities_total !== undefined && <p>Identidades: {p.identities_completed ?? 0}/{p.identities_total} · Emails resueltos: {p.emails_resolved ?? 0}</p>}
    {p.documents_total !== undefined && <p>Documentos: {p.documents_completed ?? 0}/{p.documents_total}</p>}
    {p.dedupe_email_groups !== undefined && <p>Emails compartidos: {p.dedupe_email_merged ?? 0} perfiles unificados · {p.dedupe_email_conflicts ?? 0} conflictos · {p.dedupe_identities_applied ?? 0} inferencias de confianza alta aplicadas</p>}
    {p.dedupe_pairs !== undefined && <p>Pares comparados por IA: {p.dedupe_batch ?? 0}/{p.dedupe_batches ?? 0} lotes de {p.dedupe_pairs} pares · {p.dedupe_auto_merged ?? 0} unificados automáticamente · {p.dedupe_proposals ?? 0} propuestas · {p.dedupe_different ?? 0} distintos{job.state === 'running' && p.stage === 'dedupe_people' && p.dedupe_current_batch ? ` · Procesando lote ${p.dedupe_current_batch}` : ''}</p>}
    {p.identity_auto_applied > 0 && <p>{p.identity_auto_applied} vínculos aplicados automáticamente con confianza alta</p>}
    {p.identity_rejected > 0 && <p className="memory-inline-error">Se descartaron {p.identity_rejected} asociaciones sin referencias válidas. Podés volver a inferir esta fuente.</p>}
    {p.extraction_rejected > 0 && <p className="memory-inline-error">Se descartaron {p.extraction_rejected} propuestas con formato o evidencia inválidos; el resto del lote se conservó.</p>}
    {(p.input_tokens !== undefined || p.output_tokens !== undefined) && <div className="memory-job-metrics"><span>Entrada: {number(p.input_tokens ?? 0)} tokens</span><span>Salida: {number(p.output_tokens ?? 0)} tokens</span><span>{p.extracted ?? 0} propuestas</span></div>}
    {p.identity_warning && <p className="memory-inline-error">{p.identity_warning}</p>}{p.document_error && <p className="memory-inline-error">{p.document_error}</p>}
    {p.extraction === 'disabled_for_source' && <p>Esta fuente excluye el procesamiento remoto.</p>}
    <footer><small>{formatTime(p.started_at ?? job.created_at)} · Intento {job.attempts}/{job.max_attempts}{elapsed !== null ? ` · ${Math.floor(elapsed / 60)} min ${elapsed % 60} s` : ''}</small><div className="memory-button-wrap">
      {['failed','cancelled','waiting'].includes(job.state) && <button className="btn btn-sm" onClick={() => onRetry(job.id)}>Reintentar</button>}{active && <button className="btn btn-sm" onClick={() => onCancel(job.id)}>Cancelar</button>}
    </div></footer>
  </article>
}

export function MemoryProcessing() { return <MemoryFrame><Processing /></MemoryFrame> }
function Processing() {
  const [state, setState] = useState(''), [offset, setOffset] = useState(0)
  const jobs = useMemory<any>('list_jobs', { kind: 'process,dedupe_people,index_entities', ...(state ? { state } : {}), limit: 20, offset })
  const overview = useMemory<any>('processing_status')
  const retry = useMemoryMutation('retry_job'), cancel = useMemoryMutation('cancel_job')
  const counts = overview.data?.states ?? {}, coverage = overview.data?.coverage
  return <><PageHeading title="Procesamiento" description="Seguí qué fuente está leyendo la IA y abrí sus resultados con evidencia." />
    <div className="memory-stats">{[['Procesando',counts.running ?? 0],['En cola',(counts.queued ?? 0) + (counts.waiting ?? 0)],['Fallidos',counts.failed ?? 0],['Con extracción',`${coverage?.extracted ?? 0}/${coverage?.sources ?? 0}`]].map(([label,value]) => <div className="card" key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
    <p className="memory-section-note">Se actualiza cada 5 segundos. Una fuente indexada para buscar puede seguir sin extracción de IA. Los tokens mostrados corresponden a respuestas registradas; la facturación final se consulta en el proveedor.</p>
    <div className="memory-toolbar"><select className="input" aria-label="Estado del procesamiento" value={state} onChange={e => { setState(e.target.value); setOffset(0) }}><option value="">Todos los trabajos</option><option value="active">En curso y en cola</option>{Object.entries(states).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select><Link className="btn" to="/memory/sources">Configurar IA y fuentes</Link><Link className="btn" to="/memory/review">Revisar propuestas</Link></div>
    <ErrorBox error={jobs.error ?? overview.error ?? retry.error ?? cancel.error} /><div className="memory-processing-list">{jobs.data?.items.map((job: any) => <MemoryJobCard key={job.id} job={job} onRetry={id => retry.mutate({id})} onCancel={id => cancel.mutate({id})} />)}{jobs.data?.items.length === 0 && <p className="memory-empty">No hay trabajos en este estado.</p>}</div>
    {jobs.data && <Pager total={jobs.data.total} limit={20} offset={offset} setOffset={setOffset} />}
  </>
}
