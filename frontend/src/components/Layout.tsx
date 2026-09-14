import { NavLink, Outlet } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Icon, type IconName } from './Icon'
import { useOverview } from '../lib/local'
import { useToast } from './Toast'

export interface NavEntry { to: string; label: string; icon: IconName }
export const NAV_ENTRIES: readonly NavEntry[] = [
  { to: '/catalog', label: 'MCP servers', icon: 'catalog' },
  { to: '/skills', label: 'Skills', icon: 'skills' },
  { to: '/projects', label: 'Proyectos', icon: 'matrix' },
  { to: '/memory', label: 'Memoria', icon: 'hub' },
  { to: '/clients', label: 'Clientes', icon: 'machines' },
  { to: '/activity', label: 'Actividad', icon: 'audit' },
]
export function Layout() {
  const overview = useOverview()
  const cache = useQueryClient()
  const toast = useToast()
  const core = useQuery({ queryKey: ['desktop-status'], queryFn: () => window.agentHub?.getCoreStatus() ?? Promise.resolve(null), refetchInterval: 2000 })
  const sync = useMutation({ mutationFn: async () => { if (window.agentHub) await window.agentHub.syncNow(); await cache.invalidateQueries() }, onSuccess: () => toast.success('Sincronización revisada'), onError: error => toast.error('No se pudo sincronizar', error.message) })
  const clients = overview.data?.clients ?? []
  const pending = clients.filter(client => !client.synchronized).length
  const failing = core.isError || core.data?.state === 'failed' || core.data?.daemonState === 'failed'
  const connected = clients.length > 0 && pending === 0 && !failing
  return <div className="hub-shell"><aside className="hub-sidebar">
    <div className="hub-brand"><span className="hub-brand-mark"><Icon name="hub" /></span><div><strong>Agent Hub</strong><small>Tu espacio de herramientas</small></div></div>
    <div className="hub-workspace"><Icon name="machines" /><div><strong>Esta computadora</strong><span>{overview.data?.hostname ?? 'Espacio local'}</span></div><span className="hub-local-dot" /></div>
    <div className="hub-nav-label">BIBLIOTECA</div><nav aria-label="Secciones" className="hub-nav">{NAV_ENTRIES.map(entry => <NavLink key={entry.to} className={({ isActive }) => `hub-nav-link ${isActive ? 'active' : ''}`} to={entry.to}><Icon name={entry.icon} /><span>{entry.label}</span>{entry.to === '/clients' && clients.length > 0 && <small>{clients.length}</small>}</NavLink>)}</nav>
    <div className="hub-sidebar-bottom"><div className="hub-sync-card"><div><span className={`hub-local-dot ${connected ? '' : 'pending'}`} /><strong>{failing ? 'Servicio detenido' : connected ? 'Todo sincronizado' : pending ? 'Sincronización pendiente' : 'Esperando clientes'}</strong></div><p>{failing ? 'Revisá el servicio en Ajustes.' : connected ? 'Tus clientes comparten el mismo hub.' : pending ? 'Revisá el estado de tus clientes.' : 'Conectá tu primer cliente para empezar.'}</p></div><NavLink className={({ isActive }) => `hub-nav-link ${isActive ? 'active' : ''}`} to="/settings"><Icon name="matrix" /><span>Ajustes</span></NavLink><div className="hub-version"><span>Agent Hub</span><span>Local · v0.2</span></div></div>
  </aside><div className="hub-main"><header className="hub-topbar"><div><span className="hub-local-dot" /><span>En tu computadora</span><span className="hub-topbar-divider">/</span><span>Sincronización automática</span></div><button className="btn btn-ghost btn-sm" disabled={sync.isPending} onClick={() => sync.mutate()}><Icon name="refresh" />{sync.isPending ? 'Sincronizando…' : 'Sincronizar ahora'}</button></header><main className="hub-content"><Outlet /></main></div></div>
}
export default Layout
