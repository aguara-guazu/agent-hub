import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Icon, type IconName } from './Icon'
import { useOverview } from '../lib/local'
import type { LocalClient, PendingChanges } from '../lib/local'
import { CLI_LABELS } from '../lib/types'
import { useToast } from './Toast'
import { NavigationControls } from './NavigationControls'
import { GlobalSearch } from './GlobalSearch'

export interface NavEntry { to: string; label: string; icon: IconName }
export const NAV_ENTRIES: readonly NavEntry[] = [
  { to: '/catalog', label: 'MCP servers', icon: 'catalog' },
  { to: '/skills', label: 'Skills', icon: 'skills' },
  { to: '/projects', label: 'Proyectos', icon: 'matrix' },
  { to: '/memory', label: 'Memoria', icon: 'hub' },
  { to: '/clients', label: 'Clientes', icon: 'machines' },
  { to: '/activity', label: 'Actividad', icon: 'audit' },
]
function describePending(changes: PendingChanges | null): string {
  if (!changes) return 'La lista de herramientas cambió.'
  const parts = [
    changes.skills.added.length ? `skills nuevas: ${changes.skills.added.join(', ')}` : '',
    changes.skills.changed.length ? `skills actualizadas: ${changes.skills.changed.join(', ')}` : '',
    changes.skills.removed.length ? `skills retiradas: ${changes.skills.removed.join(', ')}` : '',
    changes.servers.added.length ? `MCP servers nuevos: ${changes.servers.added.join(', ')}` : '',
    changes.servers.removed.length ? `MCP servers retirados: ${changes.servers.removed.join(', ')}` : '',
  ].filter(Boolean)
  return parts.length ? `${parts.join(' · ')}.` : 'La lista de herramientas cambió.'
}

/** Claude Desktop lee sus herramientas al abrirse: con cambios sin cargar se ofrece reiniciarla. */
function RestartNotices({ clients }: { clients: LocalClient[] }) {
  const toast = useToast()
  const restart = useMutation({
    mutationFn: (cliKind: string) => window.agentHub!.restartClient(cliKind),
    onSuccess: result => result.ok ? toast.success('Claude Desktop reiniciada', result.detail) : toast.error('No se pudo reiniciar', result.detail),
    onError: error => toast.error('No se pudo reiniciar', error.message),
  })
  const pending = clients.filter(client => client.cli_kind === 'claude_desktop' && client.restart_pending)
  if (pending.length === 0) return null
  return <>{pending.map(client => <div key={client.id} className="hub-notice" role="status"><Icon name="info" /><div><strong>{CLI_LABELS[client.cli_kind]} tiene cambios sin cargar</strong><p>{describePending(client.pending)} Sólo los ve al reiniciarse.</p></div>{window.agentHub && <button className="btn btn-sm" disabled={restart.isPending} onClick={() => restart.mutate(client.cli_kind)}>{restart.isPending ? 'Reiniciando…' : 'Reiniciar Claude Desktop'}</button>}</div>)}</>
}

export function Layout() {
  const [searchOpen, setSearchOpen] = useState(false)
  const closeSearch = useCallback(() => setSearchOpen(false), [])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      if (searchOpen || document.querySelector('dialog[open], [role="dialog"]')) return
      event.preventDefault(); setSearchOpen(true)
    }
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [searchOpen])
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
  </aside><div className="hub-main"><header className="hub-topbar"><NavigationControls />
    <button className="hub-search-trigger" aria-label="Buscar en toda tu memoria" aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K" onClick={() => setSearchOpen(true)}><Icon name="search" /><span>Buscar en tu memoria…</span><kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'} K</kbd></button>
    <button className="btn btn-ghost btn-sm hub-sync-button" disabled={sync.isPending} onClick={() => sync.mutate()}><Icon name="refresh" /><span>{sync.isPending ? 'Sincronizando…' : 'Sincronizar ahora'}</span></button>
  </header><main className="hub-content"><RestartNotices clients={clients} /><Outlet /></main></div><GlobalSearch open={searchOpen} onClose={closeSearch} /></div>
}
export default Layout
