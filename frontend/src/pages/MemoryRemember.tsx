import { Link } from 'react-router-dom'
import { ErrorBox, formatTime, useMemoryMutation, type MemoryEntity } from '../lib/memory'

const categories: Record<string, string> = { preference: 'Preferencia', decision: 'Decisión', lesson: 'Aprendizaje', procedure: 'Procedimiento', context: 'Contexto' }
const confidence: Record<string, string> = { observed: 'Observado', confirmed: 'Confirmado', inferred: 'Inferido' }
export function MemoryRemember({ entity }: { entity: MemoryEntity }) {
  const manage = useMemoryMutation('manage_memory'), archived = entity.data.memory_state === 'archived', pinned = entity.data.memory_pinned
  const change = (action: string) => manage.mutate({ id: entity.id, action, expected_updated_at: entity.updated_at, reason: 'Cambio solicitado desde la ficha del recuerdo' })
  return <section className="memory-callout"><div className="spread"><strong>Recuerdo del agente</strong><span className="badge">{archived ? 'Archivado' : pinned ? 'Fijado' : 'Activo'}</span></div>
    <p>{categories[entity.data.memory_category] ?? 'Contexto'} · {confidence[entity.data.memory_confidence] ?? 'Sin verificar'} · Importancia {entity.data.memory_importance ?? 3}/5</p>
    {entity.data.memory_expires_at && <p>Vigencia indicada: {formatTime(entity.data.memory_expires_at)}</p>}
    {entity.data.memory_archive_reason && <p>{entity.data.memory_archive_reason}</p>}
    {entity.data.memory_duplicate_of && <Link to={`/memory/entities/${entity.data.memory_duplicate_of}`}>Ver recuerdo vigente</Link>}
    <div className="memory-button-wrap"><button className="btn" disabled={manage.isPending} onClick={() => change(archived ? 'restore' : 'archive')}>{archived ? 'Restaurar y fijar recuerdo' : 'Archivar recuerdo'}</button>
      {!archived && <button className="btn" disabled={manage.isPending} onClick={() => change(pinned ? 'unpin' : 'pin')}>{pinned ? 'Dejar de fijar' : 'Fijar recuerdo'}</button>}</div>
    <p className="field-hint">Archivar lo retira de las búsquedas habituales y conserva versiones y evidencia. Fijarlo evita que el mantenimiento lo archive automáticamente.</p><ErrorBox error={manage.error} />
  </section>
}
