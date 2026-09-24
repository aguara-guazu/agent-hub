import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Modal } from '../components/Modal'
import { api } from '../lib/api'
import { ErrorBox, Field, memoryCall, useMemory, useMemoryMutation, type MemoryEntity, type Page } from '../lib/memory'

/** An async suggestion may fill an untouched selector, never replace the person's choice. */
export function SuggestedProjectSelect({ sourceId, value, onChange, label }: { sourceId: string; value: string; onChange: (id: string) => void; label: string }) {
  const [query,setQuery] = useState(''), [search,setSearch] = useState(''), touched = useRef(Boolean(value))
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()),250); return () => clearTimeout(timer) },[query])
  const suggestions = useQuery({ queryKey: ['project-suggestions',sourceId], queryFn: () => memoryCall<any>('suggest_projects',{entity_id:sourceId}), staleTime:60_000, retry:false })
  const projects = useQuery({ queryKey: ['project-choices',search], queryFn: () => memoryCall<Page<MemoryEntity>>('list_entities',{kind:'project',query:search,limit:50}) })
  const selected = useQuery({ queryKey: ['project-choice',value], queryFn: () => memoryCall<any>('get_entity',{id:value}), enabled:!!value })
  useEffect(() => {
    if (!touched.current && suggestions.data?.selected_id) { touched.current=true; onChange(suggestions.data.selected_id) }
  },[suggestions.data,onChange])
  const options = [...new Map([...(search ? [] : suggestions.data?.items ?? []),...(projects.data?.items ?? []),...(selected.data ? [selected.data.entity] : [])].map(p => [p.id,p])).values()]
  return <div className="memory-form">
    <Field label="Buscar proyecto o empresa"><input value={query} placeholder="Nombre del proyecto o de la empresa…" onChange={e => { touched.current=true; setQuery(e.target.value) }} /></Field>
    <select className="input" aria-label={label} value={value} onChange={e => { touched.current=true; onChange(e.target.value) }}><option value="">Elegir proyecto existente…</option>{options.map(p => <option key={p.id} value={p.id}>{p.title}{p.company ? ` · ${p.company}` : ''}</option>)}</select>
    <span className="field-hint">{suggestions.isPending ? 'Buscando coincidencias por contexto…' : suggestions.data?.reason ?? 'Puedes buscar y elegir un proyecto manualmente.'} La asociación se guarda al confirmar.</span>
    {suggestions.data?.semantic_status !== 'ready' && suggestions.data && <span className="field-hint">{suggestions.data.semantic_status === 'indexing' ? 'El índice semántico todavía se está completando.' : 'Búsqueda semántica no disponible; se usan coincidencias de nombres.'}</span>}
    <ErrorBox error={projects.error} />
  </div>
}

/** Generation is isolated from the form values until the person explicitly uses the draft. */
export function ProfileDraft({ projectId, kind, automatic = false, onUse }: { projectId: string; kind: 'company'|'project'; automatic?: boolean; onUse: (draft: {title:string;description:string}) => void }) {
  const [draft,setDraft] = useState<any>(null), [busy,setBusy] = useState(false), [error,setError] = useState<Error|null>(null), [used,setUsed] = useState(false)
  const controller = useRef<AbortController|null>(null)
  async function generate() {
    controller.current?.abort(); const request = new AbortController(); controller.current=request
    setBusy(true); setError(null); setUsed(false)
    try { const result = await api.post<any>('/memory/call',{operation:'draft_profile',input:{project_id:projectId,kind}},request.signal)
      if (!request.signal.aborted) setDraft(result)
    } catch (e) { if (!request.signal.aborted) setError(e instanceof Error ? e : new Error('No se pudo generar el borrador')) }
    finally { if (!request.signal.aborted) setBusy(false) }
  }
  useEffect(() => { if (automatic) void generate(); return () => controller.current?.abort() },[projectId,kind,automatic]) // component is mounted per project/form
  return <div className="memory-callout memory-profile-draft">
    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void generate()}>{busy ? 'Analizando el contexto del proyecto…' : 'Generar borrador con IA'}</button>
    {busy && <p role="status">Se analizan las reuniones y documentos con el modelo configurado en Procesamiento y búsqueda.</p>}
    <ErrorBox error={error} />
    {draft && <>
      {!used && <><p>Vista previa editable. Revisa el contenido antes de usarlo.</p>
        {kind === 'company' && <Field label="Nombre sugerido de la empresa"><input maxLength={500} value={draft.title} onChange={e => setDraft({...draft,title:e.target.value})} /></Field>}
        <Field label="Descripción sugerida"><textarea rows={6} maxLength={4000} value={draft.description} onChange={e => setDraft({...draft,description:e.target.value})} /></Field>
        <button type="button" className="btn btn-sm" disabled={busy || !draft.description.trim() || (kind === 'company' && !draft.title.trim())} onClick={() => { onUse(draft); setUsed(true) }}>Usar borrador</button></>}
      {used && <p>Borrador aplicado al formulario. Aún falta guardar los cambios.</p>}
      {!!draft.warnings?.length && <ul>{draft.warnings.map((w:string,i:number) => <li key={i}>{w}</li>)}</ul>}
      <details><summary>Fuentes del borrador</summary><p>Se consultaron {draft.coverage.sampled_sources} de {draft.coverage.available_sources} fuentes disponibles, priorizando las iniciales de assessment y venta.</p>
        <ul>{draft.sources.map((s:any) => <li key={s.id}><Link to={s.href} target="_blank" rel="noreferrer">{s.title}</Link>{s.speaker ? ` · ${s.speaker}` : ''}<blockquote>{s.text}</blockquote></li>)}</ul></details>
    </>}
  </div>
}

export function ProjectCompanyForm({ project, onClose }: { project: MemoryEntity; onClose: () => void }) {
  const [expectedUpdatedAt] = useState(project.updated_at)
  const [creating,setCreating] = useState(false), [company,setCompany] = useState(project.data.company_id ?? ''), [query,setQuery] = useState('')
  const [title,setTitle] = useState(''), [description,setDescription] = useState('')
  const companies = useMemory<Page<MemoryEntity>>('list_entities',{kind:'company',query,limit:100})
  const save = useMemoryMutation('save_project_company',onClose)
  return <Modal open title="Empresa del proyecto" onClose={onClose} busy={save.isPending}><form className="memory-form" onSubmit={e => { e.preventDefault(); save.mutate({project_id:project.id,expected_updated_at:expectedUpdatedAt,
    ...(creating ? {company:{title,description}} : {company_id:company})}) }}>
    <div className="row"><button type="button" className={`btn ${!creating ? 'btn-primary' : ''}`} onClick={() => setCreating(false)}>Asociar existente</button><button type="button" className={`btn ${creating ? 'btn-primary' : ''}`} onClick={() => setCreating(true)}>Crear empresa</button></div>
    {creating ? <>
      <ProfileDraft projectId={project.id} kind="company" automatic onUse={d => { setTitle(d.title); setDescription(d.description) }} />
      <Field label="Nombre de la empresa"><input required maxLength={500} value={title} onChange={e => setTitle(e.target.value)} /></Field>
      <Field label="Descripción de la empresa"><textarea rows={5} maxLength={4000} value={description} onChange={e => setDescription(e.target.value)} /></Field>
    </> : <><Field label="Buscar empresa"><input value={query} onChange={e => setQuery(e.target.value)} /></Field><Field label="Empresa"><select value={company} onChange={e => setCompany(e.target.value)}><option value="">Elegir empresa…</option>{companies.data?.items.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></Field><ErrorBox error={companies.error} /></>}
    <ErrorBox error={save.error} /><div className="memory-form-actions"><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn btn-primary" disabled={save.isPending || (creating ? !title.trim() : !company)}>{creating ? 'Crear y asociar empresa' : 'Asociar empresa'}</button></div>
  </form></Modal>
}
