import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal } from '../components/Modal'
import { Field, ProjectSelect, ErrorBox, useMemory, useMemoryMutation, entityPath, type MemoryEntity, type Page } from '../lib/memory'

export function EntityForm({ kind, open, onClose, projectId }: { kind: string; open: boolean; onClose: () => void; projectId?: string }) {
  const navigate = useNavigate()
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [companyId, setCompanyId] = useState('')
  const [status, setStatus] = useState('discovery'), [projects, setProjects] = useState(projectId ? [projectId] : [])
  const [fields, setFields] = useState<{ key: string; label: string; type: string; required: boolean }[]>([{ key: 'detalle', label: 'Detalle', type: 'text', required: true }])
  const companies = useMemory<Page<MemoryEntity>>('list_entities', { kind: 'company', limit: 200 }, open && kind === 'project')
  const create = useMemoryMutation<MemoryEntity>('create_entity', entity => { onClose(); navigate(entityPath(entity)) })
  const labels: Record<string, string> = { project: 'Nuevo proyecto', company: 'Nueva empresa', person: 'Nueva persona', note: 'Nueva nota', collection: 'Nueva colección' }
  return <Modal open={open} onClose={onClose} title={labels[kind] ?? 'Nueva entidad'} busy={create.isPending} width={700}>
    <form className="memory-form" onSubmit={e => { e.preventDefault(); create.mutate({ kind, title, project_ids: projects,
      data: { description, ...(kind === 'note' ? { text: description || title } : {}), ...(kind === 'project' ? { status, ...(companyId ? { company_id: companyId } : {}) } : {}), ...(kind === 'collection' ? { fields } : {}) } }) }}>
      <Field label="Nombre"><input value={title} onChange={e => setTitle(e.target.value)} required maxLength={500} /></Field>
      <Field label={kind === 'note' ? 'Contenido' : 'Descripción'}><textarea rows={4} value={description} onChange={e => setDescription(e.target.value)} /></Field>
      {kind === 'project' && <div className="memory-form-grid"><Field label="Empresa"><select value={companyId} onChange={e => setCompanyId(e.target.value)}><option value="">Sin empresa asignada</option>{companies.data?.items.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></Field>
        <Field label="Etapa"><select value={status} onChange={e => setStatus(e.target.value)}>{['discovery','presales','poc','delivery','support','completed','paused'].map(s => <option key={s}>{s}</option>)}</select></Field></div>}
      {kind !== 'project' && kind !== 'company' && <ProjectSelect value={projects} onChange={setProjects} />}
      {kind === 'collection' && <div className="memory-fields-builder"><h3>Columnas de la colección</h3>{fields.map((field, index) => <div className="memory-column-input" key={index}>
        <Field label="Identificador"><input required pattern="[a-z][a-z0-9_]{0,63}" value={field.key} onChange={e => setFields(fields.map((f, i) => i === index ? { ...f, key: e.target.value } : f))} /></Field>
        <Field label="Etiqueta"><input required value={field.label} onChange={e => setFields(fields.map((f, i) => i === index ? { ...f, label: e.target.value } : f))} /></Field>
        <Field label="Tipo"><select value={field.type} onChange={e => setFields(fields.map((f, i) => i === index ? { ...f, type: e.target.value } : f))}>{['text','number','boolean','date','datetime','entity','json'].map(t => <option key={t}>{t}</option>)}</select></Field>
        <label className="check"><input type="checkbox" checked={field.required} onChange={e => setFields(fields.map((f, i) => i === index ? { ...f, required: e.target.checked } : f))} />Obligatorio</label>
        <button type="button" className="btn btn-sm" aria-label={`Quitar ${field.label}`} onClick={() => setFields(fields.filter((_, i) => i !== index))}>×</button>
      </div>)}<button type="button" className="btn" onClick={() => setFields([...fields, { key: `campo_${fields.length + 1}`, label: 'Nuevo campo', type: 'text', required: false }])}>Agregar columna</button></div>}
      <ErrorBox error={create.error} /><div className="memory-form-actions"><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn btn-primary" disabled={create.isPending || !title.trim()}>Crear</button></div>
    </form>
  </Modal>
}

export function ImportForm({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId?: string }) {
  const navigate = useNavigate(), [title, setTitle] = useState(''), [text, setText] = useState(''), [externalId, setExternalId] = useState('')
  const [kind, setKind] = useState('meeting'), [projects, setProjects] = useState(projectId ? [projectId] : []), [occurredAt, setOccurredAt] = useState('')
  const [json, setJson] = useState<unknown>(null), [fileError, setFileError] = useState<Error | null>(null)
  const ingest = useMemoryMutation<any>('import_source', result => { onClose(); navigate(`/memory/entities/${result.entity_id}`) })
  async function load(file?: File) {
    if (!file) return
    try {
      if (file.size > 5_000_000) throw new Error('El archivo supera 5 MB; dividilo por reunión o documento')
      const content = await file.text()
      setTitle(file.name.replace(/\.[^.]+$/, '')); setExternalId(`file:${file.name}`); setFileError(null)
      if (file.name.endsWith('.json')) { setJson(JSON.parse(content)); setText(content) }
      else { setJson(null); setText(content) }
    } catch (error) { setFileError(error instanceof Error ? error : new Error('No se pudo leer el archivo')) }
  }
  return <Modal open={open} onClose={onClose} title="Incorporar una fuente" busy={ingest.isPending} width={800}>
    <form className="memory-form" onSubmit={e => { e.preventDefault(); if (fileError) return
      ingest.mutate(json ?? { kind, title, text, external_id: externalId.trim() || `manual:${crypto.randomUUID()}`, project_ids: projects,
        ...(occurredAt ? { occurred_at: new Date(occurredAt).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}) }) }}>
      <div className="memory-drop"><strong>Transcripción, documento o fuente estructurada</strong><p>TXT, Markdown, VTT, SRT o JSON. La copia original se conserva en esta computadora.</p>
        <input aria-label="Archivo para importar" type="file" accept=".txt,.md,.vtt,.srt,.json" onChange={e => void load(e.target.files?.[0])} /></div>
      {json !== null ? <p className="memory-callout">Se importará el objeto JSON completo. Sus participantes, proyectos e intervenciones se validan antes de guardar.</p> : <>
        <div className="memory-form-grid"><Field label="Título"><input value={title} onChange={e => setTitle(e.target.value)} required /></Field><Field label="Tipo de fuente"><select value={kind} onChange={e => setKind(e.target.value)}><option value="meeting">Reunión</option><option value="document">Documento</option><option value="note">Nota</option></select></Field></div>
        <div className="memory-form-grid"><Field label="Fecha y hora de la reunión"><input type="datetime-local" value={occurredAt} onChange={e => setOccurredAt(e.target.value)} /></Field><Field label="Identificador de origen"><input value={externalId} onChange={e => setExternalId(e.target.value)} placeholder="Ej.: reunion-interna-2026-09-11" /><span className="field-hint">Reutilizalo para importar una versión actualizada.</span></Field></div>
        <ProjectSelect value={projects} onChange={setProjects} />
      </>}
      <Field label={json !== null ? 'Vista previa del JSON' : 'Contenido'}><textarea rows={12} value={text} readOnly={json !== null} onChange={e => setText(e.target.value)} placeholder={'00:02 Ana: Ya validamos la integración.\n00:04 Martín: Revisamos los resultados el martes.'} required /></Field>
      <ErrorBox error={fileError ?? ingest.error} /><div className="memory-form-actions"><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn btn-primary" disabled={ingest.isPending || !!fileError}>Importar fuente</button></div>
    </form>
  </Modal>
}
