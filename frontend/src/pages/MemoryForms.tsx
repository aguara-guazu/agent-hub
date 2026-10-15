import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { Field, ProjectSelect, ErrorBox, memoryCall, useMemory, useMemoryMutation, entityPath, type MemoryEntity, type Page } from '../lib/memory'

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

const MAX_FILE_BYTES = 25_000_000
const kindLabels: Record<string, string> = { document: 'Documento', meeting: 'Reunión', note: 'Nota' }

function fileSize(bytes: number): string {
  return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`
}
function fileProblem(file: File): string | null {
  return file.size === 0 ? 'está vacío' : file.size > MAX_FILE_BYTES ? 'supera 25 MB' : null
}
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(new Error('No se pudo leer el archivo'))
    reader.readAsDataURL(file)
  })
}

/** Uploads several files to one project. Title, external_id and description are left to the worker (`infer_metadata`). */
export function ImportForm({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: string }) {
  const cache = useQueryClient(), toast = useToast()
  const [files, setFiles] = useState<File[]>([]), [kind, setKind] = useState('document'), [occurredAt, setOccurredAt] = useState('')
  const [dragging, setDragging] = useState(false), [uploading, setUploading] = useState<number | null>(null), [failures, setFailures] = useState<{ name: string; message: string }[]>([])
  const busy = uploading !== null, invalid = files.some(file => fileProblem(file) !== null)
  function add(list: FileList | null) {
    if (!list?.length) return
    const known = new Set(files.map(file => `${file.name}:${file.size}:${file.lastModified}`))
    setFiles([...files, ...Array.from(list).filter(file => !known.has(`${file.name}:${file.size}:${file.lastModified}`))]); setFailures([])
  }
  async function upload() {
    const failed: { file: File; message: string }[] = []
    for (const [index, file] of files.entries()) {
      setUploading(index)
      try {
        await memoryCall('import_file', { filename: file.name, data_base64: await readBase64(file), kind, project_ids: [projectId], infer_metadata: true,
          ...(occurredAt ? { occurred_at: new Date(occurredAt).toISOString() } : {}) })
      } catch (error) { failed.push({ file, message: error instanceof Error ? error.message : 'No se pudo subir' }) }
    }
    setUploading(null)
    void cache.invalidateQueries({ queryKey: ['memory'] }); void cache.invalidateQueries({ queryKey: ['memory-status'] })
    const saved = files.length - failed.length
    if (saved) toast.success(saved === 1 ? 'Archivo adjuntado' : `${saved} archivos adjuntados`, 'El título, el identificador y el resumen se completan al procesarlos.')
    if (!failed.length) { onClose(); return }
    setFiles(failed.map(f => f.file)); setFailures(failed.map(f => ({ name: f.file.name, message: f.message })))
  }
  return <Modal open={open} onClose={onClose} title="Adjuntar archivos" busy={busy} width={720}>
    <form className="memory-form" onSubmit={e => { e.preventDefault(); if (files.length && !invalid) void upload() }}>
      <label className={`memory-drop memory-upload-drop${dragging ? ' dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); if (!busy) add(e.dataTransfer.files) }}>
        <strong>Arrastrá archivos acá o elegilos</strong>
        <p>PDF, documentos, imágenes, audio, video y texto (TXT, Markdown, VTT, SRT, JSON), hasta 25 MB cada uno. El original se conserva en esta computadora.</p>
        <span className="btn">Elegir archivos</span>
        <input className="sr-only" aria-label="Archivos para adjuntar" type="file" multiple disabled={busy} onChange={e => { add(e.target.files); e.target.value = '' }} />
      </label>
      {files.length > 0 && <ul className="memory-upload-list">{files.map((file, index) => {
        const problem = fileProblem(file), failure = failures.find(f => f.name === file.name)
        return <li key={`${file.name}:${file.size}:${file.lastModified}`} className={problem || failure ? 'invalid' : ''}>
          <span>{file.name}</span><small>{problem ?? failure?.message ?? (uploading === index ? 'Subiendo…' : uploading !== null && index < uploading ? 'Listo' : fileSize(file.size))}</small>
          <button type="button" className="btn btn-sm" aria-label={`Quitar ${file.name}`} disabled={busy} onClick={() => setFiles(files.filter((_, i) => i !== index))}>×</button>
        </li>
      })}</ul>}
      <div className="memory-form-grid">
        <Field label="Tipo de fuente"><select value={kind} disabled={busy} onChange={e => setKind(e.target.value)}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field label={kind === 'meeting' ? 'Fecha y hora de la reunión' : 'Fecha y hora'}><input type="datetime-local" value={occurredAt} disabled={busy} onChange={e => setOccurredAt(e.target.value)} /></Field>
      </div>
      {failures.length > 0 && <ErrorBox error={new Error(failures.length === 1 ? `No se pudo subir ${failures[0]!.name}.` : `No se pudieron subir ${failures.length} archivos.`)} />}
      <div className="memory-form-actions"><button type="button" className="btn" disabled={busy} onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" disabled={busy || !files.length || invalid}>{busy ? `Subiendo ${uploading! + 1} de ${files.length}…` : files.length > 1 ? `Adjuntar ${files.length} archivos` : 'Adjuntar archivo'}</button></div>
    </form>
  </Modal>
}
