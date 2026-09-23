import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, NavLink } from 'react-router-dom'
import { api } from './api'
import { useToast } from '../components/Toast'

export interface MemoryEntity { id: string; kind: string; title: string; data: Record<string, any>; created_at: string; updated_at: string }
export interface Page<T = any> { items: T[]; total: number; limit: number; offset: number }
export const entityLabels: Record<string, string> = { company: 'Empresa', project: 'Proyecto', person: 'Persona', meeting: 'Reunión', event: 'Evento', document: 'Documento', message: 'Conversación', issue: 'Tarea', note: 'Nota', collection: 'Colección', fact: 'Conocimiento' }
export const memoryCall = <T = any,>(operation: string, input: unknown = {}) => api.post<T>('/memory/call', { operation, input })
export const MEMORY_REFRESH_MS = 5000
export function useMemory<T = any>(operation: string, input: unknown = {}, enabled = true) {
  return useQuery({ queryKey: ['memory', operation, input], queryFn: () => memoryCall<T>(operation, input), enabled,
    // MCP clients and the worker can write while this screen stays open. Only mounted, visible queries poll.
    refetchInterval: MEMORY_REFRESH_MS, refetchIntervalInBackground: false, refetchOnWindowFocus: 'always' })
}
export function useMemoryMutation<T = any>(operation: string, onSuccess?: (data: T) => void) {
  const cache = useQueryClient(), toast = useToast()
  return useMutation({ mutationFn: (input: unknown) => memoryCall<T>(operation, input), onSuccess: data => {
    void cache.invalidateQueries({ queryKey: ['memory'] }); void cache.invalidateQueries({ queryKey: ['memory-status'] }); onSuccess?.(data)
  }, onError: error => toast.error('No se pudo completar', error.message) })
}
export function useMemoryStatus() { return useQuery({ queryKey: ['memory-status'], queryFn: () => api.get<any>('/memory/status'), refetchInterval: 10_000 }) }
export function entityPath(entity: { id: string; kind: string }) { return entity.kind === 'project' ? `/projects/${entity.id}` : `/memory/entities/${entity.id}` }
export function formatTime(value: string | null | undefined) { return value ? new Date(value).toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' }) : 'Sin fecha registrada' }
export function ErrorBox({ error, retry }: { error: Error | null; retry?: () => unknown }) {
  return error ? <div className="hub-notice error" role="alert"><p>{error.message}</p>{retry && <button className="btn" onClick={() => void retry()}>Reintentar</button>}</div> : null
}
export function MemoryNav() { return <nav className="memory-nav" aria-label="Navegación de memoria">
  <NavLink to="/projects" end>Proyectos</NavLink><NavLink to="/memory" end>Explorar</NavLink>
  <NavLink to="/memory/search">Buscar</NavLink><NavLink to="/memory/review">Por revisar</NavLink><NavLink to="/memory/processing">Procesamiento</NavLink><NavLink to="/memory/sources">Fuentes y ajustes</NavLink>
</nav> }
export function MemoryFrame({ children, setup = false }: { children: ReactNode; setup?: boolean }) {
  const status = useMemoryStatus()
  return <div className="memory-page"><MemoryNav /><ErrorBox error={status.error} retry={status.refetch} />
    {!setup && status.isPending ? <div className="hub-loading" role="status">Conectando con tu memoria…</div>
      : !setup && !status.data?.ready ? <div className="memory-welcome card"><div className="hub-eyebrow">MEMORIA LOCAL</div><h1>Un lugar para el contexto de tus proyectos</h1>
        <p>Reuniones, personas y documentos conectados, con acceso a la fuente de cada dato.</p><p className="muted">{status.data?.detail}</p><Link className="btn btn-primary" to="/memory/sources">Preparar memoria</Link></div>
        : children}
  </div>
}
export function PageHeading({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <div className="hub-heading"><div><div className="hub-eyebrow">TU MEMORIA DE TRABAJO</div><h1>{title}</h1>{description && <p>{description}</p>}</div><div className="hub-actions">{children}</div></div>
}
export function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field memory-field"><span className="field-label">{label}</span>{children}</label> }
export function ProjectSelect({ value, onChange, label = 'Proyectos relacionados' }: { value: string[]; onChange: (ids: string[]) => void; label?: string }) {
  const projects = useMemory<Page<MemoryEntity>>('list_entities', { kind: 'project', limit: 200 })
  return <Field label={label}><select multiple aria-label={label} value={value} onChange={e => onChange([...e.target.selectedOptions].map(o => o.value))}>
    {projects.data?.items.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
  </select><span className="field-hint">Podés relacionar el mismo contenido con varios proyectos.</span></Field>
}
export function Pager({ total, offset, limit, setOffset }: { total: number; offset: number; limit: number; setOffset: (offset: number) => void }) {
  return <div className="memory-pager"><span>{total ? `${offset + 1}–${Math.min(offset + limit, total)} de ${total}` : 'Sin resultados'}</span><div>
    <button className="btn btn-sm" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - limit))}>Anterior</button>
    <button className="btn btn-sm" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}>Siguiente</button></div></div>
}
export function EmptyMemory({ children }: { children: ReactNode }) { return <div className="memory-empty">{children}</div> }
export function EntityRows({ items }: { items: MemoryEntity[] }) {
  if (!items.length) return <EmptyMemory>No hay información en este alcance todavía.</EmptyMemory>
  return <div className="memory-entity-list">{items.map(entity => <Link key={entity.id} to={entityPath(entity)} className="memory-entity-row">
    <span className={`memory-kind kind-${entity.kind}`}>{entityLabels[entity.kind] ?? entity.kind}</span><div><strong>{entity.title}</strong><p>{entity.data.description ?? entity.data.text?.slice(0, 160) ?? entity.data.email ?? ''}</p></div>
    <span className="memory-row-date">{entity.data.status ?? formatTime(entity.data.occurred_at ?? entity.updated_at)}</span>
  </Link>)}</div>
}
