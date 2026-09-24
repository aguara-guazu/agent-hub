import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { Field, ErrorBox, formatTime, useMemory, useMemoryMutation, entityLabels, type MemoryEntity, type Page } from '../lib/memory'
import { SuggestedProjectSelect } from './MemoryAssistance'

const CONFIDENCE: Record<string, string> = { high: 'confianza alta', medium: 'confianza media', low: 'confianza baja' }

export function InferProjectsButton() {
  const toast = useToast()
  const infer = useMemoryMutation<any>('infer_projects', result => toast.success('Búsqueda de proyecto encolada', `${result.queued} ${result.queued === 1 ? 'fuente sin proyecto' : 'fuentes sin proyecto'}`))
  return <button className="btn" disabled={infer.isPending} onClick={() => infer.mutate({})}>Buscar proyecto de fuentes sin asignar</button>
}

/** Sources the background processing could not place in a project, with the AI's suggestion and the three possible decisions. */
export function ProjectSuggestions() {
  const [offset, setOffset] = useState(0)
  const suggestions = useMemory<Page>('list_project_suggestions', { limit: 6, offset })
  const total = suggestions.data?.total ?? 0
  if (!total && !suggestions.error) return null
  return <section className="memory-section memory-suggestions" aria-live="polite">
    <div><h2>{total} {total === 1 ? 'reunión o documento parece' : 'reuniones o documentos parecen'} no tener proyecto</h2>
      <p className="memory-section-note">El procesamiento en segundo plano asigna solo lo que identifica con confianza alta; lo demás espera tu decisión.</p></div>
    <ErrorBox error={suggestions.error} />
    {suggestions.data?.items.map((item: any) => <SuggestionCard key={item.id} item={item} />)}
    {total > 6 && <div className="memory-pager"><span>{offset + 1}–{Math.min(offset + 6, total)} de {total}</span><div>
      <button className="btn btn-sm" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 6))}>Anterior</button>
      <button className="btn btn-sm" disabled={offset + 6 >= total} onClick={() => setOffset(offset + 6)}>Siguiente</button></div></div>}
  </section>
}

function SuggestionCard({ item }: { item: any }) {
  const d = item.data, toast = useToast(), [project, setProject] = useState(d.candidate_project_id ?? ''), [creating, setCreating] = useState(false)
  const review = useMemoryMutation<any>('review_project_suggestion', result => toast.success(result.decision === 'none' ? 'Quedó sin proyecto' : 'Fuente asociada al proyecto'))
  const people: any[] = item.participants ?? []
  return <article className="card memory-panel memory-suggestion">
    <div className="spread"><div><span className="badge">{entityLabels[item.source_kind] ?? 'Fuente'}</span> <Link to={`/memory/entities/${d.source_entity_id}`}><strong>{item.source_title}</strong></Link></div><span className="muted">{formatTime(item.occurred_at)}</span></div>
    {people.length > 0 && <p className="muted">Participantes: {people.slice(0, 8).map(p => p.title).join(', ')}{people.length > 8 ? ` y ${people.length - 8} más` : ''}</p>}
    {item.fact_count > 0 && <div><p className="muted">{item.fact_count} {item.fact_count === 1 ? 'hecho extraído' : 'hechos extraídos'}:</p><ul className="memory-suggestion-facts">{item.facts.slice(0, 4).map((f: any) => <li key={f.id}><span className="badge">{f.category}</span> {f.text}</li>)}</ul></div>}
    <div className="memory-callout"><span>{d.candidate_project_title ? <>La IA sugiere <strong>{d.candidate_project_title}</strong> ({CONFIDENCE[d.confidence] ?? d.confidence}).</> : d.suggested_title ? <>Nombre propuesto para un proyecto nuevo: <strong>{d.suggested_title}</strong>.</> : 'El análisis de fondo no sugirió un proyecto existente.'}</span><p>{d.reason}</p></div>
    <div className="memory-suggestion-actions">
      <SuggestedProjectSelect sourceId={d.source_entity_id} label={`Proyecto para ${item.source_title}`} value={project} onChange={setProject} />
      <button className="btn btn-primary btn-sm" disabled={!project || review.isPending} onClick={() => review.mutate({ id: item.id, decision: 'assign', project_id: project })}>Asociar</button>
      <button className="btn btn-sm" disabled={review.isPending} onClick={() => setCreating(true)}>Crear proyecto</button>
      <button className="btn btn-ghost btn-sm" disabled={review.isPending} onClick={() => review.mutate({ id: item.id, decision: 'none' })}>Dejar sin proyecto</button>
    </div>
    <ErrorBox error={review.error} />
    {creating && <CreateFromSuggestion item={item} onClose={() => setCreating(false)} />}
  </article>
}

function CreateFromSuggestion({ item, onClose }: { item: any; onClose: () => void }) {
  const [title, setTitle] = useState(item.data.suggested_title || item.source_title), [description, setDescription] = useState(item.data.suggested_description ?? ''), [company, setCompany] = useState('')
  const companies = useMemory<Page<MemoryEntity>>('list_entities', { kind: 'company', limit: 200 })
  const review = useMemoryMutation('review_project_suggestion', onClose)
  return <Modal open title="Crear proyecto para esta fuente" onClose={onClose} busy={review.isPending}><form className="memory-form" onSubmit={e => { e.preventDefault(); review.mutate({ id: item.id, decision: 'create', title, description, ...(company ? { company_id: company } : {}) }) }}>
    <p className="muted">La fuente «{item.source_title}», sus fragmentos y sus hechos quedan asociados al proyecto nuevo.</p>
    <Field label="Nombre del proyecto"><input required maxLength={500} value={title} onChange={e => setTitle(e.target.value)} /></Field>
    <Field label="Descripción"><textarea rows={3} value={description} onChange={e => setDescription(e.target.value)} /></Field>
    <Field label="Empresa"><select value={company} onChange={e => setCompany(e.target.value)}><option value="">Sin empresa asignada</option>{companies.data?.items.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></Field>
    <ErrorBox error={review.error} /><div className="memory-form-actions"><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn btn-primary" disabled={review.isPending || !title.trim()}>Crear y asociar</button></div>
  </form></Modal>
}
