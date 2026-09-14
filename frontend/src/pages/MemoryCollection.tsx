import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Modal } from '../components/Modal'
import { Field, ProjectSelect, Pager, ErrorBox, EmptyMemory, useMemory, useMemoryMutation, type MemoryEntity, type Page } from '../lib/memory'

interface Column { key: string; label: string; type: string; required: boolean }
export function MemoryCollection({ entity }: { entity: MemoryEntity }) {
  const [offset, setOffset] = useState(0), [editing, setEditing] = useState<any>(null), [ruleOpen, setRuleOpen] = useState(false), [columnOpen, setColumnOpen] = useState(false)
  const [filterField, setFilterField] = useState(''), [filterValue, setFilterValue] = useState('')
  const fields: Column[] = entity.data.fields ?? []
  const field = fields.find(f => f.key === filterField)
  const filter = filterField && filterValue ? { [filterField]: field?.type === 'number' ? Number(filterValue) : field?.type === 'boolean' ? filterValue === 'true' : filterValue } : {}
  const records = useMemory<Page>('list_records', { collection_id: entity.id, limit: 50, offset, filter })
  const rules = useMemory<any[]>('list_rules'), update = useMemoryMutation('update_rule')
  return <section className="memory-section"><div className="spread"><h2>Registros</h2><div className="row"><button className="btn" onClick={() => setColumnOpen(true)}>Agregar columna</button><button className="btn" onClick={() => setRuleOpen(true)}>Seguimiento automático</button><button className="btn btn-primary" onClick={() => setEditing({})}>Nueva fila</button></div></div>
    <div className="memory-toolbar"><select className="input" aria-label="Filtrar columna" value={filterField} onChange={e => { setFilterField(e.target.value); setFilterValue(''); setOffset(0) }}><option value="">Sin filtro</option>{fields.filter(f => f.type !== 'json').map(f => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
      {filterField && <input className="input" aria-label="Valor exacto del filtro" placeholder="Valor exacto…" value={filterValue} onChange={e => { setFilterValue(e.target.value); setOffset(0) }} />}</div>
    <ErrorBox error={records.error} retry={records.refetch} /><div className="memory-table-wrap card"><table className="memory-table"><thead><tr>{fields.map(f => <th key={f.key}>{f.label}</th>)}<th>Evidencia</th><th><span className="sr-only">Acciones</span></th></tr></thead><tbody>
      {records.data?.items.map(row => <tr key={row.id}>{fields.map(f => <td key={f.key}>{f.type === 'entity' && row.values[f.key] ? <Link to={`/memory/entities/${row.values[f.key]}`}>Ver entidad ↗</Link> : f.type === 'boolean' ? row.values[f.key] === undefined ? '—' : row.values[f.key] ? 'Sí' : 'No' : typeof row.values[f.key] === 'object' ? JSON.stringify(row.values[f.key]) : String(row.values[f.key] ?? '—')}</td>)}
        <td>{row.evidence_ids?.map((ev: string, index: number) => <EvidenceLink key={ev} id={ev} label={`Fuente ${index + 1}`} />)}{row.stale && <span className="badge badge-stale">Fuente actualizada</span>}</td><td><button className="btn btn-ghost btn-sm" onClick={() => setEditing(row)}>Editar</button></td></tr>)}
    </tbody></table>{records.data?.items.length === 0 && <EmptyMemory>Agregá una fila o una regla para extraer datos de nuevas fuentes.</EmptyMemory>}</div>
    {records.data && <Pager total={records.data.total} offset={offset} limit={50} setOffset={setOffset} />}
    <div className="memory-rule-list">{rules.data?.filter(r => r.collection_id === entity.id).map(rule => <div className="card memory-panel" key={rule.id}><div className="spread"><strong>{rule.name}</strong><button className="btn btn-sm" onClick={() => update.mutate({ id: rule.id, enabled: !rule.enabled })}>{rule.enabled ? 'Pausar' : 'Activar'}</button></div><p>{rule.instructions}</p><small className="muted">{rule.enabled ? 'Activa' : 'Pausada'} · {rule.processed_versions} versiones procesadas en esta revisión</small></div>)}</div>
    {editing && <RecordForm entity={entity} record={editing} onClose={() => setEditing(null)} />}
    {ruleOpen && <RuleForm entity={entity} onClose={() => setRuleOpen(false)} />}
    {columnOpen && <AddColumn entity={entity} onClose={() => setColumnOpen(false)} />}
  </section>
}
function EvidenceLink({ id, label }: { id: string; label: string }) {
  const evidence = useMemory<any>('get_evidence', { fragment_id: id })
  return evidence.data ? <Link className="memory-cell-link" to={`/memory/entities/${evidence.data.entity_id}?version=${evidence.data.version_id}&fragment=${id}`}>{label} ↗</Link> : <span>{label}</span>
}
function RecordForm({ entity, record, onClose }: { entity: MemoryEntity; record: any; onClose: () => void }) {
  const fields: Column[] = entity.data.fields ?? [], [values, setValues] = useState<Record<string, any>>(record.values ?? {}), [evidence, setEvidence] = useState((record.evidence_ids ?? []).join('\n'))
  const [error, setError] = useState<Error | null>(null)
  const save = useMemoryMutation(record.id ? 'update_record' : 'add_record', onClose)
  const entities = useMemory<Page<MemoryEntity>>('list_entities', { limit: 200 }, fields.some(f => f.type === 'entity'))
  return <Modal open title={record.id ? 'Editar fila' : 'Nueva fila'} onClose={onClose} busy={save.isPending}><form className="memory-form" onSubmit={e => {
    e.preventDefault()
    try {
      const parsed: Record<string, any> = {}
      for (const field of fields) {
        const raw = values[field.key]
        if (raw === undefined || raw === '') continue
        parsed[field.key] = field.type === 'number' ? Number(raw) : field.type === 'json' && typeof raw === 'string' ? JSON.parse(raw) : field.type === 'datetime' ? new Date(raw).toISOString() : raw
      }
      save.mutate({ ...(record.id ? { id: record.id } : { collection_id: entity.id }), values: parsed, evidence_ids: evidence.split(/[\s,]+/).filter(Boolean) }); setError(null)
    } catch { setError(new Error('Revisá los valores de fecha o JSON')) }
  }}>{fields.map(field => <Field key={field.key} label={`${field.label}${field.required ? ' *' : ''}`}>
    {field.type === 'boolean' ? <select value={values[field.key] === undefined ? '' : String(values[field.key])} onChange={e => setValues({ ...values, [field.key]: e.target.value === '' ? undefined : e.target.value === 'true' })} required={field.required}><option value="">Sin valor</option><option value="true">Sí</option><option value="false">No</option></select>
      : field.type === 'entity' ? <select required={field.required} value={values[field.key] ?? ''} onChange={e => setValues({ ...values, [field.key]: e.target.value })}><option value="">Seleccionar…</option>{entities.data?.items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
        : field.type === 'json' ? <textarea rows={4} required={field.required} value={typeof values[field.key] === 'object' ? JSON.stringify(values[field.key], null, 2) : values[field.key] ?? ''} onChange={e => setValues({ ...values, [field.key]: e.target.value })} />
          : <input required={field.required} type={field.type === 'datetime' ? 'datetime-local' : field.type === 'number' || field.type === 'date' ? field.type : 'text'} step={field.type === 'number' ? 'any' : undefined} value={values[field.key] ?? ''} onChange={e => setValues({ ...values, [field.key]: e.target.value })} />}
  </Field>)}<Field label="IDs de evidencia (opcional, uno por línea)"><textarea rows={2} value={evidence} onChange={e => setEvidence(e.target.value)} /></Field><ErrorBox error={error ?? save.error} /><button className="btn btn-primary" disabled={save.isPending}>Guardar fila</button></form></Modal>
}
function RuleForm({ entity, onClose }: { entity: MemoryEntity; onClose: () => void }) {
  const [name, setName] = useState(''), [instructions, setInstructions] = useState(''), [projects, setProjects] = useState<string[]>([])
  const create = useMemoryMutation('create_rule', onClose)
  return <Modal open title="Seguir registrando información" onClose={onClose}><form className="memory-form" onSubmit={e => { e.preventDefault(); create.mutate({ collection_id: entity.id, name, instructions, project_ids: projects, enabled: true }) }}>
    <p>La regla recorre el material importado y se aplica a fuentes nuevas. Cada fila conserva los fragmentos que la respaldan. Necesita un modelo de extracción configurado.</p>
    <Field label="Nombre del seguimiento"><input required value={name} onChange={e => setName(e.target.value)} placeholder="Disponibilidad de Martín" /></Field><Field label="Qué registrar"><textarea required rows={5} value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="Registrá cada mención explícita de horarios de atención. Conservá la expresión original y la zona horaria si se menciona." /></Field><ProjectSelect value={projects} onChange={setProjects} />
    <ErrorBox error={create.error} /><button className="btn btn-primary" disabled={create.isPending}>Crear seguimiento</button></form></Modal>
}
function AddColumn({ entity, onClose }: { entity: MemoryEntity; onClose: () => void }) {
  const [key, setKey] = useState(''), [label, setLabel] = useState(''), [type, setType] = useState('text')
  const save = useMemoryMutation('update_entity', onClose)
  return <Modal open title="Agregar columna" onClose={onClose}><form className="memory-form" onSubmit={e => { e.preventDefault(); save.mutate({ id: entity.id, expected_updated_at: entity.updated_at, data: { fields: [...entity.data.fields, { key, label, type, required: false }] } }) }}>
    <Field label="Etiqueta"><input value={label} onChange={e => setLabel(e.target.value)} required /></Field><Field label="Identificador"><input value={key} onChange={e => setKey(e.target.value)} required pattern="[a-z][a-z0-9_]{0,63}" placeholder="zona_horaria" /></Field><Field label="Tipo"><select value={type} onChange={e => setType(e.target.value)}>{['text','number','boolean','date','datetime','entity','json'].map(t => <option key={t}>{t}</option>)}</select></Field><p className="muted">La nueva columna es opcional para conservar las filas existentes.</p><ErrorBox error={save.error} /><button className="btn btn-primary" disabled={save.isPending}>Agregar columna</button></form></Modal>
}
