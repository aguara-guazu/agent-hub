import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Icon, type IconName } from './Icon'
import { api } from '../lib/api'
import { entityLabels, memoryCall, type MemoryEntity, type Page } from '../lib/memory'

interface Result {
  key: string; entity_id: string; title: string; kind: string; preview: string; href: string;
  fragment_id: string | null; category: string | null; review_state: string | null; stale: string | null;
  updated_at: string; speaker_name: string | null; projects: { id: string; title: string }[]
}
interface Results { items: Result[]; total: number; semantic_status: string; has_more: boolean; offset: number; limit: number }
const icons: Record<string,IconName> = { project: 'matrix', fact: 'sparkles', person: 'users', company: 'machines', meeting: 'users', note: 'document', collection: 'matrix' }
const categories: Record<string,string> = { finding: 'Hallazgo', decision: 'Decisión', commitment: 'Compromiso', risk: 'Riesgo', summary: 'Resumen' }
const suggestions = ['¿Qué compromisos quedaron pendientes?', 'Decisiones sobre la arquitectura', 'Riesgos mencionados en las reuniones']

export function GlobalSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), navigate = useNavigate(), listId = useId()
  const [query, setQuery] = useState(''), [debounced, setDebounced] = useState(''), [kind, setKind] = useState('')
  const [project, setProject] = useState(''), [period, setPeriod] = useState(''), [from, setFrom] = useState('')
  const [filters, setFilters] = useState(false), [active, setActive] = useState(0)
  const result = useInfiniteQuery({ queryKey: ['memory','global-search',debounced,kind,project,from], initialPageParam: 0,
    queryFn: ({ signal, pageParam }) => api.post<Results>('/memory/search', { query: debounced, ...(kind ? { kind } : {}),
      ...(project ? { project_id: project } : {}), ...(from ? { from } : {}), limit: 20, offset: pageParam }, signal),
    getNextPageParam: (last) => last.has_more ? last.offset + last.limit : undefined,
    enabled: open && query.trim() === debounced, retry: false, staleTime: 15_000, refetchInterval: open ? 10_000 : false })
  const projects = useQuery({ queryKey: ['memory','search-projects'], queryFn: () => memoryCall<Page<MemoryEntity>>('list_entities', { kind: 'project', limit: 200 }), enabled: open && filters, staleTime: 15_000 })
  const items = [...new Map(result.data?.pages.flatMap(page => page.items).map(row => [row.entity_id, row])).values()]
  const waiting = query.trim() !== debounced || result.isPending
  const selectedFilters = Number(Boolean(kind)) + Number(Boolean(project)) + Number(Boolean(from))

  useEffect(() => { const timer = setTimeout(() => setDebounced(query.trim()), 300); return () => clearTimeout(timer) }, [query])
  useEffect(() => { setActive(0) }, [debounced,kind,project,from])
  useEffect(() => { setActive(index => Math.min(index, Math.max(0, items.length - 1))) }, [items.length])
  useEffect(() => {
    const element = dialog.current
    if (!element || !open) return
    const previous = document.activeElement as HTMLElement | null
    element.showModal(); input.current?.focus()
    return () => { element.close(); if (previous?.isConnected) previous.focus() }
  }, [open])
  useEffect(() => {
    if (!open) return
    const listener = (event: KeyboardEvent) => {
      if (!event.isComposing && !event.altKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); onClose() }
    }
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [open,onClose])

  function move(next: number) {
    const index = Math.max(0,Math.min(items.length-1,next))
    setActive(index)
    document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: 'nearest' })
  }
  function choose(row: Result) { onClose(); navigate(row.href) }
  const semantic = result.data?.pages[0]?.semantic_status
  const semanticMessage = semantic === 'ready' ? 'Por significado y palabras' : semantic === 'indexing' ? 'Por significado · completando el índice local'
    : semantic === 'unavailable' ? 'Por palabras · el modelo local no está disponible' : semantic === 'not_configured' ? 'Por palabras · activá la búsqueda por significado' : 'Sólo en tu computadora'

  return createPortal(<dialog ref={dialog} className="global-search-dialog" aria-label="Buscar en toda tu memoria" onKeyDown={event => {
    if (event.key !== 'Tab') return
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input, select, button:not(:disabled), a[href]')]
      .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0)
    const target = event.shiftKey && document.activeElement === controls[0] ? controls.at(-1)
      : !event.shiftKey && document.activeElement === controls.at(-1) ? controls[0] : null
    if (target) { event.preventDefault(); target.focus() }
  }}
    onCancel={e => { e.preventDefault(); onClose() }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="global-search-input-row">
      <span className="global-search-symbol"><Icon name="search" /></span>
      <input ref={input} value={query} maxLength={2000} placeholder="Una idea, un proyecto, algo que se dijo…" aria-label="Buscar en toda tu memoria"
        role="combobox" aria-expanded={open} aria-autocomplete="list" aria-controls={listId}
        aria-activedescendant={!waiting && items[active] ? `${listId}-${active}` : undefined}
        onChange={e => setQuery(e.target.value)} onKeyDown={e => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'ArrowDown') { e.preventDefault(); move(active+1) }
          if (e.key === 'ArrowUp') { e.preventDefault(); move(active-1) }
          if (e.key === 'Enter' && !waiting && items[active]) { e.preventDefault(); choose(items[active]) }
        }} />
      {query && <button className="global-search-icon-button" aria-label="Limpiar búsqueda" onClick={() => { setQuery(''); input.current?.focus() }}><Icon name="x" /></button>}
      <button className="global-search-close" onClick={onClose} aria-label="Cerrar búsqueda"><kbd>esc</kbd></button>
    </div>
    <div className="global-search-toolbar"><div className="global-search-chips" aria-label="Tipo de resultado">
      {[['','Todo'],['project','Proyectos'],['fact','Conocimientos'],['note','Notas'],['meeting','Reuniones']].map(([value,label]) =>
        <button key={value} aria-pressed={kind === value} onClick={() => setKind(kind === value ? '' : value!)}>{label}</button>)}
    </div><button className={`global-search-filter-button ${filters || selectedFilters ? 'active' : ''}`} aria-expanded={filters} aria-controls={`${listId}-filters`} onClick={() => setFilters(v => !v)}><Icon name="filter" />Filtros{selectedFilters > 0 && <span>{selectedFilters}</span>}</button></div>
    {filters && <div id={`${listId}-filters`} className="global-search-filters">
      <label>Proyecto<select aria-label="Proyecto" value={project} onChange={e => setProject(e.target.value)}><option value="">Todos los proyectos</option>{projects.data?.items.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
      <label>Contenido<select aria-label="Contenido" value={kind} onChange={e => setKind(e.target.value)}><option value="">Todos los tipos</option>{Object.entries(entityLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Actualizado<select aria-label="Actualizado" value={period} onChange={e => { setPeriod(e.target.value); setFrom(e.target.value ? new Date(Date.now()-Number(e.target.value)*86400000).toISOString() : '') }}><option value="">Cualquier fecha</option><option value="7">Últimos 7 días</option><option value="30">Últimos 30 días</option><option value="90">Últimos 90 días</option></select></label>
      {selectedFilters > 0 && <button onClick={() => { setKind(''); setProject(''); setPeriod(''); setFrom('') }}>Quitar filtros</button>}
    </div>}
    <div className="global-search-body" aria-busy={waiting}>
      {!query && !selectedFilters && <div className="global-search-intro"><span>ENCONTRÁ EL CONTEXTO</span><h2>Buscá como lo recordás.</h2><p>Proyectos, conocimientos y conversaciones, conectados en un solo lugar.</p><div>{suggestions.map(text => <button key={text} onClick={() => setQuery(text)}><Icon name="sparkles" />{text}<span>↗</span></button>)}</div></div>}
      <div className="global-search-results-heading"><span>{query || selectedFilters ? 'RESULTADOS EN TU MEMORIA' : 'ACTUALIZADO RECIENTEMENTE'}</span><span role="status" aria-live="polite">{waiting ? 'Buscando…' : result.isError ? '' : `${items.length}${result.hasNextPage ? '+' : ''} ${items.length === 1 && !result.hasNextPage ? 'resultado' : 'resultados'}`}</span></div>
      {result.isError ? <div className="global-search-empty" role="alert"><Icon name="alert" /><h3>No pudimos buscar en tu memoria</h3><p>{result.error.message}</p><button className="btn" onClick={() => void result.refetch()}>Reintentar</button><Link to="/memory/sources" onClick={onClose}>Revisar ajustes</Link></div>
        : waiting ? <div className="global-search-skeleton" role="status" aria-label="Buscando resultados"><i /><i /><i /></div>
        : items.length === 0 ? <div className="global-search-empty"><Icon name="search" /><h3>{query ? 'Todavía no encontramos una coincidencia' : 'Tu memoria empieza acá'}</h3><p>{query ? 'Probá con otra idea o ampliá los filtros.' : 'Conectá tus fuentes o guardá una nota para empezar a encontrar contexto.'}</p>{selectedFilters > 0 && <button className="btn" onClick={() => { setKind(''); setProject(''); setPeriod(''); setFrom('') }}>Ampliar la búsqueda</button>}</div> : null}
      <div id={listId} role="listbox" aria-label="Resultados de búsqueda" className="global-search-results">
        {!waiting && !result.isError && items.map((row,index) => <Link key={row.key} id={`${listId}-${index}`} to={row.href} role="option" aria-selected={active === index} tabIndex={-1}
          className={`global-search-result ${active === index ? 'selected' : ''}`} onMouseEnter={() => setActive(index)} onClick={onClose}>
          <span className={`global-result-icon type-${row.kind}`}><Icon name={icons[row.kind] ?? 'document'} /></span>
          <div className="global-result-copy"><div className="global-result-meta"><span>{categories[row.category ?? ''] ?? entityLabels[row.kind] ?? row.kind}</span>
            {row.projects[0] && row.kind !== 'project' && <><i /> <span>{row.projects[0].title}{row.projects.length > 1 ? ` +${row.projects.length-1}` : ''}</span></>}
            {row.review_state === 'pending' && <em>Por revisar</em>}{row.stale === 'true' && <em>Fuente actualizada</em>}</div>
            <h3>{row.title}</h3>{row.preview && <p>{row.speaker_name && <strong>{row.speaker_name}: </strong>}{row.preview}</p>}
            <span className="global-result-date">{row.fragment_id ? 'Ver fragmento de la fuente · ' : ''}{new Date(row.updated_at).toLocaleDateString('es-AR',{ day:'numeric',month:'short',year:'numeric' })}</span>
          </div><span className="global-result-enter" aria-hidden="true">↵</span>
        </Link>)}
      </div>
      {!waiting && result.hasNextPage && <button className="global-search-more" disabled={result.isFetchingNextPage} onClick={() => void result.fetchNextPage()}>{result.isFetchingNextPage ? 'Cargando…' : 'Ver más resultados'}</button>}
    </div>
    <footer className="global-search-footer"><div className={semantic === 'ready' || semantic === 'indexing' ? 'semantic-ready' : ''}><Icon name="sparkles" /><span>{semanticMessage}</span>
      {(semantic === 'not_configured' || semantic === 'unavailable') && <Link to="/memory/sources" onClick={onClose}>Configurar</Link>}</div><span className="global-search-key-hints"><kbd>↑</kbd><kbd>↓</kbd> recorrer <kbd>↵</kbd> abrir</span></footer>
  </dialog>,document.body)
}
